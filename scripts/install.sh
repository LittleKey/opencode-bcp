#!/usr/bin/env bash
# BCP 2.0.0 host-aware transactional installer (single canonical managed file).
#
# Official same-package dual entry: ONE file, <config-root>/plugin/blackboard.ts,
# discovered by BOTH host majors (the v2 host scans plugin/ AND plugins/ plus
# every global/ancestor/project config root, so exactly one canonical copy must
# remain host-discoverable). Files are added/removed/replaced ONLY inside the
# installation root; anything user-modified is refused, never overwritten.
#
# Usage:
#   install.sh [--project <dir>] [--host v1|v2|<executable>] [--artifact <file>]
#              [--skip-build] [--adopt <file>=<sha256>]...
#
#   --project <dir>   install into <dir>/.opencode/plugin (dir must already
#                     exist, else exit 3). Default: global root
#                     (OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME/opencode >
#                     $HOME/.config/opencode).
#   --host            explicit host: keyword (v1|v2, verified against the
#                     'opencode' on PATH) or an executable path whose
#                     `--version` output is parsed. Default: probe PATH.
#                     Gates: v1 requires >= 1.18.29 (tested 1.18.33);
#                     v2 requires >= 2.0.20 (tested 2.0.20).
#   --artifact <file> install this prebuilt bundle instead of building
#                     (implies --skip-build).
#   --skip-build      use dist/blackboard.ts as-is (also: BB_INSTALL_SKIP_BUILD=1).
#   --adopt <file>=<sha256>
#                     explicitly adopt one unmanifested file at a managed
#                     legacy name iff its sha256 equals <sha256> (repeatable).
#                     Without a matching known release digest or an exact
#                     adoption, files at managed legacy names are refused;
#                     the file's name or a substring marker proves nothing.
#
# Scope/collisions: BCP files OUTSIDE the installation root (global root,
# ancestor roots) are collisions — the host would discover both copies, so
# this install refuses BEFORE mutating and lists them. Run an explicit install
# at each of those roots to migrate or remove them there.
#
# Exit codes: 0 installed/already up to date · 2 usage, unsupported host,
# collision outside the installation root, unmanaged or user-modified conflict
# · 3 --project target is not an existing directory · 1 unexpected failure
# (best-effort in-process rollback: originals restored, including symlink
# topology; NOT a SIGKILL/power-loss recovery claim).
# Machine-readable manifest: <config-root>/bcp-install.json
# Storage data ($HOME/.cache/opencode/blackboard) is never touched.
# Test-only fault injection: BCP_INSTALL_FAULT=after-backup|after-removals|before-manifest
set -euo pipefail

COMMON="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/_bcp_common.sh"
# shellcheck source=_bcp_common.sh
. "$COMMON"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

MODE="global"; TARGET_DIR=""; HOST_ARG=""; ARTIFACT=""
SKIP_BUILD="${BB_INSTALL_SKIP_BUILD:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) MODE="project"; TARGET_DIR="${2:?--project requires a directory}"; shift 2 ;;
    --host) HOST_ARG="${2:?--host requires v1|v2|<executable-path>}"; shift 2 ;;
    --artifact) ARTIFACT="${2:?--artifact requires a file}"; SKIP_BUILD=1; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --adopt) bcp_adopt_add "${2:?--adopt requires <file>=<sha256>}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# --- 1. bundle artifact -------------------------------------------------------
if [[ -z "$ARTIFACT" ]]; then
  if [[ "$SKIP_BUILD" != "1" ]]; then
    bash "$REPO/scripts/build.sh" >/dev/null
  fi
  ARTIFACT="$REPO/dist/blackboard.ts"
fi
if [[ ! -f "$ARTIFACT" ]]; then
  bcp_die 2 "bundle artifact not found: $ARTIFACT (run scripts/build.sh first, or pass --artifact)"
fi
if [[ -d "$(dirname "$ARTIFACT")" ]]; then
  ARTIFACT="$(bcp_physical_dir "$(dirname "$ARTIFACT")")/$(basename "$ARTIFACT")"
fi
ART_SHA="$(bcp_sha_of "$ARTIFACT")"
[[ -n "$ART_SHA" ]] || bcp_die 2 "cannot hash bundle artifact: $ARTIFACT"

# --- 2. host compatibility gate (install-time, before any mutation) -----------
bcp_detect_host "$HOST_ARG"

# --- 3. scope ------------------------------------------------------------------
BCP_MODE_PROJECT=0
if [[ "$MODE" == "project" ]]; then BCP_MODE_PROJECT=1; fi
bcp_resolve_roots

# --- 4. classify every host-discoverable BCP file ------------------------------
# The installation root (BCP_TARGET_ROOT) is the only scope mutated. Every
# other host-discoverable root is checked for collisions: a BCP file there
# would make the host load the plugin twice, so the install refuses BEFORE
# mutating and reports the paths for an explicit install at that root.
declare -A PLANNED=()
REMOVE=(); MIGRATED=(); REFUSALS=(); CLEANED=(); COLLISIONS=()
IDEMPOTENT=0
IS_TARGET=0

while IFS= read -r R; do
  [[ -n "$R" ]] || continue
  IS_TARGET=0; [[ "$R" == "$BCP_TARGET_ROOT" ]] && IS_TARGET=1
  M="$R/$BCP_MANIFEST_NAME"
  if [[ -f "$M" ]]; then
    F="$R/$BCP_CANONICAL_REL"
    if [[ -f "$F" ]]; then
      if recorded="$(bcp_manifest_sha "$M")"; then
        actual="$(bcp_sha_of "$F")"
        if [[ "$recorded" == "$actual" ]]; then
          if [[ "$IS_TARGET" == 1 && "$recorded" == "$ART_SHA" ]]; then
            # up-to-date canonical install at the target root: keep both files
            # in place (PLANNED guards them from the legacy scan below)
            IDEMPOTENT=1
            PLANNED[$F]=1; PLANNED[$M]=1
          elif [[ "$IS_TARGET" == 1 ]]; then
            PLANNED[$F]=1; REMOVE+=("$F")
            MIGRATED+=("$R"$'\t'"$BCP_CANONICAL_REL"$'\t'"$actual")
            PLANNED[$M]=1; REMOVE+=("$M")
          else
            PLANNED[$F]=1
            COLLISIONS+=("$F (existing BCP install; run install.sh explicitly at that root to migrate or uninstall.sh to remove)")
          fi
        else
          if [[ "$IS_TARGET" == 1 ]]; then
            REFUSALS+=("user-modified managed file (sha256 mismatch against install manifest $M): $F")
          else
            PLANNED[$F]=1
            COLLISIONS+=("$F (user-modified against its install manifest $M; handle it at that root)")
          fi
        fi
      else
        if [[ "$IS_TARGET" == 1 ]]; then
          REFUSALS+=("unparseable install manifest (ownership cannot be verified): $M")
        else
          PLANNED[$F]=1
          COLLISIONS+=("$F (install manifest unreadable: $M; handle it at that root)")
        fi
      fi
    else
      # stale manifest without a canonical file: the host discovers nothing
      # here; clean it only inside the installation root
      if [[ "$IS_TARGET" == 1 ]]; then
        PLANNED[$M]=1; REMOVE+=("$M"); CLEANED+=("$M")
      fi
    fi
  fi
  for rel in $BCP_MANAGED_NAMES; do
    F="$R/$rel"
    if [[ -f "$F" && -z "${PLANNED[$F]:-}" ]]; then
      if [[ "$IS_TARGET" != 1 ]]; then
        PLANNED[$F]=1
        COLLISIONS+=("$F (BCP file at managed name outside the installation root; run install.sh explicitly at that root to migrate it)")
        continue
      fi
      sha="$(bcp_sha_of "$F")"
      if bcp_known_legacy_sha "$rel" "$sha"; then
        PLANNED[$F]=1; REMOVE+=("$F")
        MIGRATED+=("$R"$'\t'"$rel"$'\t'"$sha")
      elif adopted="$(bcp_adopted_sha "$F")"; then
        if [[ "$adopted" != "$sha" ]]; then
          REFUSALS+=("--adopt digest mismatch for $F: file is sha256:$sha, adopted digest is $adopted")
        else
          PLANNED[$F]=1; REMOVE+=("$F")
          MIGRATED+=("$R"$'\t'"$rel"$'\t'"$sha")
        fi
      else
        REFUSALS+=("file at managed legacy name matches no known release digest — a name or substring marker is not ownership: $F (sha256:$sha); after verifying it is yours, pass --adopt \"$F=$sha\"")
      fi
    fi
  done
  if [[ "$IS_TARGET" == 1 ]]; then
    for sub in plugin plugins; do
      D="$R/$sub"
      [[ -d "$D" ]] || continue
      for F in "$D"/blackboard*; do
        [[ -f "$F" ]] || continue
        if [[ -n "${PLANNED[$F]:-}" ]]; then continue; fi
        base="$(basename "$F")"
        case "$base" in
          blackboard.ts|blackboard.js|blackboard-v2.ts) ;; # handled above
          blackboard.ts.tmp.*)
            PLANNED[$F]=1; REMOVE+=("$F"); CLEANED+=("$F") ;; # crashed atomic-write leftover
          *)
            REFUSALS+=("unmanaged conflicting plugin file: $F") ;;
        esac
      done
    done
  fi
done < <(bcp_scope_roots)

if [[ "$IDEMPOTENT" == "1" && "${#REMOVE[@]}" -gt 0 ]]; then
  # up-to-date canonical exists, but the installation root still has managed
  # leftovers to migrate: rewrite the canonical too so the manifest records
  # the migration.
  F="$BCP_TARGET_ROOT/$BCP_CANONICAL_REL"; M="$BCP_TARGET_ROOT/$BCP_MANIFEST_NAME"
  PLANNED[$F]=1; REMOVE+=("$F")
  MIGRATED+=("$BCP_TARGET_ROOT"$'\t'"$BCP_CANONICAL_REL"$'\t'"$ART_SHA")
  PLANNED[$M]=1; REMOVE+=("$M")
  IDEMPOTENT=0
fi

if [[ "${#COLLISIONS[@]}" -gt 0 ]]; then
  echo "ERROR: refusing install — BCP files detected OUTSIDE the installation root ($BCP_TARGET_ROOT). The host would discover both; they are never touched by this install. Run install.sh explicitly at each of those roots to migrate them, or uninstall.sh there:" >&2
  printf '  %s\n' "${COLLISIONS[@]}" >&2
  exit 2
fi

if [[ "${#REFUSALS[@]}" -gt 0 ]]; then
  echo "ERROR: refusing install — unmanaged or user-modified BCP files at the installation root (delete or restore them first, or adopt an exact digest with --adopt <file>=<sha256>):" >&2
  printf '  %s\n' "${REFUSALS[@]}" >&2
  exit 2
fi

if [[ "$IDEMPOTENT" == "1" && "${#REMOVE[@]}" -eq 0 ]]; then
  echo "already installed: $BCP_TARGET_ROOT/$BCP_CANONICAL_REL (sha256:$ART_SHA, up to date)"
  echo "host: $BCP_FAMILY $BCP_HOST_VERSION via $BCP_HOST_EXE"
  exit 0
fi

# --- 5. transaction -------------------------------------------------------------
CANONICAL="$BCP_TARGET_ROOT/$BCP_CANONICAL_REL"
MANIFEST="$BCP_TARGET_ROOT/$BCP_MANIFEST_NAME"

bcp_fault() {
  if [[ "${BCP_INSTALL_FAULT:-}" == "$1" ]]; then
    echo "ERROR: injected test fault reached: $1" >&2
    exit 1
  fi
}

bcp_tx_begin

# Back up everything we will remove or replace (symlinks keep their topology).
for F in "${REMOVE[@]}"; do bcp_tx_backup "$F"; done
bcp_fault after-backup
# Remove everything except the canonical pair: the previous canonical file and
# manifest stay in place until their atomic replacements below, so the plugin
# entry is present at every point in time.
for F in "${REMOVE[@]}"; do
  [[ "$F" == "$CANONICAL" || "$F" == "$MANIFEST" ]] && continue
  rm -f -- "$F"
done
bcp_fault after-removals

mkdir -p "$BCP_TARGET_ROOT/plugin"
STAGE="$BCP_TARGET_ROOT/plugin/blackboard.ts.tmp.$$"
bcp_tx_created "$STAGE"
if ! cp -- "$ARTIFACT" "$STAGE"; then
  rm -f -- "$STAGE"
  bcp_die 1 "staging bundle into $BCP_TARGET_ROOT/plugin failed"
fi
bcp_tx_created "$CANONICAL"
if ! mv -f -- "$STAGE" "$CANONICAL"; then
  bcp_die 1 "activating bundle at $CANONICAL failed"
fi
chmod 644 -- "$CANONICAL" 2>/dev/null || true
if [[ "$(bcp_sha_of "$CANONICAL")" != "$ART_SHA" ]]; then
  bcp_die 1 "post-write verification failed for $CANONICAL"
fi
bcp_fault before-manifest

VERSION="$(bcp_package_version "$REPO")"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MIGRATED_ENTRIES=()
for rec in "${MIGRATED[@]:-}"; do
  [[ -n "$rec" ]] || continue
  IFS=$'\t' read -r mroot mrel msha <<< "$rec"
  MIGRATED_ENTRIES+=("    { \"root\": \"$(bcp_json_escape "$mroot")\", \"file\": \"$mrel\", \"sha256\": \"$msha\" }")
done
MIGRATED_JSON=""
for i in "${!MIGRATED_ENTRIES[@]}"; do
  if [[ "$i" -gt 0 ]]; then MIGRATED_JSON+=",
"; fi
  MIGRATED_JSON+="${MIGRATED_ENTRIES[$i]}"
done

STAGE_MANIFEST="$BCP_TARGET_ROOT/$BCP_MANIFEST_NAME.tmp.$$"
bcp_tx_created "$STAGE_MANIFEST"
bcp_tx_created "$MANIFEST"
if ! cat > "$STAGE_MANIFEST" <<EOF
{
  "schema": "opencode-bcp.install/1",
  "name": "opencode-bcp",
  "version": "$VERSION",
  "installedAt": "$NOW",
  "host": { "family": "$BCP_FAMILY", "version": "$BCP_HOST_VERSION", "executable": "$(bcp_json_escape "$BCP_HOST_EXE")" },
  "root": "$(bcp_json_escape "$BCP_TARGET_ROOT")",
  "file": "$BCP_CANONICAL_REL",
  "artifact": "$(bcp_json_escape "$ARTIFACT")",
  "artifactSha256": "$ART_SHA",
  "entryShape": { "id": "opencode-bcp", "server": "v1", "setup": "v2" },
  "requirements": { "v1": ">= $BCP_V1_MIN (tested $BCP_V1_TESTED)", "v2": ">= $BCP_V2_MIN (tested $BCP_V2_TESTED)" },
  "migrated": [
$MIGRATED_JSON
  ]
}
EOF
then
  bcp_die 1 "writing install manifest failed"
fi
if ! mv -f -- "$STAGE_MANIFEST" "$MANIFEST"; then
  bcp_die 1 "activating install manifest at $MANIFEST failed"
fi
if [[ "$(bcp_manifest_sha "$MANIFEST")" != "$ART_SHA" ]]; then
  bcp_die 1 "manifest verification failed for $MANIFEST"
fi

bcp_tx_commit

echo "installed: $CANONICAL (sha256:$ART_SHA)"
echo "host: $BCP_FAMILY $BCP_HOST_VERSION via $BCP_HOST_EXE"
echo "migrated: ${#MIGRATED[@]} managed BCP file(s) removed; cleaned: ${#CLEANED[@]}"
echo "manifest: $MANIFEST"
echo "storage data untouched: \$HOME/.cache/opencode/blackboard"
