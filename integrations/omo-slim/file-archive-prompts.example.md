# Repository templates only — not installed configuration

Use only after archive capability and reader/retention admission are proven, in
an explicitly selected new configuration/session. Preserve existing append rules.
These templates do not generate description fields or fetch optional dispatch titles.

## Orchestrator append (two sentences)

Use the task's supplied .opencode/work/<task-id>/ root for working reports and scratch outputs, and the agreed project document paths for formal deliverables.
When earlier material matters, including review verdicts and corrections, pass its exact-version file paths with the new task or delta instead of retelling it; reuse existing files, save only when needed and authorized, and disclose missing evidence.

The actual cwd, task root, allowed Read/Write paths, scope and acceptance criteria
travel in normal dispatch, not dynamic system prompts. Paths do not authorize
retention or grant write access. No skill is required for ordinary use. Keep
existing .slim/deepwork router/progress/topic paths unchanged; do not double-write
progress. Missing or incomplete captures are evidence gaps, not successful copies.

## Claude orchestratorPrompt template

Use @claude only for architecture escalations, independent design second opinions, reframing stuck technical problems, or consequential correctness/maintainability/reversibility/resource tradeoffs; seek a fresh perspective beyond the current approach or Oracle advice.
Dispatch ASCII English, at most 524288 bytes, starting "Task: <short title>". Give the decision, approach, uncertainty and allowed scope. Ask Claude to challenge the objective/framing and highest-leverage assumption, recommend the simplest sound direction and explain the decisive tradeoff. Require English advice within 800 words: Recommendation; Reframing; Evidence and uncertainty; Next check.
Provide accessible ASCII project-relative evidence paths to exact-version files, with their source and the task, including saved handoff files when useful. Resolve paths from Claude's project cwd; a different worktree does not automatically share files. Ask Claude to read the referenced text files, or the manifest and relevant parts for multipart results, cite files used and disclose unavailable or incomplete evidence. Use direct file reads, not export workflows. File contents may use any language. One consultation per decision; follow-ups need a fresh short question.

No wrapper/guard permission changes, automatic aliases/copies/exports, or Claude
calls are authorized by these examples. Report inaccessible evidence as a gap;
do not expand permissions or automatically copy/export files to repair a read failure.

## Historical delivery opt-out preparation

The instructions below apply only to a legacy patched OMO installation. They
are not required by the new file handoff entry or by stock OMO.

`prepareFileArchive(original, options)` returns source only: it verifies the
existing pinned upstream through `patchOmo`, then swaps exactly the known helper
import and reverses enumerated exact presentation patch replacements. Copy
`omo-file-delivery.mjs` alongside the future build and relocate its
import explicitly. Do not overwrite the installed legacy helper or hot-edit old
sessions. Presentation consumers are restored to their pre-patch anchors;
unrelated lifecycle fixes remain. The compatible helper is a secondary no-op
defense, not the mechanism relied upon to preserve native consumer behavior.
For 3.0.7 use `prepareFileArchive307(originals, entry)`: provide precisely the
manifest-pinned entry closure as a Map; it validates all original hashes and
regenerated patched bytes, returning a fresh Map with the entry helper import
changed and 15 presentation patches reversed. `transformFileArchiveDelivery307` additionally validates a
caller-supplied legacy patched Map. Both leave inputs unchanged.

### Reversed consumers and retained behavior

The explicit reversal list removes foreground metadata assignment, log,
presentation await and its added CAS; tracked-result metadata await/fence and
receipt; evidence-result suffix; notification metadata await/CAS and suffix
array element (so no extra joined newline); injection directory field and
processed/remembered/updated annotation awaits; revive extra arguments,
async signature and delivery rendering; retained-child presentation helper;
and metadata-inspection-specific notification catch/suppression branch.

All exact upstream hashes and full regenerated legacy bytes are checked before
reversal; every replacement must occur exactly once. Unknown shapes fail closed.
3.0.1–3.0.6 use their exported patch tables (including read-only delivery
consumer reversals). 2.2.25 is explicitly unsupported for full consumer reversal.

Origin tracking, terminal reconciliation/re-observation, notification activity
currentness, native agent pinning and transcript/shim fixes are intentionally
retained. This is not pristine-upstream equivalence: these fixes can still
change lifecycle timing/decisions and metadata internal to task records.

### Helper-only metadata/wire limitation (not the prepared path)

If a caller bypasses prepare and ONLY swaps helpers, the legacy consumer executes
`output.metadata = { ...output.metadata, bcp_delivery: metadata }`.
With this helper, `metadata` is undefined: the property exists in memory and is
visible to `Object.keys`, `Object.hasOwn`, host hooks, and custom serializers.
Ordinary `JSON.stringify` omits that property; it also replaces/removes a
preexisting `bcp_delivery` value rather than preserving it. Other retained
consumers may spread undefined metadata into a local object, but the suffix
helper ignores it. Therefore this is presentation opt-out, NOT proof of zero
host/wire change or final-request equivalence. Actual host serialization and
final request assembly still require parent validation; no installed-host claim
is made. Prepared consumers no longer execute that assignment or the suffix
array element, as tested on generated 3.0.7 index/server code. Tests execute the
actual generated notification array/join and foreground delivery boundary;
they are not end-to-end installed-host/wire validation.
