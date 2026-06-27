import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function installChromeMock(initialStore = {}) {
  const store = { ...initialStore };

  const local = {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys)) out[k] = k in store ? store[k] : def;
      return out;
    },
    async set(updates) { Object.assign(store, updates); },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete store[k];
    },
    async clear() { for (const k of Object.keys(store)) delete store[k]; },
  };

  const messageListeners = [];
  const clickListeners = [];

  const downloads = {
    search: vi.fn(async () => []),
    removeFile: vi.fn(async () => {}),
    erase: vi.fn(async () => {}),
    show: vi.fn(),
    showDefaultFolder: vi.fn(),
  };

  const tabs = {
    query: vi.fn(async () => []),
    update: vi.fn(async () => {}),
    create: vi.fn(async () => ({ id: 1 })),
  };

  const windows = {
    update: vi.fn(async () => {}),
  };

  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    ...(previousChrome || {}),
    storage: { local },
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://fake-id/${path}`),
      onMessage: {
        addListener: vi.fn((fn) => messageListeners.push(fn)),
      },
    },
    action: {
      onClicked: {
        addListener: vi.fn((fn) => clickListeners.push(fn)),
      },
    },
    tabs,
    windows,
    downloads,
  };

  return {
    store,
    messageListeners,
    clickListeners,
    downloads,
    tabs,
    windows,
    restore() {
      if (previousChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previousChrome;
    },
  };
}

describe("service_worker", () => {
  let chromeMock;
  let sw;

  beforeEach(async () => {
    vi.resetModules();
    chromeMock = installChromeMock();
    sw = await import("../extension/service_worker.js");
  });

  afterEach(() => {
    chromeMock?.restore();
    vi.restoreAllMocks();
  });

  describe("module registration", () => {
    it("registers a message listener and a click listener", () => {
      expect(chromeMock.messageListeners).toHaveLength(1);
      expect(chromeMock.clickListeners).toHaveLength(1);
    });
  });

  describe("getSessions", () => {
    it("returns an empty array when storage is empty", async () => {
      expect(await sw.getSessions()).toEqual([]);
    });

    it("returns stored sessions", async () => {
      const sessions = [{ id: "s1", meetingLabel: "Test" }];
      chromeMock.store.v2Sessions = sessions;
      expect(await sw.getSessions()).toEqual(sessions);
    });

    it("returns an empty array when stored value is not an array", async () => {
      chromeMock.store.v2Sessions = "not-an-array";
      expect(await sw.getSessions()).toEqual([]);
    });
  });

  describe("saveSessionFromPanel", () => {
    it("creates a session from a minimal payload with defaults", async () => {
      const session = await sw.saveSessionFromPanel({ meetingLabel: "Meeting" });
      expect(session.id).toBeTruthy();
      expect(session.meetingLabel).toBe("Meeting");
      expect(session.tabTitle).toBe("Meeting");
      expect(session.status).toBe("complete");
      expect(session.audioFormat).toBe("webm");
      expect(session.transcriptText).toBe("");
      expect(session.transcriptWords).toEqual([]);
      expect(session.mp3DownloadId).toBeNull();
      expect(session.mp3FileName).toBe("");
    });

    it("preserves provided fields", async () => {
      const payload = {
        id: "custom-id",
        tabTitle: "Tab Title",
        meetingLabel: "Label",
        tabUrl: "https://example.com",
        startedAt: 1000,
        endedAt: 5000,
        durationMs: 4000,
        fileName: "test.webm",
        downloadId: 42,
        audioFormat: "webm",
        audioMimeType: "audio/webm",
      };
      const session = await sw.saveSessionFromPanel(payload);
      expect(session.id).toBe("custom-id");
      expect(session.tabTitle).toBe("Tab Title");
      expect(session.durationMs).toBe(4000);
      expect(session.downloadId).toBe(42);
      expect(session.audioMimeType).toBe("audio/webm");
    });

    it("throws when payload is missing", async () => {
      await expect(sw.saveSessionFromPanel(null)).rejects.toThrow(/payload required/i);
      await expect(sw.saveSessionFromPanel("string")).rejects.toThrow(/payload required/i);
    });

    it("computes durationMs from endedAt - startedAt when not provided", async () => {
      const session = await sw.saveSessionFromPanel({ startedAt: 1000, endedAt: 6000 });
      expect(session.durationMs).toBe(5000);
    });

    it("clamps negative durationMs to zero", async () => {
      const session = await sw.saveSessionFromPanel({ startedAt: 10000, endedAt: 5000, durationMs: -100 });
      expect(session.durationMs).toBe(0);
    });

    it("generates an id when not provided", async () => {
      const session = await sw.saveSessionFromPanel({});
      expect(session.id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    });

    it("prepends the new session to existing stored sessions", async () => {
      chromeMock.store.v2Sessions = [{ id: "old", meetingLabel: "Old" }];
      await sw.saveSessionFromPanel({ id: "new", meetingLabel: "New" });
      const stored = await sw.getSessions();
      expect(stored[0].id).toBe("new");
      expect(stored[1].id).toBe("old");
    });

    it("caps stored sessions at 300", async () => {
      const many = Array.from({ length: 299 }, (_, i) => ({ id: `s${i}`, meetingLabel: `S${i}` }));
      chromeMock.store.v2Sessions = many;
      await sw.saveSessionFromPanel({ id: "new", meetingLabel: "New" });
      const stored = await sw.getSessions();
      expect(stored).toHaveLength(300);
      expect(stored[0].id).toBe("new");
    });
  });

  describe("updateSessionMp3", () => {
    it("updates the MP3 fields on an existing session", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", meetingLabel: "Test", mp3FileName: "", mp3DownloadId: null }];
      const updated = await sw.updateSessionMp3("s1", { downloadId: 10, fileName: "test.mp3" });
      expect(updated.mp3DownloadId).toBe(10);
      expect(updated.mp3FileName).toBe("test.mp3");
    });

    it("throws when session ID is missing", async () => {
      await expect(sw.updateSessionMp3("", {})).rejects.toThrow(/Session ID/i);
      await expect(sw.updateSessionMp3(null, {})).rejects.toThrow(/Session ID/i);
    });

    it("throws when MP3 payload is missing", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1" }];
      await expect(sw.updateSessionMp3("s1", null)).rejects.toThrow(/MP3 payload/i);
    });

    it("throws when session is not found", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1" }];
      await expect(sw.updateSessionMp3("nonexistent", { downloadId: 1 })).rejects.toThrow(/not found/i);
    });

    it("handles non-integer downloadId gracefully", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1" }];
      const updated = await sw.updateSessionMp3("s1", { downloadId: "not-int", fileName: "f.mp3" });
      expect(updated.mp3DownloadId).toBeNull();
    });
  });

  describe("updateSessionTranscript", () => {
    it("updates transcript text and words on an existing session", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", transcriptText: "", transcriptWords: [] }];
      const words = [
        { text: "hello", start: 0, end: 1 },
        { text: "world", start: 1, end: 2 },
      ];
      const updated = await sw.updateSessionTranscript("s1", "hello world", words);
      expect(updated.transcriptText).toBe("hello world");
      expect(updated.transcriptWords).toHaveLength(2);
      expect(updated.transcriptWords[0]).toEqual({ text: "hello", start: 0, end: 1 });
    });

    it("throws when session ID is missing", async () => {
      await expect(sw.updateSessionTranscript("", "text", [])).rejects.toThrow(/Session ID/i);
    });

    it("throws when session is not found", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1" }];
      await expect(sw.updateSessionTranscript("nope", "text", [])).rejects.toThrow(/not found/i);
    });

    it("sanitizes word entries", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", transcriptText: "", transcriptWords: [] }];
      const words = [
        { text: "good", start: 0, end: 1 },
        { word: "alt-field" },
        { text: "   ", start: 5 },
        null,
        { text: "valid", start: 2, end: 3 },
      ];
      const updated = await sw.updateSessionTranscript("s1", "good valid", words);
      expect(updated.transcriptWords).toHaveLength(3);
      expect(updated.transcriptWords[0].text).toBe("good");
      expect(updated.transcriptWords[1].text).toBe("alt-field");
      expect(updated.transcriptWords[2].text).toBe("valid");
    });

    it("handles non-array transcriptWords", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", transcriptText: "", transcriptWords: [] }];
      const updated = await sw.updateSessionTranscript("s1", "text", "not-array");
      expect(updated.transcriptWords).toEqual([]);
    });

    it("trims transcript text", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", transcriptText: "", transcriptWords: [] }];
      const updated = await sw.updateSessionTranscript("s1", "  text  ", []);
      expect(updated.transcriptText).toBe("text");
    });
  });

  describe("deleteSession", () => {
    it("removes a session from storage", async () => {
      chromeMock.store.v2Sessions = [
        { id: "s1", meetingLabel: "One" },
        { id: "s2", meetingLabel: "Two" },
      ];
      await sw.deleteSession("s1");
      const remaining = await sw.getSessions();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("s2");
    });

    it("throws when session ID is missing", async () => {
      await expect(sw.deleteSession("")).rejects.toThrow(/Session ID/i);
    });

    it("removes download files for a deleted session", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", downloadId: 10, mp3DownloadId: 20 }];
      await sw.deleteSession("s1");
      expect(chromeMock.downloads.removeFile).toHaveBeenCalledWith(10);
      expect(chromeMock.downloads.removeFile).toHaveBeenCalledWith(20);
      expect(chromeMock.downloads.erase).toHaveBeenCalledWith({ id: 10 });
      expect(chromeMock.downloads.erase).toHaveBeenCalledWith({ id: 20 });
    });

    it("handles dl- prefixed IDs by removing the download file", async () => {
      await sw.deleteSession("dl-42");
      expect(chromeMock.downloads.removeFile).toHaveBeenCalledWith(42);
      expect(chromeMock.downloads.erase).toHaveBeenCalledWith({ id: 42 });
    });

    it("handles fs- prefixed IDs as no-ops", async () => {
      await sw.deleteSession("fs-something");
      expect(chromeMock.downloads.removeFile).not.toHaveBeenCalled();
    });

    it("throws when session not found and id is not dl-/fs- prefixed", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1" }];
      await sw.deleteSession("nonexistent");
      const remaining = await sw.getSessions();
      expect(remaining).toEqual([{ id: "s1" }]);
    });
  });

  describe("synthesizeSessionFromDownload", () => {
    it("creates a synthesized session from a download object", () => {
      const download = {
        id: 99,
        filename: "/home/user/Downloads/Tab Recorder/2026-01-01/My Recording_14-30.webm",
        startTime: "2026-01-01T14:30:00.000Z",
        state: "complete",
      };
      const session = sw.synthesizeSessionFromDownload(download);
      expect(session.id).toBe("dl-99");
      expect(session.downloadId).toBe(99);
      expect(session.audioFormat).toBe("webm");
      expect(session.meetingLabel).toBe("My Recording");
      expect(session.tabTitle).toBe("My Recording");
      expect(session.durationMs).toBe(0);
      expect(session.status).toBe("complete");
      expect(session.fileName).toContain("Tab Recorder");
      expect(session.startedAt).toBe(Date.parse("2026-01-01T14:30:00.000Z"));
    });

    it("uses fallback label when basename is empty", () => {
      const session = sw.synthesizeSessionFromDownload({ id: 1, filename: "" });
      expect(session.meetingLabel).toBe("recording");
    });

    it("strips timestamp suffix from filename label", () => {
      const session = sw.synthesizeSessionFromDownload({
        id: 1,
        filename: "Tab Recorder/2026-01-01/Test_14-30.webm",
        startTime: "2026-01-01T14:30:00.000Z",
      });
      expect(session.meetingLabel).toBe("Test");
    });

    it("uses Date.now() when startTime is invalid", () => {
      const before = Date.now();
      const session = sw.synthesizeSessionFromDownload({ id: 1, filename: "test.webm", startTime: "invalid" });
      const after = Date.now();
      expect(session.startedAt).toBeGreaterThanOrEqual(before);
      expect(session.startedAt).toBeLessThanOrEqual(after);
    });

    it("uses Date.now() when startTime is missing", () => {
      const before = Date.now();
      const session = sw.synthesizeSessionFromDownload({ id: 1, filename: "test.webm" });
      const after = Date.now();
      expect(session.startedAt).toBeGreaterThanOrEqual(before);
      expect(session.startedAt).toBeLessThanOrEqual(after);
    });

    it("handles Windows-style path separators", () => {
      const session = sw.synthesizeSessionFromDownload({
        id: 1,
        filename: "C:\\Users\\test\\Downloads\\Tab Recorder\\2026-01-01\\Meeting_14-30.webm",
        startTime: "2026-01-01T14:30:00.000Z",
      });
      expect(session.meetingLabel).toBe("Meeting");
      expect(session.fileName).toContain("Tab Recorder");
    });
  });

  describe("getOrphanDownloads", () => {
    it("returns downloads not already tracked as sessions", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", downloadId: 10 }];
      chromeMock.downloads.search.mockResolvedValueOnce([
        { id: 10, filename: "Tab Recorder/test1.webm", startTime: "2026-01-01T00:00:00.000Z", state: "complete", exists: true },
        { id: 20, filename: "Tab Recorder/test2.webm", startTime: "2026-01-01T00:00:00.000Z", state: "complete", exists: true },
      ]);
      const orphans = await sw.getOrphanDownloads();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].id).toBe("dl-20");
    });

    it("filters out incomplete downloads", async () => {
      chromeMock.downloads.search.mockResolvedValueOnce([
        { id: 30, filename: "Tab Recorder/test.webm", startTime: "2026-01-01T00:00:00.000Z", state: "in_progress", exists: true },
      ]);
      const orphans = await sw.getOrphanDownloads();
      expect(orphans).toHaveLength(0);
    });

    it("filters out downloads with exists: false", async () => {
      chromeMock.downloads.search.mockResolvedValueOnce([
        { id: 40, filename: "Tab Recorder/test.webm", startTime: "2026-01-01T00:00:00.000Z", state: "complete", exists: false },
      ]);
      const orphans = await sw.getOrphanDownloads();
      expect(orphans).toHaveLength(0);
    });

    it("returns empty array when downloads.search throws", async () => {
      chromeMock.downloads.search.mockRejectedValueOnce(new Error("search failed"));
      const orphans = await sw.getOrphanDownloads();
      expect(orphans).toEqual([]);
    });
  });

  describe("message router", () => {
    function sendMessage(message) {
      return new Promise((resolve) => {
        chromeMock.messageListeners[0]({ ...message }, {}, resolve);
      });
    }

    it("routes get-sessions", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1" }];
      const response = await sendMessage({ type: "get-sessions" });
      expect(response.ok).toBe(true);
      expect(response.sessions).toHaveLength(1);
    });

    it("routes save-session", async () => {
      const response = await sendMessage({ type: "save-session", session: { meetingLabel: "Test" } });
      expect(response.ok).toBe(true);
      expect(response.session.meetingLabel).toBe("Test");
    });

    it("routes get-orphan-downloads", async () => {
      chromeMock.downloads.search.mockResolvedValueOnce([]);
      const response = await sendMessage({ type: "get-orphan-downloads" });
      expect(response.ok).toBe(true);
      expect(response.orphans).toEqual([]);
    });

    it("routes update-session-mp3", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", mp3FileName: "" }];
      const response = await sendMessage({ type: "update-session-mp3", sessionId: "s1", mp3: { downloadId: 5, fileName: "test.mp3" } });
      expect(response.ok).toBe(true);
      expect(response.session.mp3FileName).toBe("test.mp3");
    });

    it("routes update-session-transcript", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1", transcriptText: "" }];
      const response = await sendMessage({ type: "update-session-transcript", sessionId: "s1", transcriptText: "hello", transcriptWords: [] });
      expect(response.ok).toBe(true);
      expect(response.session.transcriptText).toBe("hello");
    });

    it("routes delete-session", async () => {
      chromeMock.store.v2Sessions = [{ id: "s1" }];
      const response = await sendMessage({ type: "delete-session", sessionId: "s1" });
      expect(response.ok).toBe(true);
      const remaining = await sw.getSessions();
      expect(remaining).toHaveLength(0);
    });

    it("returns undefined for non-object messages", () => {
      const result = chromeMock.messageListeners[0]("not-an-object", {}, () => {});
      expect(result).toBeUndefined();
    });

    it("returns undefined for unknown message types", () => {
      const result = chromeMock.messageListeners[0]({ type: "unknown" }, {}, () => {});
      expect(result).toBeUndefined();
    });

    it("returns ok: false on error for save-session", async () => {
      const response = await sendMessage({ type: "save-session", session: null });
      expect(response.ok).toBe(false);
      expect(response.error).toBeTruthy();
    });
  });
});
