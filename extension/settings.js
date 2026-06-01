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
import { isAvailable as browserAiAvailable } from "./lib/browserAi.js";

const modelSelect = document.getElementById("model-select");
const engineStateEl = document.getElementById("engine-state");
const cacheStateEl = document.getElementById("cache-state");
const progressWrap = document.getElementById("model-progress-wrap");
const progressFill = document.getElementById("model-progress-fill");
const progressText = document.getElementById("model-progress-text");
const downloadButton = document.getElementById("download-model-btn");
const clearCacheButton = document.getElementById("clear-cache-btn");
const toastEl = document.getElementById("toast");

let activeWorker = null;

init().catch((error) => showToast(`Error: ${error?.message || error}`, "error"));

async function init() {
  buildModelOptions(WHISPER_MODELS, await getSelectedModelId());

  detectEngineCapability().then((label) => {
    engineStateEl.textContent = label;
    if (label === "WebGPU available") engineStateEl.classList.add("is-positive");
  });

  await refreshCacheState();

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
      await refreshCacheState();
      showToast(`Selected ${findModel(modelSelect.value)?.label || modelSelect.value}`, "success");
    } catch (error) {
      showToast(`Error: ${error?.message || error}`, "error");
    }
  });

  downloadButton.addEventListener("click", onWarmupModel);
  clearCacheButton.addEventListener("click", onClearCache);

  refreshBrowserAiState().catch(() => {});
}

async function refreshBrowserAiState() {
  const stateEl = document.getElementById("browser-ai-state");
  const helpEl = document.getElementById("browser-ai-help");
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
}

function buildModelOptions(models, current) {
  modelSelect.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = current && findModel(current) ? current : DEFAULT_WHISPER_MODEL_ID;
}

async function refreshCacheState() {
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

async function onWarmupModel() {
  if (activeWorker) {
    showToast("A warmup is already running.", "info");
    return;
  }
  const modelId = modelSelect.value;
  console.log("[settings] starting warmup", { modelId });
  downloadButton.disabled = true;
  downloadButton.textContent = "Downloading...";
  clearCacheButton.disabled = true;
  progressWrap.classList.remove("hidden");
  setProgress(0, "Spawning worker...");
  showToast(`Loading ${modelId}...`, "info");

  const workerUrl = chrome.runtime.getURL("lib/whisperWorker.js");
  let worker;
  try {
    worker = new Worker(workerUrl, { type: "module" });
  } catch (error) {
    console.error("[settings] worker construction failed", error);
    showToast(`Failed to spawn worker: ${error?.message || error}`, "error");
    finishWarmup({ ok: false });
    return;
  }
  activeWorker = worker;
  const jobId = "warmup-" + Math.random().toString(36).slice(2, 10);

  // Some module-worker errors during top-level evaluation never reach
  // worker.onerror in Chrome. Set a watchdog: if we don't receive any
  // message in 30s, assume the worker failed silently and surface it.
  const watchdog = setTimeout(() => {
    if (activeWorker !== worker) return;
    console.error("[settings] worker startup timeout (30s with no messages)");
    showToast("Worker didn't respond after 30s — check DevTools console for module load errors.", "error");
    finishWarmup({ ok: false });
  }, 30_000);
  let receivedAnyMessage = false;

  worker.onmessage = (event) => {
    const data = event.data || {};
    receivedAnyMessage = true;
    clearTimeout(watchdog);
    console.log("[settings] worker message", data);
    if (data.type === "worker-booting") {
      setProgress(0, "Worker starting (loading transformers.js bundle)...");
      return;
    }
    if (data.type === "worker-ready") {
      setProgress(0, "Worker ready, sending warmup...");
      worker.postMessage({ type: "warmup", jobId, modelId });
      return;
    }
    if (data.type === "worker-import-error") {
      showToast(`Library load failed: ${data.error}`, "error");
      console.error("[settings] worker import error", data);
      finishWarmup({ ok: false });
      return;
    }
    if (data.jobId && data.jobId !== jobId) return;
    if (data.type === "downloadProgress") {
      const pct = data.progress || (data.total ? data.loaded / data.total : 0);
      setProgress(pct / 100,
        `${data.file || "model"}: ${formatModelSize(data.loaded)} / ${formatModelSize(data.total)}`);
    } else if (data.type === "stage") {
      progressText.textContent = data.stage;
    } else if (data.type === "engine") {
      engineStateEl.textContent = data.device === "webgpu" ? "WebGPU active" : "WASM CPU";
      if (data.device === "webgpu") engineStateEl.classList.add("is-positive");
    } else if (data.type === "done") {
      finishWarmup({ ok: true });
    } else if (data.type === "error") {
      showToast(`Warmup failed: ${data.error}`, "error");
      finishWarmup({ ok: false });
    }
  };
  worker.onerror = (event) => {
    const detail = [
      event.message,
      event.filename ? `at ${event.filename}${event.lineno != null ? ":" + event.lineno : ""}` : null,
      event.error?.message && event.error.message !== event.message ? `(${event.error.message})` : null,
      event.error?.stack ? event.error.stack.split("\n")[0] : null
    ].filter(Boolean).join(" ");
    console.error("[settings] worker error", event);
    showToast(`Worker error: ${detail || "no details from runtime (check DevTools console)"}`, "error");
    finishWarmup({ ok: false });
  };
  worker.onmessageerror = (event) => {
    console.error("[settings] worker message error", event);
    showToast("Worker message error (postMessage cloning failed)", "error");
    finishWarmup({ ok: false });
  };

  // The worker now self-initiates the warmup once it sends "worker-ready".
  // We don't post anything here so the import has time to finish first.
}

function finishWarmup({ ok }) {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
  downloadButton.disabled = false;
  downloadButton.textContent = "Download / Warm Up Model";
  clearCacheButton.disabled = false;
  progressWrap.classList.add("hidden");
  setProgress(0, "");
  if (ok) showToast("Model ready.", "success");
  refreshCacheState().catch(() => {});
}

async function onClearCache() {
  if (!confirm("Clear the cached transcription model? You'll re-download on next use.")) return;
  try {
    if ("caches" in self) {
      await caches.delete("transformers-cache");
    }
    showToast("Model cache cleared.", "success");
  } catch (error) {
    showToast(`Clear failed: ${error?.message || error}`, "error");
  }
  await refreshCacheState();
}

function setProgress(fraction, text) {
  progressFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  progressText.textContent = text;
}

function showToast(message, type = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 3000);
}
