# skill-overrides — auditable deltas over pinned stock skills

Phase 1 "restore upstream defaults" (plan `upstream-defaults-20261006`).

On the verified v2 host, `oh-my-opencode-slim` registers its packaged skills **in-process** from the
plugin artifact's own `src/skills/<name>/SKILL.md` (`CUSTOM_SKILLS` registry /
`buildBundledSkillInfos`; the staged artifact carries `src/skills/**`
verbatim). Stock skills therefore need **no local copies**: a same-named file
copy under the config skills root only *shadows* the in-process registration
(the legacy copy mechanism the plugin itself warns about) and drifts from the
executing code. The verified v1 host does not expose that registration path.
Its installer exposes the five unchanged stock skills from the pinned artifact:
staged relative file links avoid duplicating staging bytes; activation materializes
them as managed, version-pinned copies for native skill discovery. They are not
independently maintained prompt forks. Both host paths require actual loading
checks; package resource presence alone is insufficient.

Skills are **not appendable** — there is no host or plugin mechanism to extend
a packaged `SKILL.md`. The only auditable way to carry a local delta is a full
file copy that replaces the stock payload. This directory holds exactly that:
small, anchored, reviewable patch files. `../build-skills.mjs` applies each
patch to **pinned stock 3.0.1 bytes** (every base file sha256-verified; any
upstream drift refuses generation) and emits a generated skills tree plus a
provenance manifest.

Rule of ownership: upstream code stays the execution owner. A patched copy
changes only what the host *serves the model* from the skills root; plugin-
embedded behavior (e.g. the deepwork hook's bundled activation prompt) remains
stock. Deltas below deliberately avoid contradicting that embedded behavior.

## Inheritance layout (generated tree)

- `clonedeps`, `reflect`, `simplify`, `verification-planning`, `worktrees` —
  **inherited stock content**, omitted from this generator's output: v2 uses
  artifact in-process registration; v1 uses the installer's managed stock
  exposure described above.
- `codemap`, `deepwork`, `oh-my-opencode-slim` — **patched copies** (stock
  bytes + the patch file beside this README with the same name).
- every other skill in the pinned personal source — **copied verbatim**, including reference files, nested scripts and each file's Unix permission bits. The build manifest records both content hashes and modes; the runtime stage/activation manifests preserve the generated modes.
- `loop-engineering` (packaged by stock but not registered in-process) —
  excluded everywhere.

## codemap.json — 1 op

| id | delta | why |
|---|---|---|
| `repository-map-navigation` | The `codemap.md` usage paragraph becomes "navigation index, not mandatory pre-reading". | BCP token-efficiency policy: read only the parts relevant to the current task instead of the full map before every task. |

Intentionally **not** preserved from the old global copy: the three absolute
`~/.config/opencode/skills/codemap/scripts/codemap.mjs` command paths (stock's
relative `scripts/codemap.mjs` + base-directory note is correct and
relocatable), and the stale `codemap/codemap.md` fact wording (stock 3.0.1
already carries the corrected native-discovery fact).

## deepwork.json — 4 ops

| id | delta | why |
|---|---|---|
| `todo-live-status` | Setup bullet: live execution status lives in the Todo; `.slim/deepwork/` holds decision/evidence snapshots, not a second synchronized checklist. | BCP state policy: Todo is the live status; the deepwork file is the durable handoff record. |
| `snapshot-handoff-boundaries` | Update bullet: refresh at handoff/recovery boundaries; record accepted findings and original references; snapshot age must be visible; consult live execution state before resuming. | Original-source handoffs: point at live/original sources instead of duplicating state. |
| `oracle-gates-from-risk` | Planning bullets: schedule `@oracle` reviews from the work's goal and risk (not one mechanical gate per phase); reference still-valid prior evidence instead of a fresh gate for unchanged ground. | Avoids ritual gates while keeping the stock 1 + 2 review budget explicit. |
| `user-authorized-commits` | Phase-Execution commit bullet: propose a focused commit at a valid delivery boundary and create it **only with explicit user authorization**; deepwork never commits on its own initiative. | BCP commit policy replaces stock's automatic per-phase commit. |

Intentionally **not** preserved: the old global copy's free-named
`.slim/deepwork/<short-task-slug>.md` progress file — the stock 3.0.1 deepwork
hook pins `.slim/deepwork/<session-id>.md` in its activation prompt, so the
served text must keep the session-pinned contract (the old wording predates
that hook and would contradict it).

## oh-my-opencode-slim.json — 3 ops

| id | delta | why |
|---|---|---|
| `project-local-config-and-prompts` | Config table gains the three project-local rows (`.opencode/oh-my-opencode-slim.jsonc`/`.json`, preset prompt dir, prompt dir). | Fact correction — verified in 3.0.1 loader code: project config is merged over user config (`.jsonc` wins within a directory) and project prompt dirs are checked first. |
| `prompt-lookup-order` | Lookup order becomes the 4-level project-first order with independent base/append resolution. | Fact correction — verified in 3.0.1 (`getPromptCandidates`): each file name resolves independently, so base and append may come from different directories; custom agents use the same lookup. |
| `inline-prompt-schema-boundary` | Schema-boundary block: built-in agents DO accept inline `prompt`/`orchestratorPrompt`; inline wins with a logged warning and the append file still applies; `orchestratorPrompt` is rejected on the orchestrator itself; custom agents without `model`/`inheritModelFrom` are skipped with a warning. | Fact correction — upstream docs claim built-ins don't support inline prompts; the 3.0.1 implementation does. This was the original motivation for the local copy. |

Intentionally **not** preserved: the "verified against plugin version 2.2.25"
pins (facts re-verified against 3.0.1) and the stale "Installed skill prompt
payload" skill-table row (stock's "shadows the bundled in-process skill"
wording describes the verified v2 shadow mechanism, not v1 registration).

## Personal skill migration

The personal `executing-plans` and `writing-plans` trees travel through the
same generator. Keep the entire directories: `executing-plans/scripts/`
contains executable sibling-dependent helpers, and `references/` contains
the review template. Installing only `SKILL.md` is incomplete.

The committed `dotfiles/opencode/runtime/generated/skills/` tree is a
self-contained installation input. It may also be used as `--personal-dir`
when rebuilding on a new machine; use a **different** `--out-dir`, inspect
the output, then update the profile pins. The generator replaces its output
directory and must never be pointed at its own input. Existing inherited and
patched names in the personal source remain excluded in favor of the pinned
artifact and patch definitions.

For the optional cross-repository consistency test, set
`OPROFILE_RUNTIME_DIR` to the target `dotfiles/opencode/runtime` directory.

## Version bumps

On an upstream upgrade: re-diff each `SKILL.md` against the new stock bytes,
update `STOCK_SKILL_SHA256` in `../build-skills.mjs`, and re-derive any patch
whose anchor no longer matches. Missing base or drifted anchor = refusal, never
a silent skip.
