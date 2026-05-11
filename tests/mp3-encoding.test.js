import { describe, it, expect } from "vitest";
import {
  encodePcmToMp3,
  floatToInt16
} from "../extension/lib/mp3Encoding.js";

function makeSineFloat32({ frequencyHz, durationSec, sampleRate, amplitude = 0.5 }) {
  const numSamples = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude;
  }
  return out;
}

describe("floatToInt16", () => {
  it("maps zero to zero", () => {
    const out = floatToInt16(new Float32Array([0, 0, 0]));
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it("clamps values above +1 to int16 max", () => {
    const out = floatToInt16(new Float32Array([1, 1.5, 2]));
    expect(out[0]).toBe(0x7fff);
    expect(out[1]).toBe(0x7fff);
    expect(out[2]).toBe(0x7fff);
  });

  it("clamps values below -1 to int16 min", () => {
    const out = floatToInt16(new Float32Array([-1, -1.5, -2]));
    expect(out[0]).toBe(-0x8000);
    expect(out[1]).toBe(-0x8000);
    expect(out[2]).toBe(-0x8000);
  });

  it("scales positive and negative differently to use full int16 range", () => {
    // Negative numbers scale by 0x8000 (32768), positive by 0x7FFF (32767).
    // Int16Array assignment truncates toward zero, so 0.5 * 32767 = 16383.5 → 16383,
    // while -0.5 * 32768 = -16384 exactly.
    const out = floatToInt16(new Float32Array([0.5, -0.5]));
    expect(out[0]).toBe(Math.trunc(0.5 * 0x7fff));
    expect(out[1]).toBe(-0x8000 / 2);
  });

  it("returns an Int16Array of matching length", () => {
    const out = floatToInt16(new Float32Array(100));
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(100);
  });
});

describe("encodePcmToMp3", () => {
  it("returns a non-empty Uint8Array MP3 for mono input", () => {
    const sampleRate = 44100;
    const left = makeSineFloat32({ frequencyHz: 440, durationSec: 0.5, sampleRate });
    const out = encodePcmToMp3({ left, sampleRate });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBeGreaterThan(0);
    expect(out[0]).toBe(0xff);
    expect(out[1] & 0xe0).toBe(0xe0); // 11-bit MP3 frame sync
  });

  it("encodes stereo input to a non-empty buffer", () => {
    const sampleRate = 44100;
    const left = makeSineFloat32({ frequencyHz: 440, durationSec: 0.5, sampleRate });
    const right = makeSineFloat32({ frequencyHz: 660, durationSec: 0.5, sampleRate });
    const out = encodePcmToMp3({ left, right, sampleRate });
    expect(out.byteLength).toBeGreaterThan(0);
  });

  it("handles input lengths that are not multiples of the LAME block size (1152)", () => {
    const sampleRate = 44100;
    const oddLength = 1152 * 3 + 17; // intentionally not a multiple of 1152
    const left = new Float32Array(oddLength);
    for (let i = 0; i < oddLength; i++) {
      left[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3;
    }
    const out = encodePcmToMp3({ left, sampleRate });
    expect(out.byteLength).toBeGreaterThan(0);
  });

  it("calls onProgress monotonically and ends at 1.0", () => {
    const sampleRate = 44100;
    const left = makeSineFloat32({ frequencyHz: 440, durationSec: 1, sampleRate });
    const reported = [];
    encodePcmToMp3({
      left,
      sampleRate,
      onProgress: (p) => reported.push(p)
    });
    expect(reported.length).toBeGreaterThan(1);
    for (let i = 1; i < reported.length; i++) {
      expect(reported[i]).toBeGreaterThanOrEqual(reported[i - 1]);
    }
    expect(reported[reported.length - 1]).toBe(1);
  });

  it("clamps bitrate into the 64–320 range", () => {
    const sampleRate = 44100;
    const left = makeSineFloat32({ frequencyHz: 440, durationSec: 0.25, sampleRate });
    // way out of range; encoding should still succeed
    expect(() => encodePcmToMp3({ left, sampleRate, bitrate: 9999 })).not.toThrow();
    expect(() => encodePcmToMp3({ left, sampleRate, bitrate: 1 })).not.toThrow();
  });

  it("higher bitrate produces a larger file for the same input", () => {
    const sampleRate = 44100;
    const left = makeSineFloat32({ frequencyHz: 440, durationSec: 1, sampleRate });
    const small = encodePcmToMp3({ left, sampleRate, bitrate: 64 });
    const large = encodePcmToMp3({ left, sampleRate, bitrate: 192 });
    expect(large.byteLength).toBeGreaterThan(small.byteLength);
  });

  it("produces approximately bitrate-sized output at 128 kbps", () => {
    // 128 kbps = 16 KB/s, 1 second of audio → ~16 KB.
    const sampleRate = 44100;
    const left = makeSineFloat32({ frequencyHz: 440, durationSec: 1, sampleRate });
    const out = encodePcmToMp3({ left, sampleRate, bitrate: 128 });
    expect(out.byteLength).toBeGreaterThan(8 * 1024);
    expect(out.byteLength).toBeLessThan(40 * 1024);
  });

  it("encodes silence without error", () => {
    const sampleRate = 44100;
    const left = new Float32Array(sampleRate); // 1 second of zeros
    const out = encodePcmToMp3({ left, sampleRate });
    expect(out.byteLength).toBeGreaterThan(0);
  });

  it("throws on missing or malformed inputs", () => {
    expect(() => encodePcmToMp3({})).toThrow();
    expect(() => encodePcmToMp3({ left: new Float32Array(10) })).toThrow();
    expect(() =>
      encodePcmToMp3({ left: [1, 2, 3], sampleRate: 44100 })
    ).toThrow();
    expect(() =>
      encodePcmToMp3({ left: new Float32Array(10), right: [1, 2, 3], sampleRate: 44100 })
    ).toThrow();
  });
});
