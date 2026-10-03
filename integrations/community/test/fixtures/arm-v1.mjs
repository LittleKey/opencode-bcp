// Subprocess fixture: arm the built v1 compression entry through the REAL
// loader surface (emitted v1.mjs default export) with a plan-off pinned
// fixture (no proxy spawn, no state writes), then report:
//  - the module's export surface (must be default-only)
//  - the armed registry claim (from the emitted engine-registry module)
//  - whether a cross-entry v2 arm attempt conflicts (duplicate-routing guard)
// The parent controls env (isolated HOME/XDG, real Node PATH, network-off).
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [bundleDir] = process.argv.slice(2);

const report = {};
const mod = await import(pathToFileURL(join(bundleDir, "v1.mjs")).href);
report.exportNames = Object.keys(mod).sort();
report.defaultIsFn = typeof mod.default === "function";

// plan mode is forced off via BILI_NATIVE_OPENCODE=0 (parent env): the pinned
// server(ctx) returns {} without spawning a proxy or touching host state.
try {
  const hooks = await mod.default({});
  report.hooksType = typeof hooks;
  report.armError = null;
} catch (err) {
  report.hooksType = null;
  report.armError = String(err?.message ?? err);
}

const reg = await import(pathToFileURL(join(bundleDir, "lib", "engine-registry.mjs")).href);
report.claimedAfterArm = reg.claimedEngines();

// Duplicate-routing guard: with the v1 engine armed in this bundle copy, a v2
// arm attempt must throw the registry conflict (never silently coexist).
try {
  const v2 = await import(pathToFileURL(join(bundleDir, "v2.mjs")).href);
  await v2.setup({});
  report.conflictCaught = false;
} catch (err) {
  report.conflictCaught = /conflict/.test(String(err?.message ?? err));
  report.conflictMessage = String(err?.message ?? err);
}

process.stdout.write(JSON.stringify(report, null, 2));
