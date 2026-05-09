#!/usr/bin/env bash
# transcribe.sh — Transcribe a Tab Recorder audio file using whisper.cpp + large-v3-turbo
#
# Usage:
#   ./transcribe.sh <path_to_webm_file> [output_directory]
#
# Example:
#   ./transcribe.sh ~/Downloads/Tab\ Recorder/2026-05-08/2026-05-08-0700_07-00.webm
#   ./transcribe.sh ~/Downloads/Tab\ Recorder/2026-05-08/2026-05-08-0700_07-00.webm ~/Documents/Transcripts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="${HOME}/.cache/whisper-cpp/models"
MODEL_NAME="ggml-large-v3-turbo.bin"
MODEL_PATH="${MODEL_DIR}/${MODEL_NAME}"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"

# Check for whisper-cli
if ! command -v whisper-cli &> /dev/null; then
    echo "Error: whisper-cli is not installed or not in PATH." >&2
    echo "Install it with: brew install whisper-cpp" >&2
    exit 1
fi

# Check for ffmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "Error: ffmpeg is not installed or not in PATH." >&2
    echo "Install it with: brew install ffmpeg" >&2
    exit 1
fi

# Validate arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <path_to_webm_file> [output_directory]" >&2
    echo "  output_directory: optional; defaults to the same directory as the audio file" >&2
    exit 1
fi

AUDIO_FILE="$1"
shift

# Default output directory to the audio file's parent directory
if [ $# -ge 1 ]; then
    OUTPUT_DIR="$1"
else
    OUTPUT_DIR="$(dirname "$AUDIO_FILE")"
fi

# Verify the audio file exists
if [ ! -f "$AUDIO_FILE" ]; then
    echo "Error: Audio file not found: $AUDIO_FILE" >&2
    exit 1
fi

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

BASENAME=$(basename "$AUDIO_FILE" .webm)
TRANSCRIPT_FILE="${OUTPUT_DIR}/${BASENAME}.txt"
WAV_TEMP="${OUTPUT_DIR}/.tmp_${BASENAME}_16bit.wav"

# Download model if needed
download_model() {
    echo "Model not found locally. Downloading ${MODEL_NAME}..." >&2
    echo "This is a one-time download (~1.6 GB)." >&2
    mkdir -p "${MODEL_DIR}"
    curl -L --progress-bar -o "${MODEL_PATH}.tmp" "${MODEL_URL}"
    mv "${MODEL_PATH}.tmp" "${MODEL_PATH}"
    echo "Model downloaded to ${MODEL_PATH}" >&2
}

if [ ! -f "${MODEL_PATH}" ]; then
    download_model
else
    echo "Using cached model: ${MODEL_PATH}"
fi

# Convert webm to 16-bit WAV (whisper-cli native requirement)
echo "Converting ${AUDIO_FILE} to 16-bit WAV..."
ffmpeg -y -i "${AUDIO_FILE}" -ar 16000 -ac 1 -c:a pcm_s16le "${WAV_TEMP}" &> /dev/null

# Transcribe with whisper-cli
echo "Transcribing with whisper-cli (model: large-v3-turbo)..."
whisper-cli \
    -m "${MODEL_PATH}" \
    -f "${WAV_TEMP}" \
    -l en \
    -t 8 \
    -otxt \
    -of "${OUTPUT_DIR}/${BASENAME}" \
    -pp

# whisper-cli -otxt writes to OUTPUT_DIR/BASENAME.txt
# Clean up temp wav
rm -f "${WAV_TEMP}"

echo "---"
echo "Transcript saved to: ${TRANSCRIPT_FILE}"
