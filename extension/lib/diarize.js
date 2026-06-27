// Core diarization pipeline. Pure logic — no Web Worker, no Cache API,
// no DOM. The expensive embed step is injected by the caller so this
// module is fully unit-testable and the panel wiring (PR4b) can supply
// a real worker-backed embed function later.
//
// Inputs / outputs:
//   diarize({
//     segments,       // Whisper-style [{ start, end, text }] in ms.
//     pcm16k,         // Float32Array of 16 kHz mono audio.
//     embedFn,        // async (Float32Array) => Float32Array (size 512 for WavLM-SV).
//     segmenterOpts?, // forwarded to segmentWordsToUtterances
//     clusterOpts?,   // forwarded to clusterEmbeddings
//     onUtteranceProgress? // (currentIndex, total) => void
//   }) -> { utterances: [{ startSec, endSec, tokens, text, speakerId }],
//           speakerCount: number,
//           skipped: "too-few-utterances" | null }

import { segmentWordsToUtterances } from "./utteranceSegmenter.js";
import { clusterEmbeddings } from "./embeddingCluster.js";

export const TARGET_SAMPLE_RATE = 16_000;

export async function diarize({
  segments,
  pcm16k,
  embedFn,
  segmenterOpts,
  clusterOpts,
  onUtteranceProgress
} = {}) {
  if (typeof embedFn !== "function") {
    throw new Error("diarize requires an embedFn(Float32Array) => Float32Array");
  }
  if (!(pcm16k instanceof Float32Array)) {
    throw new Error("diarize requires pcm16k as a Float32Array of 16 kHz mono audio");
  }

  const utterances = segmentWordsToUtterances(segments, segmenterOpts);
  if (utterances.length < 2) {
    return {
      utterances: utterances.map((u) => ({ ...u, speakerId: 0 })),
      speakerCount: utterances.length,
      skipped: "too-few-utterances"
    };
  }

  const embeddings = [];
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    const slice = sliceAudio(pcm16k, u.startSec, u.endSec);
    const emb = await embedFn(slice);
    embeddings.push(emb);
    if (typeof onUtteranceProgress === "function") {
      onUtteranceProgress(i + 1, utterances.length);
    }
  }

  const clusterIds = clusterEmbeddings(embeddings, clusterOpts);
  const labeled = utterances.map((u, i) => ({
    ...u,
    speakerId: clusterIds[i]
  }));
  const speakerCount = new Set(Array.from(clusterIds)).size;
  return { utterances: labeled, speakerCount, skipped: null };
}

export function sliceAudio(pcm, startSec, endSec, sampleRate = TARGET_SAMPLE_RATE) {
  const startSample = Math.max(0, Math.floor(startSec * sampleRate));
  const endSample = Math.min(pcm.length, Math.ceil(endSec * sampleRate));
  if (endSample <= startSample) return new Float32Array(0);
  return pcm.subarray(startSample, endSample);
}
