/**
 * NeMo-style log-mel frontend for the Sortformer diarization models
 * (Nemotron 3 Diarization / diar_streaming_sortformer).
 *
 * The exported ONNX graph takes 128-dimensional features, not audio, so this
 * is the piece that has to exist in JS before the model can run in the
 * browser. It is deliberately not Whisper's frontend: different mel count,
 * different mel scale, pre-emphasis, no normalization.
 *
 * Pipeline, matching NeMo's AudioToMelSpectrogramPreprocessor as configured
 * for Sortformer:
 *
 *   pre-emphasis 0.97
 *   -> centre-pad by n_fft/2
 *   -> Hann window (periodic=False) rounded to bfloat16, zero-padded centred
 *      into n_fft
 *   -> rFFT, power spectrum (mag_power = 2)
 *   -> Slaney mel filterbank, 128 bands, Slaney-normalized
 *   -> log(x + 2^-24)
 *   -> (time, mels), normalize='NA' so no mean/variance step
 *
 * Verified against an independent numpy implementation; see
 * tools/gen-mel-fixtures.py and tests/mel-spectrogram.test.js.
 */

export const SORTFORMER_MEL_CONFIG = Object.freeze({
  sampleRate: 16000,
  nFft: 512,
  winLength: 400,
  hopLength: 160,
  nMels: 128,
  preemphasis: 0.97,
  // NeMo: log_zero_guard_type="add", log_zero_guard_value=2**-24.
  logZeroGuard: 2 ** -24
});

// Slaney mel scale, the htk=False branch in librosa.
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOG_STEP = 0.06875177742094912;

const bf16Float = new Float32Array(1);
const bf16Bits = new Uint32Array(bf16Float.buffer);

/**
 * Round a float32 to bfloat16 precision (round-half-to-even) and back.
 *
 * NeMo materializes the analysis window in bfloat16. Keeping full float32
 * precision here shifts the resulting features enough to be visible in the
 * model's output, so the loss of precision has to be reproduced, not skipped.
 */
export function toBf16(value) {
  bf16Float[0] = value;
  const bits = bf16Bits[0];
  bf16Bits[0] = (bits + 0x7fff + ((bits >>> 16) & 1)) & 0xffff0000;
  return bf16Float[0];
}

export function hzToMel(hz) {
  return hz < MIN_LOG_HZ ? hz / F_SP : MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP;
}

export function melToHz(mel) {
  return mel < MIN_LOG_MEL ? mel * F_SP : MIN_LOG_HZ * Math.exp((mel - MIN_LOG_MEL) * LOG_STEP);
}

/**
 * Slaney mel filterbank, stored sparsely: each band is a triangle covering one
 * contiguous run of FFT bins, so applying it walks only the non-zero weights
 * instead of a 128 x 257 dense multiply per frame.
 *
 * @returns {{nMels: number, freqBins: number, starts: Int32Array, lengths: Int32Array, weights: Float32Array, offsets: Int32Array}}
 */
export function createMelFilterbank({
  nFft = SORTFORMER_MEL_CONFIG.nFft,
  nMels = SORTFORMER_MEL_CONFIG.nMels,
  sampleRate = SORTFORMER_MEL_CONFIG.sampleRate
} = {}) {
  const freqBins = Math.floor(nFft / 2) + 1;
  const melMin = hzToMel(0);
  const melMax = hzToMel(sampleRate / 2);

  const points = new Float64Array(nMels + 2);
  for (let i = 0; i < points.length; i++) {
    points[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }

  const fftFreqs = new Float64Array(freqBins);
  for (let k = 0; k < freqBins; k++) fftFreqs[k] = (k * sampleRate) / nFft;

  const starts = new Int32Array(nMels);
  const lengths = new Int32Array(nMels);
  const offsets = new Int32Array(nMels + 1);
  const rows = [];

  for (let i = 0; i < nMels; i++) {
    const lowerStep = points[i + 1] - points[i];
    const upperStep = points[i + 2] - points[i + 1];
    const enorm = 2 / (points[i + 2] - points[i]);

    const row = [];
    let start = -1;
    for (let k = 0; k < freqBins; k++) {
      const lower = (fftFreqs[k] - points[i]) / lowerStep;
      const upper = (points[i + 2] - fftFreqs[k]) / upperStep;
      const weight = Math.max(0, Math.min(lower, upper)) * enorm;
      if (weight > 0) {
        if (start < 0) start = k;
        row.push(weight);
      } else if (start >= 0) {
        break; // Triangles are contiguous; past the far edge there is nothing.
      }
    }
    starts[i] = start < 0 ? 0 : start;
    lengths[i] = row.length;
    rows.push(row);
  }

  let total = 0;
  for (let i = 0; i < nMels; i++) {
    offsets[i] = total;
    total += lengths[i];
  }
  offsets[nMels] = total;

  const weights = new Float32Array(total);
  let w = 0;
  for (const row of rows) for (const value of row) weights[w++] = value;

  return { nMels, freqBins, starts, lengths, offsets, weights };
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT over separate real/imaginary
 * arrays, with the twiddle and bit-reversal tables built once per size.
 */
function createFft(n) {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
  const levels = Math.log2(n);
  const half = n / 2;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const reversed = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1);
      x >>>= 1;
    }
    reversed[i] = r;
  }

  return function transform(re, im) {
    for (let i = 0; i < n; i++) {
      const j = reversed[i];
      if (j > i) {
        let tmp = re[i];
        re[i] = re[j];
        re[j] = tmp;
        tmp = im[i];
        im[i] = im[j];
        im[j] = tmp;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + halfSize; j++, k += step) {
          const l = j + halfSize;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

/** Hann window, periodic=False, bf16-rounded, zero-padded centred into nFft. */
export function createAnalysisWindow({
  nFft = SORTFORMER_MEL_CONFIG.nFft,
  winLength = SORTFORMER_MEL_CONFIG.winLength
} = {}) {
  const window = new Float32Array(nFft);
  const offset = Math.floor((nFft - winLength) / 2);
  const denominator = winLength - 1;
  for (let i = 0; i < winLength; i++) {
    const value = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denominator);
    window[offset + i] = toBf16(value);
  }
  return window;
}

/** Number of frames the frontend produces for a given sample count. */
export function melFrameCount(sampleCount, config = SORTFORMER_MEL_CONFIG) {
  const { nFft, hopLength } = { ...SORTFORMER_MEL_CONFIG, ...config };
  const padded = Math.max(0, sampleCount) + 2 * Math.floor(nFft / 2);
  if (padded < nFft) return 0;
  return Math.floor((padded - nFft) / hopLength) + 1;
}

/**
 * Build a reusable frontend. The filterbank, window and FFT tables are
 * deterministic from the config, so a long recording should compute them once
 * rather than per call.
 */
export function createMelFrontend(overrides = {}) {
  const config = Object.freeze({ ...SORTFORMER_MEL_CONFIG, ...overrides });
  const { nFft, winLength, hopLength, nMels, sampleRate, preemphasis, logZeroGuard } = config;

  const filterbank = createMelFilterbank({ nFft, nMels, sampleRate });
  const window = createAnalysisWindow({ nFft, winLength });
  const fft = createFft(nFft);

  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const power = new Float64Array(filterbank.freqBins);

  /**
   * @param {Float32Array|ArrayLike<number>} audio mono samples at `sampleRate`
   * @returns {{frames: number, nMels: number, data: Float32Array}} row-major (time, mels)
   */
  function computeLogMel(audio) {
    const samples = audio instanceof Float32Array ? audio : Float32Array.from(audio || []);
    const frames = melFrameCount(samples.length, config);
    const data = new Float32Array(frames * nMels);
    if (frames === 0) return { frames: 0, nMels, data };

    // Pre-emphasis into a padded buffer, so framing can index it directly
    // instead of branching on the pad regions inside the hot loop.
    const pad = Math.floor(nFft / 2);
    const padded = new Float32Array(samples.length + 2 * pad);
    if (samples.length > 0) {
      padded[pad] = samples[0];
      for (let i = 1; i < samples.length; i++) {
        padded[pad + i] = samples[i] - preemphasis * samples[i - 1];
      }
    }

    for (let t = 0; t < frames; t++) {
      const start = t * hopLength;
      for (let i = 0; i < nFft; i++) {
        re[i] = padded[start + i] * window[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < power.length; k++) {
        power[k] = re[k] * re[k] + im[k] * im[k];
      }

      const rowBase = t * nMels;
      for (let m = 0; m < nMels; m++) {
        const from = filterbank.offsets[m];
        const count = filterbank.lengths[m];
        const binBase = filterbank.starts[m];
        let sum = 0;
        for (let j = 0; j < count; j++) {
          sum += filterbank.weights[from + j] * power[binBase + j];
        }
        data[rowBase + m] = Math.log(sum + logZeroGuard);
      }
    }

    return { frames, nMels, data };
  }

  return { config, filterbank, window, computeLogMel };
}

/** One-shot convenience wrapper; prefer `createMelFrontend` for repeated use. */
export function computeLogMel(audio, overrides = {}) {
  return createMelFrontend(overrides).computeLogMel(audio);
}
