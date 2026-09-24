# Nemotron 3 Diarization in the browser: implementation handoff

**Status:** feasibility proven, mel frontend landed, state machine not started.
**Date:** 2026-09-24. **Last commit in this line of work:** `2fe1ff8`.

## Goal

Replace Tab Recorder's current diarization (WavLM speaker embeddings plus
clustering) with NVIDIA's Nemotron 3 Diarization, running locally in the
extension via `onnxruntime-web`. The model is end-to-end: it emits per-speaker
activity directly, handles overlapping speech, and supports up to 8 speakers.
It ranks #1 on VoiceArena's Diarization-Bench at 14.72% DER.

---

## 1. What is already proven

All of this was measured on an Apple Silicon Mac, not inferred.

### The ONNX export exists and is good

NVIDIA ships only a `.nemo` checkpoint. The usable artifact is a community
export:

- **File:** `nemotron-3-diarization/nemotron3_diar_v3.onnx` in
  [`altunenes/parakeet-rs`](https://huggingface.co/altunenes/parakeet-rs)
- **Size:** 400,506,656 bytes (400.5 MB), fp32, dynamic time axes
- **License:** OpenMDW-1.1, same as
  [`nvidia/Nemotron-3-Diarization`](https://huggingface.co/nvidia/Nemotron-3-Diarization).
  Permissive, commercial use fine.
- **Validated by the exporter** against NeMo 3.1.0's own `diarize()`: graph
  matches the PyTorch forward pass over 751 real streaming steps across all
  four latency presets, max difference ~7e-6. Full-pipeline segments identical
  to NeMo's at the three low-latency presets, within 10 ms at `offline()`.

> **Do not use `nvidia/Nemotron-3-Diarization-preview`.** It is manually gated
> and licensed for internal test and evaluation only, not production, and only
> on systems with NVIDIA GPUs. The non-preview repo is the open-weight one.

### onnxruntime-web can run it

Measured by loading the real file and running a synthetic offline step:

| Runtime | Per step | Throughput |
| --- | --- | --- |
| `onnxruntime-web`, wasm, **1 thread** | 4101 ms | **6.6x realtime** |
| `onnxruntime-node`, native CPU | 436 ms | 62.4x realtime |

One offline step covers 27.2 s of audio, so a 90-minute recording diarizes in
roughly **14 minutes** in the browser. The single-thread constraint is
deliberate and realistic: an extension page is not cross-origin isolated, so
there is no `SharedArrayBuffer` and no wasm threading. Treat 6.6x as the floor.

**WebGPU is untested** - there is no adapter under Node. It may be much faster;
it may also hit the same kind of wedging the whisper path did (see
`extension/lib/whisperClient.js` for the watchdog that exists because of it).

### Graph signature

```
inputs:
  chunk                   float32[1, 3048, 128]   log-mel features
  chunk_lengths           int64[1]
  spkcache                float32[1, 264, 512]    speaker cache embeddings
  spkcache_lengths        int64[1]
  fifo                    float32[1, 40, 512]     FIFO embeddings
  fifo_lengths            int64[1]

outputs:
  preds_diar              float32[1, 685, 8]      80 ms resolution, drives the cache
  preds_hires             float32[1, 5480, 8]     10 ms resolution, the results
  chunk_pre_encode_embs   float32[1, 381, 512]    embeddings to feed the FIFO
  chunk_pre_encode_lengths int64[1]
```

opset 17, 6134 nodes, 37 distinct op types, all standard (`MatMul`,
`LayerNormalization`, `Softmax`, `Erf`, `ScatterElements`, `AveragePool`, ...),
zero custom domains. That is why ORT-web executed it without complaint.

`chunk_frames = (chunk_len + right_context + left_context) * 8 = (340 + 40 + 1) * 8 = 3048`.

### Everything configurable is in the ONNX metadata

Read it with `metadata_props`; do not hardcode these.

```
chunk_len = 340                  spkcache_len = 264
right_context = 40               subsampling_factor = 8
fifo_len = 40                    upsample_factor = 8
spkcache_update_period = 300     n_spk = 8
feat_dim = 128                   emb_dim = 512
high_resolution = 1              spkcache_sil_frames_per_spk = 1
use_learnable_sil_emb = 1        learnable_sil_emb = <7424 chars>
```

The learned silence embedding lives outside the graph and is embedded here
because the runtime needs it to seed empty cache slots.

### The mel frontend is done

`extension/lib/melSpectrogram.js`, committed and tested. This is the piece the
graph needs because it takes features, not audio.

```js
import { createMelFrontend } from "./lib/melSpectrogram.js";

const frontend = createMelFrontend();               // build once, reuse
const { frames, nMels, data } = frontend.computeLogMel(pcm16kMono);
// data is Float32Array, row-major (frames, 128), ready to slice into `chunk`
```

It implements NeMo's `AudioToMelSpectrogramPreprocessor` as Sortformer
configures it: 16 kHz, n_fft 512, win 400, hop 160, 128 Slaney mels,
pre-emphasis 0.97, power spectrum, `log(x + 2^-24)`, and **no** normalization
(`normalize='NA'`).

Two things that silently wreck the features if you touch them:

- The analysis window is **rounded to bfloat16**. NeMo materializes it at that
  precision and the difference shows up downstream.
- Hann is **`periodic=False`** (divide by `N-1`) and zero-padded *centred* into
  the 512-point buffer, matching librosa's `pad_center`.

Validated against `tools/gen-mel-fixtures.py`, an independent numpy
implementation written from the same spec rather than shared code. Regenerate
fixtures with `python3 tools/gen-mel-fixtures.py` (needs numpy).

Throughput is a non-issue: **475x realtime** on a 10-minute signal.

---

## 2. What remains

### 2.1 The streaming state machine (the bulk of the work)

The ONNX call is trivial. The speaker cache and FIFO are managed entirely by
the caller, and that logic is the real port. Reference implementation:
[`parakeet-rs/src/sortformer.rs`](https://github.com/altunenes/parakeet-rs/blob/master/src/sortformer.rs),
~53 KB of Rust. Expect 800-1200 lines of JS.

Pieces, in dependency order:

1. **Chunk assembly.** Slice the mel output into 3048-frame windows with the
   right left/right context overlap, tracking which portion of each step's
   output is newly committed versus context.
2. **FIFO.** 40 slots of 512-dim embeddings sitting between the current chunk
   and the speaker cache. Fed from `chunk_pre_encode_embs`.
3. **Speaker cache.** 264 slots, refreshed every `spkcache_update_period = 300`
   steps from the FIFO. The scoring rules decide which frames earn a slot and
   are the fiddliest part; the relevant constants in `sortformer.rs` are:
   ```
   PRED_SCORE_THRESHOLD = 0.25    STRONG_BOOST_RATE = 0.75
   WEAK_BOOST_RATE = 1.5          MIN_POS_SCORES_RATE = 0.5
   SCORES_BOOST_LATEST = 0.05     SPKCACHE_SIL_FRAMES_PER_SPK = 1
   MAX_INDEX = 99999
   ```
   Empty slots are seeded with the learned silence embedding from metadata.
4. **Post-processing.** Hysteresis binarization of `preds_hires` (10 ms frames)
   into speaker segments, with onset/offset thresholds and padding. See
   `post_process` and the `binarize_matches_hysteresis` test in `sortformer.rs`
   for the exact expected behaviour: a speaker active in 10 ms frames 10..30
   must yield exactly one segment with sample offsets `10*160` to `30*160`.

The four latency presets (`offline`, `low_latency`, `very_low_latency`,
`ultra_low_latency`) are runtime parameter sets over the same file. For a
recording app, `offline()` is the only one that matters: chunk 340, right
context 40, fifo 40, update 300, cache 264. It is also the fastest per second
of audio.

### 2.2 Model delivery

400 MB fp32, on top of the 538 MB whisper model the extension already pulls.
That is a lot to ask.

Quantizing is the obvious lever but **must be measured, not assumed**. The
whisper work in this repo established that encoders are quantization-sensitive
(see `extension/lib/whisperModel.js`, where every model pairs a full-precision
encoder with a 4-bit decoder for exactly this reason). Validate any quantized
Sortformer against NeMo or parakeet-rs output before shipping it.

Reuse the existing consent machinery rather than inventing new UI:
`getModelDownloadConsent` / `setModelDownloadConsent` in `whisperModel.js` and
the `model-download-consent` blocker in `extension/lib/transcriptionHealth.js`
already handle the one-time prompt, per model id.

---

## 3. Validation strategy (open decision)

The mel stage had a clean numeric spec, so a second implementation in numpy
gave real ground truth. The state machine does not have that: its ground truth
is parakeet-rs itself.

Two options, not yet chosen:

- **End-to-end.** Port it, then compare final segments against NeMo's published
  output on a known file. Faster to reach, but a bug surfaces far from its
  cause.
- **Per-step fixtures.** Install Rust, instrument parakeet-rs to dump the
  cache/FIFO tensors at each step, and assert against them the way
  `tests/mel-spectrogram.test.js` does. Slower to set up, catches errors where
  they happen.

The second is recommended given how stateful the cache logic is, but the call
belongs to whoever picks this up.

---

## 4. Integration points in this codebase

Current diarization, for reference and eventual replacement:

| File | Role |
| --- | --- |
| `extension/lib/diarize.js` | Orchestrates embed-per-utterance plus clustering |
| `extension/lib/diarizationWorker.js` | WavLM speaker embeddings via transformers.js |
| `extension/lib/diarizationWorkerClient.js` | Worker message plumbing |
| `extension/lib/embeddingCluster.js` | Clusters embeddings into speakers |
| `extension/lib/utteranceSegmenter.js` | Splits Whisper segments into utterances |
| `extension/lib/diarizedTranscript.js` | Writes `.diarized.txt` / `.diarized.json` |
| `panel.js: diarizeSession` (~2592) | Manual "Diarize" row action |
| `panel.js: maybeAutoDiarize` (~3474) | Auto-diarize after transcription |

Sortformer collapses items 1-5: it consumes audio directly and emits speaker
segments, so it needs neither Whisper segments nor clustering. Note that the
current path *requires* `session._fsSegmentsJsonPath` (Whisper segments) before
it will diarize; Sortformer removes that dependency, which is an improvement
worth taking rather than preserving.

Output format should stay compatible with `formatDiarizedText` /
`formatDiarizedJson` so the rest of the UI keeps working unchanged.

Patterns worth copying rather than reinventing:

- **`extension/lib/whisperClient.js`** - worker client with a liveness
  watchdog, stall detection and CPU-fallback retry. A 400 MB model on ORT-web
  will need the same treatment; it exists because a lost WebGPU device hung a
  job for hours with no error.
- **`extension/lib/jobQueue.js`** - jobs carry an `AbortController`, so long
  runs can be stopped.
- **Chunk-level progress** - see `runChunkedWhisperTranscription` in `panel.js`
  for how per-chunk progress and partial failure are surfaced.

---

## 5. Reproducing the measurements

```bash
# Model (400 MB). HF resets the connection often; resume on failure.
curl -L --retry 8 --retry-all-errors -C - \
  -o nemotron3_diar_v3.onnx \
  https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-3-diarization/nemotron3_diar_v3.onnx

# onnxruntime-node and onnxruntime-web are already in node_modules.
# Load it, print the I/O signature, run a timed synthetic step under both.
```

The probe script used for the numbers above is not committed (it lived in a
scratch directory). It is ~100 lines: decode `metadata_props` with protobufjs,
create an `InferenceSession` under each runtime, feed random tensors of the
shapes in §1, and time three steady-state runs. Rebuild it if you need to
re-measure; set `ort.env.wasm.numThreads = 1` for a realistic browser number.

---

## 6. Open questions

1. **WebGPU.** Untested. Could change the performance picture entirely, in
   either direction.
2. **Quantization.** Can the 400 MB come down without wrecking DER? Needs
   measurement against NeMo output.
3. **Validation approach** for the state machine (§3).
4. **Whether to keep WavLM at all.** Sortformer caps at 8 speakers. If that is
   acceptable for meeting recordings, the old path can be deleted rather than
   kept as a fallback, which removes a lot of code.

## 7. Sources

- [Nemotron 3 Diarization announcement](https://huggingface.co/blog/nvidia/nemotron-diarization)
  (architecture: streaming Sortformer, 31-layer transformer encoder with RoPE, 100M params)
- [`nvidia/Nemotron-3-Diarization`](https://huggingface.co/nvidia/Nemotron-3-Diarization) (open weights, OpenMDW-1.1)
- [ONNX export + parakeet-rs](https://github.com/altunenes/parakeet-rs), export script
  `scripts/export_diar_sortformer.py`
- [NeMo issue #15077](https://github.com/NVIDIA-NeMo/NeMo/issues/15077) - why exporting
  streaming Sortformer from NeMo directly still fails, for context if you ever need to
  re-export
