# Tab Recorder Extension (Chrome)

Records tab audio+video as WebM, then uploads to Google Drive.

## Setup
1. Create a Google Cloud project.
1. Enable the Google Drive API.
1. Create an OAuth client ID of type **Chrome Extension**.
1. Load the extension unpacked to get its extension ID.
1. Add that extension ID to the OAuth client in Google Cloud.
1. Copy the OAuth client ID into `manifest.json` at `oauth2.client_id`.
1. Reload the extension.

## Use
- Click the extension icon to open the tab picker and start recording.
- Or right-click a tab and choose **Record this tab**.
- Click the same tab’s **Stop** button in the popup to finish. Upload is automatic.
- Optional: set a fixed Google Drive folder ID in the popup.
- The popup shows the last upload and can open it directly in Drive.
- Audio monitor plays captured audio locally during recording (enabled by default).

## Output
Uploaded files are named like `tab-recording-YYYYMMDD-HHMMSS.webm`.

## Optional: convert to MP4 for STT
```bash
ffmpeg -i input.webm -c:v libx264 -c:a aac output.mp4
```

## Files
- `manifest.json`: MV3 config + OAuth scopes.
- `service_worker.js`: state, context menus, offscreen orchestration.
- `offscreen.html` + `offscreen.js`: capture, recorder, Drive upload.
- `popup.html` + `popup.js` + `popup.css`: tab picker UI.
