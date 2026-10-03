import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPS, PINS } from "./helper.mjs";
import { PASS_THROUGH_KEYS, OLD_ONLY_KEYS } from "../src/compression/config-semantics.mjs";

// Tripwire: src/compression/config-semantics.mjs was written against the
// VERIFIED semantics of billion-context 0.1.175's compiled compress-settings
// parser (dist/index.js). If the pinned package ever changes those bytes, this
// test fails and forces explicit re-verification of the translation semantics
// — silently trusting stale translations is exactly what it must prevent.

const indexJsPath = join(DEPS.billionContextDir, "dist", "index.js");
const pkgJsonPath = join(DEPS.billionContextDir, "package.json");

test("billion-context parser bytes still match the semantics config-semantics.mjs encodes", () => {
  let bytes;
  try {
    bytes = readFileSync(indexJsPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read pinned billion-context parser at ${indexJsPath}: ${err.message} — DEPS.billionContextDir must point at the verified 0.1.175 install`,
    );
  }

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  assert.equal(
    pkg.version,
    PINS.billionContextVersion,
    `pinned billion-context version drifted (found ${pkg.version}, expected ${PINS.billionContextVersion}) — re-verify config semantics before bumping`,
  );

  // parser entry points the translations mirror
  for (const fn of ["parsePercent", "parseCompressSettings", "resolveContextLimitValue", "mergeCompress", "validateConfig"]) {
    assert.ok(
      bytes.includes(`function ${fn}(`),
      `parser function ${fn} missing from dist/index.js — the compiled parser changed; re-verify src/compression/config-semantics.mjs against the new bytes`,
    );
  }

  // load-bearing semantic conversions:
  // - old "maxContextLimit" percent string lands on nudge.maxContextLimitPct
  assert.ok(
    bytes.includes("nudge.maxContextLimitPct=parsePercent(s3.maxContextLimit)"),
    "maxContextLimit->maxContextLimitPct conversion anchor missing — translateMaxContextLimit semantics must be re-verified",
  );
  // - emergencyThresholdPercent feeds BOTH nudge.emergencyThresholdPct and truncate.threshold
  assert.ok(
    bytes.includes("emergencyThresholdPct=pct2;truncate.threshold=pct2"),
    "emergencyThresholdPercent dual-target anchor missing — validateEmitted/translation semantics must be re-verified",
  );

  // every forwarded key must still be known to the compiled parser
  for (const key of PASS_THROUGH_KEYS) {
    assert.ok(
      bytes.includes(key),
      `PASS_THROUGH key "${key}" no longer appears in dist/index.js — the parser dropped or renamed it; re-verify before forwarding`,
    );
  }
  // every refused old-only key must stay unread as a settings property by the
  // compiled parser (detection: property access like `.minContextLimit` not
  // followed by more identifier chars, so `minContextLimitPct` does not false-
  // positive). Generic names that legitimately occur elsewhere in the bundle
  // (e.g. "permission") cannot be checked this way and are skipped — their
  // refusal is covered by the translation tests instead.
  const absenceCheckable = Object.keys(OLD_ONLY_KEYS).filter((key) => key !== "permission");
  for (const key of absenceCheckable) {
    assert.ok(
      !new RegExp(`\\.${key}(?![A-Za-z0-9_])`).test(bytes),
      `OLD_ONLY key "${key}" is read as a settings property in dist/index.js — the parser may have grown an equivalent; re-verify the refusal rationale in OLD_ONLY_KEYS`,
    );
  }

  // 0.1.175-only parser surface the compatibility layer documents
  for (const key of ["stripImages", "visibilityMarkers", "injectTool", "injectNudge", "acknowledgePromptsRisk", "outputHeadroomMaxPct"]) {
    assert.ok(
      bytes.includes(key),
      `new-only settings key "${key}" missing from dist/index.js — parser surface changed; update the key-set documentation in config-semantics.mjs`,
    );
  }
});
