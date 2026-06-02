// Thin wrapper around Chrome's built-in Gemini Nano (Prompt API).
//
// The contract this module enforces: we ONLY use Nano if the browser
// reports the model as already-available locally. We never pass a
// `monitor` callback and never call create() against a 'downloadable'
// status, so the 4 GB on-device-model download is never triggered by
// this extension. Users who want Nano enable it themselves in
// chrome://flags + chrome://components.

const AUTO_SUMMARIZE_KEY = "autoSummarizeOnTranscribe";
const MODEL_LABEL = "gemini-nano";

// Soft ceiling for one prompt's input. Nano's context window is ~4-6K
// tokens depending on version; we conservatively chunk anything bigger
// than this many characters. (rough heuristic: ~4 chars per token.)
const MAX_CHUNK_CHARS = 12_000;
const MAX_CHUNKS = 20;

// Chrome's LanguageModel API logs a warning unless input/output languages
// are declared. Transcripts vary, but our system prompts force English
// output (JSON / bullets), so we attest English here.
const SESSION_LANGS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

const SYSTEM_FINAL = `You are a precise summarizer of audio recording transcripts.
Output STRICT JSON with exactly two keys:
- "description": one plain sentence under 20 words capturing what the recording is about. No quotes, no leading phrases like "This recording is about". Just the sentence.
- "summary": markdown starting with "## Summary" then 3-6 concise bullet points covering main topics, decisions, and any action items.
Do not include any text outside the JSON object.`;

const SYSTEM_CHUNK = `Summarize this transcript chunk as 2-4 plain markdown bullet points covering the main topics, decisions, and actions. Output only the bullets, nothing else.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string", maxLength: 240 },
    summary: { type: "string" },
  },
  required: ["description", "summary"],
};

export const BROWSER_AI = {
  MODEL_LABEL,
  MAX_CHUNK_CHARS,
  MAX_CHUNKS,
};

// Returns true only when the LanguageModel global exists AND reports the
// model as fully available on this device. 'downloadable' returns false
// so we never trigger the 4 GB download.
export async function isAvailable() {
  const api = globalThis.LanguageModel;
  if (!api || typeof api.availability !== "function") return false;
  try {
    const status = await api.availability();
    return status === "available";
  } catch (_) {
    return false;
  }
}

export async function getAutoSummarizePreference() {
  try {
    const result = await chrome.storage.local.get(AUTO_SUMMARIZE_KEY);
    return result?.[AUTO_SUMMARIZE_KEY] === true;
  } catch (_) {
    return false;
  }
}

export async function setAutoSummarizePreference(enabled) {
  await chrome.storage.local.set({ [AUTO_SUMMARIZE_KEY]: !!enabled });
}

// Split a transcript into chunks bounded by `maxChars`, breaking on
// sentence boundaries where possible. Falls back to hard splits when
// a single sentence exceeds the limit.
export function chunkText(text, maxChars = MAX_CHUNK_CHARS) {
  const src = String(text || "").trim();
  if (!src) return [];
  if (src.length <= maxChars) return [src];

  // Coarse sentence segmentation: split on terminal punctuation followed
  // by whitespace. Good enough for transcripts; we don't need linguistic
  // perfection here.
  const sentences = src.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [src];
  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > maxChars && buf) {
      chunks.push(buf.trim());
      buf = "";
    }
    if (s.length > maxChars) {
      // A single mega-sentence: hard-split it.
      if (buf) {
        chunks.push(buf.trim());
        buf = "";
      }
      for (let i = 0; i < s.length; i += maxChars) {
        chunks.push(s.slice(i, i + maxChars).trim());
      }
      continue;
    }
    buf += s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// Attempt to recover a `{description, summary}` object from a Nano
// response. First tries strict JSON; falls back to extracting the
// first balanced `{...}` block; finally degrades to summary-only.
export function parseStructuredResponse(raw) {
  const text = String(raw || "").trim();
  if (!text) return { description: "", summary: "" };

  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object") {
        return {
          description: String(obj.description || "").trim(),
          summary: String(obj.summary || "").trim(),
        };
      }
    } catch (_) {}
    return null;
  };

  const direct = tryParse(text);
  if (direct) return direct;

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    const extracted = tryParse(match[0]);
    if (extracted) return extracted;
  }

  // Final fallback: keep the raw text as the summary, leave description blank.
  return { description: "", summary: text };
}

async function promptStructured(session, userPrompt) {
  // Prefer responseConstraint when the API supports it (newer Chrome).
  // Older versions ignore the option and we fall back to JSON-in-prose.
  let raw;
  try {
    raw = await session.prompt(userPrompt, {
      responseConstraint: RESPONSE_SCHEMA,
    });
  } catch (_) {
    raw = await session.prompt(userPrompt);
  }
  return parseStructuredResponse(raw);
}

// Produce {description, summary} from a transcript. Caller MUST verify
// isAvailable() first; this function will throw if Nano is missing.
export async function summarizeAndDescribe(transcript, opts = {}) {
  const api = globalThis.LanguageModel;
  if (!api) throw new Error("LanguageModel global not available");

  const text = String(transcript || "").trim();
  if (!text) return { description: "", summary: "" };

  const chunks = chunkText(text, opts.maxChunkChars || MAX_CHUNK_CHARS);
  const tooLong = chunks.length > (opts.maxChunks || MAX_CHUNKS);
  const usedChunks = tooLong ? chunks.slice(0, opts.maxChunks || MAX_CHUNKS) : chunks;

  // Short transcript: single structured call.
  if (usedChunks.length === 1) {
    const session = await api.create({ systemPrompt: SYSTEM_FINAL, ...SESSION_LANGS });
    try {
      return await promptStructured(session, usedChunks[0]);
    } finally {
      session.destroy?.();
    }
  }

  // Long transcript: map (chunk → bullets), then reduce (bullets → JSON).
  const chunkSession = await api.create({ systemPrompt: SYSTEM_CHUNK, ...SESSION_LANGS });
  const partials = [];
  try {
    for (const chunk of usedChunks) {
      const bullets = await chunkSession.prompt(chunk);
      partials.push(String(bullets || "").trim());
    }
  } finally {
    chunkSession.destroy?.();
  }

  const combined = partials.join("\n");
  const finalSession = await api.create({ systemPrompt: SYSTEM_FINAL, ...SESSION_LANGS });
  try {
    const result = await promptStructured(finalSession, combined);
    if (tooLong && result.description) {
      result.description = result.description.replace(/\.?$/, " (partial).");
    }
    return result;
  } finally {
    finalSession.destroy?.();
  }
}
