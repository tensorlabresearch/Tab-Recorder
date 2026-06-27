import { describe, expect, it } from "vitest";
import {
  LARGE_TRANSCRIPTION_THRESHOLD_MS,
  TRANSCRIPTION_CHUNK_MS,
  TRANSCRIPTION_CHUNK_OVERLAP_MS,
  createTranscriptionChunkPlan,
  mergeTranscriptionChunkResults,
  offsetTranscriptionSegment,
  segmentBelongsToTranscriptionChunk
} from "../extension/lib/transcriptionChunks.js";

describe("createTranscriptionChunkPlan", () => {
  it("uses a single chunk below the large-recording threshold", () => {
    const plan = createTranscriptionChunkPlan(5 * 60 * 1000);

    expect(plan.thresholdMs).toBe(LARGE_TRANSCRIPTION_THRESHOLD_MS);
    expect(plan.chunkMs).toBe(TRANSCRIPTION_CHUNK_MS);
    expect(plan.overlapMs).toBe(TRANSCRIPTION_CHUNK_OVERLAP_MS);
    expect(plan.chunked).toBe(false);
    expect(plan.chunks).toEqual([
      {
        index: 0,
        total: 1,
        coreStartMs: 0,
        coreEndMs: 5 * 60 * 1000,
        audioStartMs: 0,
        audioEndMs: 5 * 60 * 1000
      }
    ]);
  });

  it("splits a four hour recording into overlapping ten minute chunks", () => {
    const plan = createTranscriptionChunkPlan(4 * 60 * 60 * 1000);

    expect(plan.chunked).toBe(true);
    expect(plan.chunks).toHaveLength(24);
    expect(plan.chunks[0]).toMatchObject({
      index: 0,
      total: 24,
      coreStartMs: 0,
      coreEndMs: 10 * 60 * 1000,
      audioStartMs: 0,
      audioEndMs: 10 * 60 * 1000 + 10 * 1000
    });
    expect(plan.chunks[1]).toMatchObject({
      index: 1,
      total: 24,
      coreStartMs: 10 * 60 * 1000,
      coreEndMs: 20 * 60 * 1000,
      audioStartMs: 10 * 60 * 1000 - 10 * 1000,
      audioEndMs: 20 * 60 * 1000 + 10 * 1000
    });
    expect(plan.chunks[23]).toMatchObject({
      index: 23,
      total: 24,
      coreStartMs: 230 * 60 * 1000,
      coreEndMs: 240 * 60 * 1000,
      audioEndMs: 240 * 60 * 1000
    });
  });

  it("returns no chunks for invalid duration", () => {
    const plan = createTranscriptionChunkPlan(0);

    expect(plan.chunked).toBe(false);
    expect(plan.chunks).toEqual([]);
  });
});

describe("transcription chunk segment helpers", () => {
  it("offsets segment timestamps into global recording time", () => {
    expect(offsetTranscriptionSegment({ text: " hello ", start: 1250, end: 2000 }, 10_000)).toEqual({
      text: "hello",
      start: 11_250,
      end: 12_000
    });
  });

  it("checks segment membership by midpoint against the chunk core", () => {
    const plan = createTranscriptionChunkPlan(25_000, {
      thresholdMs: 1,
      chunkMs: 10_000,
      overlapMs: 2_000
    });

    expect(segmentBelongsToTranscriptionChunk({ text: "a", start: 9_500, end: 10_500 }, plan.chunks[0])).toBe(false);
    expect(segmentBelongsToTranscriptionChunk({ text: "b", start: 9_500, end: 10_500 }, plan.chunks[1])).toBe(true);
    expect(segmentBelongsToTranscriptionChunk({ text: "c", start: 24_500, end: 25_000 }, plan.chunks[2])).toBe(true);
  });
});

describe("mergeTranscriptionChunkResults", () => {
  it("offsets chunks, filters overlap regions, and glues text in timestamp order", () => {
    const plan = createTranscriptionChunkPlan(25_000, {
      thresholdMs: 1,
      chunkMs: 10_000,
      overlapMs: 2_000
    });

    const out = mergeTranscriptionChunkResults([
      {
        chunk: plan.chunks[0],
        result: {
          segments: [
            { text: "zero", start: 0, end: 1000 },
            { text: "drop after core", start: 10_500, end: 11_500 }
          ]
        }
      },
      {
        chunk: plan.chunks[1],
        result: {
          segments: [
            { text: "ten", start: 3000, end: 4000 },
            { text: "drop after second core", start: 13_000, end: 13_500 }
          ]
        }
      },
      {
        chunk: plan.chunks[2],
        result: {
          segments: [{ text: "twenty", start: 2500, end: 3500 }]
        }
      }
    ]);

    expect(out.text).toBe("zero ten twenty");
    expect(out.segments).toEqual([
      { text: "zero", start: 0, end: 1000 },
      { text: "ten", start: 11_000, end: 12_000 },
      { text: "twenty", start: 20_500, end: 21_500 }
    ]);
  });

  it("falls back to chunk text when timestamp segments are unavailable", () => {
    const out = mergeTranscriptionChunkResults([
      { result: { text: "first part" } },
      { result: { text: "second part" } }
    ]);

    expect(out).toEqual({ text: "first part second part", segments: [] });
  });
});
