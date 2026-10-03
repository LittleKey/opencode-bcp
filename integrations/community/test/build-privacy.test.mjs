import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "../src/lib/hash.mjs";
import { buildPrivacy, PATCHED_SESSION_SHA256, STOCK_SESSION_SHA256 } from "../src/privacy/builder.mjs";
import { DEPS, withTempDir } from "./helper.mjs";

async function buildTo(tmp, overrides = {}) {
  return buildPrivacy({
    vibeguardDir: DEPS.vibeguardDir,
    outDir: join(tmp, "privacy"),
    expectedVersion: "0.1.0",
    stockSessionSha256: STOCK_SESSION_SHA256,
    patchedSessionSha256: PATCHED_SESSION_SHA256,
    generatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  });
}

test("buildPrivacy emits the module set with the exact byte patch applied", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    for (const rel of result.files) {
      assert.ok(readFileSync(join(result.outDir, rel), "utf8").length > 0, rel);
    }
    assert.equal(await sha256File(join(result.outDir, "vibeguard", "session.js")), PATCHED_SESSION_SHA256);
    const manifest = JSON.parse(readFileSync(join(result.outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.upstream.opencodeVibeguard.version, "0.1.0");
    assert.equal(manifest.upstream.opencodeVibeguard.stockSessionSha256, STOCK_SESSION_SHA256);
    assert.equal(manifest.upstream.opencodeVibeguard.patchedSessionSha256, PATCHED_SESSION_SHA256);
    assert.ok(manifest.upstream.opencodeVibeguard.changes[0].includes("non-greedy"));
    assert.ok(manifest.coverage.v2.some((c) => c.includes("http.response")));
    // coverage matches the actual hooks: the pre-admission prompt hook was
    // removed (raw user input must reach storage unmutated)
    assert.ok(!manifest.coverage.v2.some((c) => c.includes("session.hook prompt")), "no prompt-hook coverage claim");
    // serialized tool-argument retention is a documented limit, not a silent gap
    assert.ok(
      manifest.limits.some((l) => l.includes("tool-argument JSON is deliberately NOT restored")),
      "wire tool-argument retention limit must be explicit",
    );
    assert.ok(manifest.limits.some((l) => /split/.test(l)));
    assert.match(manifest.removal, /0\.1\.0/);
  }));

test("buildPrivacy refuses wrong package version or tampered sources", async () =>
  withTempDir(async (tmp) => {
    await assert.rejects(buildTo(tmp, { expectedVersion: "9.9.9" }), /opencode-vibeguard mismatch/);
    await assert.rejects(
      buildTo(tmp, { stockSessionSha256: "0".repeat(64) }),
      /stock session\.js sha256 mismatch/,
    );
    await assert.rejects(
      buildTo(tmp, { patchedSessionSha256: "0".repeat(64) }),
      /patched session\.js sha256 mismatch/,
    );
    await assert.rejects(buildTo(tmp, { stockSessionSha256: undefined }), /requires/);
  }));

test("patched session keeps stock content except the single regex fix", async () =>
  withTempDir(async (tmp) => {
    const result = await buildTo(tmp);
    const stock = readFileSync(join(DEPS.vibeguardDir, "src", "session.js"), "utf8");
    const patched = readFileSync(join(result.outDir, "vibeguard", "session.js"), "utf8");
    assert.equal(patched, stock.replace("[A-Za-z0-9_]+_[a-f0-9A-F]{12}", "[A-Za-z0-9_]+?_[a-f0-9A-F]{12}"));
  }));
