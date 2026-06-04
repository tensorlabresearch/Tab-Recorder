import {
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL_ID,
  getSelectedModelId,
  setSelectedModelId,
  isModelCached,
  findModel,
  formatModelSize,
  getAutoTranscribePreference,
  setAutoTranscribePreference
} from "./lib/whisperModel.js";
import {
  isAvailable as browserAiAvailable,
  getAutoSummarizePreference,
  setAutoSummarizePreference
} from "./lib/browserAi.js";
import {
  SPEAKER_EMBED_MODELS,
  DEFAULT_SPEAKER_EMBED_MODEL_ID,
  getSelectedSpeakerEmbedModelId,
  setSelectedSpeakerEmbedModelId,
  isSpeakerEmbedModelCached,
  findSpeakerEmbedModel,
  getAutoDiarizePreference,
  setAutoDiarizePreference
} from "./lib/speakerEmbedModel.js";

const modelSelect = document.getElementById("model-select");
const engineStateEl = document.getElementById("engine-state");
const cacheStateEl = document.getElementById("cache-state");
const progressWrap = document.getElementById("model-progress-wrap");
const progressFill = document.getElementById("model-progress-fill");
const progressText = document.getElementById("model-progress-text");
const downloadButton = document.getElementById("download-model-btn");
const clearCacheButton = document.getElementById("clear-cache-btn");
const toastEl = document.getElementById("toast");

const speakerModelSelect = document.getElementById("speaker-model-select");
const speakerEngineStateEl = document.getElementById("speaker-engine-state");
const speakerCacheStateEl = document.getElementById("speaker-cache-state");
const speakerProgressWrap = document.getElementById("speaker-progress-wrap");
const speakerProgressFill = document.getElementById("speaker-progress-fill");
const speakerProgressText = document.getElementById("speaker-progress-text");
const speakerDownloadButton = document.getElementById("speaker-download-btn");
const speakerClearButton = document.getElementById("speaker-clear-btn");

init().catch((error) => showToast(`Error: ${error?.message || error}`, "error"));

async function init() {
  buildSelectOptions(modelSelect, WHISPER_MODELS, await getSelectedModelId(), DEFAULT_WHISPER_MODEL_ID);
  buildSelectOptions(
    speakerModelSelect,
    SPEAKER_EMBED_MODELS,
    await getSelectedSpeakerEmbedModelId(),
    DEFAULT_SPEAKER_EMBED_MODEL_ID
  );

  detectEngineCapability().then((label) => {
    engineStateEl.textContent = label;
    speakerEngineStateEl.textContent = label;
    if (label === "WebGPU available") {
      engineStateEl.classList.add("is-positive");
      speakerEngineStateEl.classList.add("is-positive");
    }
  });

  await refreshWhisperCacheState();
  await refreshSpeakerCacheState();

  const autoTranscribeToggle = document.getElementById("auto-transcribe-toggle");
  if (autoTranscribeToggle) {
    autoTranscribeToggle.checked = await getAutoTranscribePreference();
    autoTranscribeToggle.addEventListener("change", async () => {
      try {
        await setAutoTranscribePreference(autoTranscribeToggle.checked);
        showToast(
          autoTranscribeToggle.checked
            ? "Auto-transcribe enabled"
            : "Auto-transcribe disabled",
          "success"
        );
      } catch (error) {
        showToast(`Error: ${error?.message || error}`, "error");
      }
    });
  }

  modelSelect.addEventListener("change", async () => {
    try {
      await setSelectedModelId(modelSelect.value);
      await refreshWhisperCacheState();
      showToast(`Selected ${findModel(modelSelect.value)?.label || modelSelect.value}`, "success");
    } catch (error) {
      showToast(`Error: ${error?.message || error}`, "error");
    }
  });

  speakerModelSelect.addEventListener("change", async () => {
    try {
      await setSelectedSpeakerEmbedModelId(speakerModelSelect.value);
      await refreshSpeakerCacheState();
      showToast(
        `Selected ${findSpeakerEmbedModel(speakerModelSelect.value)?.label || speakerModelSelect.value}`,
        "success"
      );
    } catch (error) {
      showToast(`Error: ${error?.message || error}`, "error");
    }
  });

  downloadButton.addEventListener("click", () => runWarmup(whisperWarmupConfig()));
  clearCacheButton.addEventListener("click", () => clearTransformersCache({
    refresh: () => Promise.all([refreshWhisperCacheState(), refreshSpeakerCacheState()])
  }));

  speakerDownloadButton.addEventListener("click", () => runWarmup(speakerWarmupConfig()));
  speakerClearButton.addEventListener("click", () => clearTransformersCache({
    refresh: () => Promise.all([refreshWhisperCacheState(), refreshSpeakerCacheState()])
  }));

  refreshBrowserAiState().catch(() => {});
}

async function refreshBrowserAiState() {
  const stateEl = document.getElementById("browser-ai-state");
  const helpEl = document.getElementById("browser-ai-help");
  const autoToggle = document.getElementById("auto-summarize-toggle");
  if (!stateEl) return;
  const available = await browserAiAvailable();
  if (available) {
    stateEl.textContent = "Available (Gemini Nano detected)";
    stateEl.classList.add("is-positive");
    if (helpEl) helpEl.classList.add("hidden");
  } else {
    stateEl.textContent = "Not detected on this device";
    stateEl.classList.remove("is-positive");
    if (helpEl) helpEl.classList.remove("hidden");
  }
  if (autoToggle) {
    autoToggle.disabled = !available;
    autoToggle.checked = available ? await getAutoSummarizePreference() : false;
    if (!autoToggle.dataset.bound) {
      autoToggle.dataset.bound = "1";
      autoToggle.addEventListener("change", async () => {
        try {
          await setAutoSummarizePreference(autoToggle.checked);
          showToast(
            autoToggle.checked
              ? "Auto-summarize enabled"
              : "Auto-summarize disabled",
            "success"
          );
        } catch (error) {
          showToast(`Error: ${error?.message || error}`, "error");
        }
      });
    }
  }
}

function buildSelectOptions(selectEl, models, current, fallback) {
  selectEl.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    selectEl.appendChild(opt);
  }
  const valid = models.some((m) => m.id === current);
  selectEl.value = valid ? current : fallback;
}

async function refreshWhisperCacheState() {
  const id = modelSelect.value;
  const model = findModel(id);
  const cached = await isModelCached(id);
  if (cached) {
    cacheStateEl.textContent = `Cached (${formatModelSize(model?.approxBytes)})`;
    cacheStateEl.classList.add("is-positive");
  } else {
    cacheStateEl.textContent = `Not downloaded (~${formatModelSize(model?.approxBytes)})`;
    cacheStateEl.classList.remove("is-positive");
  }
}

async function refreshSpeakerCacheState() {
  const id = speakerModelSelect.value;
  const model = findSpeakerEmbedModel(id);
  const cached = await isSpeakerEmbedModelCached(id);
  if (cached) {
    speakerCacheStateEl.textContent = `Cached (${formatModelSize(model?.approxBytes)})`;
    speakerCacheStateEl.classList.add("is-positive");
  } else {
    speakerCacheStateEl.textContent = `Not downloaded (~${formatModelSize(model?.approxBytes)})`;
    speakerCacheStateEl.classList.remove("is-positive");
  }
  // Auto-diarize toggle is only meaningful once the model is cached —
  // otherwise we'd silently trigger a 95 MB download mid-transcription.
  const autoToggle = document.getElementById("auto-diarize-toggle");
  if (autoToggle) {
    autoToggle.disabled = !cached;
    autoToggle.checked = cached ? await getAutoDiarizePreference() : false;
    if (!autoToggle.dataset.bound) {
      autoToggle.dataset.bound = "1";
      autoToggle.addEventListener("change", async () => {
        try {
          await setAutoDiarizePreference(autoToggle.checked);
          showToast(
            autoToggle.checked ? "Auto-diarize enabled" : "Auto-diarize disabled",
            "success"
          );
        } catch (error) {
          showToast(`Error: ${error?.message || error}`, "error");
        }
      });
    }
  }
}

async function detectEngineCapability() {
  if (!("gpu" in navigator)) return "WASM CPU (no WebGPU)";
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) return "WebGPU available";
    return "WASM CPU (WebGPU adapter unavailable)";
  } catch (_) {
    return "WASM CPU (WebGPU adapter unavailable)";
  }
}

function whisperWarmupConfig() {
  return {
    label: "Whisper",
    workerPath: "lib/whisperWorker.js",
    getModelId: () => modelSelect.value,
    engineStateEl,
    progressWrap,
    progressFill,
    progressText,
    downloadButton,
    clearButton: clearCacheButton,
    refresh: refreshWhisperCacheState
  };
}

function speakerWarmupConfig() {
  return {
    label: "Speaker model",
    workerPath: "lib/diarizationWorker.js",
    getModelId: () => speakerModelSelect.value,
    engineStateEl: speakerEngineStateEl,
    progressWrap: speakerProgressWrap,
    progressFill: speakerProgressFill,
    progressText: speakerProgressText,
    downloadButton: speakerDownloadButton,
    clearButton: speakerClearButton,
    refresh: refreshSpeakerCacheState
  };
}

const activeWorkers = new Map();

async function runWarmup(cfg) {
  if (activeWorkers.has(cfg.workerPath)) {
    showToast(`A ${cfg.label} warmup is already running.`, "info");
    return;
  }
  const modelId = cfg.getModelId();
  console.log(`[settings] starting ${cfg.label} warmup`, { modelId });
  cfg.downloadButton.disabled = true;
  cfg.downloadButton.textContent = "Downloading...";
  cfg.clearButton.disabled = true;
  cfg.progressWrap.classList.remove("hidden");
  setProgress(cfg, 0, "Spawning worker...");
  showToast(`Loading ${modelId}...`, "info");

  const workerUrl = chrome.runtime.getURL(cfg.workerPath);
  let worker;
  try {
    worker = new Worker(workerUrl, { type: "module" });
  } catch (error) {
    console.error(`[settings] ${cfg.label} worker construction failed`, error);
    showToast(`Failed to spawn worker: ${error?.message || error}`, "error");
    finishWarmup(cfg, worker, { ok: false });
    return;
  }
  activeWorkers.set(cfg.workerPath, worker);
  const jobId = "warmup-" + Math.random().toString(36).slice(2, 10);

  // Some module-worker errors during top-level evaluation never reach
  // worker.onerror in Chrome. Set a watchdog: if we don't receive any
  // message in 30s, assume the worker failed silently and surface it.
  const watchdog = setTimeout(() => {
    if (activeWorkers.get(cfg.workerPath) !== worker) return;
    console.error(`[settings] ${cfg.label} worker startup timeout (30s with no messages)`);
    showToast(
      `Worker didn't respond after 30s — check DevTools console for module load errors.`,
      "error"
    );
    finishWarmup(cfg, worker, { ok: false });
  }, 30_000);

  worker.onmessage = (event) => {
    const data = event.data || {};
    clearTimeout(watchdog);
    console.log(`[settings] ${cfg.label} worker message`, data);
    if (data.type === "worker-booting") {
      setProgress(cfg, 0, "Worker starting (loading transformers.js bundle)...");
      return;
    }
    if (data.type === "worker-ready") {
      setProgress(cfg, 0, "Worker ready, sending warmup...");
      worker.postMessage({ type: "warmup", jobId, modelId });
      return;
    }
    if (data.type === "worker-import-error") {
      showToast(`Library load failed: ${data.error}`, "error");
      console.error(`[settings] ${cfg.label} worker import error`, data);
      finishWarmup(cfg, worker, { ok: false });
      return;
    }
    if (data.jobId && data.jobId !== jobId) return;
    if (data.type === "downloadProgress") {
      const pct = data.progress || (data.total ? data.loaded / data.total : 0);
      setProgress(
        cfg,
        pct / 100,
        `${data.file || "model"}: ${formatModelSize(data.loaded)} / ${formatModelSize(data.total)}`
      );
    } else if (data.type === "stage") {
      cfg.progressText.textContent = data.stage;
    } else if (data.type === "engine") {
      cfg.engineStateEl.textContent = data.device === "webgpu" ? "WebGPU active" : "WASM CPU";
      if (data.device === "webgpu") cfg.engineStateEl.classList.add("is-positive");
    } else if (data.type === "done") {
      finishWarmup(cfg, worker, { ok: true });
    } else if (data.type === "error") {
      showToast(`Warmup failed: ${data.error}`, "error");
      finishWarmup(cfg, worker, { ok: false });
    }
  };
  worker.onerror = (event) => {
    const detail = [
      event.message,
      event.filename ? `at ${event.filename}${event.lineno != null ? ":" + event.lineno : ""}` : null,
      event.error?.message && event.error.message !== event.message ? `(${event.error.message})` : null,
      event.error?.stack ? event.error.stack.split("\n")[0] : null
    ].filter(Boolean).join(" ");
    console.error(`[settings] ${cfg.label} worker error`, event);
    showToast(`Worker error: ${detail || "no details from runtime (check DevTools console)"}`, "error");
    finishWarmup(cfg, worker, { ok: false });
  };
  worker.onmessageerror = (event) => {
    console.error(`[settings] ${cfg.label} worker message error`, event);
    showToast("Worker message error (postMessage cloning failed)", "error");
    finishWarmup(cfg, worker, { ok: false });
  };

  // The worker self-initiates the warmup once it sends "worker-ready".
}

function finishWarmup(cfg, worker, { ok }) {
  if (worker) worker.terminate();
  if (activeWorkers.get(cfg.workerPath) === worker) {
    activeWorkers.delete(cfg.workerPath);
  }
  cfg.downloadButton.disabled = false;
  cfg.downloadButton.textContent = "Download / Warm Up Model";
  cfg.clearButton.disabled = false;
  cfg.progressWrap.classList.add("hidden");
  setProgress(cfg, 0, "");
  if (ok) showToast(`${cfg.label} ready.`, "success");
  cfg.refresh().catch(() => {});
}

async function clearTransformersCache({ refresh }) {
  if (!confirm("Clear the cached transcription + speaker-detection models? You'll re-download on next use.")) return;
  try {
    if ("caches" in self) {
      await caches.delete("transformers-cache");
    }
    showToast("Model cache cleared.", "success");
  } catch (error) {
    showToast(`Clear failed: ${error?.message || error}`, "error");
  }
  await refresh();
}

function setProgress(cfg, fraction, text) {
  cfg.progressFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  cfg.progressText.textContent = text;
}

function showToast(message, type = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 3000);
}
