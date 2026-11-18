# File handoff implementation notes

See [V2 installation](../INSTALL.md#v2-快照归档独立配置) for the independent
profile. Installation supplies no retention or reader approval.
`bcp_save` takes `{"sessionId":"...","messageId":"..."}`; `messageId` is optional.
It saves an existing assistant reply from the caller's own session or an
authorized direct child session. With `messageId` it reads exactly that message.
Without one it selects the latest assistant message before testing eligibility,
never falling back to an older successful turn. The selected message is
rechecked by ID before publication. An in-flight reply is not a saved reply.
The tool does not accept body text and does not promise to identify the final
reply of a particular dispatch or reproduce a parent notification.

It returns versioned paths rather than echoing the body. There is no automatic
capture. The same static tool may be visible to multiple agents; trusted task
scope, retention policy, reader eligibility and host permissions govern writes.
Missing or ambiguous authorization fails closed.

### Isolated configuration contract

Build the entry with `bash scripts/build-file-archive.sh`. OpenCode V2 loads
local plugins as package directories, not bare bundle files; the directory's
server export must resolve to the built entry. Register that package with
operator-owned plugin options. In the installed profile, publish options
after starting the service and establishing the caller session. Replace the
owner-private `options.json` atomically. The tool reads it at execution and
rechecks it before writing; a change during the operation denies that save.

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
archive write paths. Revoking a grant blocks subsequent writes; it does not
recall copies already saved or erase host tool-call history.

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
- `archive/`: BCP-only copies, metadata and derived index. The layout helper
  returns this path but does not create it or its lock: the core owns creation.
  Copies are nested by encoded **source** session, not by the saving caller.
  A main session may handle multiple tasks; a session ID is not a task ID.
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
authorship as authenticated.

Identity is source session plus stored message. New records use `bcp.handoff.v1`.
Navigation contains source/version, not descriptions, previews or title
fallback. Agents do not repair archive bodies or indexes. No new author
tags/output protocol are required.

Publication is no-clobber, with a fixed-inode task lock and policy/identity
rechecks. `archive/index.jsonl` is a derived task-level index. Normal saves
append a single complete line; a retry of an already indexed copy leaves it
unchanged. Line order is index insertion order, not a guarantee of newest first.
Existing `index.md` files remain historical snapshots; the first authorized
save to an old root builds the new index from verified manifests and bodies.
Existing record paths do not move.

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
`bash scripts/build-file-archive.sh` builds a separate repository artifact only.
The isolated installer does not change global configuration, migrate reports,
or backfill replies. Old reports and exports remain untouched.
