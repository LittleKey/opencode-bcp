// Subprocess fixture: arm the built v2 compression entry through the emitted
// Plugin surface against a mock plugin context and report what the pinned
// billion-context setup registered — including the CLAIM LIFECYCLE: the claim
// must exist after setup, be released by the returned cleanup, and allow a
// clean re-arm. The parent controls env (isolated HOME/XDG, real Node PATH,
// network-off knobs).
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const bundleDir = process.argv[2];
const { default: plugin } = await import(pathToFileURL(join(bundleDir, "v2.mjs")).href);
const registry = await import(pathToFileURL(join(bundleDir, "lib", "engine-registry.mjs")).href);

const registrations = [];
const disposed = [];
const ctx = {
  session: {
    hook: async (name, cb) => {
      registrations.push(["session", name]);
      return { dispose: async () => disposed.push(name) };
    },
  },
  tool: {
    transform: async (cb) => {
      registrations.push(["tool", "transform"]);
      return { dispose: async () => disposed.push("transform") };
    },
  },
  event: {
    subscribe: () =>
      (async function* () {
        // yields nothing; loop exits immediately
      })(),
  },
  client: {},
};

const cleanup = await plugin.setup(ctx);
const cleanupIsFunction = typeof cleanup === "function";
const claimedAfterSetup = registry.claimedEngines();
await cleanup?.();
const claimedAfterCleanup = registry.claimedEngines();

// after the host-invoked cleanup the bundle copy must re-arm cleanly
const cleanup2 = await plugin.setup(ctx);
const reArmOk = typeof cleanup2 === "function";
await cleanup2?.();
const claimedAfterReArmCleanup = registry.claimedEngines();

process.stdout.write(
  JSON.stringify(
    {
      id: plugin.id,
      registrations,
      disposed,
      cleanupIsFunction,
      claimedAfterSetup,
      claimedAfterCleanup,
      reArmOk,
      claimedAfterReArmCleanup,
    },
    null,
    2,
  ),
);
