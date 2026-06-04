import { describe, it, expect } from "vitest";
import {
  formatDiarizedText,
  formatDiarizedJson,
  formatTimecode,
  defaultSpeakerLabel
} from "../extension/lib/diarizedTranscript.js";

const utt = (startSec, endSec, speakerId, text) => ({
  startSec,
  endSec,
  speakerId,
  text
});

describe("formatTimecode", () => {
  it("renders MM:SS for sub-hour spans", () => {
    expect(formatTimecode(0)).toBe("00:00");
    expect(formatTimecode(5)).toBe("00:05");
    expect(formatTimecode(65)).toBe("01:05");
    expect(formatTimecode(3599)).toBe("59:59");
  });

  it("renders HH:MM:SS for hour-and-beyond spans", () => {
    expect(formatTimecode(3600)).toBe("01:00:00");
    expect(formatTimecode(3725)).toBe("01:02:05");
  });

  it("floors fractional seconds", () => {
    expect(formatTimecode(1.9)).toBe("00:01");
  });

  it("clamps negative / non-numeric to 0", () => {
    expect(formatTimecode(-10)).toBe("00:00");
    expect(formatTimecode(NaN)).toBe("00:00");
    expect(formatTimecode(undefined)).toBe("00:00");
  });
});

describe("defaultSpeakerLabel", () => {
  it("emits one-indexed labels", () => {
    expect(defaultSpeakerLabel(0)).toBe("Speaker 1");
    expect(defaultSpeakerLabel(7)).toBe("Speaker 8");
  });

  it("clamps non-finite ids to Speaker 1", () => {
    expect(defaultSpeakerLabel(undefined)).toBe("Speaker 1");
    expect(defaultSpeakerLabel(NaN)).toBe("Speaker 1");
  });
});

describe("formatDiarizedText", () => {
  it("groups consecutive same-speaker lines under one label", () => {
    const text = formatDiarizedText([
      utt(0, 2, 0, "hello"),
      utt(2.5, 4, 0, "again"),
      utt(5, 7, 1, "hi there")
    ]);
    expect(text).toMatchInlineSnapshot(`
"Speaker 1:
[00:00] hello
[00:02] again

Speaker 2:
[00:05] hi there"
`);
  });

  it("alternates speakers correctly", () => {
    const text = formatDiarizedText([
      utt(0, 2, 0, "a"),
      utt(2.5, 4, 1, "b"),
      utt(5, 7, 0, "c")
    ]);
    const lines = text.split("\n");
    expect(lines.filter((l) => l === "Speaker 1:")).toHaveLength(2);
    expect(lines.filter((l) => l === "Speaker 2:")).toHaveLength(1);
  });

  it("returns empty string for empty / non-array input", () => {
    expect(formatDiarizedText([])).toBe("");
    expect(formatDiarizedText(null)).toBe("");
    expect(formatDiarizedText("nope")).toBe("");
  });

  it("skips null entries in the utterance list", () => {
    const text = formatDiarizedText([
      utt(0, 1, 0, "alpha"),
      null,
      utt(2, 3, 0, "beta")
    ]);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  it("honors a custom speakerLabel callback", () => {
    const text = formatDiarizedText(
      [utt(0, 1, 0, "x"), utt(2, 3, 1, "y")],
      { speakerLabel: (id) => `Person ${String.fromCharCode(65 + id)}` }
    );
    expect(text).toContain("Person A:");
    expect(text).toContain("Person B:");
  });
});

describe("formatDiarizedJson", () => {
  it("returns valid JSON with version, speakerCount, and utterances", () => {
    const raw = formatDiarizedJson(
      [utt(0, 1.5, 0, "hi"), utt(2, 3.25, 1, "there")],
      2
    );
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.speakerCount).toBe(2);
    expect(parsed.utterances).toHaveLength(2);
    expect(parsed.utterances[0]).toEqual({
      startSec: 0,
      endSec: 1.5,
      speakerId: 0,
      text: "hi"
    });
  });

  it("rounds timestamps to 3 decimal places", () => {
    const parsed = JSON.parse(
      formatDiarizedJson([utt(0.12345, 1.98765, 0, "x")], 1)
    );
    expect(parsed.utterances[0].startSec).toBe(0.123);
    expect(parsed.utterances[0].endSec).toBe(1.988);
  });

  it("merges optional meta into the top-level object", () => {
    const parsed = JSON.parse(
      formatDiarizedJson([utt(0, 1, 0, "x")], 1, {
        sourceFile: "Tab Recorder/foo.webm",
        modelId: "Xenova/wavlm-base-plus-sv"
      })
    );
    expect(parsed.sourceFile).toBe("Tab Recorder/foo.webm");
    expect(parsed.modelId).toBe("Xenova/wavlm-base-plus-sv");
  });

  it("defaults speakerId to 0 for entries missing it", () => {
    const parsed = JSON.parse(
      formatDiarizedJson([{ startSec: 0, endSec: 1, text: "x" }], 1)
    );
    expect(parsed.utterances[0].speakerId).toBe(0);
  });

  it("emits an empty utterances array for non-array input", () => {
    const parsed = JSON.parse(formatDiarizedJson(null, 0));
    expect(parsed.utterances).toEqual([]);
    expect(parsed.speakerCount).toBe(0);
  });
});
