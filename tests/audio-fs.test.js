import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { installChromeStorageMock } from "./helpers/chrome-storage-mock.js";
import { makeFakeRoot } from "./helpers/fake-fs-handle.js";

// Fresh IDB per test to avoid cross-test contamination.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

let chromeMock;
beforeEach(() => {
  chromeMock = installChromeStorageMock();
});
afterEach(() => {
  chromeMock.restore();
});

// Re-import audioFs each test so its module-level cachedHandle starts fresh.
async function loadAudioFs() {
  // Vite/vitest caches modules; reset before each suite to drop cachedHandle.
  return await import("../extension/lib/audioFs.js");
}

describe("pathCandidates (pure)", () => {
  let pathCandidates;
  beforeEach(async () => {
    ({ pathCandidates } = await loadAudioFs());
  });

  it("returns the original path when the handle name doesn't appear in it", () => {
    const handle = { name: "Other" };
    const out = pathCandidates(handle, "Tab Recorder/2026-05-08/foo.webm");
    expect(out).toContain("Tab Recorder/2026-05-08/foo.webm");
  });

  it("strips a leading 'Tab Recorder/' prefix", () => {
    const handle = { name: "Tab Recorder" };
    const out = pathCandidates(handle, "Tab Recorder/2026-05-08/foo.webm");
    expect(out).toContain("2026-05-08/foo.webm");
  });

  it("strips a leading handle name even when it isn't 'Tab Recorder'", () => {
    const handle = { name: "Recordings" };
    const out = pathCandidates(handle, "Recordings/2026-05-08/foo.webm");
    expect(out).toContain("2026-05-08/foo.webm");
  });

  it("escapes regex metacharacters in handle names", () => {
    const handle = { name: "My (Folder)" };
    const out = pathCandidates(handle, "My (Folder)/foo.webm");
    expect(out).toContain("foo.webm");
  });

  it("handles backslash separators on Windows-style paths", () => {
    const handle = { name: "Tab Recorder" };
    const out = pathCandidates(handle, "Tab Recorder\\2026-05-08\\foo.webm");
    // Both stripping forms (handle.name and the literal "Tab Recorder/")
    // collapse to the same result here.
    expect(out).toContain("2026-05-08\\foo.webm");
  });

  it("dedupes when handle.name matches the literal prefix", () => {
    const handle = { name: "Tab Recorder" };
    const out = pathCandidates(handle, "Tab Recorder/foo.webm");
    // Distinct candidates only — original + stripped variant.
    expect(new Set(out).size).toBe(out.length);
  });

  it("returns an empty list for falsy input", () => {
    expect(pathCandidates({ name: "x" }, "")).toEqual([]);
    expect(pathCandidates({ name: "x" }, null)).toEqual([]);
  });
});

describe("getRecordingsDirectoryHandle / pickRecordingsDirectory / forgetRecordingsDirectory", () => {
  let mod;
  beforeEach(async () => {
    mod = await loadAudioFs();
  });

  it("returns null when no handle has been picked yet", async () => {
    const h = await mod.getRecordingsDirectoryHandle();
    expect(h).toBeNull();
  });

  it("pickRecordingsDirectory persists and getRecordingsDirectoryHandle returns it", async () => {
    const fakeHandle = makeFakeRoot("Tab Recorder");
    globalThis.window = {
      ...(globalThis.window || {}),
      showDirectoryPicker: async () => fakeHandle
    };

    const picked = await mod.pickRecordingsDirectory();
    expect(picked.name).toBe("Tab Recorder");

    const fetched = await mod.getRecordingsDirectoryHandle();
    expect(fetched).toBe(fakeHandle);

    delete globalThis.window;
  });

  it("forgetRecordingsDirectory clears the persisted handle", async () => {
    const fakeHandle = makeFakeRoot("Tab Recorder");
    globalThis.window = {
      ...(globalThis.window || {}),
      showDirectoryPicker: async () => fakeHandle
    };
    await mod.pickRecordingsDirectory();
    expect(await mod.getRecordingsDirectoryHandle()).toBe(fakeHandle);

    await mod.forgetRecordingsDirectory();
    expect(await mod.getRecordingsDirectoryHandle()).toBeNull();

    delete globalThis.window;
  });

  it("pickRecordingsDirectory throws when the API isn't available", async () => {
    globalThis.window = {}; // no showDirectoryPicker
    await expect(mod.pickRecordingsDirectory()).rejects.toThrow(
      /File System Access API not available/
    );
    delete globalThis.window;
  });
});

describe("ensureWritable", () => {
  let mod;
  beforeEach(async () => {
    mod = await loadAudioFs();
  });

  it("returns false for a null handle", async () => {
    expect(await mod.ensureWritable(null)).toBe(false);
  });

  it("returns true when permission is already granted", async () => {
    const h = makeFakeRoot();
    h.permissionState = "granted";
    expect(await mod.ensureWritable(h)).toBe(true);
  });

  it("falls back to requestPermission when query says prompt", async () => {
    const h = makeFakeRoot();
    let queried = 0;
    let requested = 0;
    h.queryPermission = async () => {
      queried++;
      return "prompt";
    };
    h.requestPermission = async () => {
      requested++;
      return "granted";
    };
    expect(await mod.ensureWritable(h)).toBe(true);
    expect(queried).toBe(1);
    expect(requested).toBe(1);
  });

  it("returns false when the user denies the prompt", async () => {
    const h = makeFakeRoot();
    h.queryPermission = async () => "prompt";
    h.requestPermission = async () => "denied";
    expect(await mod.ensureWritable(h)).toBe(false);
  });
});

describe("readRecordingFile / writeRecordingArtifact / removeRecordingArtifact", () => {
  let mod;
  beforeEach(async () => {
    mod = await loadAudioFs();
  });

  it("readRecordingFile finds the source even when the saved path includes the handle name as prefix", async () => {
    const root = makeFakeRoot("Tab Recorder");
    await root._addFile("2026-05-08/foo.webm", "audio bytes");
    const file = await mod.readRecordingFile(root, "Tab Recorder/2026-05-08/foo.webm");
    expect(file).toBeTruthy();
    expect(await file.text()).toBe("audio bytes");
  });

  it("readRecordingFile falls back to a basename search when the path is wrong", async () => {
    const root = makeFakeRoot("Tab Recorder");
    await root._addFile("loose/foo.webm", "from somewhere else");
    const file = await mod.readRecordingFile(root, "Tab Recorder/2026-05-08/foo.webm");
    expect(await file.text()).toBe("from somewhere else");
  });

  it("readRecordingFile throws a helpful error when the basename truly doesn't exist", async () => {
    const root = makeFakeRoot("Tab Recorder");
    await expect(
      mod.readRecordingFile(root, "Tab Recorder/2026-05-08/missing.webm")
    ).rejects.toThrow(/File not found/);
  });

  it("writeRecordingArtifact lands the file with the source basename + new extension", async () => {
    const root = makeFakeRoot("Tab Recorder");
    await root._addFile("2026-05-08/foo_15-30.webm", "wave");
    const result = await mod.writeRecordingArtifact(
      root,
      "Tab Recorder/2026-05-08/foo_15-30.webm",
      new Blob(["mp3 bytes"]),
      { extension: "mp3" }
    );
    expect(result.fileName).toBe("2026-05-08/foo_15-30.mp3");
    const dir = await root.getDirectoryHandle("2026-05-08");
    const fh = await dir.getFileHandle("foo_15-30.mp3");
    const content = await (await fh.getFile()).text();
    expect(content).toBe("mp3 bytes");
  });

  it("removeRecordingArtifact deletes the listed sibling extensions", async () => {
    const root = makeFakeRoot("Tab Recorder");
    await root._addFile("2026-05-08/foo.webm", "wave");
    await root._addFile("2026-05-08/foo.mp3", "mp3");
    await root._addFile("2026-05-08/foo.txt", "text");

    await mod.removeRecordingArtifact(root, "Tab Recorder/2026-05-08/foo.webm", {
      extensions: ["mp3", "txt"]
    });

    const dir = await root.getDirectoryHandle("2026-05-08");
    // webm should still be there
    await expect(dir.getFileHandle("foo.webm")).resolves.toBeTruthy();
    // mp3 + txt removed
    await expect(dir.getFileHandle("foo.mp3")).rejects.toThrow();
    await expect(dir.getFileHandle("foo.txt")).rejects.toThrow();
  });

  it("readArtifactText reads a transcript file via the granted handle", async () => {
    const root = makeFakeRoot("Tab Recorder");
    await root._addFile("2026-05-08/foo.txt", "hello world");
    const text = await mod.readArtifactText(root, "Tab Recorder/2026-05-08/foo.txt");
    expect(text).toBe("hello world");
  });
});

describe("enumerateRecordings", () => {
  let mod;
  beforeEach(async () => {
    mod = await loadAudioFs();
  });

  it("walks the tree and surfaces webm files with paired mp3/txt siblings", async () => {
    const root = makeFakeRoot("Tab Recorder");
    await root._addFile("2026-05-08/standup.webm", "...");
    await root._addFile("2026-05-08/standup.mp3", "...");
    await root._addFile("2026-05-08/standup.txt", "...");
    await root._addFile("2026-05-09/lonely.webm", "...");

    const entries = await mod.enumerateRecordings(root);
    expect(entries.length).toBe(2);

    const standup = entries.find((e) => e.baseName === "standup");
    expect(standup).toBeTruthy();
    expect(standup.mp3Path).toMatch(/standup\.mp3$/);
    expect(standup.txtPath).toMatch(/standup\.txt$/);

    const lonely = entries.find((e) => e.baseName === "lonely");
    expect(lonely).toBeTruthy();
    expect(lonely.mp3Path).toBeNull();
    expect(lonely.txtPath).toBeNull();
  });

  it("returns an empty list for a null handle", async () => {
    expect(await mod.enumerateRecordings(null)).toEqual([]);
  });

  it("returns an empty list when permission is denied", async () => {
    const root = makeFakeRoot("Tab Recorder");
    root.permissionState = "denied";
    const entries = await mod.enumerateRecordings(root);
    expect(entries).toEqual([]);
  });
});
