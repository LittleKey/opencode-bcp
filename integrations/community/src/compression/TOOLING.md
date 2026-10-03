# Compression bundle: install contract, loader surface, tooling truth

Generated-bundle documentation for `buildCompression()` output. Everything here
is verified against the pinned artifacts listed in the emitted `deps.json` /
`manifest.json` (billion-context 0.1.175, repaired opencode-acp 1.18.2 build).

## Install contract (explicit legacy-ACP slot)

1. Build the bundle (`buildCompression`). The emitted
   `legacy-acp/opencode-acp/dist/index.js` is a **byte-exact copy** of the
   verified repaired ACP entry (builder re-verifies the copy against the pin).
2. Copy the emitted tree byte-exactly:
   `<cacheHome>/opencode/packages/<SPEC>/node_modules/opencode-acp/`
3. Export `BILI_OPENCODE_ACP_SPEC=<SPEC>` for the host session.

Integrity is enforced twice, independently:

- build time: the emitted copy must hash-equal `deps.json
  .compression.legacyAcp.slot.sha256` (build fails otherwise), and
- arm time: `planLegacySelection()` verifies the INSTALLED slot against the
  same pin. Without the env var, with a missing slot, or on any content
  mismatch the v1 wrapper refuses to arm. There is **no stock fallback** —
  an unrepaired opencode-acp inside the host's probe range is never selected,
  only audited (`auditStockCandidates`).

Because the emitted file is the repaired entry's own bytes, the documented
install steps satisfy the hash gate by construction; no machine-local wrapper
and no baked absolute path is part of the slot artifact.

## Supported loader exports

- `v1.mjs` — default export only: `server(ctx) -> hooks`. No named exports,
  no factories. The pinned artifact's dual-shape default
  `{ id, setup, server }` (0.1.175) is normalized inside the guarded entry.
- `v2.mjs` — Plugin surface: default export `{ id, setup }` plus named
  `id` / `setup`. No factories. `setup(ctx)` returns the pinned artifact's
  cleanup function, wrapped to also release the engine claim.

Hosts must not introspect these modules beyond that surface; internal
factories in `entry-core.mjs` are not part of the package contract.

## Engine exclusivity (precise scope)

The registry in `lib/engine-registry.mjs` is **per emitted bundle copy**:

- within one bundle copy, at most one engine (v1 or v2) is armed at a time;
  a second arm attempt throws a `compression engine conflict` error;
- it is NOT process-global: separate bundle copies (another project, or a
  second copy of this bundle) keep separate registries and legitimately
  coexist in one server process;
- it is NOT a per-request router; the supported invariant is arm-time
  exclusivity plus claim release — the v2 wrapper releases its claim when the
  host invokes the `setup()` cleanup; the v1 claim is held for the process
  lifetime of the armed bundle (the v1 host controls the hooks lifetime).
- unmodified stock plugins and foreign compressors do not participate; no
  global per-process exclusion is imposed on them.

## Pinned v2 tool surface and transport (billion-context 0.1.175)

Registered tools (verified in the pinned `dist/agent/opencode.js` bytes and on
a real v2.0.20 host): `compress`, `decompress`, `search_context`,
`acp_status`, `acp_cache`, `absorb` (plus an `image_full` name under
imageCompression). **`acp_status` exists — old status surfaces are not
removed.**

Transport requirement: registration alone is not a transport. The bili-backed
tools execute only against a live bili proxy. Per the pinned README
(L150–199), the **native v1/v2 plugins self-spawn the proxy** — no launcher
command and no env vars are needed; spawned lanes live in a self-managed port
zone starting at 18787 (collisions hop +1) and a deliberate `bili start`
daemon is attached by default. The launcher (`bili opencode`), the
`BILLION_CONTEXT_PROXY` env var and a `/bili/`-prefixed provider baseURL are
the other documented postures, and are what the tools' `bili: no proxy
detected` message suggests when no live proxy was found (e.g. the self-spawn
bootstrap failed). This bundle never rewrites user provider config, adds no
mandatory launcher, and implements no alternative transport/daemon protocol.

Gating and fixture safety (pinned `planNativeOpencode`):
`BILLION_CONTEXT_PLUGIN=0` or `BILI_NATIVE_OPENCODE=0` forces plan mode
`off` — no spawn, no state writes, traffic direct. Network-off knobs for any
test that lets the pinned fixture run for real: `ACP_AUTO_UPDATE=0`
(self-update) and `BILI_ADVISORY_CHECK=0` (advisory npm poll); optional
`BILI_ADVISORY_URL`. Any upstream-setup test must also isolate
`HOME`/`XDG_CACHE_HOME`/`XDG_CONFIG_HOME` to temp dirs and put the resolved
real Node bin directory FIRST on `PATH` — a mismatched sandbox HOME with mise
shims on PATH makes the spawned bootstrap fail (`mise ERROR node is not a
valid shim`). Owner retest on the real host CONFIRMED the native self-start
route works with a correct sandbox Node PATH and `compaction.auto: false`
(search_context executed, returning the pinned no-blocks message) — no
launcher adaptation is needed on this route. For real installs the pinned
README (L150–199) also requires setting `"compaction": { "auto": false }` in
the host config, otherwise OpenCode's native auto-compaction
double-compresses.

## Known gaps (reported, not faked)

- **No `recap` tool** exists in the pinned 0.1.175 bundle — the word appears
  only in verbosity prompt text. Old recap-style summaries are a genuine gap;
  do not claim parity.
- **Absolute-token thresholds** (`maxContextLimit` as a token count) translate
  only with a known model context limit, and cannot be pinned across model
  sizes — see `src/compression/config-semantics.mjs` for the full translation
  and drop list (`minContextLimit`, `summaryBuffer`, `allowSubAgents`,
  `contextLimitFallback`, `minNudgeContextPercent`, `permission` are dropped
  with recorded reasons, never mapped to different-meaning keys).

## Tests and removal

Run from `integrations/community/`:

```
node --test test/build-compression.test.mjs test/engine-select.test.mjs \
  test/entries.test.mjs test/config-semantics.test.mjs \
  test/config-semantics-tripwire.test.mjs test/install-contract.test.mjs
```

End-to-end admission: `/tmp/opencode/dual-host-major-20260930/compression-entry-check.mjs <new-output-dir>`
must report `documented_generated_legacy_slot: true`.

Removal conditions: delete the bundle and the `BILI_OPENCODE_ACP_SPEC` slot
when no old v1 sessions remain and all hosts run compression natively through
the bili proxy. The tripwire test forces re-verification of config semantics
whenever the pinned parser bytes change.
