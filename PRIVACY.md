# Tab Recorder — Privacy Practices

This document is used to answer the **Privacy practices** questionnaire in the Chrome Web Store Developer Dashboard.

## Single Purpose Description

Tab Recorder is an audio-first browser extension that captures browser tab audio (and optionally microphone input) directly within Chrome, stores recordings locally, and provides optional on-device speech-to-text transcription and on-device summarization. Its single purpose is **browser tab audio recording with local storage, local transcription, and local summarization**.

## Data Collection — What Data Is Gathered?

**No remote data collection.** Tab Recorder does NOT collect, transmit, or process user data on remote servers. All data stays local.

### Data handled locally:
1. **Audio recordings** — Captured via `getDisplayMedia()`/`getUserMedia()` and stored as files on the user's local disk
2. **Transcription text** — Generated locally via ONNX Runtime WASM (Transformers.js) within the browser
3. **Summary + description** — Generated locally by Chrome's built-in Gemini Nano (the Prompt API), only when the user has already enabled the model in `chrome://flags` and the browser reports it as available. The extension itself never triggers the multi-gigabyte model download.
4. **Session metadata** — Recording names, duration, timestamps stored in `chrome.storage.local`
5. **File handles** — References to user-selected recording directory (via `showSaveFilePicker`)

### Data NOT collected:
- No account or identity information
- No analytics or telemetry
- No remote logging or crash reporting
- No data sent to external APIs or cloud services (including: huggingface.co is not pinged in production; see Permissions section)

## Permissions Justification

| Permission | Why It's Needed |
|---|---|
| `activeTab` | To detect which tab is currently active when recording starts |
| `tabCapture` | To capture audio from a specific browser tab via `chrome.tabCapture.capture()` |
| `desktopCapture` | To present the native screen/tab/audio picker via `chrome.desktopCapture.chooseDesktopMedia()` |
| `tabs` | To read tab title/URL metadata for labeling recordings (read-only) |
| `storage` | To persist session metadata (recording list, titles, durations) across browser restarts |
| `downloads` | To save recordings to the user's Downloads folder with a default filename |
| `host_permissions: <all_urls>` | Required by `tabCapture` API to capture audio from any active tab regardless of origin |

**Removed in v1.1.0:** `host_permissions: https://huggingface.co/*` was previously included for development/debugging of local model loading. This permission has been removed because Whisper models run entirely locally via WASM/ONNX; no network calls are made.

## Data Usage — How Is Data Used?

- **Audio**: Saved as `.webm` files to the user's chosen local directory. The user can optionally convert to `.mp3` locally.
- **Transcription**: Generated entirely in a Web Worker using bundled ONNX runtime. No text is sent to any server.
- **Summary + description**: When the user opts in and Chrome's built-in Gemini Nano is already present on the device, the transcript is passed to the on-device model via the browser's Prompt API. Inference runs locally; no transcript or summary text leaves the machine. The resulting summary lives next to the recording as a plain `.summary.md` file. The extension probes availability with `LanguageModel.availability()` and only proceeds when the status is `"available"` — never `"downloadable"` — so it cannot initiate the model download on the user's behalf.
- **Metadata**: Used solely to populate the recordings list UI.

## Data Sharing — With Whom Is Data Shared?

**No one.** All data is local-first. There is no third-party sharing, no cloud sync, no advertising.

## User Control

- Users choose where recordings are saved (via file picker or default Downloads folder)
- Users can delete individual recordings within the panel UI
- Users can clear all session data via the browser's "Clear browsing data" → "Hosted app data"
- Recordings are ordinary files on disk; users manage them with their OS file manager

## Compliance

- GDPR: No personal data is collected or transferred.
- CCPA: No sale of personal information.
- Children's data: Not applicable; Tab Recorder does not target children and collects no user data.

## Contact

For privacy questions, open an issue on the GitHub repository.
