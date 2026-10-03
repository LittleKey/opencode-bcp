import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildCompression } from "../src/compression/builder.mjs";
import { sha256File } from "../src/lib/hash.mjs";
import {
  DEPS,
  PINS,
  withEnv,
  withTempDir,
} from "./helper.mjs";

const SPEC_ENV = "BILI_OPENCODE_ACP_SPEC";

async function buildTo(tmp, overrides = {}) {
  return buildCompression({
    billionContextDir: DEPS.billionContextDir,
    legacyAcpEntry: DEPS.repairedAcpEntry,
    legacyAcpManifestPath: DEPS.repairedAcpManifest,
    outDir: join(tmp, "compression"),
    expectedVersion: PINS.billionContextVersion,
    packageJsonSha256: PINS.packageJsonSha256,
    serverEntrySha256: PINS.serverEntrySha256,
    v2EntrySha256: PINS.v2EntrySha256,
    legacyAcpSha256: PINS.legacyAcpSha256,
    legacyAcpUpstreamSourceSha256: PINS.legacyAcpUpstreamSourceSha256,
    generatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  });
}

/**
 * Child env for any fixture that lets the pinned upstream code run:
 * isolated HOME/XDG (never the real ~/.config or ~/.cache — earlier runs
 * polluted real state), the resolved real Node bin FIRST on PATH (mise shims
 * break spawned bootstrap with a sandboxed HOME), and the pinned network-off
 * knobs. BILI_NATIVE_OPENCODE=0 additionally forces pinned plan mode "off"
 * (no proxy spawn, no state writes) for v1 arm fixtures.
 */
function fixtureEnv(tmp, cacheRoot, { spec } = {}) {
  return {
    ...process.env,
    HOME: tmp,
    XDG_CACHE_HOME: cacheRoot,
    XDG_CONFIG_HOME: tmp,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    BILI_NATIVE_OPENCODE: "0",
    ACP_AUTO_UPDATE: "0",
    BILI_ADVISORY_CHECK: "0",
    ...(spec === undefined ? {} : { [SPEC_ENV]: spec }),
  };
}

test("v2 entry arms the pinned billion-context plugin in a subprocess and releases its claim on cleanup", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    const armFixture = fileURLToPath(new URL("./fixtures/arm-v2.mjs", import.meta.url));
    const arm = spawnSync(process.execPath, [armFixture, result.outDir], {
      encoding: "utf8",
      timeout: 60000,
      env: fixtureEnv(tmp, tmp),
    });
    assert.equal(arm.status, 0, `fixture failed:\n${arm.stdout}\n${arm.stderr}`);
    const report = JSON.parse(arm.stdout);
    assert.equal(report.id, "community-compression-v2");
    assert.ok(
      report.registrations.some(([domain, name]) => domain === "session" && name === "http.request"),
      `expected http.request registration, got ${JSON.stringify(report.registrations)}`,
    );
    assert.equal(report.cleanupIsFunction, true);
    assert.ok(report.disposed.includes("http.request"), "cleanup must dispose registrations");
    // claim lifecycle: armed -> released by the host-invoked cleanup -> re-arm ok
    assert.deepEqual(report.claimedAfterSetup, ["compression-v2"]);
    assert.deepEqual(report.claimedAfterCleanup, []);
    assert.equal(report.reArmOk, true, "bundle copy must re-arm after cleanup released the claim");
    assert.deepEqual(report.claimedAfterReArmCleanup, []);
  }));

test("v1 entry (loader surface) refuses to arm without an explicit legacy-ACP spec", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    const server = (await import(pathToFileURL(join(result.outDir, "v1.mjs")).href)).default;
    assert.equal(typeof server, "function");
    await withEnv(SPEC_ENV, undefined, async () => {
      await assert.rejects(() => server({}), /BILI_OPENCODE_ACP_SPEC/);
    });
  }));

test("v1 entry (loader surface) refuses to arm when the explicit slot is missing", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    const server = (await import(pathToFileURL(join(result.outDir, "v1.mjs")).href)).default;
    await withEnv(SPEC_ENV, "does-not-exist", async () => {
      await withEnv("XDG_CACHE_HOME", tmp, async () => {
        await assert.rejects(() => server({}), /does not exist|no candidate/);
      });
    });
  }));

test("v1 entry arms through the loader surface with the documented generated slot, and blocks a cross-entry arm", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    // documented install: byte-exact copy of the emitted slot tree
    const cacheRoot = join(tmp, "cache");
    cpSync(join(result.outDir, "legacy-acp", "opencode-acp"), join(cacheRoot, "opencode", "packages", "goodspec", "node_modules", "opencode-acp"), { recursive: true });
    const armFixture = fileURLToPath(new URL("./fixtures/arm-v1.mjs", import.meta.url));
    const arm = spawnSync(process.execPath, [armFixture, result.outDir], {
      encoding: "utf8",
      timeout: 60000,
      env: fixtureEnv(tmp, cacheRoot, { spec: "goodspec" }),
    });
    assert.equal(arm.status, 0, `fixture failed:\n${arm.stdout}\n${arm.stderr}`);
    const report = JSON.parse(arm.stdout);
    // loader surface: default only, no factory exports
    assert.equal(report.defaultIsFn, true);
    assert.ok(!report.exportNames.includes("createCompressionV1Entry"), "factory must not be on the loader surface");
    assert.ok(!report.exportNames.includes("server"), "named server export must not be on the loader surface");
    // plan mode off: pinned server returns {} without spawning or state writes
    assert.equal(report.armError, null, `arm failed: ${report.armError}`);
    assert.equal(report.hooksType, "object");
    assert.deepEqual(report.claimedAfterArm, ["compression-v1"]);
    // duplicate-routing guard: the second entry must conflict in this bundle copy
    assert.equal(report.conflictCaught, true, `expected conflict, got ${JSON.stringify(report)}`);
    assert.match(report.conflictMessage ?? "", /conflict/);
  }));

test("documented install of a tampered slot is refused at arm time (fresh process)", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    const cacheRoot = join(tmp, "cache");
    const slotDist = join(cacheRoot, "opencode", "packages", "badslot", "node_modules", "opencode-acp", "dist");
    cpSync(join(result.outDir, "legacy-acp", "opencode-acp"), join(cacheRoot, "opencode", "packages", "badslot", "node_modules", "opencode-acp"), { recursive: true });
    // corrupt the installed slot AFTER install, like a drifted/stale copy
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(slotDist, "index.js"), "\n// tampered after install\n", "utf8");
    const armFixture = fileURLToPath(new URL("./fixtures/arm-v1.mjs", import.meta.url));
    const arm = spawnSync(process.execPath, [armFixture, result.outDir], {
      encoding: "utf8",
      timeout: 60000,
      env: fixtureEnv(tmp, cacheRoot, { spec: "badslot" }),
    });
    assert.equal(arm.status, 0, `fixture crashed instead of reporting:\n${arm.stderr}`);
    const report = JSON.parse(arm.stdout);
    assert.match(report.armError ?? "", /content mismatch/, "tampered slot must be refused with the hash-gate error");
    assert.deepEqual(report.claimedAfterArm, [], "no claim may be held for a refused arm");
  }));

test("emitted legacy slot is a byte-exact copy of the repaired entry (install contract)", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    const emitted = join(result.outDir, "legacy-acp", "opencode-acp", "dist", "index.js");
    const [emittedSha, sourceSha] = await Promise.all([sha256File(emitted), sha256File(DEPS.repairedAcpEntry)]);
    assert.equal(emittedSha, PINS.legacyAcpSha256);
    assert.equal(emittedSha, sourceSha);
    assert.equal(readFileSync(emitted).equals(readFileSync(DEPS.repairedAcpEntry)), true);
    // no generated wrapper: no baked absolute target, no builder header
    const text = readFileSync(emitted, "utf8");
    assert.ok(!text.includes("opencode-community-compat builder"), "slot file must be the repaired bytes, not generated code");
  }));

test("emitted deps.json identity matches the pins used at build time", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    const deps = JSON.parse(readFileSync(join(result.outDir, "deps.json"), "utf8"));
    assert.equal(deps.compression.packageDir, DEPS.billionContextDir);
    assert.equal(deps.compression.legacyAcp.entry.path, DEPS.repairedAcpEntry);
    assert.equal(deps.compression.legacyAcp.upstreamSourceSha256, PINS.legacyAcpUpstreamSourceSha256);
    // slot install contract is machine-readable in deps.json
    assert.equal(deps.compression.legacyAcp.slot.sha256, PINS.legacyAcpSha256);
    assert.equal(deps.compression.legacyAcp.slot.emittedTree, "legacy-acp/opencode-acp");
    assert.match(deps.compression.legacyAcp.slot.installedLayout, /packages\/<SPEC>\/node_modules\/opencode-acp\/dist\/index\.js/);
    assert.match(deps.compression.legacyAcp.slot.contract, /byte-exact/);
  }));

test("copying the repaired entry for a build keeps emitted slot byte-identical", async () =>
  withTempDir(async (tmp) => {
    // builder input via a COPY (not the original file) — emitted slot must
    // still equal the pinned bytes
    const entryCopy = join(tmp, "acp-src.js");
    copyFileSync(DEPS.repairedAcpEntry, entryCopy);
    const result = await buildTo(tmp, { legacyAcpEntry: entryCopy });
    const emittedSha = await sha256File(join(result.outDir, "legacy-acp", "opencode-acp", "dist", "index.js"));
    assert.equal(emittedSha, PINS.legacyAcpSha256);
  }));
