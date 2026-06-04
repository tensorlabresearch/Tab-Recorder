// Module worker that runs WavLM-based speaker embedding via Transformers.js
// (onnxruntime-web). Mirrors whisperWorker.js's lifecycle so the panel /
// settings can drive it with the same boot, ready, progress, done/error
// protocol. Prefers WebGPU; falls back to WASM CPU.

// Surface uncaught issues; otherwise empty events make debugging painful.
self.addEventListener("error", (event) => {
  console.error("[diarizationWorker] uncaught error", event.error || event.message, event);
});
self.addEventListener("unhandledrejection", (event) => {
  console.error("[diarizationWorker] unhandled rejection", event.reason);
});

let AutoModel = null;
let AutoProcessor = null;
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
    console.log("[diarizationWorker] importing transformers.web.min.js...");
    const lib = await import("./transformersJs/transformers.web.min.js");
    AutoModel = lib.AutoModel;
    AutoProcessor = lib.AutoProcessor;
    env = lib.env;

    // Keep onnxruntime artifacts loading from the extension origin (MV3 forbids
    // remote scripts/wasm). The trailing slash is required by transformers.js.
    env.backends.onnx.wasm.wasmPaths = new URL("./transformersJs/wasm/", self.location.href).href;
    env.backends.onnx.wasm.numThreads = 1;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    console.log("[diarizationWorker] transformers.js ready");
    self.postMessage({ type: "worker-ready" });
    return null;
  } catch (error) {
    importError = error;
    console.error("[diarizationWorker] failed to import transformers.web.min.js", error);
    self.postMessage({
      type: "worker-import-error",
      error: String(error?.message || error),
      stack: error?.stack
    });
    return error;
  }
})();

let modelPromise = null;
let processorPromise = null;
let activeModelId = null;
let activeDevice = null;

self.onmessage = async (event) => {
  const data = event.data || {};
  const { type, jobId } = data;
  console.log("[diarizationWorker] received message", { type, jobId });

  await importPromise;

  if (importError) {
    sendError(jobId, new Error(`Transformers.js import failed: ${importError?.message || importError}`));
    return;
  }

  if (type === "warmup") {
    try {
      await ensurePipeline(data.modelId, jobId);
      // Run one tiny embedding pass on 1s of silence so warmup proves the
      // full path (processor + model + output), not just model load.
      const silence = new Float32Array(16000);
      await embedAudio(silence);
      self.postMessage({ type: "done", jobId, device: activeDevice });
    } catch (error) {
      sendError(jobId, error);
    }
    return;
  }

  if (type === "embed") {
    try {
      await ensurePipeline(data.modelId, jobId);
      const audio =
        data.pcm instanceof Float32Array ? data.pcm : new Float32Array(data.pcm);
      const embedding = await embedAudio(audio);
      self.postMessage({
        type: "done",
        jobId,
        embedding,
        device: activeDevice
      }, [embedding.buffer]);
    } catch (error) {
      sendError(jobId, error);
    }
  }
};

async function ensurePipeline(modelId, jobId) {
  const desired = String(modelId || "Xenova/wavlm-base-plus-sv");
  if (modelPromise && processorPromise && activeModelId === desired) {
    return { model: await modelPromise, processor: await processorPromise };
  }
  if (activeModelId !== desired) {
    modelPromise = null;
    processorPromise = null;
    activeDevice = null;
  }
  activeModelId = desired;
  send(jobId, { type: "stage", stage: "Loading speaker-embed model" });

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
      send(jobId, { type: "stage", stage: "Speaker-embed model ready" });
    }
  };

  // Try WebGPU first; fall back to WASM if it isn't available or fails to init.
  let modelLoaded = null;
  try {
    modelLoaded = await AutoModel.from_pretrained(desired, {
      device: "webgpu",
      dtype: "fp32",
      progress_callback: progressCallback
    });
    activeDevice = "webgpu";
    send(jobId, { type: "engine", device: "webgpu" });
  } catch (error) {
    console.warn("[diarizationWorker] WebGPU unavailable, falling back to WASM", error);
    modelLoaded = await AutoModel.from_pretrained(desired, {
      device: "wasm",
      progress_callback: progressCallback
    });
    activeDevice = "wasm";
    send(jobId, { type: "engine", device: "wasm" });
  }
  modelPromise = Promise.resolve(modelLoaded);

  // The feature extractor (preprocessor_config.json) is part of the same
  // model repo on HF; from_pretrained pulls it from the same cache.
  processorPromise = AutoProcessor.from_pretrained(desired, {
    progress_callback: progressCallback
  });
  await processorPromise;
  return { model: modelLoaded, processor: await processorPromise };
}

async function embedAudio(pcm) {
  const processor = await processorPromise;
  const model = await modelPromise;
  if (!processor || !model) {
    throw new Error("Speaker-embed pipeline not initialized");
  }
  // WavLM expects 16 kHz mono Float32. Caller is responsible for resampling.
  const inputs = await processor(pcm, { sampling_rate: 16000 });
  const output = await model(inputs);
  // WavLMForXVector returns an "embeddings" tensor of shape [1, 512].
  const tensor = output.embeddings || output.last_hidden_state || output[0];
  if (!tensor || !tensor.data) {
    throw new Error("Speaker-embed model returned no embedding tensor");
  }
  // Copy out as a plain Float32Array so we can transfer ownership.
  return new Float32Array(tensor.data);
}

function send(jobId, payload) {
  self.postMessage({ jobId, ...payload });
}

function sendError(jobId, error) {
  console.error("[diarizationWorker]", error);
  self.postMessage({
    type: "error",
    jobId,
    error: String(error?.message || error)
  });
}
