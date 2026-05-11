import { describe, it, expect } from "vitest";
import {
  pathKey,
  synthesizeSessionFromFs,
  mergeSessionSources
} from "../extension/lib/sessionMerge.js";

describe("pathKey", () => {
  it("returns null for missing input", () => {
    expect(pathKey(null)).toBeNull();
    expect(pathKey(undefined)).toBeNull();
    expect(pathKey("")).toBeNull();
  });

  it("strips a leading 'Tab Recorder/' prefix and lower-cases the rest", () => {
    expect(pathKey("Tab Recorder/2026-05-08/Foo.webm")).toBe("2026-05-08/foo.webm");
    expect(pathKey("Tab Recorder\\2026-05-08\\Bar.webm")).toBe("2026-05-08\\bar.webm");
  });

  it("leaves paths without the prefix unchanged (apart from case)", () => {
    expect(pathKey("Downloads/Tab Recorder/foo.webm")).toBe("downloads/tab recorder/foo.webm");
  });

  it("treats different cases of the same path as the same key", () => {
    expect(pathKey("TAB RECORDER/Foo.webm")).toBe(pathKey("TAB RECORDER/foo.webm"));
  });
});

describe("synthesizeSessionFromFs", () => {
  it("derives a clean label from the base filename", () => {
    const out = synthesizeSessionFromFs({
      baseName: "team-standup_15-30",
      path: "Tab Recorder/2026-05-08/team-standup_15-30.webm"
    });
    expect(out.meetingLabel).toBe("team standup");
    expect(out.tabTitle).toBe("team standup");
    expect(out.id.startsWith("fs-")).toBe(true);
    expect(out.fileName).toBe("Tab Recorder/2026-05-08/team-standup_15-30.webm");
    expect(out.audioFormat).toBe("webm");
    expect(out.transcriptText).toBe("");
  });

  it("falls back to 'Recording' when the basename is empty", () => {
    const out = synthesizeSessionFromFs({ baseName: "", path: "x.webm" });
    expect(out.meetingLabel).toBe("Recording");
  });

  it("propagates mp3 and txt sibling paths", () => {
    const out = synthesizeSessionFromFs({
      baseName: "foo",
      path: "Tab Recorder/foo.webm",
      mp3Path: "Tab Recorder/foo.mp3",
      txtPath: "Tab Recorder/foo.txt"
    });
    expect(out.mp3FileName).toBe("Tab Recorder/foo.mp3");
    expect(out._fsTxtPath).toBe("Tab Recorder/foo.txt");
  });
});

describe("mergeSessionSources", () => {
  const stored = {
    id: "stored-1",
    fileName: "Tab Recorder/2026-05-08/foo.webm",
    meetingLabel: "Stored",
    durationMs: 12345,
    startedAt: 1000,
    transcriptText: "hello"
  };
  const orphan = {
    id: "dl-9",
    fileName: "Tab Recorder/2026-05-08/foo.webm",
    meetingLabel: "Orphan",
    startedAt: 2000
  };
  const fsFile = {
    baseName: "foo",
    path: "Tab Recorder/2026-05-08/foo.webm",
    lastModified: 3000
  };

  it("returns an empty array for empty inputs", () => {
    expect(mergeSessionSources()).toEqual([]);
    expect(mergeSessionSources([], [], [])).toEqual([]);
  });

  it("stored sessions take precedence over download orphans for the same file", () => {
    const merged = mergeSessionSources([stored], [orphan], []);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("stored-1");
    expect(merged[0].meetingLabel).toBe("Stored");
  });

  it("download orphans are kept for files not in stored", () => {
    const otherOrphan = { ...orphan, fileName: "Tab Recorder/2026-05-08/bar.webm" };
    const merged = mergeSessionSources([stored], [otherOrphan], []);
    const ids = merged.map((m) => m.id);
    expect(ids).toContain("stored-1");
    expect(ids).toContain("dl-9");
  });

  it("FS scan augments existing entries with mp3 sibling and preserves stored transcript", () => {
    const fsWithSiblings = {
      ...fsFile,
      mp3Path: "Tab Recorder/2026-05-08/foo.mp3",
      txtPath: "Tab Recorder/2026-05-08/foo.txt"
    };
    const merged = mergeSessionSources([stored], [], [fsWithSiblings]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("stored-1");
    expect(merged[0].mp3FileName).toBe("Tab Recorder/2026-05-08/foo.mp3");
    // stored.transcriptText is set, so _fsTxtPath is NOT attached (no fallback needed)
    expect(merged[0]._fsTxtPath).toBeUndefined();
    expect(merged[0].transcriptText).toBe("hello");
  });

  it("FS scan attaches _fsTxtPath when stored has no transcriptText", () => {
    const storedNoTranscript = { ...stored, transcriptText: "" };
    const fsWithTxt = {
      ...fsFile,
      txtPath: "Tab Recorder/2026-05-08/foo.txt"
    };
    const merged = mergeSessionSources([storedNoTranscript], [], [fsWithTxt]);
    expect(merged[0]._fsTxtPath).toBe("Tab Recorder/2026-05-08/foo.txt");
  });

  it("FS scan does not clobber a stored mp3 reference", () => {
    const storedWithMp3 = { ...stored, mp3FileName: "kept.mp3" };
    const fsWithMp3 = { ...fsFile, mp3Path: "ignored.mp3" };
    const merged = mergeSessionSources([storedWithMp3], [], [fsWithMp3]);
    expect(merged[0].mp3FileName).toBe("kept.mp3");
  });

  it("FS scan adds completely new files as synthesized rows", () => {
    const newFs = {
      baseName: "fresh",
      path: "Tab Recorder/2026-05-09/fresh.webm",
      lastModified: 4000
    };
    const merged = mergeSessionSources([stored], [], [newFs]);
    expect(merged).toHaveLength(2);
    const synth = merged.find((m) => m.id.startsWith("fs-"));
    expect(synth).toBeTruthy();
    expect(synth.fileName).toBe("Tab Recorder/2026-05-09/fresh.webm");
  });

  it("output is sorted newest-first by startedAt", () => {
    const a = { id: "a", fileName: "a.webm", startedAt: 1 };
    const b = { id: "b", fileName: "b.webm", startedAt: 3 };
    const c = { id: "c", fileName: "c.webm", startedAt: 2 };
    const merged = mergeSessionSources([a, b, c]);
    expect(merged.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("ignores entries without a valid file path", () => {
    const merged = mergeSessionSources(
      [{ id: "no-file" }],
      [{ id: "dl-x" }],
      [{ baseName: "foo" }]
    );
    expect(merged).toEqual([]);
  });
});
