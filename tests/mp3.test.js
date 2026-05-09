import { describe, it, expect } from "vitest";
import { Mp3Encoder } from "../projects/tab-recorder-v2/lib/lamejs/lamejs.js";

function encodeMonoPcm(pcm, sampleRate, bitrate = 128) {
  const encoder = new Mp3Encoder(1, sampleRate, bitrate);
  const blockSize = 1152;
  const chunks = [];
  for (let i = 0; i < pcm.length; i += blockSize) {
    const buf = encoder.encodeBuffer(pcm.subarray(i, Math.min(i + blockSize, pcm.length)));
    if (buf && buf.length > 0) chunks.push(buf);
  }
  const flush = encoder.flush();
  if (flush && flush.length > 0) chunks.push(flush);

  let totalBytes = 0;
  for (const c of chunks) totalBytes += c.length;
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

function makeSineWave({ frequencyHz, durationSec, sampleRate, amplitude = 0.5 }) {
  const numSamples = Math.floor(sampleRate * durationSec);
  const pcm = new Int16Array(numSamples);
  const peak = Math.floor(0x7fff * amplitude);
  for (let i = 0; i < numSamples; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * peak);
  }
  return pcm;
}

describe("lamejs Mp3Encoder", () => {
  it("produces a non-empty MP3 buffer for a sine wave", () => {
    const sampleRate = 44100;
    const pcm = makeSineWave({ frequencyHz: 440, durationSec: 0.5, sampleRate });
    const mp3 = encodeMonoPcm(pcm, sampleRate);
    expect(mp3.byteLength).toBeGreaterThan(0);
  });

  it("output starts with an MP3 frame sync header", () => {
    const sampleRate = 44100;
    const pcm = makeSineWave({ frequencyHz: 440, durationSec: 0.2, sampleRate });
    const mp3 = encodeMonoPcm(pcm, sampleRate);

    // MP3 frame sync: 11 bits set (0xFF 0xE0..0xFF in second byte's top bits).
    // ID3 tags also start with "ID3"; lamejs doesn't write ID3 by default.
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1] & 0xe0).toBe(0xe0);
  });

  it("output size is in the right ballpark for 128 kbps", () => {
    const sampleRate = 44100;
    const durationSec = 1;
    const pcm = makeSineWave({ frequencyHz: 440, durationSec, sampleRate });
    const mp3 = encodeMonoPcm(pcm, sampleRate, 128);

    // 128 kbps = 16 KB per second of audio. Allow generous slack for CBR padding,
    // small-input warmup frames, and end-of-stream tail.
    expect(mp3.byteLength).toBeGreaterThan(8 * 1024);
    expect(mp3.byteLength).toBeLessThan(40 * 1024);
  });

  it("higher bitrate produces a larger file for the same input", () => {
    const sampleRate = 44100;
    const pcm = makeSineWave({ frequencyHz: 440, durationSec: 1, sampleRate });
    const small = encodeMonoPcm(pcm, sampleRate, 64);
    const large = encodeMonoPcm(pcm, sampleRate, 192);
    expect(large.byteLength).toBeGreaterThan(small.byteLength);
  });

  it("handles silence without crashing", () => {
    const sampleRate = 44100;
    const pcm = new Int16Array(sampleRate); // 1 second of zeros
    const mp3 = encodeMonoPcm(pcm, sampleRate);
    expect(mp3.byteLength).toBeGreaterThan(0);
  });

  it("encodes stereo input to a non-empty buffer", () => {
    const sampleRate = 44100;
    const left = makeSineWave({ frequencyHz: 440, durationSec: 0.5, sampleRate });
    const right = makeSineWave({ frequencyHz: 660, durationSec: 0.5, sampleRate });
    const encoder = new Mp3Encoder(2, sampleRate, 128);
    const blockSize = 1152;
    const chunks = [];
    for (let i = 0; i < left.length; i += blockSize) {
      const lc = left.subarray(i, Math.min(i + blockSize, left.length));
      const rc = right.subarray(i, Math.min(i + blockSize, right.length));
      const buf = encoder.encodeBuffer(lc, rc);
      if (buf && buf.length > 0) chunks.push(buf);
    }
    const flush = encoder.flush();
    if (flush && flush.length > 0) chunks.push(flush);
    let total = 0;
    for (const c of chunks) total += c.length;
    expect(total).toBeGreaterThan(0);
  });
});
