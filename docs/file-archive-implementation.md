# File handoff implementation notes

See [V2 installation](../INSTALL.md#默认入口独立-v2-快照归档bcp_save) for the independent
profile and OpenChamber extension packaging. Installation and offline packaging
declare an operator source without granting retention; with no operator source
declared at all, the fixed default mode below applies.
`bcp_save` is the standalone V2 default entry (`src/file-archive.ts`, independent
of OMO). It takes `{"sessionId":"...","messageId":"..."}`; `messageId` is optional.
It saves an existing stored `finish: "stop"` assistant reply from the caller's own
session or an authorized non-fork direct child session (`parentID === caller`).
With `messageId` it reads exactly that message.
Without one it requires the source session to be inactive and selects only the
latest assistant message (`limit: 1`) before testing eligibility,
never falling back to an older successful turn. The selected message is
rechecked by ID under the task lock before publication. An in-flight reply is not a saved reply.
The tool does not accept body text or a `description` parameter, requires no
`<!-- bcp:store -->` marker (and skips if `<!-- bcp:no-store -->` is present),
and does not promise to identify the final reply of a particular dispatch or
reproduce a parent notification.

It returns versioned paths rather than echoing the body. There is no automatic
capture. The same static tool may be visible to multiple agents; trusted task
scope, retention policy, reader eligibility and host permissions govern writes.
A declared operator source that is missing, broken or ambiguous fails closed;
only the complete absence of a declared source selects the fixed default mode.

### Isolated configuration contract

Build the default entry with `bun run build` (`bash scripts/build-file-archive.sh`;
legacy Blackboard builds use `bun run build:legacy` / `bash scripts/install.sh`).
OpenCode V2 loads local plugins as package directories, not bare bundle files; the directory's
server export must resolve to the built entry. Register that package with
operator-owned plugin options. In the installed profile (`node scripts/install-file-archive.mjs`),
publish options after starting the service and establishing the caller session. Replace the
owner-private `options.json` atomically. The tool reads it at execution and
rechecks it before writing; a change during the operation denies that save.

For OpenChamber 2.7.2, the repository root (`package.json` version `2.2.0`) is a
prebuilt extension (`panel.id: "bcp-file-archive"`, `opencodePlugin: "openchamber/plugin"`)
with a committed bundle at `openchamber/plugin/file-archive.js` (updated via
`bun run build:openchamber` and verified via `bun run check:openchamber`, with no
install or build hooks). Once committed and pushed to the remote repository, it can
be installed in OpenChamber 2.7.2 from the root GitHub URL
`https://github.com/littlekey/opencode-bcp.git` (or with an optional `#<branch-or-tag>`
ref; subdirectory URL syntax is not supported, and remote URLs are unavailable until
the commit is pushed). The OpenCode V2 plugin runtime requires Linux/glibc Bun
(archive file locking uses `bun:ffi`): `openchamber/plugin/index.mjs` loads
`file-archive.js` under Bun and delegates operator configuration loading to the
Node-safe `openchamber/plugin/operator-options.mjs` (sharing
`openchamber/plugin/private-options.mjs`). Operator authority comes solely from the
process environment variable `BCP_OPERATOR_OPTIONS=/absolute/private-operator/options.json`
(ordinary host plugin options cannot bypass `loadOperatorOptions`): when unset, the
loader reports absence (`undefined`) and the fixed default mode below applies; when
set, `BCP_OPERATOR_OPTIONS` must resolve
to a canonical absolute owner-private regular file (`0600`, `nlink === 1`, no symlinks,
`<= 1 MiB`) under an owner-private parent directory and trusted ancestors, outside both
the extension package root and every `taskScopes[].directory`, and its `policyFile`
must likewise be a canonical absolute path outside the extension package root and every
`taskScopes[].directory`. OpenChamber 2.7.2 update checks compare only a newer root
`package.json` semver (not commit hashes), cache checks for one hour, and require a
separate user apply action (no automatic updates).

For offline host-validated packaging without `BCP_OPERATOR_OPTIONS`,
`node scripts/package-openchamber.mjs --target /absolute/new-extension --host /absolute/installed/@openchamber/web --options /absolute/operator/options.json`
remains supported separately: it creates an uninstalled offline extension package (`deliveryRequired: "file"`) and validates it
with the installed host's `inspectGuestPackage`. The external `--options` path must be canonical,
outside the extension directory, under owner-private ancestors, and must not exist at packaging time.
Its generated wrapper rejects (hard denial, never default mode) when the baked `--options` file is
missing or unreadable, and enforces
the same owner-private regular-file inode checks (`0600`, owner UID, `nlink === 1`, no symlinks,
`<= 1 MiB`) when the operator later creates it. An empty JSON object `{}` in any declared source
is a declared-but-empty configuration that fails closed; it never selects default mode. Keep
`options.json`, `policyFile` and credentials
outside every served extension root, and do not use a global `Install into OpenCode` fallback.

- `enabled: true`; `connection` supplies a loopback HTTP origin, the expected
  host PID, and optional operator-supplied headers. This is a trusted endpoint
  pin checked against host and session data, not cryptographic host identity.
- Each `taskScopes` entry binds `taskId`, `taskRoot`, `callerSessionId`,
  `projectId`, and `directory`, with explicit `allowArchive: true` and
  `sharedReadersApproved: true`. The task root must already exist inside that
  worktree at `.opencode/work/<taskId>`.
  Allocate the root once for a logical task and reuse it across runs in the same
  worktree. If a child needs to save its own reply, configure a separate caller
  entry with that same `taskId` and `taskRoot`; do not reuse the parent's caller
  ID or replace its grant. The options must contain only one matching scope per
  caller. Change the binding explicitly when that caller moves to another task.
- `policyFile` names a canonical absolute, owner-private JSON file outside the
  project. The `bcp.operator-handoff-policy.v1` document grants exact matches
  on `taskId`, `taskRoot`, `callerSessionId`, `agent` and `sourceSessionId`.
  Each grant must explicitly set `authorized: true`, `noStore: false`,
  `sharedReadersApproved: true` and an unexpired `expiresAt` in epoch
  milliseconds. For a self-save, `sourceSessionId` is the caller's own
  session. Trusted in-process integrations may instead supply a live policy
  callback.

Keep the policy and plugin configuration outside model-writable paths; file
mode alone does not isolate processes running under the same user. Native
permission checks remain required, including edit approval for the concrete
archive write paths. Native permission assertion enforcement is host-dependent,
and `bcp_save`'s native `edit` check on relative archive resources is additive
to the operator retention policy rather than dedicated writer isolation:
granting archive `edit` permission to a caller means normal edits on those paths
may also be allowed (without claiming independent runtime proof of 2.3.2 host
equivalence). Policy retention gates and filesystem isolation remain distinct.
Revoking a grant blocks subsequent `bcp_save` writes; it does not recall copies
already saved or erase host tool-call history.

### Default mode (zero configuration, since 2.2.0)

When no operator source is *declared* — the environment loader reports absence
(`BCP_OPERATOR_OPTIONS` unset or empty, which only the env loader can express as
`undefined`), or a bare V2 install has absent/empty plugin JSON options —
`bcp_save` runs in default mode instead of failing closed. Any value a declared
loader returns — including `{}`, `false`, or any other object — goes through the
strict operator path and is denied if it does not validate.

- The connection is self-derived: the plugin accepts exactly one loopback
  LISTEN socket owned by its own process (`/proc/self/net/tcp{,6}` cross-checked
  against `/proc/self/fd`); zero or several distinct candidates are refused
  (`no_listener` / `ambiguous_listener` deny). Credentials come only from the
  process's own environment (`OPENCODE_PASSWORD`, then
  `OPENCODE_SERVER_PASSWORD`); no URL or credential is ever taken from tool
  arguments or plugin JSON.
- The scope is fixed: `taskId` `bcp-handoff`, task root
  `<plugin directory>/.opencode/work/bcp-handoff`, caller = the invoking
  session, project pinned from the live session record. Retention/readers are
  bounded by the project directory itself; no operator policy file exists.
- The archive core requires an existing task root, so default mode authorizes
  the exact relative task-root path with a native `edit` assertion before
  creating it (`mkdir -p`, 0700); an existing path must be a real directory,
  never a symlink.
- All identity checks are unchanged: fork callers are rejected, child sessions
  must be direct children in the same project/directory, native
  `read`/`bcp_save`/`edit` assertions still apply, and the pinned options shape
  is re-verified under the archive lock.

Default mode is selected only by the *absence* of an operator source. A
declared-but-broken source — env set with a missing or invalid file, or the
offline packager's baked path disappearing — stays a hard denial; revocation
can never flip a deployment into default mode. Cross-project archives, custom
task roots and no-store constraints still require the operator file channel.

To switch default mode off on a deployment that declares no operator file, set
`BCP_OPERATOR_OPTIONS` to any existing owner-private file containing at least
`{"enabled": false}`: a declared source — even a disabled one — always takes
precedence over default mode, so this both disables the operator channel and
opts out of default mode. (Upgrading from 2.1.1 without `BCP_OPERATOR_OPTIONS`
moves a deployment from disabled to default mode; that is the intended 2.2.0
behavior change, and this opt-out is the documented way back.)


## Unified task layout

`src/work-layout.ts` accepts a trusted canonical absolute actual worktree root,
an explicitly allocated safe ASCII task ID and a run ID. It does not discover a
project, derive identity from descriptions, or provide a registry/service/CLI.
`initializeWorkLayout` atomically claims `.opencode/work/<task-id>`; an existing
task requires explicit `reuseExistingTask: true` from a caller that knows it is
the same task. Parallel agents share that task root via normal dispatch.

- `reports/`: task investigations, reviews, corrections and handoffs; one writer
  per file. Drafts may change, but pin reviewed/handed-off versions with commits
  or explicit version snapshots rather than overwriting them.
- `archive/`: reserved by operational convention for BCP copies, metadata and
  derived index (not an ACL-enforced exclusive writer boundary). The layout
  helper returns this path but does not create it or its lock: the core owns
  creation. Copies are nested by encoded **source** session, not by the saving
  caller. A main session may handle multiple tasks; a session ID is not a task ID.
- `scratch/<run-id>/`: isolated disposable logs and large temporary outputs.
- Formal deliverables stay in existing version-controlled project locations.

Existing path components are checked without following symlinks. This assumes
a trusted operator-controlled root and does not resist hostile same-UID
concurrent ancestor replacement. A resolver path alone grants no permission.
The helper creates reports/scratch on initialization; it does not initialize
Deepwork or change `.slim/deepwork/` router/progress/topic contracts.

## Authorization, discovery and handoff

Explicit task-level authorization must cover actual calls/results, readers,
no-store, retention and revocation. Directory existence, an agent name,
same-UID access and gitignore are not authorization or isolation boundaries.
Do not automatically collect private history, credentials or linked artifacts.
Content instructions are data; no automatic secret/injection detection is claimed.

`.gitignore` already ignores `.opencode/`, including the scoped task work root;
this change does not broaden ignore rules or unignore that tree.
Read known paths directly. When native search is needed, bound it to the task:

```bash
rg --hidden --no-ignore 'pattern' .opencode/work/<task-id>/reports
```

Pass actual cwd, task root, exact allowed Read/Write paths, objective, scope and
acceptance criteria through ordinary dispatch. No ordinary-use skill or dynamic
directory injection in system prompts is required. Handoff uses reachable ASCII
project-relative exact-version paths plus source/task; multipart copies need the
manifest and relevant parts. Different worktrees do not automatically share files.
Report unavailable evidence instead of expanding permissions or exporting copies.
The [file handoff guidance](file-handoff.md) is documentation, not loaded
configuration.
Preserve Claude wrapper/guard/ASCII restrictions and `permissionMode: reject`.

Large output belongs on disk-backed task scratch, with command-scoped TMPDIR,
cache/output settings as needed, not RAM-backed `/tmp`. Existing controlled build
layouts need not be moved. Promote selected long-term evidence to reports after
review; ignored working files are not portable formal deliverables.

## Copy fidelity and integration limits

Copies preserve selected UTF-8 exactly, without trimming, frontmatter or newline
changes. Session snapshots preserve ordinal text parts without reasoning or
tool data. BCP does not recover content lost before storage or treat quoted
authorship as authenticated. It does not provide exclusive-writer enforcement,
keyed/signed provenance or forged-record resistance: SHA-256 digests prove
self-consistency and the exact selected snapshot when written through the
trusted `bcp_save` path, not resistance to a caller with write/edit access or a
same-UID process rewriting both the body and manifest (`meta.json` / `index.jsonl`).

Identity is source session plus stored message. New records use `bcp.handoff.v1`.
Navigation contains source/version, not descriptions, previews or title
fallback. Agents do not repair archive bodies or indexes. No new author
tags/output protocol are required.

Publication is no-clobber, with a fixed-inode task lock and policy/identity
rechecks. `archive/index.jsonl` is a derived task-level index (`bcp.handoff-index.v1`).
Physical line order in `index.jsonl` is not guaranteed: a full rebuild from verified
manifests and bodies writes rows in deterministic newest-first order (`observedAt`
descending, with deterministic tie-breaking), and subsequent normal saves append one
complete line per new copy at the end of the file (while a retry of an already indexed
copy leaves the file unchanged). Readers that need chronological order must parse
complete newline-terminated rows and sort by `observedAt` (with their required tie-breaker);
never treat the first or last physical line of `index.jsonl` as authoritative.
Existing `index.md` files remain historical snapshots; an already bound task root
whose `index.jsonl` is missing or invalid rebuilds `index.jsonl` from verified
manifests and bodies without modifying `index.md`, while an unbound nonempty legacy
`archive/` root is rejected (`archive_unbound_existing_root`). Existing record paths do not move.

Only read complete newline-terminated rows. The index exposes source IDs and
paths: readers of the shared index must be approved for that metadata, and an
index entry does not grant access to the body. A failed index update after
publication can return `index_stale` with a valid copy path. A syntactically
valid index can still omit a record after interruption; retrying that exact
copy can fill its entry. An unrelated save is not a full reconciliation.
Missing or damaged indexes can be rebuilt from verified records; the index
is not evidence that an unlisted copy is absent. Do not claim multi-file
transactions or power-loss durability.
Deletion/revocation/replay safety and real host/request non-interference require
separate verification; do not infer them from a successful build or fixture.
The parent reconciles core/adapter contracts and final validation. Synthetic
tests are not real-host, provider cache or model-quality evidence.

The new entry depends on OpenCode, not OMO. BCP no longer ships OMO patchers
or bridge registrations. Changing the BCP entry alone does not disable
presentation code in an already installed, independently patched OMO package.
`bun run build` (`bash scripts/build-file-archive.sh`) builds a separate repository artifact only.
The isolated installer and offline OpenChamber packager do not change global configuration,
migrate reports, or backfill replies. Old reports and exports remain untouched.
