import { describe, it, expect } from "vitest";
import { diarize, sliceAudio, TARGET_SAMPLE_RATE } from "../extension/lib/diarize.js";

// Build a Whisper-style segment with start/end in ms.
const seg = (start, end, text = "x") => ({ start, end, text });

// Make a flat Float32Array of length seconds * 16000.
function silentPcm(seconds) {
  return new Float32Array(Math.ceil(seconds * TARGET_SAMPLE_RATE));
}

// An embed function that returns a fixed vector based on the audio
// slice's mean amplitude — gives us a deterministic, controllable
// "speaker identity" stand-in for tests.
function makeFakeEmbed(idForSlice) {
  return async (slice) => {
    const id = idForSlice(slice);
    const vec = new Float32Array(4);
    vec[id % 4] = 1;
    return vec;
  };
}

describe("sliceAudio", () => {
  it("slices into the buffer in sample space", () => {
    const pcm = new Float32Array(16_000); // 1 second
    for (let i = 0; i < pcm.length; i++) pcm[i] = i;
    const slice = sliceAudio(pcm, 0.25, 0.75);
    expect(slice.length).toBe(16_000 * 0.5);
    expect(slice[0]).toBe(4_000); // 0.25s * 16k
  });

  it("clamps to [0, pcm.length]", () => {
    // 16 kHz PCM, 1 s buffer (16_000 samples).
    const pcm = new Float32Array(16_000);
    // Negative start clamps to 0.
    expect(sliceAudio(pcm, -1, 0.1).length).toBe(1_600);
    // End past the buffer clamps to the buffer length.
    expect(sliceAudio(pcm, 0.5, 99).length).toBe(8_000);
  });

  it("returns an empty Float32Array when end <= start", () => {
    const pcm = new Float32Array(1_000);
    expect(sliceAudio(pcm, 0.5, 0.5).length).toBe(0);
    expect(sliceAudio(pcm, 0.6, 0.3).length).toBe(0);
  });
});

describe("diarize — input validation", () => {
  it("throws when embedFn is missing", async () => {
    await expect(
      diarize({ segments: [], pcm16k: silentPcm(1) })
    ).rejects.toThrow(/embedFn/);
  });

  it("throws when pcm16k is not a Float32Array", async () => {
    await expect(
      diarize({ segments: [], pcm16k: [1, 2, 3], embedFn: async () => new Float32Array(4) })
    ).rejects.toThrow(/Float32Array/);
  });
});

describe("diarize — degenerate utterance counts", () => {
  it("returns empty + skipped=too-few when no utterances survive segmentation", async () => {
    const result = await diarize({
      segments: [],
      pcm16k: silentPcm(2),
      embedFn: async () => new Float32Array(4)
    });
    expect(result.utterances).toEqual([]);
    expect(result.speakerCount).toBe(0);
    expect(result.skipped).toBe("too-few-utterances");
  });

  it("labels the single utterance speaker=0 and reports skipped", async () => {
    const result = await diarize({
      segments: [seg(0, 1200, "hello")],
      pcm16k: silentPcm(2),
      embedFn: async () => new Float32Array(4)
    });
    expect(result.utterances.length).toBe(1);
    expect(result.utterances[0].speakerId).toBe(0);
    expect(result.speakerCount).toBe(1);
    expect(result.skipped).toBe("too-few-utterances");
  });

  it("skips calling embedFn entirely when too few utterances", async () => {
    let calls = 0;
    await diarize({
      segments: [seg(0, 1200, "hi")],
      pcm16k: silentPcm(2),
      embedFn: async () => {
        calls++;
        return new Float32Array(4);
      }
    });
    expect(calls).toBe(0);
  });
});

describe("diarize — happy path", () => {
  it("labels two clearly-separable utterances with two different speakers", async () => {
    // Two utterances, well-separated in time so they segment cleanly.
    const segments = [
      seg(0, 1500, "alpha"),
      seg(3000, 4500, "beta")
    ];
    // Fake embed: assign id 0 to first slice, id 1 to second.
    let calls = 0;
    const embedFn = async () => {
      const id = calls++;
      const vec = new Float32Array(4);
      vec[id] = 1;
      return vec;
    };
    const result = await diarize({
      segments,
      pcm16k: silentPcm(5),
      embedFn
    });
    expect(result.skipped).toBeNull();
    expect(result.utterances.length).toBe(2);
    expect(result.utterances[0].speakerId).not.toBe(result.utterances[1].speakerId);
    expect(result.speakerCount).toBe(2);
  });

  it("calls embedFn exactly once per utterance, in order", async () => {
    const segments = [
      seg(0, 1500, "one"),
      seg(3000, 4500, "two"),
      seg(6000, 7500, "three")
    ];
    const sliceLengths = [];
    const embedFn = async (slice) => {
      sliceLengths.push(slice.length);
      const vec = new Float32Array(4);
      vec[sliceLengths.length - 1] = 1;
      return vec;
    };
    await diarize({
      segments,
      pcm16k: silentPcm(10),
      embedFn
    });
    expect(sliceLengths).toHaveLength(3);
    // Each slice spans ~1.5s of audio at 16 kHz.
    for (const len of sliceLengths) {
      expect(len).toBeGreaterThan(16_000 * 1.4);
      expect(len).toBeLessThan(16_000 * 1.6);
    }
  });

  it("invokes onUtteranceProgress for each utterance", async () => {
    const segments = [seg(0, 1500, "a"), seg(3000, 4500, "b")];
    const progressCalls = [];
    await diarize({
      segments,
      pcm16k: silentPcm(5),
      embedFn: async () => new Float32Array(4),
      onUtteranceProgress: (current, total) => progressCalls.push([current, total])
    });
    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2]
    ]);
  });

  it("clusters identical-prototype utterances into one speaker", async () => {
    const segments = [
      seg(0, 1500, "a"),
      seg(3000, 4500, "b"),
      seg(6000, 7500, "c")
    ];
    const embedFn = async () => new Float32Array([1, 0, 0, 0]);
    const result = await diarize({
      segments,
      pcm16k: silentPcm(10),
      embedFn
    });
    expect(result.speakerCount).toBe(1);
    expect(result.utterances.map((u) => u.speakerId)).toEqual([0, 0, 0]);
  });
});

describe("diarize — option forwarding", () => {
  it("forwards segmenterOpts (custom minGapMs changes utterance count)", async () => {
    // Two segments 300 ms apart -- under default 500 ms gap they'd merge;
    // with minGapMs:100 they split into two utterances.
    const segments = [seg(0, 1500, "a"), seg(1800, 3300, "b")];
    const embedFn = async () => new Float32Array(4);
    const merged = await diarize({
      segments,
      pcm16k: silentPcm(5),
      embedFn,
      segmenterOpts: { minGapMs: 500, minDurationMs: 100 }
    });
    expect(merged.utterances.length).toBe(1);
    expect(merged.skipped).toBe("too-few-utterances");

    const split = await diarize({
      segments,
      pcm16k: silentPcm(5),
      embedFn,
      segmenterOpts: { minGapMs: 100, minDurationMs: 100 }
    });
    expect(split.utterances.length).toBe(2);
  });

  it("forwards clusterOpts (maxClusters cap)", async () => {
    const segments = [
      seg(0, 1500, "a"),
      seg(3000, 4500, "b"),
      seg(6000, 7500, "c")
    ];
    // Each utterance gets a fresh prototype -> would naturally be 3 speakers.
    let calls = 0;
    const embedFn = async () => {
      const vec = new Float32Array(4);
      vec[calls++] = 1;
      return vec;
    };
    const result = await diarize({
      segments,
      pcm16k: silentPcm(10),
      embedFn,
      clusterOpts: { maxClusters: 2 }
    });
    expect(result.speakerCount).toBeLessThanOrEqual(2);
  });
});
