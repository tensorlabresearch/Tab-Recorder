# Tab Recorder: Share As Zip + Setup

## What To Zip

Zip the entire `tab-recorder-v2` extension folder:

- `projects/tab-recorder-v2/`

Do not include parent repo files like root `.env`, `.git`, or other projects.

## Create The Zip (Sender)

From repo root (`/Users/jameswidner/Documents/SuiteTemp`):

```bash
zip -r tab-recorder-v2.zip projects/tab-recorder-v2
```

If you only want runtime files and no docs:

```bash
cd projects/tab-recorder-v2
zip -r ../../tab-recorder-v2-runtime.zip . \
  -x "*.DS_Store" \
  -x "BENCHMARKS.md" \
  -x "CONTEXT.md" \
  -x "IMPLEMENTATION_BACKLOG.md" \
  -x "ZOOM_INGESTION_PLAN.md" \
  -x "zoom-ingestion/*"
```

## Unzip + Load (Recipient)

1. Unzip:

```bash
mkdir -p ~/Downloads/tab-recorder-v2-share
unzip tab-recorder-v2.zip -d ~/Downloads/tab-recorder-v2-share
```

2. Open Chrome extension page:

- Go to `chrome://extensions`
- Turn on `Developer mode`
- Click `Load unpacked`
- Select:
  - `~/Downloads/tab-recorder-v2-share/projects/tab-recorder-v2`
  - or the unzipped runtime folder root if you used runtime zip

3. Pin extension and open it from toolbar.

## First-Run Setup

1. Click extension icon to open side panel.
2. Start/stop a short recording test.
3. Open Notes Page and click `Refresh`.
4. If using transcription UI later, enter OpenAI key when prompted.

## Important Notes

- Do not share secrets in zip (no API keys in files).
- If Google Drive auth fails on recipient machine, they may need their own OAuth client setup for this extension build.
- After updates, reload extension in `chrome://extensions`.
