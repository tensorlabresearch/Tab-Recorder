#!/usr/bin/env python3
"""Generate golden fixtures for the Sortformer log-mel frontend.

This is an independent reference implementation of NeMo's preprocessor as the
Nemotron 3 Diarization / Streaming Sortformer models expect it, written from
the same spec the JS port follows but with numpy rather than shared code. Two
implementations agreeing is the point: it catches transcription errors in the
port that a self-consistent test never would.

Pipeline (NeMo AudioToMelSpectrogramPreprocessor, Sortformer settings):

    preemphasis 0.97
    -> pad n_fft//2 both sides (center=True)
    -> Hann window, periodic=False, rounded to bfloat16, zero-padded
       centered into n_fft
    -> rfft, power spectrum (mag_power=2)
    -> Slaney mel filterbank, 128 bands, 0..sr/2, Slaney-normalized
    -> log(x + 2**-24)
    -> transpose to (time, features); normalize='NA', i.e. none

Usage:  python3 tools/gen-mel-fixtures.py
Writes: tests/fixtures/mel-sortformer.json
"""

import json
import pathlib

import numpy as np

SAMPLE_RATE = 16000
N_FFT = 512
WIN_LENGTH = 400
HOP_LENGTH = 160
N_MELS = 128
PREEMPH = 0.97
LOG_ZERO_GUARD = 2.0**-24

# Slaney mel scale constants (librosa's htk=False path).
F_SP = 200.0 / 3.0
MIN_LOG_HZ = 1000.0
MIN_LOG_MEL = MIN_LOG_HZ / F_SP
LOG_STEP = 0.06875177742094912


def to_bf16(x):
    """Round float32 to bfloat16 precision, round-half-to-even, back to f32.

    NeMo's window tensor is materialized in bfloat16; keeping full float32
    precision here shifts the features enough to matter downstream.
    """
    bits = np.asarray(x, dtype=np.float32).view(np.uint32).astype(np.uint64)
    rounded = (bits + 0x7FFF + ((bits >> 16) & 1)) & 0xFFFF0000
    return rounded.astype(np.uint32).view(np.float32)


def hz_to_mel(hz):
    hz = np.asarray(hz, dtype=np.float64)
    # np.where evaluates both branches, so guard the log against hz == 0.
    safe = np.maximum(hz, np.finfo(np.float64).tiny)
    return np.where(hz < MIN_LOG_HZ, hz / F_SP, MIN_LOG_MEL + np.log(safe / MIN_LOG_HZ) / LOG_STEP)


def mel_to_hz(mel):
    mel = np.asarray(mel, dtype=np.float64)
    return np.where(
        mel < MIN_LOG_MEL, mel * F_SP, MIN_LOG_HZ * np.exp((mel - MIN_LOG_MEL) * LOG_STEP)
    )


def mel_filterbank(n_fft=N_FFT, n_mels=N_MELS, sample_rate=SAMPLE_RATE):
    freq_bins = n_fft // 2 + 1
    mel_min = hz_to_mel(0.0)
    mel_max = hz_to_mel(sample_rate / 2.0)
    points = mel_to_hz(mel_min + (mel_max - mel_min) * np.arange(n_mels + 2) / (n_mels + 1))
    fft_freqs = np.arange(freq_bins) * sample_rate / n_fft
    fdiff = np.diff(points)

    fb = np.zeros((n_mels, freq_bins), dtype=np.float64)
    for i in range(n_mels):
        lower = (fft_freqs - points[i]) / fdiff[i]
        upper = (points[i + 2] - fft_freqs) / fdiff[i + 1]
        fb[i] = np.maximum(0.0, np.minimum(lower, upper))
        fb[i] *= 2.0 / (points[i + 2] - points[i])  # Slaney normalization
    return fb.astype(np.float32)


def preemphasis(audio, coef=PREEMPH):
    if audio.size == 0:
        return audio
    out = np.empty_like(audio)
    out[0] = audio[0]
    out[1:] = audio[1:] - coef * audio[:-1]
    return out


def fft_window():
    n = WIN_LENGTH - 1
    hann = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(WIN_LENGTH) / n)
    hann = to_bf16(hann.astype(np.float32))
    window = np.zeros(N_FFT, dtype=np.float32)
    offset = (N_FFT - WIN_LENGTH) // 2
    window[offset : offset + WIN_LENGTH] = hann
    return window


def log_mel(audio):
    audio = np.asarray(audio, dtype=np.float32)
    emphasized = preemphasis(audio)

    pad = N_FFT // 2
    padded = np.concatenate(
        [np.zeros(pad, dtype=np.float32), emphasized, np.zeros(pad, dtype=np.float32)]
    )
    num_frames = (len(padded) - N_FFT) // HOP_LENGTH + 1
    window = fft_window()

    power = np.empty((N_FFT // 2 + 1, num_frames), dtype=np.float32)
    for t in range(num_frames):
        start = t * HOP_LENGTH
        spectrum = np.fft.rfft(padded[start : start + N_FFT] * window)
        power[:, t] = (spectrum.real**2 + spectrum.imag**2).astype(np.float32)

    mel = mel_filterbank() @ power
    return np.log(mel + LOG_ZERO_GUARD).T  # (time, mels), no normalization


def lcg(n, seed=12345):
    """Deterministic pseudo-random audio, reproducible in JS with the same constants."""
    out = np.empty(n, dtype=np.float32)
    state = np.uint32(seed)
    for i in range(n):
        state = np.uint32((np.uint64(state) * np.uint64(1664525) + np.uint64(1013904223)) % (1 << 32))
        out[i] = (float(state) / 2147483648.0) - 1.0
    return out


def sine(freq, n, sample_rate=SAMPLE_RATE):
    return np.sin(2.0 * np.pi * freq * np.arange(n) / sample_rate).astype(np.float32)


def main():
    cases = {
        # 0.5 s each: enough frames to exercise framing without a huge fixture.
        "silence": np.zeros(8000, dtype=np.float32),
        "sine1k": sine(1000.0, 8000),
        "noise": lcg(8000),
        # Shorter than one full window, to pin the framing edge case.
        "short": lcg(300, seed=999),
    }

    fixtures = {
        "_comment": "Generated by tools/gen-mel-fixtures.py. Do not edit by hand.",
        "config": {
            "sampleRate": SAMPLE_RATE,
            "nFft": N_FFT,
            "winLength": WIN_LENGTH,
            "hopLength": HOP_LENGTH,
            "nMels": N_MELS,
            "preemphasis": PREEMPH,
        },
        # A few filterbank rows, to catch a wrong mel scale independently of the STFT.
        "filterbank": {},
        "cases": {},
    }

    fb = mel_filterbank()
    for row in (0, 1, 64, 127):
        nz = np.nonzero(fb[row])[0]
        fixtures["filterbank"][str(row)] = {
            "firstBin": int(nz[0]),
            "lastBin": int(nz[-1]),
            "values": [round(float(v), 9) for v in fb[row][nz[0] : nz[-1] + 1]],
        }

    for name, audio in cases.items():
        mel = log_mel(audio)
        fixtures["cases"][name] = {
            "samples": int(audio.size),
            "frames": int(mel.shape[0]),
            "mels": int(mel.shape[1]),
            # Whole frames at the start, middle and end; plus per-frame sums,
            # which catch a drift that spot-checked frames would miss.
            "frame0": [round(float(v), 6) for v in mel[0]],
            "frameMid": [round(float(v), 6) for v in mel[mel.shape[0] // 2]],
            "frameLast": [round(float(v), 6) for v in mel[-1]],
            "frameSums": [round(float(v), 4) for v in mel.sum(axis=1)],
        }

    out = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "mel-sortformer.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixtures, indent=1) + "\n")
    print(f"wrote {out}")
    for name, case in fixtures["cases"].items():
        print(f"  {name}: {case['samples']} samples -> {case['frames']} frames x {case['mels']}")


if __name__ == "__main__":
    main()
