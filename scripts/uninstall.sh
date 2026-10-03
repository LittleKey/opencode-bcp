#!/usr/bin/env bash
# BCP 2.0.0 uninstaller — ownership-checked removal.
#
# Removes the single canonical dual-entry install (via its install manifest)
# or, when no manifest exists, pre-2.0.0 legacy entries
# (v1 plugin/blackboard.ts|blackboard.js and v2 plugins/blackboard-v2.ts).
# Every removal requires exact ownership: a manifest sha256 match, a known
# legacy release digest, or an explicit --adopt of that exact digest. A name
# or substring marker proves nothing; user-modified or unmanaged files are
# refused, never deleted. Unrelated files and
# ~/.cache/opencode/blackboard data are never touched.
#
# A target project is NOT authorization to remove a plugin used by other
# projects: files are removed ONLY inside the installation root. BCP files
# in other host-discoverable roots (global root, ancestor roots) are reported
# but left untouched — uninstall explicitly at those roots if wanted.
#
# Usage: uninstall.sh [--project <dir>] [--adopt <file>=<sha256>]...
#   --project <dir>  remove only from <dir>/.opencode (default: global root).
#   --adopt <file>=<sha256>
#                    explicitly authorize removal of one unmanifested file at
#                    a managed legacy name iff its sha256 equals <sha256>
#                    (repeatable).
# Exit codes: 0 removed or nothing installed · 2 refused (ownership check) ·
# 3 --project target is not an existing directory · 1 unexpected failure
# (best-effort in-process rollback: originals restored, including symlink
# topology; NOT a SIGKILL/power-loss recovery claim).
set -euo pipefail

COMMON="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/_bcp_common.sh"
# shellcheck source=_bcp_common.sh
. "$COMMON"

MODE="global"; TARGET_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) MODE="project"; TARGET_DIR="${2:?--project requires a directory}"; shift 2 ;;
    --adopt) bcp_adopt_add "${2:?--adopt requires <file>=<sha256>}"; shift 2 ;;
    -h|--help) sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

BCP_MODE_PROJECT=0
if [[ "$MODE" == "project" ]]; then BCP_MODE_PROJECT=1; fi
bcp_resolve_roots

declare -A PLANNED=()
REMOVE=(); REFUSALS=(); ELSEWHERE=()
IS_TARGET=0

while IFS= read -r R; do
  [[ -n "$R" ]] || continue
  IS_TARGET=0; [[ "$R" == "$BCP_TARGET_ROOT" ]] && IS_TARGET=1
  M="$R/$BCP_MANIFEST_NAME"
  if [[ -f "$M" ]]; then
    F="$R/$BCP_CANONICAL_REL"
    if [[ -f "$F" ]]; then
      if [[ "$IS_TARGET" != 1 ]]; then
        PLANNED[$F]=1
        ELSEWHERE+=("$F (existing BCP install; not touched — uninstall explicitly at that root)")
      elif recorded="$(bcp_manifest_sha "$M")"; then
        if [[ "$recorded" == "$(bcp_sha_of "$F")" ]]; then
          PLANNED[$F]=1; REMOVE+=("$F")
          PLANNED[$M]=1; REMOVE+=("$M")
        else
          REFUSALS+=("user-modified managed file (sha256 mismatch against install manifest $M): $F")
        fi
      else
        REFUSALS+=("unparseable install manifest (ownership cannot be verified): $M")
      fi
    else
      # stale manifest, canonical already gone: only meaningful at this root
      if [[ "$IS_TARGET" == 1 ]]; then
        PLANNED[$M]=1; REMOVE+=("$M")
      fi
    fi
  fi
  for rel in $BCP_MANAGED_NAMES; do
    F="$R/$rel"
    [[ -f "$F" ]] || continue
    if [[ -n "${PLANNED[$F]:-}" ]]; then continue; fi
    if [[ "$IS_TARGET" != 1 ]]; then
      PLANNED[$F]=1
      ELSEWHERE+=("$F (BCP file at managed name outside the installation root; not touched)")
      continue
    fi
    sha="$(bcp_sha_of "$F")"
    if bcp_known_legacy_sha "$rel" "$sha"; then
      PLANNED[$F]=1; REMOVE+=("$F")
    elif adopted="$(bcp_adopted_sha "$F")"; then
      if [[ "$adopted" != "$sha" ]]; then
        REFUSALS+=("--adopt digest mismatch for $F: file is sha256:$sha, adopted digest is $adopted")
      else
        PLANNED[$F]=1; REMOVE+=("$F")
      fi
    else
      REFUSALS+=("file at managed legacy name matches no known release digest — a name or substring marker is not ownership (not removing): $F (sha256:$sha); after verifying it is yours, pass --adopt \"$F=$sha\"")
    fi
  done
done < <(bcp_scope_roots)

if [[ "${#REFUSALS[@]}" -gt 0 ]]; then
  echo "ERROR: refusing uninstall — ownership check failed:" >&2
  printf '  %s\n' "${REFUSALS[@]}" >&2
  exit 2
fi
if [[ "${#ELSEWHERE[@]}" -gt 0 ]]; then
  echo "present elsewhere (untouched):"
  printf '  %s\n' "${ELSEWHERE[@]}"
fi

if [[ "${#REMOVE[@]}" -eq 0 ]]; then
  echo "not installed (nothing found at the installation root: $BCP_TARGET_ROOT)"
  echo "storage kept: \$HOME/.cache/opencode/blackboard (data is not deleted)"
  exit 0
fi

bcp_tx_begin
for F in "${REMOVE[@]}"; do bcp_tx_backup "$F"; done
for F in "${REMOVE[@]}"; do rm -f -- "$F"; echo "removed: $F"; done
bcp_tx_commit
echo "storage kept: \$HOME/.cache/opencode/blackboard (data is not deleted)"
