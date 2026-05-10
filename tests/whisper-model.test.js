import { describe, it, expect } from "vitest";
import {
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL_ID,
  findModel,
  formatModelSize
} from "../projects/tab-recorder-v2/lib/whisperModel.js";

describe("WHISPER_MODELS registry", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(WHISPER_MODELS)).toBe(true);
    expect(WHISPER_MODELS.length).toBeGreaterThan(0);
  });

  it("each entry has id/label/approxBytes", () => {
    for (const m of WHISPER_MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.label).toBe("string");
      expect(typeof m.approxBytes).toBe("number");
      expect(m.approxBytes).toBeGreaterThan(0);
    }
  });

  it("ids follow the Xenova/whisper-* naming convention", () => {
    for (const m of WHISPER_MODELS) {
      expect(m.id).toMatch(/^Xenova\/whisper-/);
    }
  });

  it("ids are unique", () => {
    const ids = WHISPER_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DEFAULT_WHISPER_MODEL_ID points to a registered entry", () => {
    expect(WHISPER_MODELS.some((m) => m.id === DEFAULT_WHISPER_MODEL_ID)).toBe(true);
  });

  it("DEFAULT_WHISPER_MODEL_ID is the small English model", () => {
    expect(DEFAULT_WHISPER_MODEL_ID).toBe("Xenova/whisper-small.en");
  });
});

describe("findModel", () => {
  it("returns the matching entry by id", () => {
    const found = findModel("Xenova/whisper-small.en");
    expect(found).toBeTruthy();
    expect(found.id).toBe("Xenova/whisper-small.en");
  });

  it("returns null for an unknown id", () => {
    expect(findModel("Xenova/whisper-mythical")).toBeNull();
  });

  it("returns null for null/undefined/empty input", () => {
    expect(findModel(null)).toBeNull();
    expect(findModel(undefined)).toBeNull();
    expect(findModel("")).toBeNull();
  });
});

describe("formatModelSize", () => {
  it("renders MB for megabyte-range values", () => {
    expect(formatModelSize(80 * 1024 * 1024)).toBe("80 MB");
    expect(formatModelSize(244 * 1024 * 1024)).toBe("244 MB");
  });

  it("renders GB for gigabyte-range values", () => {
    expect(formatModelSize(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });

  it("rounds MB to whole numbers", () => {
    expect(formatModelSize(40 * 1024 * 1024 + 100 * 1024)).toBe("40 MB");
  });

  it("returns 0 B for zero / negative / non-numeric input", () => {
    expect(formatModelSize(0)).toBe("0 B");
    expect(formatModelSize(-1)).toBe("0 B");
    expect(formatModelSize(NaN)).toBe("0 B");
    expect(formatModelSize(undefined)).toBe("0 B");
    expect(formatModelSize(null)).toBe("0 B");
  });
});
