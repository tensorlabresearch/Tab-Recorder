// Pure-JS parser for whisper.cpp's printf transcript output.
//
// whisper_full prints lines like:
//   [00:00:00.000 --> 00:00:05.000]   Hello world
// when print_timestamps is on. Each line corresponds to one segment.
//
// This module also recognises the `whisper_print_timings:` marker that
// whisper_print_timings emits at the end of a run, which we use as the
// completion signal.

const SEGMENT_RE = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.*)$/;
const TS_RE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

export const FINISH_MARKER = "whisper_print_timings:";

export function parseTimestampMs(stamp) {
  if (!stamp) return 0;
  const m = TS_RE.exec(String(stamp));
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4]);
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

export function parseSegmentLine(line) {
  if (!line) return null;
  const m = SEGMENT_RE.exec(String(line));
  if (!m) return null;
  const text = m[3].trim();
  if (!text) return null;
  return {
    text,
    start: parseTimestampMs(m[1]),
    end: parseTimestampMs(m[2])
  };
}

export function isFinishLine(line) {
  return typeof line === "string" && line.includes(FINISH_MARKER);
}

export function parseTranscript(lines) {
  const segments = [];
  for (const line of lines || []) {
    const seg = parseSegmentLine(line);
    if (seg) segments.push(seg);
  }
  const text = segments.map((s) => s.text).join(" ").trim();
  return { text, segments };
}
