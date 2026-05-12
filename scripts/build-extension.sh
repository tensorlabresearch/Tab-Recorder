#!/usr/bin/env bash
set -euo pipefail

# Tab Recorder Extension Builder
# Creates a clean ZIP ready for Chrome Web Store upload

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXTENSION_DIR="${PROJECT_ROOT}/extension"
BUILD_DIR="${PROJECT_ROOT}/build"

echo "=== Tab Recorder Extension Builder ==="

# Validate extension exists
if [[ ! -d "${EXTENSION_DIR}" ]]; then
    echo "ERROR: extension/ directory not found at ${EXTENSION_DIR}"
    exit 1
fi

# Validate manifest
if [[ ! -f "${EXTENSION_DIR}/manifest.json" ]]; then
    echo "ERROR: manifest.json not found in ${EXTENSION_DIR}"
    exit 1
fi

# Read version from manifest
VERSION="$(jq -r '.version' "${EXTENSION_DIR}/manifest.json")"
NAME="$(jq -r '.name' "${EXTENSION_DIR}/manifest.json")"
echo "Extension: ${NAME} v${VERSION}"

# Clean and create build dir
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# Copy extension files to build staging area
echo "Staging files..."
STAGE_DIR="${BUILD_DIR}/extension-staged"
rsync -a --exclude='*.map' --exclude='.DS_Store' --exclude='__MACOSX' \
    "${EXTENSION_DIR}/" "${STAGE_DIR}/"

# Audit: ensure no remote loads, eval, or suspicious patterns
echo "Auditing for policy red flags..."
AUDIT_ISSUES=0

# Check for fetch(), eval(), new Function(), document.write, innerHTML in JS
# Note: panel.js legitimately uses innerHTML for table rendering (acceptable in panel.html)
# We only flag highly suspicious patterns: dynamic eval(), fetch() calls, remote URLs
RED_FLAG_PATTERN='(fetch\s*\(|new\s+Function\s*\(|eval\s*\(|document\.write\s*\()'
# Exclude vendored third-party libraries (transformers.js, onnx runtime)
RED_FLAG_FILES=$(find "${STAGE_DIR}/" -type f -name "*.js" \
    ! -path "*/transformersJs/*" ! -path "*/lamejs/*" \
    | xargs -r grep -rlnE "${RED_FLAG_PATTERN}" 2>/dev/null || true)

if [[ -n "${RED_FLAG_FILES}" ]]; then
    echo "  ⚠️ RED FLAG: Potential unsafe patterns found in:"
    echo "${RED_FLAG_FILES}" | sed 's/^/     /'
    AUDIT_ISSUES=$((AUDIT_ISSUES + 1))
else
    echo "  ✅ No eval/fetch/document.write patterns found"
fi

# Check for remote CDN URLs in JS (excluding comments)
CDN_PATTERN='https?://(cdn|unpkg|jsdelivr|ajax\.google|raw\.githubusercontent)'
CDN_FILES=$(find "${STAGE_DIR}/" -type f \( -name "*.js" -o -name "*.json" \) \
    ! -path "*/transformersJs/*" ! -path "*/lamejs/*" \
    | xargs -r grep -rlnE "${CDN_PATTERN}" 2>/dev/null || true)
if [[ -n "${CDN_FILES}" ]]; then
    echo "  ⚠️ RED FLAG: Potential CDN/remote URLs found in:"
    echo "${CDN_FILES}" | sed 's/^/     /'
    AUDIT_ISSUES=$((AUDIT_ISSUES + 1))
else
    echo "  ✅ No remote CDN references found"
fi

# Check for inline scripts in HTML
# All our script tags should be external module references like: <script type="module" src="...">
# Any <script>...</script> with actual JS content (not empty, not just src=) is flagged
INLINE_SCRIPT_FILES=0
while IFS= read -r htmlfile; do
    count=$(grep -cE '<script[^>]*>[^<]+' "$htmlfile" 2>/dev/null || echo "0")
    # Trim whitespace/newlines from count
    count=$(echo "$count" | tr -d '[:space:]')
    if [[ "$count" -gt 0 ]]; then
        INLINE_SCRIPT_FILES=$((INLINE_SCRIPT_FILES + 1))
    fi
done < <(find "${STAGE_DIR}/" -name "*.html" -type f)

if [[ "${INLINE_SCRIPT_FILES}" -gt 0 ]]; then
    echo "  ⚠️ RED FLAG: Inline <script> body content found in ${INLINE_SCRIPT_FILES} HTML file(s)"
    AUDIT_ISSUES=$((AUDIT_ISSUES + 1))
else
    echo "  ✅ HTML scripts are external module references only"
fi

# Check expected icons exist
for SIZE in 16 32 48 128; do
    if [[ ! -f "${STAGE_DIR}/icons/icon${SIZE}.png" ]]; then
        echo "  ⚠️ WARNING: Missing icon${SIZE}.png"
        AUDIT_ISSUES=$((AUDIT_ISSUES + 1))
    fi
done
echo "  ✅ Icon set verified"

# Check manifest critical fields
if [[ "$(jq -r '.name' "${STAGE_DIR}/manifest.json")" == "null" ]]; then
    echo "  ❌ ERROR: manifest missing 'name'"
    exit 1
fi
if [[ "$(jq -r '.version' "${STAGE_DIR}/manifest.json")" == "null" ]]; then
    echo "  ❌ ERROR: manifest missing 'version'"
    exit 1
fi
if [[ "$(jq -r '.description' "${STAGE_DIR}/manifest.json")" == "null" ]]; then
    echo "  ❌ ERROR: manifest missing 'description'"
    exit 1
fi
echo "  ✅ Manifest fields verified"

# Summary
if [[ "${AUDIT_ISSUES}" -gt 0 ]]; then
    echo ""
    echo "  ⚠️ ${AUDIT_ISSUES} audit issue(s) found. Review above."
    echo "  Build will continue but MANUAL REVIEW REQUIRED before submission."
    echo ""
fi

# Create ZIP at the root level (extension files directly inside, not a parent folder)
ZIP_NAME="tab-recorder-v${VERSION}.zip"
ZIP_PATH="${BUILD_DIR}/${ZIP_NAME}"

echo "Creating ZIP: ${ZIP_NAME}"
cd "${STAGE_DIR}"
zip -r "${ZIP_PATH}" . -x "*.map" -x "*.git*" -x "__MACOSX/*" -x ".DS_Store"
cd "${PROJECT_ROOT}"

# Statistics
FILE_COUNT=$(unzip -l "${ZIP_PATH}" | tail -1 | awk '{print $1}')
ZIP_SIZE=$(du -h "${ZIP_PATH}" | cut -f1)

echo ""
echo "=== Build Complete ==="
echo "File: ${ZIP_PATH}"
echo "Size: ${ZIP_SIZE}"
echo "Files: ${FILE_COUNT}"
echo ""
echo "Next steps:"
echo "1. If audit issues exist, review and fix before submitting."
echo "2. Upload ${ZIP_NAME} to the Chrome Web Store Developer Dashboard."
echo "3. Ensure store listing assets (screenshots, promo images) are ready."
echo "4. Complete the privacy practices questionnaire."
echo ""
echo "Dashboard: https://chrome.google.com/webstore/devconsole"
