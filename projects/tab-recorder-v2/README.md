# Tab Recorder

Audio-first Chrome extension for tab recording with lightweight knowledge workflows inspired by Glean.

## What This Version Adds

- Audio-only recording path (no video dependency).
- Timestamped active notes during recording.
- Client-facing popup focused on meeting name + note capture.
- Dedicated notes workspace page (`notes_page.html`) for reviewing sessions.
- Notes workspace can also sync Google Drive items (folders/audio/notes) via Drive API.
- Notes workspace supports add/edit notes and syncs note edits back to Drive markdown.
- `Refresh` in notes workspace reloads local sessions and syncs notes from Drive.
- Notes are now a single pad (not segmented entries) in popup and workspace.
- Workspace keeps one action button: `Open Drive`.
- Extension now opens as a right-side panel from the toolbar action.
- Drive delivery into a per-session folder (audio + notes markdown).
- Optional Zoom connector sync to pull cloud-ingested sessions into the same library.

## Why This Exists

V1 optimized tab audio+video capture. This version focuses on the workflow layer: preserving moments and making recordings retrievable by context.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked` and select `projects/tab-recorder-v2`.

## Share As Zip

If you want someone else to install your current extension build from a zip, use:

- `projects/tab-recorder-v2/SETUP.md`

## Use

1. Open the target tab and ensure audio is playing.
2. Click `Start Recording Active Tab`.
3. Add/edit the meeting name and timestamped notes while recording.
4. Click `Stop Recording`.
5. Click `Open Notes Page` to review saved sessions and open Drive artifacts.

## Data Model

Each session stores:

- `tabTitle`, `tabUrl`, `startedAt`, `endedAt`, `durationMs`
- `status` (`recording`, `complete`, `upload_error`, `failed`)
- `highlights[]` with `text` and `atMs` (used as meeting notes)
- `drive` metadata for audio file, notes file, and parent folder links

## Current Limits

- Uses browser tab capture; Zoom audio reliability can still vary by browser/media routing behavior.
- Search is local substring match over title, URL, and highlight text.
- Zoom connector sync requires the local connector service (`zoom-ingestion`) to be running.
