![Tab Recorder Logo](icon128.png)


# Tab Recorder (Chrome Extension)

Audio-first tab recorder for meetings, with a side-panel workflow, Drive upload, and notes workspace.

## Install (Developer Mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `projects/tab-recorder-v2`
5. Click the extension icon to open the side panel

## What You Get

- Record active tab audio to Google Drive
- Meeting notes while recording
- Notes workspace with playback + timestamped playback notes
- Per-session Drive folder with audio + notes markdown

## Repo Layout

- `projects/tab-recorder-v2` -> active extension code (this is the one to install)
- `projects/tab-recorder-extension` -> older version

## Zip For Sharing

Use the instructions in:

- `projects/tab-recorder-v2/SETUP.md`

## Quick Troubleshooting

- If changes do not appear: go to `chrome://extensions` and click **Reload** on Tab Recorder.
- If panel opens stale: close/reopen side panel after reload.
