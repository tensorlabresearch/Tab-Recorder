import { describe, it, expect } from "vitest";
import {
  SPEAKER_EMBED_MODELS,
  DEFAULT_SPEAKER_EMBED_MODEL_ID,
  findSpeakerEmbedModel
} from "../extension/lib/speakerEmbedModel.js";

describe("SPEAKER_EMBED_MODELS registry", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(SPEAKER_EMBED_MODELS)).toBe(true);
    expect(SPEAKER_EMBED_MODELS.length).toBeGreaterThan(0);
  });

  it("each entry has id/label/approxBytes", () => {
    for (const m of SPEAKER_EMBED_MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.label).toBe("string");
      expect(typeof m.approxBytes).toBe("number");
      expect(m.approxBytes).toBeGreaterThan(0);
    }
  });

  it("ids follow the Xenova/* naming convention", () => {
    for (const m of SPEAKER_EMBED_MODELS) {
      expect(m.id).toMatch(/^Xenova\//);
    }
  });

  it("ids are unique", () => {
    const ids = SPEAKER_EMBED_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DEFAULT_SPEAKER_EMBED_MODEL_ID points to a registered entry", () => {
    expect(SPEAKER_EMBED_MODELS.some((m) => m.id === DEFAULT_SPEAKER_EMBED_MODEL_ID)).toBe(true);
  });

  it("DEFAULT_SPEAKER_EMBED_MODEL_ID is the WavLM SV model", () => {
    expect(DEFAULT_SPEAKER_EMBED_MODEL_ID).toBe("Xenova/wavlm-base-plus-sv");
  });
});

describe("findSpeakerEmbedModel", () => {
  it("returns the matching entry by id", () => {
    const found = findSpeakerEmbedModel("Xenova/wavlm-base-plus-sv");
    expect(found).toBeTruthy();
    expect(found.id).toBe("Xenova/wavlm-base-plus-sv");
  });

  it("returns null for an unknown id", () => {
    expect(findSpeakerEmbedModel("Xenova/mystery-model")).toBeNull();
  });

  it("returns null for null/undefined/empty input", () => {
    expect(findSpeakerEmbedModel(null)).toBeNull();
    expect(findSpeakerEmbedModel(undefined)).toBeNull();
    expect(findSpeakerEmbedModel("")).toBeNull();
  });
});
