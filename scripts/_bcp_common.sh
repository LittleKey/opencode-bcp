#!/usr/bin/env bash
# Shared internals for scripts/install.sh and scripts/uninstall.sh (BCP 2.0.0).
# Not meant to be executed directly.
#
# Model: exactly ONE canonical managed file per host-visible scope:
#   <config-root>/plugin/blackboard.ts        (discovered by v1 AND v2 hosts;
#                                              v2 additionally scans plugins/ and
#                                              every global/ancestor/project root)
# Ownership:
#   - <config-root>/bcp-install.json          machine-readable install manifest
#   - managed legacy names (pre-2.0.0 installer outputs, migrated on contact):
#       plugin/blackboard.ts, plugin/blackboard.js, plugins/blackboard-v2.ts
#   - a file at a managed name is OURS only on an exact content digest: a
#     known legacy release digest (bcp_known_legacy_sha, recoverable from this
#     repo's history) or an explicit --adopt of that exact digest. A
#     name/substring marker alone proves nothing about who wrote the file;
#     anything else is user-modified and REFUSED, never overwritten.
#     Manifest sha256-mismatch rejection is unchanged.
# Unrelated files and ~/.cache/opencode/blackboard data are never touched.
# Unrelated files and ~/.cache/opencode/blackboard data are never touched.

# --- constants ---------------------------------------------------------------
BCP_CANONICAL_REL="plugin/blackboard.ts"
BCP_MANIFEST_NAME="bcp-install.json"
BCP_MANAGED_NAMES="plugin/blackboard.ts plugin/blackboard.js plugins/blackboard-v2.ts"
BCP_V1_MIN="1.18.29";  BCP_V1_TESTED="1.18.33"
BCP_V2_MIN="2.0.20";   BCP_V2_TESTED="2.0.20"

# --- basics ------------------------------------------------------------------
bcp_die() { local code="$1"; shift; echo "ERROR: $*" >&2; exit "$code"; }

bcp_physical_dir() { (cd "$1" 2>/dev/null && pwd -P); }

bcp_sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# true if dotted version $1 >= floor $2 (GNU sort -V; linux platform)
bcp_ver_at_least() {
  local first
  first="$(printf '%s\n%s\n' "$1" "$2" | sort -V | { IFS= read -r first; printf '%s' "$first"; })"
  [[ "$first" == "$2" ]]
}

# --- legacy ownership: exact release digests + explicit adoption ------------------
# A file at a managed legacy name is ours only on an exact content digest.
# Known legacy release digests, each verifiable against this repository:
#   plugin/blackboard.ts = f682fef1...0de40c — the v1 bundle as installed by the
#   v1.20.0-era installer (recoverable from git:
#   harness/live-agg/.opencode/plugin/blackboard.ts). No pre-2.0.0 v2/.js
#   release bytes are recoverable, so those names require explicit adoption.
bcp_known_legacy_sha() { # $1=relative managed name $2=sha256 → 0 if a known release
  case "$1:$2" in
    plugin/blackboard.ts:f682fef193284420c184cc99f00c03b04ee28a7394988fa4aa15ef93af0de40c) return 0 ;;
    *) return 1 ;;
  esac
}

# Explicit, documented adoption: --adopt <file>=<sha256> authorizes migration
# or removal of exactly that physical file iff its content sha256 equals
# <sha256>. Parsed by the entry scripts before any mutation.
BCP_ADOPTED=()
bcp_adopt_add() { # $1=spec "<file>=<sha256>"
  local spec="$1" f="" s="" phys
  if [[ "$spec" != *=* ]]; then
    bcp_die 2 "--adopt expects <file>=<sha256> (got: $spec)"
  fi
  f="${spec%%=*}"; s="${spec#*=}"
  if [[ ! "$s" =~ ^[0-9a-f]{64}$ ]]; then
    bcp_die 2 "--adopt digest must be 64 lowercase hex chars (got: $s)"
  fi
  phys="$(bcp_physical_dir "$(dirname "$f")")"
  if [[ -n "$phys" ]]; then f="$phys/$(basename "$f")"; fi
  BCP_ADOPTED+=("$f=$s")
}
bcp_adopted_sha() { # $1=file → prints the adopted digest iff this exact file is adopted
  local f="$1" e af as
  for e in "${BCP_ADOPTED[@]:-}"; do
    [[ -n "$e" ]] || continue
    af="${e%%=*}"; as="${e#*=}"
    if [[ "$af" == "$f" ]]; then printf '%s' "$as"; return 0; fi
  done
  return 1
}

bcp_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# extract "artifactSha256": "<64 hex>" from an install/release manifest
bcp_manifest_sha() {
  local content
  content="$(cat "$1" 2>/dev/null)" || return 1
  [[ "$content" =~ \"artifactSha256\"[:[:space:]]*\"([0-9a-f]{64})\" ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}

# best-effort package version without requiring bun at install time
bcp_package_version() {
  local repo="$1" v="" f
  for f in "$repo/dist/release.json" "$repo/package.json"; do
    if [[ -f "$f" ]]; then
      v="$(cat "$f" 2>/dev/null)" || v=""
      if [[ "$v" =~ \"version\"[:[:space:]]*\"([^\"]+)\" ]]; then
        printf '%s' "${BASH_REMATCH[1]}"; return 0
      fi
    fi
  done
  printf '%s' "unknown"
}

# --- host detection / compatibility gate ---------------------------------------
# Sets: BCP_FAMILY (v1|v2), BCP_HOST_VERSION, BCP_HOST_EXE
bcp_detect_host() {
  local host_arg="$1"
  local exe="" require_family=""
  if [[ -n "$host_arg" ]]; then
    case "$host_arg" in
      v1|v2)
        exe="$(command -v opencode 2>/dev/null || true)"
        if [[ -z "$exe" ]]; then
          bcp_die 2 "--host $host_arg given but no 'opencode' executable on PATH to verify against"
        fi
        require_family="$host_arg" ;;
      *)
        if [[ ! -x "$host_arg" ]]; then
          bcp_die 2 "--host executable not found or not executable: $host_arg"
        fi
        exe="$host_arg" ;;
    esac
  else
    exe="$(command -v opencode 2>/dev/null || true)"
    if [[ -z "$exe" ]]; then
      bcp_die 2 "no host detected: install-time compatibility check needs --host v1|v2|<path-to-opencode-executable> (or an 'opencode' on PATH)"
    fi
  fi

  local ver_out="" semver="" ver_rc=0
  ver_out="$("$exe" --version 2>/dev/null)" || ver_rc=$?
  if [[ "$ver_rc" -ne 0 ]]; then
    bcp_die 2 "cannot parse version from '$exe --version' (exit status $ver_rc; got: $(printf '%s' "$ver_out" | head -c 120))"
  fi
  if [[ "$ver_out" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then semver="${BASH_REMATCH[1]}"; fi
  if [[ -z "$semver" ]]; then
    bcp_die 2 "cannot parse version from '$exe --version' (got: $(printf '%s' "$ver_out" | head -c 120))"
  fi

  local major="${semver%%.*}" family=""
  case "$major" in
    1) family="v1" ;;
    2) family="v2" ;;
    *) bcp_die 2 "unsupported host major '$major' ('$exe' reports $semver); supported: v1 >= $BCP_V1_MIN, v2 >= $BCP_V2_MIN" ;;
  esac
  if [[ -n "$require_family" && "$family" != "$require_family" ]]; then
    bcp_die 2 "--host $require_family requested but '$exe' reports $semver (family $family)"
  fi
  case "$family" in
    v1)
      if ! bcp_ver_at_least "$semver" "$BCP_V1_MIN"; then
        bcp_die 2 "unsupported host: v1 $semver < $BCP_V1_MIN (same-package dual entry needs the v1 object entry, added in $BCP_V1_MIN; tested $BCP_V1_TESTED)"
      fi ;;
    v2)
      if ! bcp_ver_at_least "$semver" "$BCP_V2_MIN"; then
        bcp_die 2 "unsupported host: v2 $semver < $BCP_V2_MIN (tested $BCP_V2_TESTED)"
      fi ;;
  esac
  BCP_FAMILY="$family"; BCP_HOST_VERSION="$semver"; BCP_HOST_EXE="$exe"
}

# --- scope resolution ------------------------------------------------------------
# Sets: BCP_GLOBAL_ROOT, BCP_TARGET_ROOT (config dir receiving the install).
# Caller provides MODE ("global"|"project") and TARGET_DIR; HOME physicalized here.
bcp_resolve_roots() {
  if [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
    BCP_GLOBAL_ROOT="$OPENCODE_CONFIG_DIR"
  elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    BCP_GLOBAL_ROOT="$XDG_CONFIG_HOME/opencode"
  else
    BCP_GLOBAL_ROOT="$HOME/.config/opencode"
  fi
  if [[ -d "$BCP_GLOBAL_ROOT" ]]; then BCP_GLOBAL_ROOT="$(bcp_physical_dir "$BCP_GLOBAL_ROOT")"; fi
  if [[ -d "$HOME" ]]; then HOME="$(bcp_physical_dir "$HOME")"; fi

  if [[ "$MODE" == "project" ]]; then
    if [[ ! -d "$TARGET_DIR" ]]; then
      bcp_die 3 "--project target is not an existing directory: $TARGET_DIR"
    fi
    local phys
    phys="$(bcp_physical_dir "$TARGET_DIR")"
    if [[ -z "$phys" ]]; then
      bcp_die 3 "--project target is not an existing directory: $TARGET_DIR"
    fi
    BCP_TARGET_ROOT="$phys/.opencode"
  else
    BCP_TARGET_ROOT="$BCP_GLOBAL_ROOT"
  fi
}

# Print every config root where the host could discover a BCP file:
# target root, global root, then the target's full physical ancestor chain
# (no depth cap; $HOME/.opencode appears only when it is an ancestor, i.e.
# host-discoverable). Deduplicated, physical paths.
bcp_scope_roots() {
  local seen="|$BCP_TARGET_ROOT|"
  printf '%s\n' "$BCP_TARGET_ROOT"
  if [[ "$BCP_GLOBAL_ROOT" != "$BCP_TARGET_ROOT" ]]; then
    printf '%s\n' "$BCP_GLOBAL_ROOT"
    seen="$seen$BCP_GLOBAL_ROOT|"
  fi
  if [[ "${BCP_MODE_PROJECT:-0}" == "1" ]]; then
    local d r
    d="$(dirname "$BCP_TARGET_ROOT")"
    while [[ -n "$d" ]]; do
      r="$d/.opencode"
      case "$seen" in
        *"|$r|"*) ;;
        *) seen="$seen$r|"; printf '%s\n' "$r" ;;
      esac
      if [[ "$d" == "/" ]]; then break; fi
      d="$(dirname "$d")"
    done
  fi
}

# --- transactional backup/rollback ------------------------------------------------
#   bcp_tx_begin            create backup dir, arm EXIT-trap rollback
#   bcp_tx_backup <file>    back a file up before removing/replacing it
#                           (symlinks: link topology is recorded and restored)
#   bcp_tx_created <file>   register a file we created (dropped on rollback)
#   bcp_tx_commit           success: drop backups, disarm trap
#   bcp_tx_rollback         restore originals (including symlink topology),
#                           remove created files (idempotent)
# This is an in-process, handled-failure rollback (trap EXIT). It makes no
# SIGKILL / power-loss recovery claim.
BCP_TX_DIR=""; BCP_TX_ACTIVE=0
bcp_tx_rollback() {
  if [[ "$BCP_TX_ACTIVE" != "1" ]]; then return 0; fi
  BCP_TX_ACTIVE=0
  local origin dest p meta
  if [[ -d "$BCP_TX_DIR" ]]; then
    if [[ -f "$BCP_TX_DIR/.created" ]]; then
      while IFS= read -r p; do
        if [[ -n "$p" ]]; then rm -f -- "$p" 2>/dev/null || true; fi
      done < "$BCP_TX_DIR/.created"
    fi
    for origin in "$BCP_TX_DIR"/*.origin; do
      if [[ ! -e "$origin" ]]; then break; fi
      dest="$(cat "$origin")"
      meta="$(cat "${origin%.origin}.meta" 2>/dev/null || printf 'file')"
      mkdir -p "$(dirname "$dest")" 2>/dev/null || true
      rm -f -- "$dest" 2>/dev/null || true
      if [[ "$meta" == "link" ]]; then
        # preserve link topology: the entry was a symlink, restore the symlink
        ln -s -- "$(cat "${origin%.origin}.link")" "$dest" 2>/dev/null \
          || cp -p "${origin%.origin}" "$dest" 2>/dev/null || true
      else
        cp -p "${origin%.origin}" "$dest" 2>/dev/null || true
      fi
    done
  fi
}
bcp_tx_begin() {
  BCP_TX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bcp-install-tx.XXXXXX")"
  BCP_TX_ACTIVE=1
  trap bcp_tx_rollback EXIT
}
bcp_tx_backup() {
  local f="$1" idx p
  idx=0
  for p in "$BCP_TX_DIR"/*.origin; do [[ -e "$p" ]] && idx=$((idx+1)); done
  if [[ -L "$f" ]]; then
    printf 'link' > "$BCP_TX_DIR/$idx.meta"
    printf '%s' "$(readlink -- "$f")" > "$BCP_TX_DIR/$idx.link"
    # byte safety net alongside the recorded topology (dangling links tolerated)
    if [[ -f "$f" ]]; then cp -p "$f" "$BCP_TX_DIR/$idx" 2>/dev/null || true; fi
  else
    printf 'file' > "$BCP_TX_DIR/$idx.meta"
    cp -p "$f" "$BCP_TX_DIR/$idx" || bcp_die 1 "transaction backup failed for $f"
  fi
  printf '%s' "$f" > "$BCP_TX_DIR/$idx.origin"
}
bcp_tx_created() { printf '%s\n' "$1" >> "$BCP_TX_DIR/.created"; }
bcp_tx_commit() {
  BCP_TX_ACTIVE=0
  trap - EXIT
  if [[ -d "$BCP_TX_DIR" ]]; then rm -rf "$BCP_TX_DIR"; fi
}
