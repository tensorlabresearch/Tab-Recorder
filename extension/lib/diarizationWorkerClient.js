// Thin Promise-friendly client over diarizationWorker.js. Spawns the
// worker, waits for `worker-ready`, then exposes embed(slice) and
// terminate(). Each embed call posts a unique jobId and resolves on the
// matching `done` reply; mismatched / out-of-order replies are ignored.
//
// Lifecycle:
//   const client = await openDiarizationWorker({ modelId, onStage, ... });
//   try {
//     for (const slice of slices) {
//       const emb = await client.embed(slice);
//       ...
//     }
//   } finally {
//     client.terminate();
//   }

export async function openDiarizationWorker({
  modelId,
  onStage,
  onDownloadProgress,
  onEngine
} = {}) {
  const workerUrl = chrome.runtime.getURL("lib/diarizationWorker.js");
  const worker = new Worker(workerUrl, { type: "module" });

  // Pending embed jobs, keyed by jobId.
  const pending = new Map();
  let activeDevice = null;
  let terminated = false;

  const readyPromise = new Promise((resolve, reject) => {
    const handlers = {
      "worker-booting": () => {
        try { onStage?.("Diarization worker starting"); } catch (_) {}
      },
      "worker-ready": () => {
        try { onStage?.("Worker ready"); } catch (_) {}
        resolve();
      },
      "worker-import-error": (data) => {
        reject(new Error(`Diarization library load failed: ${data.error}`));
      }
    };

    worker.onmessage = (event) => {
      const data = event.data || {};
      const handler = handlers[data.type];
      if (handler) {
        handler(data);
        return;
      }
      // Per-job traffic.
      if (data.type === "stage") {
        try { onStage?.(data.stage); } catch (_) {}
        return;
      }
      if (data.type === "downloadProgress") {
        try { onDownloadProgress?.(data); } catch (_) {}
        return;
      }
      if (data.type === "engine") {
        activeDevice = data.device || null;
        try { onEngine?.(activeDevice); } catch (_) {}
        return;
      }
      if (data.type === "done" && data.jobId) {
        const job = pending.get(data.jobId);
        if (job) {
          pending.delete(data.jobId);
          job.resolve(data.embedding ? new Float32Array(data.embedding) : null);
        }
        return;
      }
      if (data.type === "error" && data.jobId) {
        const job = pending.get(data.jobId);
        if (job) {
          pending.delete(data.jobId);
          job.reject(new Error(data.error || "Embedding failed"));
        }
        return;
      }
    };

    worker.onerror = (event) => {
      const detail = [
        event.message,
        event.filename ? `at ${event.filename}:${event.lineno}` : null
      ].filter(Boolean).join(" ");
      const err = new Error(detail || "Diarization worker error");
      reject(err);
      for (const job of pending.values()) job.reject(err);
      pending.clear();
    };

    // 30s watchdog: same pattern as the Whisper warmup path.
    setTimeout(() => {
      if (terminated) return;
      reject(new Error("Diarization worker did not respond after 30s"));
    }, 30_000);
  });

  await readyPromise;

  // Send the warmup so the model loads + processor initializes once,
  // before per-utterance embedding starts. The watchdog above only
  // guards the import; loading the model from cache can take a few
  // seconds and we surface that via onStage instead of timing out.
  await new Promise((resolve, reject) => {
    const jobId = makeJobId("warmup");
    pending.set(jobId, { resolve, reject });
    worker.postMessage({ type: "warmup", jobId, modelId });
  });

  return {
    get device() {
      return activeDevice;
    },
    embed(pcm) {
      if (terminated) return Promise.reject(new Error("Worker terminated"));
      if (!(pcm instanceof Float32Array)) {
        return Promise.reject(new Error("embed() requires a Float32Array"));
      }
      return new Promise((resolve, reject) => {
        const jobId = makeJobId("embed");
        pending.set(jobId, { resolve, reject });
        // Transfer the buffer to avoid copying large PCM through structured clone.
        const copy = new Float32Array(pcm);
        worker.postMessage({ type: "embed", jobId, modelId, pcm: copy }, [copy.buffer]);
      });
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      worker.terminate();
      const err = new Error("Worker terminated");
      for (const job of pending.values()) job.reject(err);
      pending.clear();
    }
  };
}

function makeJobId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
