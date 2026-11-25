#!/usr/bin/env bash
# Repository-local file-only entry. Never installs or invokes a host/model.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"
OUT_DIR="${1:-dist/file-archive}"
mkdir -p "$OUT_DIR"
bun build src/file-archive.ts --target=bun --outfile="$OUT_DIR/file-archive.js"
if rg -n 'from\s+["\x27]@opencode' "$OUT_DIR/file-archive.js"; then
  echo "ERROR: runtime host SDK import in file archive bundle" >&2
  exit 1
fi
echo "built repository-only file archive: $OUT_DIR/file-archive.js"
