// Configuration for the Transformers.js whisper pipeline. The actual model
// bytes are fetched and cached by transformers.js itself (browser Cache API);
// this module just persists the user's chosen variant and reports state.

const MODEL_SETTING_KEY = "whisperModelId";
const AUTO_TRANSCRIBE_KEY = "autoTranscribeOnStop";
const MODEL_CONSENT_KEY = "modelDownloadConsent";

// Sizes are the actual bytes fetched for the dtype combination we run.
//
// Whisper encoders are very sensitive to quantization while decoders tolerate
// it well, so the preferred combination everywhere is a full-precision encoder
// with a 4-bit decoder - the pairing the transformers.js WebGPU examples use.
// `dtypes` is an ordered fallback list: if a model's preferred export fails to
// build a session, the next entry is tried before giving up.
const HYBRID_DTYPES = [{ encoder_model: "fp32", decoder_model_merged: "q4" }, "fp32"];

export const WHISPER_MODELS = [
  {
    id: "onnx-community/distil-small.en",
    label: "Distil Small (English) - ~540 MB, recommended",
    approxBytes: 538 * 1024 * 1024,
    dtypes: HYBRID_DTYPES
  },
  {
    id: "Xenova/whisper-tiny.en",
    label: "Tiny (English) - ~120 MB, fastest, least accurate",
    approxBytes: 120 * 1024 * 1024,
    dtypes: HYBRID_DTYPES
  },
  {
    id: "Xenova/whisper-base.en",
    label: "Base (English) - ~210 MB, small download",
    approxBytes: 206 * 1024 * 1024,
    dtypes: HYBRID_DTYPES
  },
  {
    id: "Xenova/whisper-small.en",
    label: "Small (English) - ~590 MB, accurate but slower",
    approxBytes: 586 * 1024 * 1024,
    dtypes: HYBRID_DTYPES
  },
  {
    id: "Xenova/whisper-base",
    label: "Base (multilingual) - ~210 MB",
    approxBytes: 206 * 1024 * 1024,
    dtypes: HYBRID_DTYPES
  },
  {
    id: "onnx-community/whisper-large-v3-turbo",
    label: "Large v3 Turbo (multilingual) - ~760 MB, most accurate",
    approxBytes: 759 * 1024 * 1024,
    // This encoder is 2.5 GB at full precision, so there is no fp32 rung to
    // fall back to; quantized is the only practical way to run it in a browser.
    dtypes: [
      { encoder_model: "q4", decoder_model_merged: "q4" },
      { encoder_model: "fp16", decoder_model_merged: "q4" }
    ]
  }
];

// Distil-small.en keeps whisper-small's encoder but has two decoder layers
// instead of twelve: roughly 5-6x faster decoding, within about 1% WER, and a
// smaller download. For English meeting audio it beats whisper-small.en on
// every axis that matters here.
export const DEFAULT_WHISPER_MODEL_ID = "onnx-community/distil-small.en";

export function findModel(id) {
  return WHISPER_MODELS.find((m) => m.id === id) || null;
}

/** Ordered dtype attempts for a model id, usable straight from the worker. */
export function modelDtypes(id) {
  return findModel(id)?.dtypes || HYBRID_DTYPES;
}

export async function getSelectedModelId() {
  try {
    const result = await chrome.storage.local.get(MODEL_SETTING_KEY);
    const id = result?.[MODEL_SETTING_KEY];
    if (id && findModel(id)) return id;
  } catch (_) {}
  return DEFAULT_WHISPER_MODEL_ID;
}

/**
 * The model to actually use. An explicit choice always wins. Otherwise prefer a
 * model whose weights are already cached, so bumping the default never forces
 * an existing user into a fresh multi-hundred-megabyte download.
 */
export async function resolveModelId() {
  try {
    const result = await chrome.storage.local.get(MODEL_SETTING_KEY);
    const id = result?.[MODEL_SETTING_KEY];
    if (id && findModel(id)) return id;
  } catch (_) {}

  if (await isModelCached(DEFAULT_WHISPER_MODEL_ID).catch(() => false)) {
    return DEFAULT_WHISPER_MODEL_ID;
  }
  for (const model of WHISPER_MODELS) {
    if (await isModelCached(model.id).catch(() => false)) return model.id;
  }
  return DEFAULT_WHISPER_MODEL_ID;
}

export async function setSelectedModelId(id) {
  if (!findModel(id)) throw new Error(`Unknown whisper model: ${id}`);
  await chrome.storage.local.set({ [MODEL_SETTING_KEY]: id });
}

export async function isModelCached(id) {
  // Transformers.js stores model artifacts in the browser's Cache API under
  // the "transformers-cache" namespace. Any successfully loaded entry for
  // the model id implies a prior download.
  if (!("caches" in globalThis)) return false;
  try {
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    const needle = encodeURIComponent(id).toLowerCase().replace(/%2f/g, "/");
    return keys.some((req) => req.url.toLowerCase().includes(needle));
  } catch (_) {
    return false;
  }
}

// Auto-transcribe is ON unless the user has explicitly turned it off. A
// recording that silently produces no transcript until you find a settings
// toggle is the worst version of this feature; the model downloads on demand,
// so there is nothing to set up first.
export async function getAutoTranscribePreference() {
  try {
    const result = await chrome.storage.local.get(AUTO_TRANSCRIBE_KEY);
    return result?.[AUTO_TRANSCRIBE_KEY] !== false;
  } catch (_) {
    return true;
  }
}

export async function setAutoTranscribePreference(enabled) {
  await chrome.storage.local.set({ [AUTO_TRANSCRIBE_KEY]: !!enabled });
}

/**
 * One-time consent for letting Tab Recorder pull down model weights on its own.
 * Recorded per model id, so switching to a much larger model asks again rather
 * than silently starting a bigger download.
 *
 * @returns {Promise<"granted"|"declined"|"unset">}
 */
export async function getModelDownloadConsent(modelId) {
  try {
    const result = await chrome.storage.local.get(MODEL_CONSENT_KEY);
    const stored = result?.[MODEL_CONSENT_KEY];
    if (!stored || typeof stored !== "object") return "unset";
    if (modelId && stored.modelId && stored.modelId !== modelId) return "unset";
    if (stored.granted === true) return "granted";
    if (stored.granted === false) return "declined";
    return "unset";
  } catch (_) {
    return "unset";
  }
}

export async function setModelDownloadConsent(modelId, granted) {
  await chrome.storage.local.set({
    [MODEL_CONSENT_KEY]: { modelId: String(modelId || ""), granted: !!granted, at: Date.now() }
  });
}

export function formatModelSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}
