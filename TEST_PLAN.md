# Tab-Recorder Automated Test Plan

**Version:** 0.1.0  
**Author:** Agent (OpenCode)  
**Date:** 2026-05-06  

---

## 1. Executive Summary

This document describes an automated testing plan for the **Tab-Recorder** Chrome extension, focusing on its central function: **capturing audio from a browser tab and persisting it to a location on disk (local filesystem)**.

The plan covers:
- Unit tests for pure helper modules
- Integration tests for Chrome extension APIs
- End-to-end automated tests driving a real Chrome instance via CDP
- Verification workflows for audio capture, persistence, and integrity

---

## 2. Extension Architecture Overview

| Layer | Files | Responsibility |
|-------|-------|---------------|
| **Entry Point** | `manifest.json` | MV3 permissions, background service worker, side panel, oauth2 |
| **Side Panel** | `panel.html`, `panel.js` | UX for start/stop recording, meeting label, live notes |
| **Popup** | `popup.html`, `popup.js` | Alternate entry point for toggling recording |
| **Service Worker** | `service_worker.js` | State machine (`STATE`), session CRUD, coordinates offscreen doc |
| **Offscreen** | `offscreen.html`, `offscreen.js` | Runs in a hidden page; captures `tabCapture` stream via `getUserMedia`, runs `MediaRecorder`, assembles blob, uploads to Drive |
| **Notes Page** | `notes_page.html`, `notes_page.js` | Session history workspace with audio playback, transcription, Drive sync, local save |
| **Settings** | `settings.html`, `settings.js` | Enable local save, select output folder, format preferences |
| **File Storage** | `lib/fileStorage.js` | File System Access API wrapper; IndexedDB directory handle cache |
| **Utilities** | `lib/utils.js` | ID generation, time formatting, RMS computation, markdown builders |

### Recording Lifecycle

1. **Pre-Record** — User opens side panel, enters optional meeting label.
2. **Start** — `panel.js` calls `chrome.tabCapture.getMediaStreamId()` → `service_worker.js` creates a Session → sends `offscreen-start` → `offscreen.js` calls `getUserMedia({ mandatory: { chromeMediaSource: "tab" } })` → `MediaRecorder.start(1000)`.
3. **During** — Audio chunks written to `IndexedDB` (`tabRecorderV2Cache`). Silence monitor runs. Optional notes are persisted with timestamps.
4. **Stop** — User clicks stop → `offscreen.js` assembles blob from cache → `uploadToDrive()` → on success, service worker calls `saveSessionLocally()` if enabled.
5. **Post-Stop** — Session metadata stored in Chrome `localStorage`. Notes saved to Google Drive as `.md`. Audio saved to Drive as `.webm`. Optionally saved locally.

### Critical Dependencies

| Dependency | Test Impact |
|------------|------------|
| `chrome.tabCapture` | Requires a real Chrome tab producing audio; cannot be mocked in Node.js |
| `navigator.mediaDevices.getUserMedia` | Requires HTTPS or chrome-extension origin; needs user grant (`tabCapture` already granted) |
| `MediaRecorder` | Encodes to `audio/webm;codecs=opus` or `audio/webm`; browser-specific |
| `window.showDirectoryPicker()` (FSA) | Requires user gesture and real browser window; blocks headless automation without patch |
| `chrome.identity.getAuthToken` | Requires Google OAuth client configured; may require interactive consent |
| `IndexedDB` chunk cache | Can inspect via DevTools or extension storage |

---

## 3. Test Strategy

### 3.1 Test Pyramid

| Level | Scope | Target | Approach |
|-------|-------|--------|----------|
| **Unit** | Pure functions in `lib/utils.js`, `lib/fileStorage.js` | Fast (<1s) | Vitest running in Node.js with minimal shims |
| **Integration** | Cross-script messaging, session persistence, state transitions | Medium (<10s) | Puppeteer or CDP-driven browser page with extension context |
| **End-to-End** | Full recording lifecycle: start → capture → stop → file on disk | Full (>30s) | Chrome with `--load-extension`, synthetic audio tab, CDP automation, file assertions |

### 3.2 Test Environment Requirements

| Requirement | Detail |
|------------|--------|
| Browser | Chrome 116+ (MV3 requirement) |
| Profile | Isolated `--user-data-dir` for hermetic tests |
| Audio Source | Synthetic Web Audio oscillator playing in a tab to provide capturable audio |
| Network | Drive upload mocked or skipped to avoid external dependency during core audio test |
| Local Save | For E2E disk-save tests, either (a) patch `saveSessionLocally` to accept a hash-mapped path, or (b) intercept `fetch` in offscreen doc to capture the blob and write it ourselves |
| CDP | `--remote-debugging-port=9222` with `--enable-unsafe-extension-debugging` and `--remote-allow-origins=*` for full programmatic control |

---

## 4. Unit Tests (Already Partial)

**File:** `tests/utils.test.js` (exists)  
**Runner:** `vitest` (needs `npm install` first)  

### Existing Coverage

| Function | Status |
|----------|--------|
| `makeId` | Is String, unique, format regex |
| `formatMmSs` | Zero, 1m1s, 1hr, null, negative |
| `computeRms` | Silence, non-silence, empty, null |
| `formatTimestamp` | Known date, pad digits |
| `sanitizeName` | Strip chars, truncate, empty, null, collapse spaces |
| `formatNoteTime` | Zero, 1m1s, 1hr |
| `buildNotesContent` | No notes, notes present, events, null fallback, tabTitle fallback |
| `notesBodyToHighlights` | Split lines, IDs, preserve atMs, filter empty, empty input |
| `debounce` | Delay, reset timer, rejection safety |

### Gaps to Add

| Function | Tests Needed |
|----------|-------------|
| `formatDuration` in `fileStorage.js` | MM:SS formatting at boundaries |
| `generateSessionFolderName` | Date isolation, slugification, length limit |
| `generateAudioFileName` | Timestamp extraction, slugification |
| `generateTranscriptFileName` | Default and custom formats |
| `saveFileLocally` (mock with `FileSystemDirectoryHandle` shim) | Folder creation, file write, error cases |
| `isFileSystemAccessAvailable` | Detect presence/absence of `showDirectoryPicker` |

---

## 5. Integration Tests (Proposed)

### 5.1 Service Worker State Machine

```
Scenario: Recording start-stop lifecycle
  Given a recording has never been started
  When "start-recording-with-stream" is sent with a valid streamId
  Then STATE.recording becomes true
  And STATE.status becomes "starting"
  And a session is persisted

  When "offscreen-status" with event "recording-started" arrives
  Then STATE.status becomes "recording"

  When "stop-recording" is sent
  Then STATE.status becomes "stopping"

  When "offscreen-status" with event "upload-complete" arrives
  Then STATE.recording becomes false
  And session status becomes "complete"
  And session is saved to storage
```

### 5.2 Message Router (service_worker.js onMessage)

| Message Type | Test |
|--------------|------|
| `get-state` | Returns current STATE payload |
| `get-sessions` | Returns deserialized array from `localStorage` |
| `start-recording-with-stream` | Validates session creation, rejects duplicate |
| `stop-recording` | Transitions to stopping, sends offscreen-stop |
| `add-highlight` | Appends to session.highlights and noteEvents |
| `set-meeting-label` | Persists to localStorage and STATE |
| `update-session-notes` | Updates existing session by ID |

### 5.3 Offscreen Document Lifecycle

| Phase | Assertion |
|-------|-----------|
| `offscreen-start` received | Calls `setupCapture`, obtains tab stream, creates MediaRecorder |
| Data available | Writes chunks to `recordedChunks` AND caches to IndexedDB |
| `offscreen-stop` received | Calls `mediaRecorder.stop()`, triggers `onstop` |
| Upload complete | Sends `offscreen-status` with `event: "upload-complete"` |
| Upload error | Sends `offscreen-status` with `event: "upload-error"` |

---

## 6. End-to-End Tests (Central Function)

These tests verify the full flow from UI interaction to an audio file written on disk.

### 6.1 Test Setup (One-Time)

```bash
# 1. Prepare an isolated Chrome profile
cp -r /home/wes/chrome-debug-profile /tmp/tr-test-profile

# 2. Launch Chrome with extension loaded and test flags
/usr/bin/google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tr-test-profile \
  --enable-unsafe-extension-debugging \
  --remote-allow-origins='*' \
  --load-extension=/home/wes/Tab-Recorder/projects/tab-recorder-v2 \
  --no-first-run \
  --no-default-browser-check

# 3. Create a tab that plays synthetic audio (so tabCapture has data to record)
# This is a self-contained HTML page using Web Audio API oscillator
```

### 6.2 Audio Source Tab

A minimal HTML page that produces continuous audible signal:

```html
<!DOCTYPE html>
<html><body>
<script>
const ctx = new AudioContext();
const osc = ctx.createOscillator();
osc.type = 'sine';
osc.frequency.value = 440;
const gain = ctx.createGain();
gain.gain.value = 0.5;
osc.connect(gain).connect(ctx.destination);
osc.start();
document.title = "Audio Source Test Page";
</script>
<h1>Synthetic Audio Playing</h1>
</body></html>
```

Serve this via a local HTTP server (e.g., `python -m http.server 8787`) so Chrome treats it as a real page.

### 6.3 Test Case: Record and Save to Disk (Drive Upload Mocked)

**Objective:** Start recording on the synthetic audio tab, wait 5 seconds, stop, and verify a `.webm` file appears on local disk (via the local-save bypass/hook).

**Preconditions:**
- Extension installed and side panel enabled
- Service worker alive (can verify via `chrome://serviceworker-internals`)
- Offscreen document context created
- `enableLocalSave` set to `true` in extension storage
- Local save output directory mapped to a known temp path (bypassing FSA picker)

**Steps:**
1. Open audio source tab (`http://localhost:8787/audio_source.html`)
2. Bring tab to foreground (active)
3. Trigger side panel open for the active tab via `chrome.sidePanel.setOptions`
4. Inject message via CDP Runtime.evaluate: `chrome.runtime.sendMessage({ type: "set-include-mic", enabled: false })`
5. Inject: `chrome.tabCapture.getMediaStreamId({ targetTabId: <audioTabId> })` within the extension side panel context
6. Inject the recording start flow: get stream ID → send `start-recording-with-stream`
7. Wait 5 seconds
8. Send `stop-recording`
9. Wait for upload completion (poll extension storage or listen for status change)
10. Assert the audio file exists in the known temp directory and has non-zero size

**Cleanup:**
- Clear extension storage sessions
- Remove temp output directory
- Close audio source tab

### 6.4 Test Case: Drive Upload Path (Optional, with real token)

**Objective:** Verify the Google Drive upload path works end-to-end.

**Preconditions:**
- Valid OAuth token available (pre-authenticated)
- `driveFolderId` may be set or not (root fallback)

**Steps:**
1-8 Same as above.
9. Offscreen document uploads blob to Drive.
10. Verify the returned Drive folder exists and contains the `.webm` file and `-notes.md` file.
11. Verify folder is named after the meeting label.

### 6.5 Test Case: Silence Recovery

**Objective:** Verify the auto-recovery logic in `offscreen.js`.

**Steps:**
1. Start recording a tab.
2. Mute the tab audio via CDP `Emulation.setCPUThrottling` or `chrome.tabCapture` mute.
3. Wait for silence threshold to trigger recovery attempt.
4. Assert recovery messages are emitted.
5. Unmute audio.
6. Assert `capture-recovered` event is received.
7. Stop and verify the recording was not corrupted.

---

## 7. Key Automation Scripts

### 7.1 Script Inventory

| Script | Purpose | Location |
|--------|---------|----------|
| `scripts/launch_test_chrome.sh` | Launch Chrome with correct flags for testing | `scripts/` |
| `scripts/audio_source.html` | Synthetic audio tab for capture | `scripts/` |
| `scripts/run_e2e.sh` | Orchestrate the full test | `scripts/` |
| `scripts/verify_audio.py` | Inspect saved `.webm` for duration, codec, size | `scripts/` |
| `tests/e2e_recording.spec.js` | Puppeteer/CDP test implementation | `tests/` |

### 7.2 CDP-Driven Extension Interaction Points

| Action | CDP Command | Target |
|--------|-------------|--------|
| Open audio source tab | `Target.createTarget` | Browser |
| Get target ID | `http://127.0.0.1:9222/json/list` | HTTP |
| Open side panel | `Runtime.evaluate` on extension service worker page | Service Worker |
| Get stream ID | `Runtime.evaluate` calling `chrome.tabCapture.getMediaStreamId` | Side Panel / Popup |
| Send start message | `Runtime.evaluate` sending runtime message | Service Worker |
| Observe state | `Runtime.evaluate` reading `chrome.storage.session.get()` | Any extension context |
| Screenshot for debugging | `Page.captureScreenshot` | Active page |
| Read IndexedDB | `IndexedDB.requestData` via Storage domain | Service Worker or Offscreen |

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `File System Access API` cannot be automated without user gesture | High | Patch `saveSessionLocally` with a test hook to accept a pre-configured path, or intercept the blob in offscreen via CDP `Runtime.evaluate` and write it ourselves |
| Google Drive OAuth requires interactive consent | Medium | Mock `fetch` to Drive inside offscreen document, or skip Drive upload in E2E and only test local save + blob integrity |
| tabCapture requires real audio producing tab | Medium | Use synthetic Web Audio page; works on any X11-enabled Chrome |
| Service Worker may sleep between tests | Medium | Keep it alive by pinging `chrome.runtime.sendMessage` during idle periods |
| Headless Chrome + sandbox on Linux | Low | Use the existing profile strategy and `--no-sandbox` equivalent |
| Chrome DevTools 403 without `--remote-allow-origins` | Low | Always include this flag in launch script |

---

## 9. Acceptance Criteria

1. **Unit:** All pure utility functions pass with 100% branch coverage.
2. **Integration:** Service worker message router handles all defined types without runtime errors.
3. **E2E - Audio File:** A 5-second recording of a synthetic sine wave yields a `.webm` file > 10KB with valid Opus codec metadata.
4. **E2E - Session Integrity:** Stopped session metadata includes correct `durationMs` (within ±1s of requested record time), correct `tabTitle`, and valid `noteEvents` array.
5. **E2E - Notes:** A timestamped note sent during recording appears in the saved session's `noteEvents` with `atMs` within ±2s of the note creation time.
6. **E2E - No Audio Data Loss:** A 30-second recording plays back with continuous audio (no gaps/corruption detectable by `ffprobe`).

---

## 10. Next Steps (Recommended Priority)

1. **Install Node dependencies** (`npm install` in `Tab-Recorder/` so vitest runs)
2. **Add missing unit tests** for `fileStorage.js` helpers
3. **Create `scripts/audio_source.html`** for the synthetic audio tab
4. **Create `scripts/launch_test_chrome.sh`** with all required flags
5. **Create the E2E test harness** (Puppeteer or raw CDP over `chrome_repl`)  
6. **Patch or hook local save** to bypass `showDirectoryPicker()` for automation  
7. **Run the E2E test** against the synthetic audio page and verify the saved file
