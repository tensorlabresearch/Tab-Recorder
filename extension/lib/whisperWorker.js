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
let activePipelineDevice = null;
let activeDevice = null;

// Heartbeat throttle. Generation can run for minutes without emitting a new
// transcript segment, so the panel needs a separate liveness signal to tell
// "slow" apart from "wedged" (a lost WebGPU device leaves ONNX Runtime waiting
// on GPU work that never completes, with no error).
let lastHeartbeatAt = 0;
let steppedHeartbeatSent = false;

// `stepped` marks a heartbeat that came from the generation callback. The panel
// only arms its strict "no progress" timeout once it has seen one, so a
// transformers.js build that never invokes callback_function cannot cause a
// healthy-but-slow chunk to be killed.
function heartbeat(jobId, stepped = false) {
  const now = Date.now();
  if (!stepped && now - lastHeartbeatAt < 1000) return;
  if (stepped && now - lastHeartbeatAt < 1000) {
    // Still throttled, but the panel needs to learn that stepping works.
    if (steppedHeartbeatSent) return;
  }
  lastHeartbeatAt = now;
  if (stepped) steppedHeartbeatSent = true;
  send(jobId, { type: "heartbeat", stepped });
}

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
      await ensurePipeline(data.modelId, jobId, data.device, data.dtypes);
      self.postMessage({ type: "done", jobId, text: "", segments: [], device: activeDevice });
    } catch (error) {
      sendError(jobId, error);
    }
    return;
  }

  if (type === "transcribe") {
    try {
      const transcriber = await ensurePipeline(data.modelId, jobId, data.device, data.dtypes);
      send(jobId, { type: "stage", stage: "Transcribing" });
      lastHeartbeatAt = 0;
      steppedHeartbeatSent = false;
      heartbeat(jobId);

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
          heartbeat(jobId, true);
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

async function ensurePipeline(modelId, jobId, requestedDevice, requestedDtypes) {
  const desired = String(modelId || "onnx-community/distil-small.en");
  // "wasm" is requested when the panel retries a chunk after a stall, so the
  // cache key has to include the device or the retry would reuse the same
  // (possibly wedged) WebGPU pipeline.
  const device = requestedDevice === "wasm" || requestedDevice === "webgpu" ? requestedDevice : "auto";
  if (pipelinePromise && activeModelId === desired && activePipelineDevice === device) {
    return pipelinePromise;
  }
  if (pipelinePromise) {
    // Different model or device requested: drop the old pipeline so the new
    // one loads fresh.
    pipelinePromise = null;
    activeDevice = null;
  }
  activeModelId = desired;
  activePipelineDevice = device;
  pipelinePromise = createPipeline(desired, jobId, device, requestedDtypes);
  return pipelinePromise;
}

// Preferred first, then progressively safer. A full-precision encoder with a
// 4-bit decoder is both the smallest sane download and what the transformers.js
// WebGPU examples use; plain fp32 is the rung that always works but costs
// several hundred extra megabytes.
const DEFAULT_DTYPES = [{ encoder_model: "fp32", decoder_model_merged: "q4" }, "fp32"];

function describeDtype(dtype) {
  if (typeof dtype === "string") return dtype;
  return Object.entries(dtype || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

async function createPipeline(modelId, jobId, device = "auto", requestedDtypes) {
  send(jobId, { type: "stage", stage: "Loading model" });
  const progressCallback = (progress) => {
    heartbeat(jobId);
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

  const dtypes =
    Array.isArray(requestedDtypes) && requestedDtypes.length ? requestedDtypes : DEFAULT_DTYPES;
  // WebGPU first unless the caller pinned the CPU backend (which happens when a
  // GPU session has already wedged once).
  const devices = device === "wasm" ? ["wasm"] : ["webgpu", "wasm"];

  let lastError = null;
  for (const target of devices) {
    for (const dtype of dtypes) {
      try {
        const pipe = await pipeline("automatic-speech-recognition", modelId, {
          device: target,
          dtype,
          progress_callback: progressCallback
        });
        activeDevice = target;
        send(jobId, { type: "engine", device: target });
        console.log("[whisperWorker] pipeline ready", {
          modelId,
          device: target,
          dtype: describeDtype(dtype)
        });
        return pipe;
      } catch (error) {
        lastError = error;
        // A dtype that the runtime cannot build a session for (older q8/q4
        // exports hit this) and an unavailable WebGPU adapter look the same
        // from here: move to the next rung.
        console.warn("[whisperWorker] pipeline attempt failed", {
          modelId,
          device: target,
          dtype: describeDtype(dtype),
          error: String(error?.message || error)
        });
      }
    }
  }

  throw lastError || new Error(`Could not load ${modelId} on any backend.`);
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
