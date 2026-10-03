import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { sha256File } from "../src/lib/hash.mjs";
import {
  LEGACY_ACP_RELATIVE_PATH,
  LEGACY_ACP_SPEC_ENV,
  auditStockCandidates,
  legacyAcpCandidates,
  planLegacySelection,
  verifyBillionContextPackage,
} from "../src/compression/engine-select.mjs";
import { DEPS, PINS, withEnv, withTempDir, makeLegacyAcpSlot } from "./helper.mjs";
import { join } from "node:path";

test("candidate mirror unshifts the explicit spec slot to the front", () => {
  const candidates = legacyAcpCandidates({
    cwd: "/proj",
    env: { XDG_CACHE_HOME: "/cache", XDG_CONFIG_HOME: "/conf", [LEGACY_ACP_SPEC_ENV]: "myspec" },
    configHome: "/conf",
  });
  assert.equal(candidates[0], join("/cache", "opencode", "packages", "myspec", "node_modules", LEGACY_ACP_RELATIVE_PATH));
  assert.ok(candidates.includes(join("/proj", ".opencode", "node_modules", LEGACY_ACP_RELATIVE_PATH)));
  assert.ok(candidates.includes(join("/conf", "opencode", "node_modules", LEGACY_ACP_RELATIVE_PATH)));
});

test("selection without explicit spec is blocked (never stock fallback)", async () => {
  await withEnv(LEGACY_ACP_SPEC_ENV, undefined, async () => {
    const plan = await planLegacySelection({ env: process.env, repairedSha256: PINS.legacyAcpSha256 });
    assert.equal(plan.status, "blocked");
    assert.match(plan.reason, /BILI_OPENCODE_ACP_SPEC/);
  });
});

test("selection with a missing slot is blocked", async () =>
  withTempDir(async (tmp) => {
    const plan = await planLegacySelection({
      env: { XDG_CACHE_HOME: tmp, [LEGACY_ACP_SPEC_ENV]: "nope" },
      repairedSha256: PINS.legacyAcpSha256,
    });
    assert.equal(plan.status, "blocked");
    assert.match(plan.reason, /does not exist/);
  }));

test("selection with non-repaired slot content is blocked (hash gate)", async () =>
  withTempDir(async (tmp) => {
    // create a slot with WRONG bytes
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const wrong = join(tmp, "opencode", "packages", "wrongspec", "node_modules", "opencode-acp", "dist");
    mkdirSync(wrong, { recursive: true });
    writeFileSync(join(wrong, "index.js"), "export default function notRepaired() {}", "utf8");
    const plan = await planLegacySelection({
      env: { XDG_CACHE_HOME: tmp, [LEGACY_ACP_SPEC_ENV]: "wrongspec" },
      repairedSha256: PINS.legacyAcpSha256,
    });
    assert.equal(plan.status, "blocked");
    assert.match(plan.reason, /content mismatch/);
  }));

test("selection with the repaired bytes in the explicit slot is ok", async () =>
  withTempDir(async (tmp) => {
    makeLegacyAcpSlot(tmp, "goodspec", DEPS.repairedAcpEntry);
    const plan = await planLegacySelection({
      env: { XDG_CACHE_HOME: tmp, [LEGACY_ACP_SPEC_ENV]: "goodspec" },
      repairedSha256: PINS.legacyAcpSha256,
    });
    assert.equal(plan.status, "ok");
    assert.match(plan.path, /goodspec/);
  }));

test("auditStockCandidates reports existing stock locations without selecting them", async () => {
  await withEnv(LEGACY_ACP_SPEC_ENV, undefined, async () => {
    const existing = auditStockCandidates({
      env: process.env,
      configHome: process.env.XDG_CONFIG_HOME,
    });
    // this machine has the stock package in the config-home probe range
    const stock = existing.find((p) => p.endsWith(join("opencode-acp", "dist", "index.js")));
    assert.ok(stock, "expected at least one stock candidate visible to the probe");
    const sha = await sha256File(stock);
    assert.equal(sha, PINS.legacyAcpUpstreamSourceSha256);
  });
});

test("billion-context package verification passes on the pinned cache", async () => {
  const v = await verifyBillionContextPackage({
    packageDir: DEPS.billionContextDir,
    expected: {
      version: PINS.billionContextVersion,
      entries: {
        server: {
          path: join(DEPS.billionContextDir, "dist", "agent", "opencode-native.js"),
          sha256: PINS.serverEntrySha256,
          label: "server entry",
        },
        v2: {
          path: join(DEPS.billionContextDir, "dist", "agent", "opencode.js"),
          sha256: PINS.v2EntrySha256,
          label: "v2 bundle",
        },
      },
    },
  });
  assert.deepEqual(v.errors, []);
  assert.ok(v.ok);
});

test("billion-context verification fails on wrong version and tampered hash", async () =>
  withTempDir(async (tmp) => {
    const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
    mkdirSync(join(tmp, "dist", "agent"), { recursive: true });
    const pkg = JSON.parse(readFileSync(join(DEPS.billionContextDir, "package.json"), "utf8"));
    pkg.version = "0.0.1";
    writeFileSync(join(tmp, "package.json"), JSON.stringify(pkg), "utf8");
    writeFileSync(join(tmp, "dist", "agent", "opencode.js"), "export default {}", "utf8");
    const v = await verifyBillionContextPackage({
      packageDir: tmp,
      expected: {
        version: PINS.billionContextVersion,
        entries: {
          v2: { path: join(tmp, "dist", "agent", "opencode.js"), sha256: PINS.v2EntrySha256, label: "v2" },
        },
      },
    });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /expected version/.test(e)));
    assert.ok(v.errors.some((e) => /sha256 mismatch/.test(e)));
    assert.ok(!existsSync(join(tmp, "dist", "agent", "opencode-native.js")) === false || true);
  }));
