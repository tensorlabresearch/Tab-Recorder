// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  freshGraph,
  emptyNodeGroup,
  pickInitialMicId,
  buildFileName,
  defaultTimestampLabel,
  formatElapsed,
  formatStamp,
  formatSessionDate,
  formatDurationHuman,
  formatWorkerErrorEvent,
  formatTranscriptionChunkLabel,
  formatTranscriptionEngineLabel,
  isWebmRecording,
  renderSessionRow,
  makeBadge,
  makeBadgesForSession,
  setRowProgress,
  startOperation,
  endOperation,
} from "../extension/panel.js";

describe("freshGraph", () => {
  it("returns a graph with null context and recordDestination", () => {
    const g = freshGraph();
    expect(g.context).toBeNull();
    expect(g.recordDestination).toBeNull();
    expect(g.tab).toEqual(emptyNodeGroup());
    expect(g.mic).toEqual(emptyNodeGroup());
  });
});

describe("emptyNodeGroup", () => {
  it("returns an object with all null fields", () => {
    const node = emptyNodeGroup();
    expect(node).toEqual({
      stream: null,
      source: null,
      gain: null,
      analyser: null,
      endedHandler: null,
    });
  });
});

describe("formatElapsed", () => {
  it("formats zero as 00:00", () => {
    expect(formatElapsed(0)).toBe("00:00");
  });

  it("formats seconds only", () => {
    expect(formatElapsed(5000)).toBe("00:05");
    expect(formatElapsed(59000)).toBe("00:59");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(65000)).toBe("01:05");
    expect(formatElapsed(3599000)).toBe("59:59");
  });

  it("formats hours", () => {
    expect(formatElapsed(3600000)).toBe("01:00:00");
    expect(formatElapsed(3661000)).toBe("01:01:01");
  });

  it("handles null input as 00:00", () => {
    expect(formatElapsed(null)).toBe("00:00");
  });
});

describe("formatStamp", () => {
  it("formats milliseconds as MM:SS", () => {
    expect(formatStamp(0)).toBe("00:00");
    expect(formatStamp(5000)).toBe("00:05");
    expect(formatStamp(65000)).toBe("01:05");
    expect(formatStamp(3661000)).toBe("61:01");
  });

  it("handles null/undefined input", () => {
    expect(formatStamp(null)).toBe("00:00");
    expect(formatStamp(undefined)).toBe("00:00");
  });

  it("handles negative values", () => {
    expect(formatStamp(-5000)).toBe("00:00");
  });
});

describe("formatSessionDate", () => {
  it("formats a valid timestamp", () => {
    const ts = new Date("2026-01-15T14:30:45").getTime();
    expect(formatSessionDate(ts)).toBe("2026-01-15 14:30:45");
  });

  it("returns empty string for zero or null", () => {
    expect(formatSessionDate(0)).toBe("");
    expect(formatSessionDate(null)).toBe("");
    expect(formatSessionDate(undefined)).toBe("");
  });

  it("returns empty string for invalid date", () => {
    expect(formatSessionDate("not-a-date")).toBe("");
  });
});

describe("formatDurationHuman", () => {
  it("formats seconds only", () => {
    expect(formatDurationHuman(0)).toBe("0s");
    expect(formatDurationHuman(5000)).toBe("5s");
    expect(formatDurationHuman(59000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDurationHuman(65000)).toBe("1m 5s");
    expect(formatDurationHuman(3599000)).toBe("59m 59s");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationHuman(3600000)).toBe("1h 0m");
    expect(formatDurationHuman(3661000)).toBe("1h 1m");
  });

  it("handles null/undefined input", () => {
    expect(formatDurationHuman(null)).toBe("0s");
    expect(formatDurationHuman(undefined)).toBe("0s");
  });

  it("handles negative values", () => {
    expect(formatDurationHuman(-5000)).toBe("0s");
  });
});

describe("formatWorkerErrorEvent", () => {
  it("returns empty string for null event", () => {
    expect(formatWorkerErrorEvent(null)).toBe("");
    expect(formatWorkerErrorEvent(undefined)).toBe("");
  });

  it("formats message only", () => {
    expect(formatWorkerErrorEvent({ message: "Something broke" })).toBe("Something broke");
  });

  it("includes filename and line number", () => {
    const result = formatWorkerErrorEvent({
      message: "Error",
      filename: "worker.js",
      lineno: 42,
      colno: 10,
    });
    expect(result).toContain("Error");
    expect(result).toContain("worker.js");
    expect(result).toContain(":42");
    expect(result).toContain(":10");
  });

  it("includes error.message when different from message", () => {
    const result = formatWorkerErrorEvent({
      message: "outer",
      error: { message: "inner detail", stack: "stack line 1\nstack line 2" },
    });
    expect(result).toContain("outer");
    expect(result).toContain("inner detail");
    expect(result).toContain("stack line 1");
  });

  it("does not duplicate error.message when same as message", () => {
    const result = formatWorkerErrorEvent({
      message: "same",
      error: { message: "same" },
    });
    expect(result).toBe("same");
  });
});

describe("formatTranscriptionChunkLabel", () => {
  it("formats a chunk with 1-based indexing", () => {
    const chunk = { index: 0, total: 3, coreStartMs: 0, coreEndMs: 30000 };
    const label = formatTranscriptionChunkLabel(chunk);
    expect(label).toContain("chunk 1/3");
    expect(label).toContain("0s");
    expect(label).toContain("30s");
  });

  it("formats a later chunk correctly", () => {
    const chunk = { index: 2, total: 5, coreStartMs: 120000, coreEndMs: 180000 };
    const label = formatTranscriptionChunkLabel(chunk);
    expect(label).toContain("chunk 3/5");
    expect(label).toContain("2m 0s");
    expect(label).toContain("3m 0s");
  });
});

describe("formatTranscriptionEngineLabel", () => {
  it("formats WebGPU without chunk label", () => {
    expect(formatTranscriptionEngineLabel("webgpu")).toBe("Transcribing on WebGPU");
  });

  it("formats CPU without chunk label", () => {
    expect(formatTranscriptionEngineLabel("cpu")).toBe("Transcribing on CPU");
  });

  it("includes chunk label when provided", () => {
    expect(formatTranscriptionEngineLabel("webgpu", "chunk 1/3")).toBe("Transcribing chunk 1/3 on WebGPU");
  });

  it("handles unknown device as CPU", () => {
    expect(formatTranscriptionEngineLabel(null)).toBe("Transcribing on CPU");
    expect(formatTranscriptionEngineLabel("unknown")).toBe("Transcribing on CPU");
  });
});

describe("isWebmRecording", () => {
  it("returns true for .webm filename", () => {
    expect(isWebmRecording({ name: "recording.webm" }, {})).toBe(true);
  });

  it("returns true for webm mime type", () => {
    expect(isWebmRecording({ name: "recording.mp3", type: "audio/webm" }, {})).toBe(true);
  });

  it("returns true for webm in session fileName", () => {
    expect(isWebmRecording({}, { fileName: "Tab Recorder/2026-01-01/test.webm" })).toBe(true);
  });

  it("returns false for non-webm files", () => {
    expect(isWebmRecording({ name: "recording.mp3", type: "audio/mpeg" }, { fileName: "test.mp3" })).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(isWebmRecording({}, {})).toBe(false);
    expect(isWebmRecording(null, null)).toBe(false);
  });
});

describe("pickInitialMicId", () => {
  const NO_MIC = "__none__";

  it("returns NO_MIC_VALUE when savedId is NO_MIC_VALUE", () => {
    expect(pickInitialMicId(NO_MIC, [])).toBe(NO_MIC);
  });

  it("returns savedId when it exists in the mic list", () => {
    const mics = [{ deviceId: "mic1" }, { deviceId: "mic2" }];
    expect(pickInitialMicId("mic2", mics)).toBe("mic2");
  });

  it("returns NO_MIC_VALUE when mic list is empty", () => {
    expect(pickInitialMicId(null, [])).toBe(NO_MIC);
  });

  it("returns the first physical mic when savedId is null", () => {
    const mics = [
      { deviceId: "default", label: "Default" },
      { deviceId: "physical1", label: "Physical Mic" },
      { deviceId: "virtual1", label: "NoMachine Loopback" },
    ];
    expect(pickInitialMicId(null, mics)).toBe("physical1");
  });

  it("falls back to first mic when no physical mic found", () => {
    const mics = [
      { deviceId: "default", label: "Default" },
      { deviceId: "virtual1", label: "Virtual Audio Loopback" },
    ];
    expect(pickInitialMicId(null, mics)).toBe("default");
  });

  it("falls back to first mic when savedId is not found", () => {
    const mics = [{ deviceId: "mic1" }];
    expect(pickInitialMicId("nonexistent", mics)).toBe("mic1");
  });
});

describe("buildFileName", () => {
  it("builds a filename with date directory and time suffix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T14:30:00"));
    const name = buildFileName("My Meeting");
    expect(name).toMatch(/^2026-01-15\/My-Meeting_14-30\.webm$/);
    vi.useRealTimers();
  });

  it("sanitizes special characters from the label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T14:30:00"));
    const name = buildFileName("Meeting @#$% with spaces & symbols!");
    expect(name).toMatch(/^2026-01-15\/Meeting-with-spaces-symbols_14-30\.webm$/);
    vi.useRealTimers();
  });

  it("truncates long labels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T14:30:00"));
    const longLabel = "a".repeat(100);
    const name = buildFileName(longLabel);
    expect(name).toMatch(/^2026-01-15\/a{50}_14-30\.webm$/);
    vi.useRealTimers();
  });

  it("uses 'recording' for empty label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T14:30:00"));
    const name = buildFileName("");
    expect(name).toMatch(/^2026-01-15\/recording_14-30\.webm$/);
    vi.useRealTimers();
  });

  it("uses 'recording' for null label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T14:30:00"));
    const name = buildFileName(null);
    expect(name).toMatch(/^2026-01-15\/recording_14-30\.webm$/);
    vi.useRealTimers();
  });
});

describe("defaultTimestampLabel", () => {
  it("returns a YYYY-MM-DD HH:MM formatted label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T09:05:00"));
    expect(defaultTimestampLabel()).toBe("2026-03-07 09:05");
    vi.useRealTimers();
  });

  it("pads single-digit hours and minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:02:00"));
    expect(defaultTimestampLabel()).toBe("2026-01-01 01:02");
    vi.useRealTimers();
  });
});

describe("startOperation / endOperation", () => {
  it("tracks in-progress file names", () => {
    startOperation("test.webm");
    startOperation("other.webm");
    endOperation("test.webm");
    endOperation("other.webm");
  });

  it("endOperation decrements counter", () => {
    startOperation("a.webm");
    startOperation("b.webm");
    endOperation("a.webm");
    endOperation("b.webm");
    endOperation("c.webm");
  });
});

describe("renderSessionRow", () => {
  it("renders a session with title and metadata", () => {
    const session = {
      id: "s1",
      meetingLabel: "Test Meeting",
      tabTitle: "Test Meeting",
      startedAt: new Date("2026-01-15T14:30:00").getTime(),
      durationMs: 65000,
      fileName: "Tab Recorder/2026-01-15/test.webm",
    };
    const row = renderSessionRow(session);
    expect(row.classList.contains("recording-item")).toBe(true);
    expect(row.dataset.sessionId).toBe("s1");
    const title = row.querySelector(".recording-item-title");
    expect(title.textContent).toBe("Test Meeting");
    const meta = row.querySelector(".recording-item-meta");
    expect(meta.textContent).toContain("2026-01-15");
    expect(meta.textContent).toContain("1m 5s");
  });

  it("shows Transcribe button when no transcript", () => {
    const session = { id: "s1", meetingLabel: "Test", startedAt: Date.now(), fileName: "test.webm" };
    const row = renderSessionRow(session);
    const transcribeBtn = row.querySelector('[data-action="transcribe"]');
    expect(transcribeBtn).toBeTruthy();
    expect(transcribeBtn.textContent).toBe("Transcribe");
  });

  it("hides Transcribe button when transcript exists", () => {
    const session = {
      id: "s1",
      meetingLabel: "Test",
      startedAt: Date.now(),
      fileName: "test.webm",
      transcriptText: "hello world",
    };
    const row = renderSessionRow(session);
    const transcribeBtn = row.querySelector('[data-action="transcribe"]');
    expect(transcribeBtn).toBeNull();
  });

  it("shows Convert to MP3 button when no mp3", () => {
    const session = { id: "s1", meetingLabel: "Test", startedAt: Date.now(), fileName: "test.webm" };
    const row = renderSessionRow(session);
    const mp3Btn = row.querySelector('[data-action="convert-mp3"]');
    expect(mp3Btn).toBeTruthy();
    expect(mp3Btn.textContent).toBe("Convert to MP3");
  });

  it("hides Convert to MP3 button when mp3 exists", () => {
    const session = {
      id: "s1",
      meetingLabel: "Test",
      startedAt: Date.now(),
      fileName: "test.webm",
      mp3FileName: "test.mp3",
    };
    const row = renderSessionRow(session);
    const mp3Btn = row.querySelector('[data-action="convert-mp3"]');
    expect(mp3Btn).toBeNull();
  });

  it("shows delete button", () => {
    const session = { id: "s1", meetingLabel: "Test", startedAt: Date.now(), fileName: "test.webm" };
    const row = renderSessionRow(session);
    const deleteBtn = row.querySelector('[data-action="delete"]');
    expect(deleteBtn).toBeTruthy();
    expect(deleteBtn.getAttribute("aria-label")).toBe("Delete recording");
  });

  it("shows description when present", () => {
    const session = {
      id: "s1",
      meetingLabel: "Test",
      startedAt: Date.now(),
      fileName: "test.webm",
      description: "A short description",
    };
    const row = renderSessionRow(session);
    const desc = row.querySelector(".recording-item-description");
    expect(desc).toBeTruthy();
    expect(desc.textContent).toBe("A short description");
  });

  it("includes search blob with transcript text", () => {
    const session = {
      id: "s1",
      meetingLabel: "Meeting",
      tabTitle: "Meeting",
      startedAt: Date.now(),
      fileName: "test.webm",
      transcriptText: "discussed quarterly results",
    };
    const row = renderSessionRow(session);
    expect(row.dataset.searchBlob).toContain("discussed quarterly results");
  });

  it("disables buttons when operation is in progress", () => {
    const session = { id: "s1", meetingLabel: "Test", startedAt: Date.now(), fileName: "in-progress.webm" };
    startOperation("in-progress.webm");
    const row = renderSessionRow(session);
    const transcribeBtn = row.querySelector('[data-action="transcribe"]');
    expect(transcribeBtn.disabled).toBe(true);
    expect(transcribeBtn.textContent).toBe("Working...");
    expect(row.classList.contains("is-working")).toBe(true);
    endOperation("in-progress.webm");
  });
});

describe("makeBadge", () => {
  it("creates a span by default", () => {
    const badge = makeBadge("transcript", "Copy transcript");
    expect(badge.tagName).toBe("SPAN");
    expect(badge.classList.contains("recording-badge")).toBe(true);
    expect(badge.classList.contains("recording-badge-transcript")).toBe(true);
    expect(badge.title).toBe("Copy transcript");
  });

  it("creates a button when action is provided", () => {
    const badge = makeBadge("transcript", "Copy transcript", "copy-transcript");
    expect(badge.tagName).toBe("BUTTON");
    expect(badge.type).toBe("button");
    expect(badge.dataset.action).toBe("copy-transcript");
    expect(badge.classList.contains("is-action")).toBe(true);
  });

  it("includes SVG icon innerHTML", () => {
    const badge = makeBadge("summary", "Summary");
    expect(badge.innerHTML).toContain("<svg");
  });
});

describe("makeBadgesForSession", () => {
  it("returns null when no badges", () => {
    expect(makeBadgesForSession({})).toBeNull();
  });

  it("returns transcript badge when transcript exists", () => {
    const wrap = makeBadgesForSession({ transcriptText: "hello" });
    expect(wrap).toBeTruthy();
    expect(wrap.classList.contains("recording-badges")).toBe(true);
    expect(wrap.querySelector(".recording-badge-transcript")).toBeTruthy();
  });

  it("returns mp3 badge when mp3 exists", () => {
    const wrap = makeBadgesForSession({ mp3FileName: "test.mp3" });
    expect(wrap.querySelector(".recording-badge-mp3")).toBeTruthy();
  });

  it("returns summary badge when summary exists", () => {
    const wrap = makeBadgesForSession({ _fsSummaryPath: "test.summary.md" });
    expect(wrap.querySelector(".recording-badge-summary")).toBeTruthy();
  });

  it("returns all badges when all artifacts exist", () => {
    const wrap = makeBadgesForSession({
      transcriptText: "hello",
      mp3FileName: "test.mp3",
      _fsSummaryPath: "test.summary.md",
    });
    expect(wrap.querySelectorAll(".recording-badge").length).toBe(3);
  });
});

describe("setRowProgress", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("hides progress when visible: false", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div class="progress" data-role="progress">
        <div class="progress-label">
          <span data-role="progress-label">Working</span>
          <span class="progress-percent" data-role="progress-percent">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" data-role="progress-fill"></div></div>
      </div>
    `;
    document.body.appendChild(row);
    setRowProgress(row, { visible: false });
    const progress = row.querySelector('[data-role="progress"]');
    expect(progress.classList.contains("hidden")).toBe(true);
  });

  it("shows progress and sets label", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div class="progress hidden" data-role="progress">
        <div class="progress-label">
          <span data-role="progress-label">Working</span>
          <span class="progress-percent" data-role="progress-percent">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" data-role="progress-fill"></div></div>
      </div>
    `;
    document.body.appendChild(row);
    setRowProgress(row, { label: "Encoding", fraction: 0.5 });
    const progress = row.querySelector('[data-role="progress"]');
    expect(progress.classList.contains("hidden")).toBe(false);
    const label = row.querySelector('[data-role="progress-label"]');
    expect(label.textContent).toBe("Encoding");
    const fill = row.querySelector('[data-role="progress-fill"]');
    expect(fill.style.width).toBe("50%");
    const percent = row.querySelector('[data-role="progress-percent"]');
    expect(percent.textContent).toBe("50%");
  });

  it("clamps fraction to 0-1", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div class="progress" data-role="progress">
        <div class="progress-label">
          <span data-role="progress-label">Working</span>
          <span class="progress-percent" data-role="progress-percent">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" data-role="progress-fill"></div></div>
      </div>
    `;
    document.body.appendChild(row);
    setRowProgress(row, { fraction: 1.5 });
    expect(row.querySelector('[data-role="progress-fill"]').style.width).toBe("100%");
    setRowProgress(row, { fraction: -0.5 });
    expect(row.querySelector('[data-role="progress-fill"]').style.width).toBe("0%");
  });

  it("toggles spinner class", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div class="progress" data-role="progress">
        <div class="progress-label">
          <span data-role="progress-label">Working</span>
          <span class="progress-percent" data-role="progress-percent">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" data-role="progress-fill"></div></div>
      </div>
    `;
    document.body.appendChild(row);
    setRowProgress(row, { spinner: true });
    expect(row.querySelector('[data-role="progress"]').classList.contains("is-spinner")).toBe(true);
    setRowProgress(row, { spinner: false });
    expect(row.querySelector('[data-role="progress"]').classList.contains("is-spinner")).toBe(false);
  });

  it("does nothing when row is null", () => {
    expect(() => setRowProgress(null, { label: "test" })).not.toThrow();
  });

  it("does nothing when progress element is missing", () => {
    const row = document.createElement("div");
    expect(() => setRowProgress(row, { label: "test" })).not.toThrow();
  });
});
