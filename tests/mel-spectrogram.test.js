import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  SORTFORMER_MEL_CONFIG,
  toBf16,
  hzToMel,
  melToHz,
  createMelFilterbank,
  createAnalysisWindow,
  createMelFrontend,
  computeLogMel,
  melFrameCount
} from "../extension/lib/melSpectrogram.js";

// Golden values from tools/gen-mel-fixtures.py, an independent numpy
// implementation of the same NeMo spec. Agreement between the two is the
// actual evidence the port is right.
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/mel-sortformer.json", import.meta.url), "utf8")
);

/** Must match lcg() in tools/gen-mel-fixtures.py exactly. */
function lcg(n, seed = 12345) {
  const out = new Float32Array(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state / 2147483648 - 1;
  }
  return out;
}

function sine(freq, n, sampleRate = 16000) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/**
 * The fixtures are rounded to 6 decimals and the two implementations differ in
 * float64-vs-float32 intermediate rounding, so compare proportionally rather
 * than to a fixed number of decimal places.
 */
function expectClose(actual, expected, label) {
  const tolerance = 1e-4 + 1e-5 * Math.abs(expected);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    tolerance
  );
}

const CASES = {
  silence: () => new Float32Array(8000),
  sine1k: () => sine(1000, 8000),
  noise: () => lcg(8000),
  short: () => lcg(300, 999)
};

describe("config", () => {
  it("matches the settings the fixtures were generated with", () => {
    expect(SORTFORMER_MEL_CONFIG).toMatchObject(fixtures.config);
  });
});

describe("toBf16", () => {
  it("leaves values already representable in bfloat16 untouched", () => {
    for (const value of [0, 1, -1, 0.5, 2, -256]) {
      expect(toBf16(value)).toBe(value);
    }
  });

  it("clears the low 16 mantissa bits", () => {
    const bits = new Uint32Array(new Float32Array([Math.PI]).buffer)[0];
    const rounded = new Uint32Array(new Float32Array([toBf16(Math.PI)]).buffer)[0];
    expect(rounded & 0xffff).toBe(0);
    expect(rounded).not.toBe(bits);
  });

  it("rounds to nearest, breaking exact ties toward even", () => {
    // bfloat16 keeps 7 explicit mantissa bits, so the step at 1.0 is 2^-7 and
    // the halfway point between 1.0 and 1 + 2^-7 is 1 + 2^-8.
    // 1.0 has the even mantissa, so the tie resolves down to it.
    expect(toBf16(1 + 2 ** -8)).toBe(1);
    // A hair past the tie must round up rather than truncate.
    expect(toBf16(1 + 2 ** -8 + 2 ** -20)).toBe(1 + 2 ** -7);
    // Below the tie, down.
    expect(toBf16(1 + 2 ** -9)).toBe(1);
    // The next tie up sits beside an odd mantissa, so it resolves upward.
    expect(toBf16(1 + 2 ** -7 + 2 ** -8)).toBe(1 + 2 ** -6);
  });

  it("never moves a value by more than half a bfloat16 step", () => {
    for (const value of [Math.PI, 1e-8, 12345.678, -0.30000001192092896]) {
      const step = 2 ** (Math.floor(Math.log2(Math.abs(value))) - 7);
      expect(Math.abs(toBf16(value) - value)).toBeLessThanOrEqual(step / 2);
    }
  });
});

describe("mel scale", () => {
  it("is linear below 1 kHz and logarithmic above", () => {
    expect(hzToMel(0)).toBe(0);
    expect(hzToMel(500)).toBeCloseTo(500 / (200 / 3), 10);
    expect(hzToMel(2000)).toBeGreaterThan(hzToMel(1000));
    // Above the break the scale compresses: an octave is worth less than
    // the same span of hertz below it.
    expect(hzToMel(2000) - hzToMel(1000)).toBeLessThan(hzToMel(1000) - hzToMel(0));
  });

  it("round-trips through melToHz", () => {
    for (const hz of [0, 100, 999, 1000, 1001, 4000, 8000]) {
      expect(melToHz(hzToMel(hz))).toBeCloseTo(hz, 6);
    }
  });
});

describe("createMelFilterbank", () => {
  const fb = createMelFilterbank();

  it("has one triangle per mel band over the rFFT bins", () => {
    expect(fb.nMels).toBe(128);
    expect(fb.freqBins).toBe(257);
    expect(fb.starts).toHaveLength(128);
    expect(fb.offsets[128]).toBe(fb.weights.length);
  });

  it("matches the reference filterbank rows", () => {
    for (const [row, expected] of Object.entries(fixtures.filterbank)) {
      const i = Number(row);
      expect(fb.starts[i]).toBe(expected.firstBin);
      expect(fb.starts[i] + fb.lengths[i] - 1).toBe(expected.lastBin);
      const actual = Array.from(
        fb.weights.subarray(fb.offsets[i], fb.offsets[i] + fb.lengths[i])
      );
      expect(actual).toHaveLength(expected.values.length);
      actual.forEach((value, j) => expect(value).toBeCloseTo(expected.values[j], 6));
    }
  });

  it("puts every band's weight inside the Nyquist range and in ascending order", () => {
    let previousStart = -1;
    for (let i = 0; i < fb.nMels; i++) {
      expect(fb.lengths[i]).toBeGreaterThan(0);
      expect(fb.starts[i]).toBeGreaterThanOrEqual(previousStart);
      expect(fb.starts[i] + fb.lengths[i]).toBeLessThanOrEqual(fb.freqBins);
      previousStart = fb.starts[i];
    }
  });
});

describe("createAnalysisWindow", () => {
  const window = createAnalysisWindow();

  it("centres a 400-sample window inside the 512-point FFT buffer", () => {
    expect(window).toHaveLength(512);
    const offset = (512 - 400) / 2;
    for (let i = 0; i < offset; i++) {
      expect(window[i]).toBe(0);
      expect(window[512 - 1 - i]).toBe(0);
    }
    // periodic=False means the window touches zero at both ends.
    expect(window[offset]).toBe(0);
    expect(window[offset + 399]).toBe(0);
    expect(window[offset + 200]).toBeCloseTo(1, 2);
  });

  it("is symmetric and bfloat16-rounded", () => {
    const offset = 56;
    for (let i = 0; i < 400; i++) {
      expect(window[offset + i]).toBe(window[offset + 399 - i]);
      expect(toBf16(window[offset + i])).toBe(window[offset + i]);
    }
  });
});

describe("melFrameCount", () => {
  it("matches the reference frame counts", () => {
    for (const expected of Object.values(fixtures.cases)) {
      expect(melFrameCount(expected.samples)).toBe(expected.frames);
    }
    expect(Object.keys(fixtures.cases).length).toBeGreaterThan(0);
  });

  it("returns zero when the padded signal is shorter than one window", () => {
    expect(melFrameCount(0)).toBe(1); // 256 + 0 + 256 == nFft, exactly one frame
    expect(melFrameCount(-5)).toBe(1);
  });
});

describe("computeLogMel against the numpy reference", () => {
  const frontend = createMelFrontend();

  for (const [name, build] of Object.entries(CASES)) {
    const expected = fixtures.cases[name];

    it(`reproduces '${name}' frame by frame`, () => {
      const { frames, nMels, data } = frontend.computeLogMel(build());
      expect(frames).toBe(expected.frames);
      expect(nMels).toBe(expected.mels);

      const frameAt = (t) => Array.from(data.subarray(t * nMels, (t + 1) * nMels));
      const checks = [
        ["frame0", frameAt(0), expected.frame0],
        ["frameMid", frameAt(Math.floor(frames / 2)), expected.frameMid],
        ["frameLast", frameAt(frames - 1), expected.frameLast]
      ];
      for (const [label, actual, want] of checks) {
        expect(actual, label).toHaveLength(want.length);
        actual.forEach((value, i) => expectClose(value, want[i], `${label}[${i}]`));
      }
    });

    it(`reproduces '${name}' across every frame`, () => {
      // Per-frame sums catch drift in frames the spot checks skip.
      const { frames, nMels, data } = frontend.computeLogMel(build());
      expect(frames).toBe(expected.frameSums.length);
      for (let t = 0; t < frames; t++) {
        let sum = 0;
        for (let m = 0; m < nMels; m++) sum += data[t * nMels + m];
        expectClose(sum, expected.frameSums[t], `frame ${t} sum`);
      }
    });
  }
});

describe("computeLogMel behaviour", () => {
  it("is quiet and flat for digital silence", () => {
    const { data } = computeLogMel(new Float32Array(8000));
    // log(0 + 2^-24) for every bin.
    const floor = Math.log(2 ** -24);
    for (const value of data) expect(value).toBeCloseTo(floor, 6);
  });

  it("concentrates energy in the mel bands covering a 1 kHz tone", () => {
    const { frames, nMels, data } = computeLogMel(sine(1000, 8000));
    const mid = Math.floor(frames / 2);
    let peak = -Infinity;
    let peakBand = -1;
    for (let m = 0; m < nMels; m++) {
      const value = data[mid * nMels + m];
      if (value > peak) {
        peak = value;
        peakBand = m;
      }
    }
    // 1 kHz is the Slaney break point, which sits at mel band 15 of 128
    // for a 0-8000 Hz range.
    const bandHz = (band) => melToHz((hzToMel(8000) * (band + 1)) / 129);
    expect(bandHz(peakBand)).toBeGreaterThan(700);
    expect(bandHz(peakBand)).toBeLessThan(1400);
  });

  it("accepts a plain array as well as a Float32Array", () => {
    const samples = Array.from(lcg(2000));
    const fromArray = computeLogMel(samples);
    const fromTyped = computeLogMel(Float32Array.from(samples));
    expect(fromArray.frames).toBe(fromTyped.frames);
    expect(Array.from(fromArray.data)).toEqual(Array.from(fromTyped.data));
  });

  it("returns an empty result for empty input without throwing", () => {
    const { frames, data } = computeLogMel(new Float32Array(0));
    expect(frames).toBe(1);
    expect(data).toHaveLength(128);
  });

  it("gives the same answer from a reused frontend as from a fresh one", () => {
    const frontend = createMelFrontend();
    const audio = lcg(4000, 7);
    const first = frontend.computeLogMel(audio);
    const second = frontend.computeLogMel(audio);
    const oneShot = computeLogMel(audio);
    expect(Array.from(second.data)).toEqual(Array.from(first.data));
    expect(Array.from(oneShot.data)).toEqual(Array.from(first.data));
  });

  it("produces the 128-dim frames the Sortformer graph expects", () => {
    // The ONNX input is [1, chunk_frames, 128] with 10 ms hop.
    const oneSecond = computeLogMel(lcg(16000));
    expect(oneSecond.nMels).toBe(128);
    expect(oneSecond.frames).toBe(101);
    expect(oneSecond.data).toHaveLength(101 * 128);
  });
});
