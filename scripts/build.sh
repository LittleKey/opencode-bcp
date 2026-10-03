#!/usr/bin/env bash
# BCP 2.0.0 builder — one dual-entry bundle (server=v1, setup=v2).
#
# Deterministic, self-contained: builds ONLY from this repo's sources. There is
# deliberately no hidden global source path copy; combining optional community
# artifacts later is an explicit future extension of this CLI (the flags below
# are the frozen surface).
#
# Usage: build.sh [--entry <src.ts>] [--out-dir <dir>]
# Outputs:
#   <out-dir>/blackboard.ts   self-contained dual-entry bundle (provenance banner)
#   <out-dir>/release.json    machine-readable release/compatibility manifest
# Exits non-zero if the bundle would contain a runtime @opencode/* import
# (host SDK usage must stay type-only in both adapters).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

ENTRY="src/dual.ts"
OUT_DIR="dist"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --entry) ENTRY="${2:?--entry requires a path}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?--out-dir requires a path}"; shift 2 ;;
    *) echo "usage: build.sh [--entry <src.ts>] [--out-dir <dir>]" >&2; exit 2 ;;
  esac
done

VERSION="$(bun -e 'process.stdout.write(require("./package.json").version)')"
[[ -f "$ENTRY" ]] || { echo "ERROR: entry not found: $ENTRY" >&2; exit 2; }
mkdir -p "$OUT_DIR"

TMP_BUNDLE="$(mktemp "$OUT_DIR/.blackboard.bundle.XXXXXX")"
TMP_FINAL="$(mktemp "$OUT_DIR/.blackboard.final.XXXXXX")"
cleanup() { rm -f "$TMP_BUNDLE" "$TMP_FINAL"; }
trap cleanup EXIT

bun build "$ENTRY" --target=bun --outfile="$TMP_BUNDLE" >/dev/null

# Build-time assertion: the dual bundle must not depend on any host SDK at
# runtime — a v1 host would otherwise fail loading v2 code paths (and vice
# versa). Adapters keep @opencode/* imports type-only.
bad_imports="$(rg -n 'from\s+["'\'']@opencode' "$TMP_BUNDLE" || true)"
if [[ -n "$bad_imports" ]]; then
  echo "ERROR: bundle contains runtime @opencode/* import (must stay type-only):" >&2
  printf '%s\n' "$bad_imports" >&2
  exit 1
fi

BUILD_STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  # Bundle content is deterministic: identical inputs yield an identical
  # artifact hash. The wall-clock build stamp goes to release.json only.
  echo "// @opencode-bcp-generated v$VERSION dual-entry bundle (server=v1 >=1.18.29, setup=v2 >=2.0.20)"
  echo "// Generated artifact — do not edit by hand. Reinstall via scripts/install.sh."
  cat "$TMP_BUNDLE"
} > "$TMP_FINAL"
mv "$TMP_FINAL" "$OUT_DIR/blackboard.ts"
chmod 644 "$OUT_DIR/blackboard.ts" 2>/dev/null || true

SHA="$(sha256sum "$OUT_DIR/blackboard.ts" | cut -d' ' -f1)"
BYTES="$(wc -c < "$OUT_DIR/blackboard.ts" | tr -d ' ')"

cat > "$OUT_DIR/release.json" <<EOF
{
  "name": "opencode-bcp",
  "version": "$VERSION",
  "private": true,
  "unpublished": true,
  "entry": "$ENTRY",
  "artifact": "$OUT_DIR/blackboard.ts",
  "artifactSha256": "$SHA",
  "artifactBytes": $BYTES,
  "builtAt": "$BUILD_STAMP",
  "entryShape": { "id": "opencode-bcp", "server": "v1", "setup": "v2" },
  "compatibility": {
    "discoveryPath": "<config-root>/plugin/blackboard.ts",
    "v1": { "minimum": "1.18.29", "tested": "1.18.33", "entry": "server()" },
    "v2": { "minimum": "2.0.20", "tested": "2.0.20", "entry": "setup()" }
  }
}
EOF

echo "built: $OUT_DIR/blackboard.ts (v$VERSION, $BYTES bytes, sha256:$SHA)"
