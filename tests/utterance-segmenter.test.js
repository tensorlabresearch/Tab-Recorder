import { describe, it, expect } from "vitest";
import {
  segmentWordsToUtterances,
  DEFAULT_SEGMENT_OPTIONS
} from "../extension/lib/utteranceSegmenter.js";

// Helper: build a token with ms timestamps.
const w = (start, end, text = "x") => ({ start, end, text });

describe("DEFAULT_SEGMENT_OPTIONS", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_SEGMENT_OPTIONS)).toBe(true);
  });

  it("has the documented defaults", () => {
    expect(DEFAULT_SEGMENT_OPTIONS.minGapMs).toBe(500);
    expect(DEFAULT_SEGMENT_OPTIONS.minDurationMs).toBe(600);
    expect(DEFAULT_SEGMENT_OPTIONS.maxDurationMs).toBe(20_000);
  });
});

describe("segmentWordsToUtterances — edge cases", () => {
  it("returns [] for null / undefined / non-array input", () => {
    expect(segmentWordsToUtterances(null)).toEqual([]);
    expect(segmentWordsToUtterances(undefined)).toEqual([]);
    expect(segmentWordsToUtterances("nope")).toEqual([]);
    expect(segmentWordsToUtterances({})).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(segmentWordsToUtterances([])).toEqual([]);
  });

  it("drops tokens with non-finite or inverted timestamps", () => {
    const out = segmentWordsToUtterances([
      { start: NaN, end: 1000, text: "a" },
      { start: 0, end: undefined, text: "b" },
      { start: 5000, end: 4000, text: "c" }, // inverted
      w(0, 800, "ok")
    ]);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("ok");
  });

  it("returns [] when no token survives the validity filter", () => {
    expect(
      segmentWordsToUtterances([
        { start: "nope", end: 100, text: "x" },
        { start: 100, end: "nope", text: "y" }
      ])
    ).toEqual([]);
  });
});

describe("segmentWordsToUtterances — grouping by silence gap", () => {
  it("combines tokens with sub-threshold gaps into one utterance", () => {
    const tokens = [
      w(0, 800, "hello"),
      w(900, 1700, "world"), // 100 ms gap
      w(1800, 2600, "again") // 100 ms gap
    ];
    const out = segmentWordsToUtterances(tokens);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("hello world again");
    expect(out[0].startSec).toBe(0);
    expect(out[0].endSec).toBe(2.6);
  });

  it("splits on >= minGapMs silence", () => {
    const tokens = [
      w(0, 800, "alpha"),
      w(1400, 2200, "beta") // 600 ms gap, exceeds 500
    ];
    const out = segmentWordsToUtterances(tokens);
    expect(out.length).toBe(2);
    expect(out[0].text).toBe("alpha");
    expect(out[1].text).toBe("beta");
  });

  it("treats exactly-minGapMs as a split boundary", () => {
    const tokens = [
      w(0, 800, "left"),
      w(1300, 2100, "right") // exactly 500 ms gap
    ];
    const out = segmentWordsToUtterances(tokens);
    expect(out.length).toBe(2);
  });

  it("respects a custom minGapMs", () => {
    const tokens = [
      w(0, 800, "one"),
      w(1100, 1900, "two") // 300 ms gap
    ];
    expect(segmentWordsToUtterances(tokens, { minGapMs: 200 }).length).toBe(2);
    expect(segmentWordsToUtterances(tokens, { minGapMs: 400 }).length).toBe(1);
  });
});

describe("segmentWordsToUtterances — minDurationMs filter", () => {
  it("drops utterances shorter than minDurationMs", () => {
    const tokens = [
      w(0, 200, "blip"),   // 200 ms — too short
      w(1000, 1800, "long") // 800 ms — kept
    ];
    const out = segmentWordsToUtterances(tokens);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("long");
  });

  it("keeps utterances exactly at minDurationMs", () => {
    const tokens = [w(0, 600, "exact")];
    expect(segmentWordsToUtterances(tokens).length).toBe(1);
  });

  it("respects a custom minDurationMs", () => {
    const tokens = [w(0, 800, "medium")];
    expect(segmentWordsToUtterances(tokens, { minDurationMs: 1000 }).length).toBe(0);
    expect(segmentWordsToUtterances(tokens, { minDurationMs: 500 }).length).toBe(1);
  });
});

describe("segmentWordsToUtterances — hard-split long utterances", () => {
  it("splits a single contiguous run that exceeds maxDurationMs", () => {
    // Ten contiguous 3s tokens = 30s — exceeds default 20s max.
    const tokens = Array.from({ length: 10 }, (_, i) =>
      w(i * 3000, (i + 1) * 3000, `t${i}`)
    );
    const out = segmentWordsToUtterances(tokens);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const utt of out) {
      const dur = (utt.endSec - utt.startSec) * 1000;
      // Allow a single token to push slightly past the cap.
      expect(dur).toBeLessThanOrEqual(DEFAULT_SEGMENT_OPTIONS.maxDurationMs + 3000);
    }
    expect(out.map((u) => u.tokens.length).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("respects a custom maxDurationMs", () => {
    const tokens = [
      w(0, 2000, "a"),
      w(2000, 4000, "b"),
      w(4000, 6000, "c")
    ];
    const out = segmentWordsToUtterances(tokens, {
      maxDurationMs: 3000,
      minDurationMs: 100
    });
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
});

describe("segmentWordsToUtterances — output shape", () => {
  it("emits startSec/endSec in seconds with token references retained", () => {
    const tokens = [w(1500, 2500, "hi")];
    const [out] = segmentWordsToUtterances(tokens);
    expect(out.startSec).toBe(1.5);
    expect(out.endSec).toBe(2.5);
    expect(out.tokens).toEqual(tokens);
    expect(out.text).toBe("hi");
  });

  it("collapses internal whitespace in the joined text", () => {
    const tokens = [
      w(0, 500, "  hello "),
      w(600, 1200, "  world  ")
    ];
    const [out] = segmentWordsToUtterances(tokens);
    expect(out.text).toBe("hello world");
  });

  it("skips empty-text tokens but keeps their timing", () => {
    const tokens = [
      w(0, 500, "alpha"),
      w(600, 1200, ""),
      w(1300, 1900, "gamma")
    ];
    const [out] = segmentWordsToUtterances(tokens);
    expect(out.text).toBe("alpha gamma");
    expect(out.startSec).toBe(0);
    expect(out.endSec).toBe(1.9);
  });
});

describe("segmentWordsToUtterances — ordering invariants", () => {
  it("sorts out-of-order input by start time before grouping", () => {
    const tokens = [
      w(2000, 2800, "second"),
      w(0, 800, "first"),
      w(1000, 1800, "middle")
    ];
    const out = segmentWordsToUtterances(tokens);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("first middle second");
  });

  it("is deterministic across runs", () => {
    const tokens = [w(0, 700, "a"), w(800, 1500, "b"), w(2200, 2900, "c")];
    const a = segmentWordsToUtterances(tokens);
    const b = segmentWordsToUtterances(tokens);
    expect(a).toEqual(b);
  });
});
