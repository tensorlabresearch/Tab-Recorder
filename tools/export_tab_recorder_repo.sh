#!/usr/bin/env bash
set -euo pipefail

# Create a clean folder that contains only the active extension + setup docs.
# Useful when publishing a clean GitHub repo or sending to another person.

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$SRC_ROOT/projects/tab-recorder-v2"
OUT_DIR="${1:-/tmp/tab-recorder-clean}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

rsync -av "$EXT_DIR/" "$OUT_DIR/" \
  --exclude '.DS_Store' \
  --exclude 'zoom-ingestion/.venv/' \
  --exclude 'zoom-ingestion/data/'

cat > "$OUT_DIR/README.md" << 'DOC'
# Tab Recorder

## Install in Chrome
1. Open `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select this folder

## Notes
- This package includes only the active extension build.
- If the extension was already loaded, click Reload in `chrome://extensions`.
DOC

echo "Clean export created at: $OUT_DIR"
