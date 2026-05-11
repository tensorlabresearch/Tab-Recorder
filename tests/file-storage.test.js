import { describe, it, expect } from "vitest";
import {
  generateSessionFolderName,
  generateAudioFileName,
  generateTranscriptFileName,
  getSupportedAudioFormats,
  getSupportedTranscriptFormats
} from "../extension/lib/fileStorage.js";

const FIXED_TIMESTAMP = new Date("2026-05-08T15:30:00Z").getTime();

describe("generateSessionFolderName", () => {
  it("uses YYYY-MM-DD/<sanitized-meeting-name> shape", () => {
    const out = generateSessionFolderName({
      startedAt: FIXED_TIMESTAMP,
      meetingLabel: "Team Standup"
    });
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}\/team-standup$/);
  });

  it("falls back to tabTitle when meetingLabel missing", () => {
    const out = generateSessionFolderName({
      startedAt: FIXED_TIMESTAMP,
      tabTitle: "Episode 7"
    });
    expect(out).toMatch(/\/episode-7$/);
  });

  it("falls back to 'untitled' when no name fields are set", () => {
    const out = generateSessionFolderName({ startedAt: FIXED_TIMESTAMP });
    expect(out).toMatch(/\/untitled$/);
  });

  it("uses the current date when startedAt is missing", () => {
    const out = generateSessionFolderName({ meetingLabel: "x" });
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}\/x$/);
  });

  it("strips characters that aren't word/whitespace/dash", () => {
    const out = generateSessionFolderName({
      startedAt: FIXED_TIMESTAMP,
      meetingLabel: "AI/ML <2026> Q&A"
    });
    expect(out.split("/")[1]).toBe("aiml-2026-qa");
  });

  it("collapses runs of whitespace to single dashes", () => {
    const out = generateSessionFolderName({
      startedAt: FIXED_TIMESTAMP,
      meetingLabel: "Lots   of    spaces"
    });
    expect(out.split("/")[1]).toBe("lots-of-spaces");
  });

  it("truncates the meeting name to 50 chars", () => {
    const out = generateSessionFolderName({
      startedAt: FIXED_TIMESTAMP,
      meetingLabel: "a".repeat(120)
    });
    expect(out.split("/")[1].length).toBe(50);
  });

  it("lower-cases the meeting name", () => {
    const out = generateSessionFolderName({
      startedAt: FIXED_TIMESTAMP,
      meetingLabel: "MIXEDCase"
    });
    expect(out.split("/")[1]).toBe("mixedcase");
  });
});

describe("generateAudioFileName", () => {
  it("produces <name>_HH-MM.<format>", () => {
    const out = generateAudioFileName({ startedAt: FIXED_TIMESTAMP, meetingLabel: "Foo" });
    expect(out).toMatch(/^Foo_\d{2}-\d{2}\.webm$/);
  });

  it("honours the format argument", () => {
    const out = generateAudioFileName({ startedAt: FIXED_TIMESTAMP, meetingLabel: "Foo" }, "mp3");
    expect(out.endsWith(".mp3")).toBe(true);
  });

  it("falls back to 'recording' when name fields missing", () => {
    const out = generateAudioFileName({ startedAt: FIXED_TIMESTAMP });
    expect(out).toMatch(/^recording_\d{2}-\d{2}\.webm$/);
  });

  it("uses 00-00 timestamp when startedAt is missing", () => {
    const out = generateAudioFileName({ meetingLabel: "abc" });
    expect(out).toBe("abc_00-00.webm");
  });

  it("preserves casing of the meeting label", () => {
    const out = generateAudioFileName({ startedAt: FIXED_TIMESTAMP, meetingLabel: "MixedCase" });
    expect(out.startsWith("MixedCase_")).toBe(true);
  });

  it("strips disallowed characters and squashes whitespace to dashes", () => {
    const out = generateAudioFileName({
      startedAt: FIXED_TIMESTAMP,
      meetingLabel: "AI/ML Q&A: prep"
    });
    expect(out).toMatch(/^AIML-QA-prep_\d{2}-\d{2}\.webm$/);
  });

  it("truncates the name portion to 40 chars", () => {
    const out = generateAudioFileName({
      startedAt: FIXED_TIMESTAMP,
      meetingLabel: "x".repeat(120)
    });
    const namePart = out.split("_")[0];
    expect(namePart.length).toBe(40);
  });
});

describe("generateTranscriptFileName", () => {
  it("produces <name>_HH-MM.<format>", () => {
    const out = generateTranscriptFileName({ startedAt: FIXED_TIMESTAMP, meetingLabel: "Foo" });
    expect(out).toMatch(/^Foo_\d{2}-\d{2}\.txt$/);
  });

  it("honours alternate transcript formats", () => {
    expect(
      generateTranscriptFileName({ startedAt: FIXED_TIMESTAMP, meetingLabel: "Foo" }, "json")
    ).toMatch(/\.json$/);
    expect(
      generateTranscriptFileName({ startedAt: FIXED_TIMESTAMP, meetingLabel: "Foo" }, "md")
    ).toMatch(/\.md$/);
  });

  it("falls back to 'transcript' when no name fields provided", () => {
    expect(generateTranscriptFileName({ startedAt: FIXED_TIMESTAMP })).toMatch(/^transcript_\d{2}-\d{2}\.txt$/);
  });
});

describe("getSupportedAudioFormats", () => {
  it("returns the expected entries with required fields", () => {
    const formats = getSupportedAudioFormats();
    expect(Array.isArray(formats)).toBe(true);
    expect(formats.length).toBeGreaterThan(0);
    for (const fmt of formats) {
      expect(typeof fmt.value).toBe("string");
      expect(typeof fmt.label).toBe("string");
    }
  });

  it("includes webm as the standard format", () => {
    const values = getSupportedAudioFormats().map((f) => f.value);
    expect(values).toContain("webm");
  });
});

describe("getSupportedTranscriptFormats", () => {
  it("returns the expected entries with required fields", () => {
    const formats = getSupportedTranscriptFormats();
    expect(Array.isArray(formats)).toBe(true);
    expect(formats.length).toBeGreaterThan(0);
    for (const fmt of formats) {
      expect(typeof fmt.value).toBe("string");
      expect(typeof fmt.label).toBe("string");
    }
  });

  it("includes txt, json, and md", () => {
    const values = getSupportedTranscriptFormats().map((f) => f.value);
    expect(values).toContain("txt");
    expect(values).toContain("json");
    expect(values).toContain("md");
  });
});
