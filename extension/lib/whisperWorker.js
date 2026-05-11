// Module worker that runs whisper transcription via Transformers.js
// (onnxruntime-web). Prefers WebGPU; falls back to WASM CPU.

// Surface uncaught issues; otherwise empty events make debugging painful.
self.addEventListener("error", (event) => {
  console.error("[whisperWorker] uncaught error", event.error || event.message, event);
});
self.addEventListener("unhandledrejection", (event) => {
  console.error("[whisperWorker] unhandled rejection", event.reason);
});

let pipeline = null;
let env = null;
let importError = null;

// Beacon: tells the panel/settings the worker actually started. If this never
// arrives, the worker failed to even reach module evaluation (CSP, manifest, etc).
self.postMessage({ type: "worker-booting" });

// Kick off the transformers.js import as a regular Promise (not top-level
// await) so that any message handler we register below is in place before
// the module finishes loading. Messages arriving during the import are
// queued and awaited on by the handler.
const importPromise = (async () => {
  try {
    console.log("[whisperWorker] importing transformers.web.min.js...");
    const lib = await import("./transformersJs/transformers.web.min.js");
    pipeline = lib.pipeline;
    env = lib.env;

    // Keep onnxruntime artifacts loading from the extension origin (MV3 forbids
    // remote scripts/wasm). The trailing slash is required by transformers.js.
    env.backends.onnx.wasm.wasmPaths = new URL("./transformersJs/wasm/", self.location.href).href;
    env.backends.onnx.wasm.numThreads = 1;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    console.log("[whisperWorker] transformers.js ready");
    self.postMessage({ type: "worker-ready" });
    return null;
  } catch (error) {
    importError = error;
    console.error("[whisperWorker] failed to import transformers.web.min.js", error);
    self.postMessage({
      type: "worker-import-error",
      error: String(error?.message || error),
      stack: error?.stack
    });
    return error;
  }
})();

let pipelinePromise = null;
let activeModelId = null;
let activeDevice = null;

self.onmessage = async (event) => {
  const data = event.data || {};
  const { type, jobId } = data;
  console.log("[whisperWorker] received message", { type, jobId });

  // Wait for the import promise to settle before doing anything. Messages
  // arriving while transformers.js is still loading are awaited here.
  await importPromise;

  if (importError) {
    sendError(jobId, new Error(`Transformers.js import failed: ${importError?.message || importError}`));
    return;
  }

  if (type === "warmup") {
    try {
      await ensurePipeline(data.modelId, jobId);
      self.postMessage({ type: "done", jobId, text: "", segments: [], device: activeDevice });
    } catch (error) {
      sendError(jobId, error);
    }
    return;
  }

  if (type === "transcribe") {
    try {
      const transcriber = await ensurePipeline(data.modelId, jobId);
      send(jobId, { type: "stage", stage: "Transcribing" });

      const audio =
        data.pcm instanceof Float32Array ? data.pcm : new Float32Array(data.pcm);
      const seenStarts = new Set();
      const allSegments = [];

      // English-only checkpoints (e.g. whisper-small.en) reject `task` and
      // `language` because they're not multilingual; only set those for
      // multilingual models.
      const englishOnly = /\.en($|\W)/.test(String(data.modelId || activeModelId || ""));
      const callOptions = {
        chunk_length_s: Number.isFinite(data.chunkSec) ? data.chunkSec : 30,
        stride_length_s: 5,
        return_timestamps: true
      };
      if (!englishOnly) {
        callOptions.language = data.language || "english";
        callOptions.task = "transcribe";
      }

      const out = await transcriber(audio, {
        ...callOptions,
        callback_function: (beams) => {
          if (!beams || !beams.length) return;
          const top = beams[0];
          const chunks = top?.output_token_ids ? null : top?.chunks;
          if (Array.isArray(chunks)) {
            for (const c of chunks) {
              if (!c) continue;
              const startSec = Array.isArray(c.timestamp) ? c.timestamp[0] : null;
              const endSec = Array.isArray(c.timestamp) ? c.timestamp[1] : null;
              if (startSec == null) continue;
              const key = `${startSec}|${(c.text || "").length}`;
              if (seenStarts.has(key)) continue;
              seenStarts.add(key);
              const seg = {
                text: String(c.text || "").trim(),
                start: Math.round(Number(startSec) * 1000),
                end: endSec != null ? Math.round(Number(endSec) * 1000) : null
              };
              if (!seg.text) continue;
              allSegments.push(seg);
              send(jobId, { type: "segment", segment: seg });
            }
          }
        }
      });

      // Final pass — out.chunks holds the complete segment list.
      const finalSegments = Array.isArray(out?.chunks)
        ? out.chunks
            .filter((c) => c && c.text && Array.isArray(c.timestamp))
            .map((c) => ({
              text: String(c.text).trim(),
              start: Math.round(Number(c.timestamp[0] || 0) * 1000),
              end: c.timestamp[1] != null ? Math.round(Number(c.timestamp[1]) * 1000) : null
            }))
        : allSegments;

      const finalText =
        typeof out?.text === "string"
          ? out.text.trim()
          : finalSegments.map((s) => s.text).join(" ").trim();

      console.log("[whisperWorker] transcription complete", {
        device: activeDevice,
        textLength: finalText.length,
        segmentCount: finalSegments.length,
        rawHasText: typeof out?.text === "string",
        rawHasChunks: Array.isArray(out?.chunks),
        pcmSamples: audio.length,
        firstSegment: finalSegments[0],
        rawOutPreview: out && Object.keys(out).slice(0, 8)
      });

      self.postMessage({
        type: "done",
        jobId,
        text: finalText,
        segments: finalSegments,
        device: activeDevice
      });
    } catch (error) {
      sendError(jobId, error);
    }
  }
};

async function ensurePipeline(modelId, jobId) {
  const desired = String(modelId || "Xenova/whisper-small.en");
  if (pipelinePromise && activeModelId === desired) return pipelinePromise;
  if (pipelinePromise && activeModelId !== desired) {
    // Different model requested — drop the old pipeline so the new one loads fresh.
    pipelinePromise = null;
    activeDevice = null;
  }
  activeModelId = desired;
  pipelinePromise = createPipeline(desired, jobId);
  return pipelinePromise;
}

async function createPipeline(modelId, jobId) {
  send(jobId, { type: "stage", stage: "Loading model" });
  const progressCallback = (progress) => {
    if (!progress) return;
    if (progress.status === "progress") {
      send(jobId, {
        type: "downloadProgress",
        file: progress.file || "",
        progress: Number(progress.progress) || 0,
        loaded: Number(progress.loaded) || 0,
        total: Number(progress.total) || 0
      });
    } else if (progress.status === "ready") {
      send(jobId, { type: "stage", stage: "Model ready" });
    }
  };

  // Try WebGPU first; fall back to WASM if it isn't available or fails to init.
  try {
    const pipe = await pipeline("automatic-speech-recognition", modelId, {
      device: "webgpu",
      dtype: "fp32",
      progress_callback: progressCallback
    });
    activeDevice = "webgpu";
    send(jobId, { type: "engine", device: "webgpu" });
    return pipe;
  } catch (error) {
    console.warn("[whisperWorker] WebGPU unavailable, falling back to WASM", error);
    const pipe = await pipeline("automatic-speech-recognition", modelId, {
      device: "wasm",
      progress_callback: progressCallback
    });
    activeDevice = "wasm";
    send(jobId, { type: "engine", device: "wasm" });
    return pipe;
  }
}

function send(jobId, payload) {
  self.postMessage({ jobId, ...payload });
}

function sendError(jobId, error) {
  console.error("[whisperWorker]", error);
  self.postMessage({
    type: "error",
    jobId,
    error: String(error?.message || error)
  });
}
