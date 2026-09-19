/**
 * Client side of the whisper worker: message plumbing, a liveness watchdog and
 * recovery from a wedged or crashed session.
 *
 * This lives apart from panel.js because none of it touches the DOM - it talks
 * to a Worker and reports progress through callbacks - and because the
 * watchdog rules are worth testing directly.
 */

import { DEFAULT_WHISPER_MODEL_ID, modelDtypes } from "./whisperModel.js";

export function formatWorkerErrorEvent(event) {
  if (!event) return "";
  const parts = [];
  if (event.message) parts.push(event.message);
  if (event.filename) parts.push(`at ${event.filename}${event.lineno != null ? ":" + event.lineno : ""}${event.colno != null ? ":" + event.colno : ""}`);
  if (event.error?.message && event.error.message !== event.message) {
    parts.push(`(${event.error.message})`);
  }
  if (event.error?.stack) parts.push(event.error.stack.split("\n")[0]);
  return parts.join(" ");
}

// A wedged ONNX session (most often a WebGPU device that was lost while the
// machine slept) leaves `transcriber(...)` awaiting GPU work that never
// completes and never throws, so without a watchdog a single bad chunk hangs
// the whole job queue indefinitely. The worker heartbeats on every decode step,
// which lets us treat silence as a stall rather than as slowness.
const WHISPER_LOAD_STALL_MS = 10 * 60 * 1000;
const WHISPER_GENERATION_STALL_MS = 3 * 60 * 1000;
const WHISPER_WATCHDOG_TICK_MS = 5000;
// Backstop for the case where the library never invokes callback_function, so
// there is no per-step liveness signal at all: cap a chunk at a generous
// multiple of its own audio length instead of letting it run forever.
const WHISPER_CHUNK_BUDGET_FLOOR_MS = 20 * 60 * 1000;
const WHISPER_CHUNK_BUDGET_REALTIME_FACTOR = 10;

export function whisperChunkBudgetMs(audioMs) {
  const audio = Number(audioMs);
  if (!Number.isFinite(audio) || audio <= 0) return WHISPER_CHUNK_BUDGET_FLOOR_MS;
  return Math.max(WHISPER_CHUNK_BUDGET_FLOOR_MS, audio * WHISPER_CHUNK_BUDGET_REALTIME_FACTOR);
}

export function whisperError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isRecoverableWhisperError(error) {
  const code = error?.code;
  return code === "whisper-stalled" || code === "whisper-worker-error";
}

/**
 * Build the worker that runs transcription. Overridable so tests can drive the
 * client with a fake instead of a real module Worker.
 */
export function defaultWorkerFactory() {
  return new Worker(chrome.runtime.getURL("lib/whisperWorker.js"), { type: "module" });
}

export function createWhisperWorkerClient({
  modelId,
  onEngine,
  onDownloadProgress,
  device = null,
  createWorker = defaultWorkerFactory,
  loadStallMs = WHISPER_LOAD_STALL_MS,
  generationStallMs = WHISPER_GENERATION_STALL_MS
} = {}) {
  const worker = createWorker();
  const resolvedModelId = modelId || DEFAULT_WHISPER_MODEL_ID;
  let activeJob = null;
  let closed = false;
  let watchdogId = null;

  const stopWatchdog = () => {
    if (watchdogId == null) return;
    clearInterval(watchdogId);
    watchdogId = null;
  };

  const settleActive = (settle) => {
    stopWatchdog();
    if (!activeJob) return;
    const job = activeJob;
    activeJob = null;
    try { job.cleanup?.(); } catch (_) {}
    settle(job);
  };

  const rejectActive = (error) => settleActive((job) => job.reject(error));

  const touch = () => {
    if (activeJob) activeJob.lastActivityAt = Date.now();
  };

  const startWatchdog = () => {
    stopWatchdog();
    watchdogId = setInterval(() => {
      if (!activeJob) {
        stopWatchdog();
        return;
      }
      // Model load blocks the worker thread (so it cannot heartbeat) and is
      // allowed to be slow; generation must show a per-step pulse, but only
      // once the worker has proven it emits one.
      const now = Date.now();
      const idleMs = now - activeJob.lastActivityAt;
      const elapsedMs = now - activeJob.startedAt;
      const idleLimit =
        activeJob.generating && activeJob.sawStepHeartbeat ? generationStallMs : loadStallMs;
      const overBudget = activeJob.budgetMs > 0 && elapsedMs >= activeJob.budgetMs;
      if (idleMs < idleLimit && !overBudget) return;
      const engineName = device === "wasm" ? "CPU" : "GPU";
      const reason = overBudget
        ? `ran past its ${Math.round(activeJob.budgetMs / 60000)}m budget`
        : `stopped responding for ${Math.max(1, Math.round(idleMs / 60000))}m`;
      console.error("[panel] whisper worker stalled", {
        idleMs,
        elapsedMs,
        budgetMs: activeJob.budgetMs,
        generating: activeJob.generating,
        sawStepHeartbeat: activeJob.sawStepHeartbeat,
        device: device || "auto"
      });
      closed = true;
      worker.terminate();
      rejectActive(
        whisperError(`Whisper ${reason} on the ${engineName} engine.`, "whisper-stalled")
      );
    }, WHISPER_WATCHDOG_TICK_MS);
  };

  worker.onmessage = (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === "worker-import-error") {
      rejectActive(new Error(data.error || "Transformers.js import failed"));
      return;
    }
    if (!activeJob || data.jobId !== activeJob.jobId) return;
    touch();
    if (data.type === "heartbeat") {
      if (data.stepped) activeJob.sawStepHeartbeat = true;
      return;
    }
    if (data.type === "stage") {
      if (data.stage === "Transcribing") activeJob.generating = true;
      try { activeJob.onStage?.(data.stage); } catch (_) {}
      return;
    }
    if (data.type === "downloadProgress") {
      try { onDownloadProgress?.(data); } catch (_) {}
      return;
    }
    if (data.type === "engine") {
      try { onEngine?.(data.device); } catch (_) {}
      return;
    }
    if (data.type === "segment") {
      if (data.segment) {
        try { activeJob.onSegment?.(data.segment); } catch (_) {}
      }
      return;
    }
    if (data.type === "done") {
      const payload = {
        text: data.text || "",
        segments: data.segments || [],
        device: data.device || null
      };
      settleActive((job) => job.resolve(payload));
      return;
    }
    if (data.type === "error") {
      rejectActive(new Error(data.error || "Transcription failed"));
    }
  };
  worker.onerror = (event) => {
    const detail = formatWorkerErrorEvent(event);
    console.error("[panel] whisper worker errored", event);
    worker.terminate();
    closed = true;
    rejectActive(
      whisperError(detail || "Worker error (no details from runtime)", "whisper-worker-error")
    );
  };
  worker.onmessageerror = (event) => {
    console.error("[panel] whisper worker message error", event);
    worker.terminate();
    closed = true;
    rejectActive(
      whisperError("Worker message error (postMessage cloning failed)", "whisper-worker-error")
    );
  };

  return {
    get closed() {
      return closed;
    },
    transcribe(pcm16k, { onSegment, onStage, signal, budgetMs = 0 } = {}) {
      if (closed) return Promise.reject(new Error("Whisper worker is closed."));
      if (activeJob) return Promise.reject(new Error("Whisper worker already has an active job."));
      if (signal?.aborted) return Promise.reject(abortError());

      return new Promise((resolve, reject) => {
        const jobId = Math.random().toString(36).slice(2, 10);

        const onAbort = () => {
          closed = true;
          worker.terminate();
          rejectActive(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        activeJob = {
          jobId,
          resolve,
          reject,
          onSegment,
          onStage,
          generating: false,
          sawStepHeartbeat: false,
          budgetMs: Number(budgetMs) > 0 ? Number(budgetMs) : 0,
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          cleanup: () => signal?.removeEventListener("abort", onAbort)
        };

        // Always hand the worker its own copy: the buffer is transferred (and
        // therefore detached), and a stalled chunk has to be retriable from the
        // caller's PCM.
        const source = pcm16k instanceof Float32Array ? pcm16k : new Float32Array(pcm16k || []);
        const transferablePcm = new Float32Array(source);

        try {
          worker.postMessage(
            {
              type: "transcribe",
              jobId,
              modelId: resolvedModelId,
              dtypes: modelDtypes(resolvedModelId),
              device: device || undefined,
              pcm: transferablePcm,
              language: "english"
            },
            [transferablePcm.buffer]
          );
          startWatchdog();
        } catch (error) {
          settleActive((job) => job.reject(error));
        }
      });
    },
    terminate() {
      if (closed) return;
      closed = true;
      stopWatchdog();
      worker.terminate();
      rejectActive(new Error("Whisper worker terminated."));
    }
  };
}

/**
 * Owns a whisper worker across a multi-chunk transcription and recovers from a
 * wedged or crashed worker: the client is rebuilt and the chunk retried, with
 * the retry pinned to the CPU engine because a lost WebGPU device does not come
 * back within the same worker.
 */
export function createWhisperChunkRunner({
  modelId,
  onDownloadProgress,
  onEngine,
  onRecovery,
  createWorker = defaultWorkerFactory
} = {}) {
  let client = null;
  let forcedDevice = null;

  const ensureClient = () => {
    if (client && !client.closed) return client;
    client = createWhisperWorkerClient({
      modelId,
      onDownloadProgress,
      onEngine,
      device: forcedDevice,
      createWorker
    });
    return client;
  };

  return {
    get device() {
      return forcedDevice;
    },
    async transcribe(pcm16k, handlers = {}) {
      let lastError = null;
      // Two attempts: the original engine, then a fresh worker on CPU.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const current = ensureClient();
        try {
          return await current.transcribe(pcm16k, handlers);
        } catch (error) {
          lastError = error;
          if (handlers.signal?.aborted || !isRecoverableWhisperError(error) || attempt === 2) {
            throw error;
          }
          try { current.terminate(); } catch (_) {}
          client = null;
          forcedDevice = "wasm";
          console.warn("[panel] retrying chunk on CPU after whisper failure", error);
          try { onRecovery?.(error); } catch (_) {}
        }
      }
      throw lastError;
    },
    terminate() {
      try { client?.terminate(); } catch (_) {}
      client = null;
    }
  };
}

export function abortError() {
  const error = new Error("Cancelled.");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}
