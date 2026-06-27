export const TRANSCRIPTION_SAMPLE_RATE = 16000;
export const LARGE_TRANSCRIPTION_THRESHOLD_MS = 30 * 60 * 1000;
export const TRANSCRIPTION_CHUNK_MS = 10 * 60 * 1000;
export const TRANSCRIPTION_CHUNK_OVERLAP_MS = 10 * 1000;

export function createTranscriptionChunkPlan(durationMs, options = {}) {
  const duration = normalizeDurationMs(durationMs);
  if (duration <= 0) {
    return {
      durationMs: 0,
      thresholdMs: normalizePositiveMs(options.thresholdMs, LARGE_TRANSCRIPTION_THRESHOLD_MS),
      chunkMs: normalizePositiveMs(options.chunkMs, TRANSCRIPTION_CHUNK_MS),
      overlapMs: normalizeOverlapMs(options.overlapMs, TRANSCRIPTION_CHUNK_OVERLAP_MS, TRANSCRIPTION_CHUNK_MS),
      chunked: false,
      chunks: []
    };
  }

  const thresholdMs = normalizePositiveMs(options.thresholdMs, LARGE_TRANSCRIPTION_THRESHOLD_MS);
  const chunkMs = normalizePositiveMs(options.chunkMs, TRANSCRIPTION_CHUNK_MS);
  const overlapMs = normalizeOverlapMs(options.overlapMs, TRANSCRIPTION_CHUNK_OVERLAP_MS, chunkMs);

  if (duration <= thresholdMs || duration <= chunkMs) {
    return {
      durationMs: duration,
      thresholdMs,
      chunkMs,
      overlapMs,
      chunked: false,
      chunks: [makeChunk(0, 1, 0, duration, 0, duration)]
    };
  }

  const chunks = [];
  for (let coreStartMs = 0; coreStartMs < duration; coreStartMs += chunkMs) {
    const coreEndMs = Math.min(duration, coreStartMs + chunkMs);
    chunks.push(
      makeChunk(
        chunks.length,
        0,
        coreStartMs,
        coreEndMs,
        Math.max(0, coreStartMs - overlapMs),
        Math.min(duration, coreEndMs + overlapMs)
      )
    );
  }

  for (const chunk of chunks) chunk.total = chunks.length;
  return {
    durationMs: duration,
    thresholdMs,
    chunkMs,
    overlapMs,
    chunked: chunks.length > 1,
    chunks
  };
}

export function offsetTranscriptionSegment(segment, offsetMs = 0) {
  const offset = normalizeDurationMs(offsetMs);
  const start = normalizeDurationMs(segment?.start) + offset;
  const end =
    Number.isFinite(Number(segment?.end)) && Number(segment.end) >= 0
      ? normalizeDurationMs(segment.end) + offset
      : null;
  return {
    text: String(segment?.text || "").trim(),
    start,
    end
  };
}

export function segmentBelongsToTranscriptionChunk(segment, chunk) {
  if (!segment || !chunk) return false;
  const midpoint = segmentMidpointMs(segment);
  const start = normalizeDurationMs(chunk.coreStartMs);
  const end = normalizeDurationMs(chunk.coreEndMs);
  if (end <= start) return false;
  if (Number(chunk.index) === Number(chunk.total) - 1) {
    return midpoint >= start && midpoint <= end;
  }
  return midpoint >= start && midpoint < end;
}

export function mergeTranscriptionChunkResults(chunkResults) {
  const segments = [];
  const fallbackTextParts = [];

  for (const item of Array.isArray(chunkResults) ? chunkResults : []) {
    const chunk = item?.chunk;
    const result = item?.result || item || {};
    const sourceSegments = Array.isArray(result.segments) ? result.segments : [];
    const offsetMs = normalizeDurationMs(chunk?.audioStartMs);

    if (typeof result.text === "string" && result.text.trim()) {
      fallbackTextParts.push(result.text.trim());
    }

    for (const segment of sourceSegments) {
      const adjusted = offsetTranscriptionSegment(segment, offsetMs);
      if (!adjusted.text) continue;
      if (chunk && !segmentBelongsToTranscriptionChunk(adjusted, chunk)) continue;
      segments.push(adjusted);
    }
  }

  segments.sort((a, b) => a.start - b.start || (a.end || 0) - (b.end || 0));
  const text = segments.length
    ? segments.map((segment) => segment.text).join(" ").trim()
    : fallbackTextParts.join(" ").trim();
  return { text, segments };
}

function makeChunk(index, total, coreStartMs, coreEndMs, audioStartMs, audioEndMs) {
  return {
    index,
    total,
    coreStartMs,
    coreEndMs,
    audioStartMs,
    audioEndMs
  };
}

function segmentMidpointMs(segment) {
  const start = normalizeDurationMs(segment?.start);
  const end =
    Number.isFinite(Number(segment?.end)) && Number(segment.end) >= start
      ? normalizeDurationMs(segment.end)
      : start;
  return start + (end - start) / 2;
}

function normalizeDurationMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function normalizePositiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function normalizeOverlapMs(value, fallback, chunkMs) {
  const n = Number(value);
  const overlap = Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
  return Math.min(overlap, Math.max(0, Math.floor(chunkMs / 2) - 1));
}
