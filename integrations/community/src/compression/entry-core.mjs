/**
 * Compression entry factories (emitted into the build bundle by the builder).
 *
 * Self-locating: reads deps.json from its own directory. The builder writes
 * deps.json with explicit absolute dependency paths + pinned sha256s; nothing
 * is resolved from bare npm specifiers or ambient node_modules.
 *
 * Guarantees implemented here:
 * - version/hash gates BEFORE any dependency import (narrow pinned artifacts
 *   only; unknown versions fail loudly instead of being patched fuzzily)
 * - explicit legacy-ACP selection for the v1 entry: blocked = refuse to arm,
 *   never a silent fallback to stock candidates
 * - at most one compression engine armed per emitted bundle copy (shared
 *   per-bundle registry; separate bundle copies — e.g. other projects in the
 *   same host process — never conflict; see lib/engine-registry.mjs)
 * - the v1 entry imports ONLY the v1 server entry; the v2 entry imports ONLY
 *   the v2 bundle; neither file imports the other compressor
 *
 * Claim lifetime: the v2 wrapper releases its registry claim when the host
 * invokes the cleanup function returned by setup(). The v1 wrapper hands the
 * host a server(ctx) -> hooks function whose lifetime the v1 host controls;
 * its claim is therefore held for the process lifetime of the armed bundle.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claimEngine } from "./lib/engine-registry.mjs";
// Emitted at bundle root; engine-select keeps its source-tree relative
// layout under compression/ so its ../lib/* imports resolve inside the bundle.
import { planLegacySelection, verifyBillionContextPackage } from "./compression/engine-select.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function loadDeps() {
  return JSON.parse(readFileSync(join(here, "deps.json"), "utf8"));
}

function fail(header, errors) {
  throw new Error(`[community-compression] ${header}\n  - ${errors.join("\n  - ")}`);
}

/**
 * v1 host engine: billion-context v1 server entry (dist/agent/opencode-native.js;
 * in 0.1.175 the default export is the dual-shape { id, setup, server } — the
 * v1 surface is `.server(ctx) -> hooks`) with explicit legacy-ACP selection.
 * Old v1 sessions are served by the repaired ACP (absorbed by the server via
 * the explicit BILI_OPENCODE_ACP_SPEC slot); new sessions use the bili proxy.
 */
export async function createCompressionV1Entry() {
  const d = loadDeps().compression;
  const verification = await verifyBillionContextPackage({
    packageDir: d.packageDir,
    expected: {
      version: d.version,
      entries: {
        server: { path: d.serverEntry.path, sha256: d.serverEntry.sha256, label: "billion-context v1 server entry" },
      },
    },
  });
  if (!verification.ok) fail("v1 dependency verification failed", verification.errors);

  const plan = await planLegacySelection({
    env: process.env,
    repairedSha256: d.legacyAcp?.entry?.sha256,
  });
  if (plan.status !== "ok") {
    fail("v1 legacy-ACP selection blocked (exactly-one-engine policy forbids stock fallback)", [plan.reason]);
  }

  const mod = await import(pathToFileURL(d.serverEntry.path).href);
  const exported = mod.default;
  // billion-context 0.1.175 emits a dual-shape default export { id, setup,
  // server }: `server` is the v1 host function, `setup` the v2 Plugin form.
  // A bare server(ctx) function is accepted for the older documented shape.
  const server = typeof exported === "function" ? exported : exported?.server;
  if (typeof server !== "function") {
    fail("billion-context v1 entry shape changed", [
      `${d.serverEntry.path}: default export is ${
        exported && typeof exported === "object" ? `object with keys {${Object.keys(exported).join(", ")}}` : typeof exported
      }; expected the server(ctx) function (directly or as .server)`,
    ]);
  }
  const claim = claimEngine("compression-v1");
  return {
    kind: "compression-v1",
    claim,
    legacyAcp: plan,
    server: async (ctx) => await server(ctx),
  };
}

/**
 * v2 host engine: billion-context v2 bundle (dist/agent/opencode.js, default
 * export = { id, setup }). v2 hosts have no legacy v1 ACP path; this entry
 * never registers one.
 */
export async function createCompressionV2Entry() {
  const d = loadDeps().compression;
  const verification = await verifyBillionContextPackage({
    packageDir: d.packageDir,
    expected: {
      version: d.version,
      entries: {
        v2: { path: d.v2Entry.path, sha256: d.v2Entry.sha256, label: "billion-context v2 plugin bundle" },
      },
    },
  });
  if (!verification.ok) fail("v2 dependency verification failed", verification.errors);

  const mod = await import(pathToFileURL(d.v2Entry.path).href);
  const plugin = mod.default;
  if (!plugin || typeof plugin !== "object" || typeof plugin.setup !== "function" || typeof plugin.id !== "string") {
    fail("billion-context v2 entry shape changed", [
      `${d.v2Entry.path}: default export must be { id: string, setup(ctx) }`,
    ]);
  }
  const claim = claimEngine("compression-v2");
  return {
    kind: "compression-v2",
    claim,
    id: plugin.id,
    setup: async (ctx) => {
      const cleanup = await plugin.setup(ctx);
      if (typeof cleanup !== "function") {
        // The pinned artifact armed without a teardown hook: the claim stays
        // held for the process lifetime (nothing to release it against).
        return cleanup;
      }
      // Host-invoked teardown also frees the engine slot, so the bundle copy
      // can be armed again cleanly afterwards.
      return async () => {
        try {
          await cleanup();
        } finally {
          claim.release();
        }
      };
    },
  };
}
