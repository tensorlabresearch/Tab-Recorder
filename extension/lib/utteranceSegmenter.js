// Groups time-stamped speech tokens into utterances suitable for downstream
// speaker embedding. "Words" in the function name is generic — any tokens
// with numeric { start, end } (in milliseconds) and a `text` field work. The
// current Whisper output in this project is chunk-level, not word-level;
// either granularity flows through the same algorithm.
//
// Output utterances drop too-short spans (noise / cross-talk) and hard-split
// too-long spans so each embedding pass stays in a comfortable window.

export const DEFAULT_SEGMENT_OPTIONS = Object.freeze({
  // New utterance starts when the silence gap before a token exceeds this.
  minGapMs: 500,
  // Utterances shorter than this are dropped as too noisy to embed.
  minDurationMs: 600,
  // Utterances longer than this are split into chunks of <= this length.
  maxDurationMs: 20_000
});

export function segmentWordsToUtterances(words, opts = {}) {
  const { minGapMs, minDurationMs, maxDurationMs } = {
    ...DEFAULT_SEGMENT_OPTIONS,
    ...opts
  };

  const valid = (Array.isArray(words) ? words : []).filter(
    (w) =>
      w &&
      Number.isFinite(w.start) &&
      Number.isFinite(w.end) &&
      w.end >= w.start
  );
  if (valid.length === 0) return [];

  valid.sort((a, b) => a.start - b.start || a.end - b.end);

  // Phase 1: group by silence gap.
  const groups = [];
  let current = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prevEnd = current[current.length - 1].end;
    const gap = valid[i].start - prevEnd;
    if (gap >= minGapMs) {
      groups.push(current);
      current = [valid[i]];
    } else {
      current.push(valid[i]);
    }
  }
  groups.push(current);

  // Phase 2: hard-split groups whose duration exceeds maxDurationMs.
  const splitGroups = [];
  for (const group of groups) {
    let bucket = [];
    let bucketStart = group[0].start;
    for (const token of group) {
      if (
        bucket.length > 0 &&
        token.end - bucketStart > maxDurationMs
      ) {
        splitGroups.push(bucket);
        bucket = [];
        bucketStart = token.start;
      }
      bucket.push(token);
    }
    if (bucket.length > 0) splitGroups.push(bucket);
  }

  // Phase 3: build utterance objects, drop too-short ones.
  const utterances = [];
  for (const tokens of splitGroups) {
    const startMs = tokens[0].start;
    const endMs = tokens[tokens.length - 1].end;
    if (endMs - startMs < minDurationMs) continue;
    utterances.push({
      startSec: startMs / 1000,
      endSec: endMs / 1000,
      tokens,
      text: tokens
        .map((t) => String(t.text || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    });
  }
  return utterances;
}
