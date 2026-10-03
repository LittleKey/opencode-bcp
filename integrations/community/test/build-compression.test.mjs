import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCompression, BILLION_CONTEXT_VERSION } from "../src/compression/builder.mjs";
import { claimEngine, claimedEngines } from "../src/lib/engine-registry.mjs";
import { sha256File } from "../src/lib/hash.mjs";
import { DEPS, PINS, withTempDir } from "./helper.mjs";

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

test("buildCompression emits the full bundle with pinned hashes and manifest", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    for (const rel of result.files) {
      assert.ok(readFileSync(join(result.outDir, rel), "utf8").length > 0, rel);
    }
    const deps = JSON.parse(readFileSync(join(result.outDir, "deps.json"), "utf8"));
    assert.equal(deps.compression.version, PINS.billionContextVersion);
    assert.equal(deps.compression.packageJsonSha256, PINS.packageJsonSha256);
    assert.equal(deps.compression.serverEntry.sha256, PINS.serverEntrySha256);
    assert.equal(deps.compression.v2Entry.sha256, PINS.v2EntrySha256);
    assert.equal(deps.compression.legacyAcp.entry.sha256, PINS.legacyAcpSha256);

    const manifest = JSON.parse(readFileSync(join(result.outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.upstream.billionContext.version, BILLION_CONTEXT_VERSION);
    assert.equal(manifest.upstream.legacyAcp.upstreamSourceSha256, PINS.legacyAcpUpstreamSourceSha256);
    assert.ok(manifest.upstream.legacyAcp.changes.some((c) => /export/.test(c)));
    assert.match(manifest.selection.legacyAcp.install, /BILI_OPENCODE_ACP_SPEC/);
    assert.ok(manifest.removal.length > 20);
    // precise guarantee text + pinned tooling truth are part of the manifest
    assert.match(manifest.selection.legacyAcp.armGate, /no stock fallback/i);
    assert.match(manifest.selection.exactlyOneEngine, /per emitted bundle copy/);
    assert.match(manifest.selection.exactlyOneEngine, /NOT process-global/);
    assert.match(manifest.tooling.pinnedSurface, /acp_status/);
    assert.match(manifest.tooling.transport, /SELF-SPAWN|self-spawn/);
    assert.match(manifest.tooling.fixtureSafety, /BILI_ADVISORY_CHECK=0/);
    assert.match(manifest.tooling.hostInstall, /compaction/);
    assert.match(manifest.tooling.unsupportedSemantics, /recap/);
  }));

test("buildCompression refuses wrong version and wrong pins", async () =>
  withTempDir(async (tmp) => {
    await assert.rejects(
      buildTo(tmp, { expectedVersion: "0.1.999" }),
      /billion-context mismatch/,
    );
    await assert.rejects(
      buildTo(tmp, { v2EntrySha256: "0".repeat(64) }),
      /v2 entry sha256 mismatch/,
    );
    await assert.rejects(
      buildTo(tmp, { legacyAcpSha256: "0".repeat(64) }),
      /legacy ACP entry sha256 mismatch/,
    );
    await assert.rejects(
      buildTo(tmp, { packageJsonSha256: "0".repeat(64) }),
      /package\.json sha256 mismatch/,
    );
  }));

test("buildCompression requires explicit inputs", async () => {
  await assert.rejects(buildCompression({ outDir: "/tmp/x" }), /requires/);
});

test("emitted entries expose only their documented loader surfaces and distinct dependency entries", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    const v1 = readFileSync(join(result.outDir, "v1.mjs"), "utf8");
    const v2 = readFileSync(join(result.outDir, "v2.mjs"), "utf8");
    // v1: default-only loader surface — no named server, no factory re-export
    assert.match(v1, /export default async function server/);
    assert.ok(!v1.includes("export async function server"), "v1 must not expose a named server export");
    assert.ok(!v1.includes("export { createCompressionV1Entry }"), "v1 must not re-export the factory");
    assert.ok(!v1.includes("createCompressionV2Entry"));
    // v2: Plugin surface (default {id, setup} + named id/setup), no factory
    assert.match(v2, /export const id = /);
    assert.match(v2, /export async function setup/);
    assert.match(v2, /export default \{ id, setup \}/);
    assert.ok(!v2.includes("export { createCompressionV2Entry }"), "v2 must not re-export the factory");
    assert.ok(!v2.includes("createCompressionV1Entry"));
    const core = readFileSync(join(result.outDir, "entry-core.mjs"), "utf8");
    // v1 path verifies + imports ONLY serverEntry; v2 path ONLY v2Entry
    const v1Block = core.slice(core.indexOf("createCompressionV1Entry"), core.indexOf("createCompressionV2Entry"));
    const v2Block = core.slice(core.indexOf("createCompressionV2Entry"));
    assert.ok(v1Block.includes("d.serverEntry.path"));
    assert.ok(!v1Block.includes("d.v2Entry.path"));
    assert.ok(v2Block.includes("d.v2Entry.path"));
    assert.ok(!v2Block.includes("d.serverEntry.path"));
    // v2 cleanup wrapper must release the registry claim
    assert.match(v2Block, /claim\.release\(\)/);
    // install contract: emitted legacy slot is the byte-exact repaired copy
    const legacy = join(result.outDir, "legacy-acp", "opencode-acp", "dist", "index.js");
    assert.equal(await sha256File(legacy), PINS.legacyAcpSha256);
  }));

test("engine registry enforces exactly one engine per bundle copy, without process-global exclusion", async () => {
  const first = claimEngine("compression-v1");
  assert.deepEqual(claimedEngines(), ["compression-v1"]);
  assert.throws(() => claimEngine("compression-v2"), /conflict/);
  assert.throws(() => claimEngine("compression-v1"), /conflict/);
  first.release();
  assert.deepEqual(claimedEngines(), []);
  const second = claimEngine("compression-v2");
  assert.deepEqual(claimedEngines(), ["compression-v2"]);
  second.release();
  // a SECOND module instance (what a separate bundle copy gets) holds its own
  // registry: legitimate different-project instances never conflict
  const registryUrl = new URL("../src/lib/engine-registry.mjs", import.meta.url);
  const copy2 = await import(`${registryUrl.href}?bundle-copy=2`);
  const copy3 = await import(`${registryUrl.href}?bundle-copy=3`);
  const a = copy2.claimEngine("compression-v1");
  const b = copy3.claimEngine("compression-v1");
  assert.deepEqual(copy2.claimedEngines(), ["compression-v1"]);
  assert.deepEqual(copy3.claimedEngines(), ["compression-v1"]);
  assert.deepEqual(claimedEngines(), [], "main copy must be unaffected by other copies");
  a.release();
  b.release();
  // releasing twice is a no-op; the slot stays free for a new claim
  const again = claimEngine("compression-v1");
  first.release();
  assert.deepEqual(claimedEngines(), ["compression-v1"]);
  again.release();
  assert.deepEqual(claimedEngines(), []);
});
