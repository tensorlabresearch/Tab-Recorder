// Configuration for the Transformers.js whisper pipeline. The actual model
// bytes are fetched and cached by transformers.js itself (browser Cache API);
// this module just persists the user's chosen variant and reports state.

const MODEL_SETTING_KEY = "whisperModelId";
const AUTO_TRANSCRIBE_KEY = "autoTranscribeOnStop";

export const WHISPER_MODELS = [
  {
    id: "Xenova/whisper-tiny.en",
    label: "Tiny (English) — ~40 MB, fastest",
    approxBytes: 40 * 1024 * 1024
  },
  {
    id: "Xenova/whisper-base.en",
    label: "Base (English) — ~80 MB, balanced",
    approxBytes: 80 * 1024 * 1024
  },
  {
    id: "Xenova/whisper-small.en",
    label: "Small (English) — ~250 MB, slower / more accurate",
    approxBytes: 250 * 1024 * 1024
  },
  {
    id: "Xenova/whisper-base",
    label: "Base (multilingual) — ~80 MB",
    approxBytes: 80 * 1024 * 1024
  }
];

export const DEFAULT_WHISPER_MODEL_ID = "Xenova/whisper-small.en";

export function findModel(id) {
  return WHISPER_MODELS.find((m) => m.id === id) || null;
}

export async function getSelectedModelId() {
  try {
    const result = await chrome.storage.local.get(MODEL_SETTING_KEY);
    const id = result?.[MODEL_SETTING_KEY];
    if (id && findModel(id)) return id;
  } catch (_) {}
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

export async function getAutoTranscribePreference() {
  try {
    const result = await chrome.storage.local.get(AUTO_TRANSCRIBE_KEY);
    return result?.[AUTO_TRANSCRIBE_KEY] === true;
  } catch (_) {
    return false;
  }
}

export async function setAutoTranscribePreference(enabled) {
  await chrome.storage.local.set({ [AUTO_TRANSCRIBE_KEY]: !!enabled });
}

export function formatModelSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}
