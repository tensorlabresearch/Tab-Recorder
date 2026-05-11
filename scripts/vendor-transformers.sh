#!/usr/bin/env bash
# Copies the Transformers.js + onnxruntime-web artifacts the extension needs
# from node_modules/ into extension/lib/transformersJs/.
#
# Patches transformers.web.min.js to replace the bare specifier
# `onnxruntime-web/webgpu` (which browsers can't resolve) with a relative
# path to the vendored ort.webgpu bundle.
#
# Run after `npm install` whenever @huggingface/transformers or
# onnxruntime-web is updated.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_TRANSFORMERS="$REPO_ROOT/node_modules/@huggingface/transformers/dist"
SRC_ORT="$REPO_ROOT/node_modules/onnxruntime-web/dist"
SRC_ORT_COMMON="$REPO_ROOT/node_modules/onnxruntime-common/dist/esm"
DEST="$REPO_ROOT/extension/lib/transformersJs"

if [ ! -d "$SRC_TRANSFORMERS" ]; then
  echo "[vendor-transformers] @huggingface/transformers not installed; run npm install first." >&2
  exit 1
fi

mkdir -p "$DEST/wasm"

cp "$SRC_TRANSFORMERS/transformers.web.min.js" "$DEST/transformers.web.min.js"
cp "$SRC_ORT/ort.webgpu.bundle.min.mjs"        "$DEST/ort.webgpu.bundle.min.mjs"

# ONNX runtime web picks one of these wasm variants at runtime depending on
# what the browser exposes:
#   .jsep.*       — preferred path for WebGPU (JS Execution Provider)
#   .asyncify.*   — fallback used by the WebGPU JSEP bridge in browsers without
#                   JSPI; the jsep build dynamically imports this glue.
#   (plain)       — CPU-only fallback if neither WebGPU nor jsep is available.
for variant in jsep asyncify ""; do
  if [ -n "$variant" ]; then v_dot=".$variant"; else v_dot=""; fi
  cp "$SRC_ORT/ort-wasm-simd-threaded${v_dot}.mjs"  "$DEST/wasm/ort-wasm-simd-threaded${v_dot}.mjs"
  cp "$SRC_ORT/ort-wasm-simd-threaded${v_dot}.wasm" "$DEST/wasm/ort-wasm-simd-threaded${v_dot}.wasm"
done
cp "$REPO_ROOT/node_modules/@huggingface/transformers/LICENSE" "$DEST/LICENSE" 2>/dev/null || true

# Vendor the onnxruntime-common ESM tree (transformers.web.min.js statically
# imports `Tensor` from "onnxruntime-common" — bare specifiers don't resolve in
# browser module loaders, so we copy the tree and rewrite the import below).
rm -rf "$DEST/onnxruntime-common"
cp -R "$SRC_ORT_COMMON" "$DEST/onnxruntime-common"

# Patch bare specifiers so module workers can resolve them.
python3 - <<PY
import pathlib
p = pathlib.Path("$DEST/transformers.web.min.js")
src = p.read_text()
src = src.replace('"onnxruntime-web/webgpu"', '"./ort.webgpu.bundle.min.mjs"')
src = src.replace('from"onnxruntime-common"', 'from"./onnxruntime-common/index.js"')
p.write_text(src)
PY

echo "[vendor-transformers] done."
ls -la "$DEST"
