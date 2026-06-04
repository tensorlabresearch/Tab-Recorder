// Configuration for the Transformers.js speaker-embedding pipeline. Mirrors
// the structure of whisperModel.js: this module just persists the user's
// chosen variant and reports state; the actual model bytes are fetched
// and cached by transformers.js itself (browser Cache API).

const MODEL_SETTING_KEY = "speakerEmbedModelId";
const AUTO_DIARIZE_KEY = "autoDiarizeOnTranscribe";
const SPEAKER_DETECTION_ENABLED_KEY = "speakerDetectionEnabled";

export const SPEAKER_EMBED_MODELS = [
  {
    id: "Xenova/wavlm-base-plus-sv",
    label: "WavLM Base+ (Speaker Verification) — ~95 MB",
    approxBytes: 95 * 1024 * 1024
  },
  {
    id: "Xenova/unispeech-sat-base-plus-sv",
    label: "UniSpeech-SAT Base+ (Speaker Verification) — ~95 MB",
    approxBytes: 95 * 1024 * 1024
  }
];

export const DEFAULT_SPEAKER_EMBED_MODEL_ID = "Xenova/wavlm-base-plus-sv";

export function findSpeakerEmbedModel(id) {
  return SPEAKER_EMBED_MODELS.find((m) => m.id === id) || null;
}

export async function getSelectedSpeakerEmbedModelId() {
  try {
    const result = await chrome.storage.local.get(MODEL_SETTING_KEY);
    const id = result?.[MODEL_SETTING_KEY];
    if (id && findSpeakerEmbedModel(id)) return id;
  } catch (_) {}
  return DEFAULT_SPEAKER_EMBED_MODEL_ID;
}

export async function setSelectedSpeakerEmbedModelId(id) {
  if (!findSpeakerEmbedModel(id)) {
    throw new Error(`Unknown speaker-embedding model: ${id}`);
  }
  await chrome.storage.local.set({ [MODEL_SETTING_KEY]: id });
}

// Master switch for the whole speaker-detection feature. Off by default:
// diarization pulls a ~95 MB model and adds an extra pass after every
// transcription, so it stays opt-in until the user enables it in Settings.
// When disabled, the panel hides the Diarize action and auto-diarize never
// fires regardless of the auto-diarize toggle.
export async function getSpeakerDetectionEnabled() {
  try {
    const result = await chrome.storage.local.get(SPEAKER_DETECTION_ENABLED_KEY);
    return result?.[SPEAKER_DETECTION_ENABLED_KEY] === true;
  } catch (_) {
    return false;
  }
}

export async function setSpeakerDetectionEnabled(enabled) {
  await chrome.storage.local.set({ [SPEAKER_DETECTION_ENABLED_KEY]: !!enabled });
}

export async function getAutoDiarizePreference() {
  try {
    const result = await chrome.storage.local.get(AUTO_DIARIZE_KEY);
    return result?.[AUTO_DIARIZE_KEY] === true;
  } catch (_) {
    return false;
  }
}

export async function setAutoDiarizePreference(enabled) {
  await chrome.storage.local.set({ [AUTO_DIARIZE_KEY]: !!enabled });
}

export async function isSpeakerEmbedModelCached(id) {
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
