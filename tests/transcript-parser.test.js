import { describe, it, expect } from "vitest";
import {
  FINISH_MARKER,
  parseTimestampMs,
  parseSegmentLine,
  isFinishLine,
  parseTranscript
} from "../projects/tab-recorder-v2/lib/transcriptParser.js";

describe("parseTimestampMs", () => {
  it("returns 0 for empty / invalid input", () => {
    expect(parseTimestampMs("")).toBe(0);
    expect(parseTimestampMs(null)).toBe(0);
    expect(parseTimestampMs("nope")).toBe(0);
    expect(parseTimestampMs("12:34:56")).toBe(0); // missing fractional seconds
  });

  it("parses hh:mm:ss.SSS to integer ms", () => {
    expect(parseTimestampMs("00:00:00.000")).toBe(0);
    expect(parseTimestampMs("00:00:01.000")).toBe(1000);
    expect(parseTimestampMs("00:01:00.000")).toBe(60_000);
    expect(parseTimestampMs("01:00:00.000")).toBe(3_600_000);
    expect(parseTimestampMs("00:00:00.500")).toBe(500);
    expect(parseTimestampMs("00:00:12.345")).toBe(12_345);
  });

  it("handles a representative whisper segment timestamp", () => {
    expect(parseTimestampMs("01:23:45.678")).toBe(
      ((1 * 60 + 23) * 60 + 45) * 1000 + 678
    );
  });
});

describe("parseSegmentLine", () => {
  it("returns null for non-segment lines", () => {
    expect(parseSegmentLine("")).toBeNull();
    expect(parseSegmentLine("system_info: n_threads = 1 / 8")).toBeNull();
    expect(parseSegmentLine("whisper_print_timings:    load time =   123 ms")).toBeNull();
    expect(parseSegmentLine("[00:00:00.000 --> 00:00:05.000]")).toBeNull(); // empty text
    expect(parseSegmentLine("[00:00:00.000]   stuck")).toBeNull(); // missing end
  });

  it("parses a typical whisper.cpp segment line", () => {
    const seg = parseSegmentLine("[00:00:00.000 --> 00:00:05.000]   Hello world");
    expect(seg).toEqual({ text: "Hello world", start: 0, end: 5000 });
  });

  it("handles tightly-spaced arrow without padding", () => {
    const seg = parseSegmentLine("[00:00:01.000-->00:00:02.000]  test");
    expect(seg).toEqual({ text: "test", start: 1000, end: 2000 });
  });

  it("trims interior whitespace and tabs", () => {
    const seg = parseSegmentLine("[00:00:10.000 --> 00:00:15.500] \t  Mixed   Whitespace  ");
    expect(seg.text).toBe("Mixed   Whitespace");
  });
});

describe("isFinishLine", () => {
  it("matches whisper_print_timings rows", () => {
    expect(isFinishLine("whisper_print_timings:    load time =  234 ms")).toBe(true);
    expect(isFinishLine("    whisper_print_timings: total time = 1234 ms")).toBe(true);
  });

  it("does not match unrelated lines", () => {
    expect(isFinishLine("[00:00:00.000 --> 00:00:05.000]   text")).toBe(false);
    expect(isFinishLine("system_info: n_threads = 1")).toBe(false);
    expect(isFinishLine("")).toBe(false);
    expect(isFinishLine(null)).toBe(false);
  });

  it("uses the exported FINISH_MARKER constant", () => {
    expect(FINISH_MARKER).toBe("whisper_print_timings:");
    expect(isFinishLine(FINISH_MARKER)).toBe(true);
  });
});

describe("parseTranscript", () => {
  it("returns empty result for no segment lines", () => {
    const out = parseTranscript([
      "system_info: ...",
      "whisper_full: processing 80000 samples ...",
      "whisper_print_timings:    load time =  123 ms"
    ]);
    expect(out).toEqual({ text: "", segments: [] });
  });

  it("collects all segment lines into segments and joined text", () => {
    const lines = [
      "system_info: ...",
      "[00:00:00.000 --> 00:00:05.000]   Hello there.",
      "[00:00:05.000 --> 00:00:10.000]   General Kenobi.",
      "whisper_print_timings: total time = 5 ms"
    ];
    const out = parseTranscript(lines);
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]).toEqual({ text: "Hello there.", start: 0, end: 5000 });
    expect(out.segments[1]).toEqual({ text: "General Kenobi.", start: 5000, end: 10000 });
    expect(out.text).toBe("Hello there. General Kenobi.");
  });

  it("ignores empty-text segments", () => {
    const out = parseTranscript([
      "[00:00:00.000 --> 00:00:01.000] ",
      "[00:00:01.000 --> 00:00:02.000]   words"
    ]);
    expect(out.segments).toHaveLength(1);
    expect(out.text).toBe("words");
  });

  it("handles undefined input gracefully", () => {
    expect(parseTranscript()).toEqual({ text: "", segments: [] });
    expect(parseTranscript(null)).toEqual({ text: "", segments: [] });
  });
});
