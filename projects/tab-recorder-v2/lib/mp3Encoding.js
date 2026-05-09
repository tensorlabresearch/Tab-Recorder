import { Mp3Encoder } from "./lamejs/lamejs.js";

const BLOCK_SIZE = 1152; // LAME's natural frame size

export function floatToInt16(float) {
  const out = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const s = Math.max(-1, Math.min(1, float[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function encodePcmToMp3({
  left,
  right = null,
  sampleRate,
  bitrate = 128,
  onProgress,
  progressInterval = 0.04
} = {}) {
  if (!left || !(left instanceof Float32Array)) {
    throw new Error("encodePcmToMp3: left channel Float32Array required");
  }
  if (right && !(right instanceof Float32Array)) {
    throw new Error("encodePcmToMp3: right channel must be Float32Array if provided");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("encodePcmToMp3: sampleRate required");
  }

  const channels = right ? 2 : 1;
  const clampedBitrate = Math.max(64, Math.min(320, Number(bitrate) || 128));
  const encoder = new Mp3Encoder(channels, sampleRate, clampedBitrate);
  const leftInt16 = floatToInt16(left);
  const rightInt16 = right ? floatToInt16(right) : null;
  const total = leftInt16.length;

  const chunks = [];
  let lastReported = 0;

  for (let i = 0; i < total; i += BLOCK_SIZE) {
    const end = Math.min(i + BLOCK_SIZE, total);
    const leftChunk = leftInt16.subarray(i, end);
    const rightChunk = rightInt16 ? rightInt16.subarray(i, end) : null;
    const buf = rightChunk
      ? encoder.encodeBuffer(leftChunk, rightChunk)
      : encoder.encodeBuffer(leftChunk);
    if (buf && buf.length > 0) chunks.push(buf);

    if (typeof onProgress === "function") {
      const progress = total === 0 ? 1 : i / total;
      if (progress - lastReported >= progressInterval) {
        lastReported = progress;
        onProgress(progress);
      }
    }
  }

  const flush = encoder.flush();
  if (flush && flush.length > 0) chunks.push(flush);

  if (typeof onProgress === "function") onProgress(1);

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
