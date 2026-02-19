# Tab Recorder Setup (From Zip)

## 1. What To Share

Share a zip that contains only this extension folder:

- `projects/tab-recorder-v2/`

Do not include root repo files (`.env`, `.git`, other projects).

## 2. Create Zip (Sender)

From repo root:

```bash
zip -r tab-recorder.zip projects/tab-recorder-v2
```

## 3. Unzip + Install (Recipient)

1. Unzip:

```bash
mkdir -p ~/Downloads/tab-recorder-share
unzip tab-recorder.zip -d ~/Downloads/tab-recorder-share
```

2. Load in Chrome:
- Open `chrome://extensions`
- Turn on `Developer mode`
- Click `Load unpacked`
- Select `~/Downloads/tab-recorder-share/projects/tab-recorder-v2`

## 4. First Run

1. Click extension icon to open side panel.
2. Start and stop a short recording.
3. Open Notes Page and click `Refresh`.

## 5. If Something Looks Stale

- Reload extension on `chrome://extensions`.
