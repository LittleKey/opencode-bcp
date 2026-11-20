# Changelog

## 2.2.0 — zero-configuration default mode

`bcp_save` is now usable with no operator configuration at all.

- **Default mode**: when no operator source is declared (`BCP_OPERATOR_OPTIONS`
  unset, or absent/empty plugin JSON options for a bare V2 install), `bcp_save`
  derives its own loopback connection (exactly one process-owned loopback
  LISTEN socket; zero or several candidates deny with `no_listener` /
  `ambiguous_listener`; credentials only from the process's own
  `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`) and archives into a fixed
  scope: `taskId` `bcp-handoff`, task root
  `<plugin directory>/.opencode/work/bcp-handoff`, project pinned from the live
  session record. All identity checks (fork rejection, direct-child ancestry,
  project/directory equality) and native `read`/`bcp_save`/`edit` assertions
  are unchanged. The exact relative task-root path is authorized with a native
  `edit` assertion before the first `mkdir` (0700).
- **Behavior change on upgrade (2.1.1 → 2.2.0)**: a 2.1.1 Git-extension
  deployment without `BCP_OPERATOR_OPTIONS` previously failed closed (every
  save denied with `trusted_configuration_required`). After updating to 2.2.0
  the same deployment runs in default mode and can save. A bare V2 install
  with absent/empty plugin JSON options switches the same way (there the
  `BCP_OPERATOR_OPTIONS` opt-out does not apply — provide plugin JSON options
  with `{"enabled": false}` instead). To stay disabled, set
  `BCP_OPERATOR_OPTIONS` to an existing owner-private file containing
  `{"enabled": false}` — a declared source, even a disabled one, always takes
  precedence over default mode.
- **Absence-only trigger**: default mode is selected only by the *absence* of a
  declared operator source. A declared-but-broken source (env set with a
  missing/invalid file, an offline-packaged baked path that disappeared, or a
  loader error) stays a hard denial — revocation can never flip a deployment
  into default mode. A declared source returning `{}` (installer initial
  state, offline packager) is a declared-but-empty configuration that fails
  closed. The offline packager wrapper now rejects when its baked options file
  is missing instead of returning `{}`.
- **Host compatibility**: OpenChamber 2.7.2 and 2.7.3 are accepted packaging
  targets (2.7.3 moved its guest loader to `build/server/lib/guests`).

## 2.1.1 — bump past the historical v2.1.0 tag

The local historical tag `v2.1.0` pointed at retired publication-handoff code;
the Git-extension release was re-versioned to 2.1.1 to avoid the collision.

## 2.1.0 — Git-installable OpenChamber snapshot extension

First Git-URL-installable OpenChamber extension release (root `package.json`
extension metadata, prebuilt `openchamber/plugin/` bundle, external
`BCP_OPERATOR_OPTIONS` operator channel, fail-closed without configuration).
