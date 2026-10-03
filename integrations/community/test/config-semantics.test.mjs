import test from "node:test";
import assert from "node:assert/strict";
import {
  OLD_ONLY_KEYS,
  PASS_THROUGH_KEYS,
  parsePercentLike,
  translateCompressConfig,
  translateCompressSettings,
  translateMaxContextLimit,
  validateEmitted,
} from "../src/compression/config-semantics.mjs";

const LIMIT = 200000;

test("parsePercentLike mirrors kernel semantics", () => {
  assert.equal(parsePercentLike(0.8), 0.8); // number stays a fraction
  assert.equal(parsePercentLike("80%"), 0.8); // percent string divided by 100
  assert.equal(parsePercentLike("0.8"), 0.8);
});

test("absolute-token maxContextLimit translates to an explicit percent string", () => {
  const t = translateMaxContextLimit(160000, LIMIT);
  assert.ok(t.ok, JSON.stringify(t));
  assert.equal(t.value, "80%");
});

test("absolute-token translation is exact for non-round values", () => {
  const t = translateMaxContextLimit(123456, LIMIT);
  assert.ok(t.ok);
  assert.equal(t.value, "61.728%");
});

test("pct-string maxContextLimit passes through (same relative meaning old and new)", () => {
  const t = translateMaxContextLimit("80%", LIMIT);
  assert.ok(t.ok);
  assert.equal(t.value, "80%");
});

test("numbers in (0,1] are refused as ambiguous, never silently reinterpreted", () => {
  const t = translateMaxContextLimit(0.8, LIMIT);
  assert.equal(t.ok, false);
  assert.match(t.errors[0], /ambiguous/);
});

test("absolute translation requires a known model context limit", () => {
  const t = translateMaxContextLimit(160000, undefined);
  assert.equal(t.ok, false);
  assert.match(t.errors[0], /model context limit/);
});

test("absolute values above the model limit are refused", () => {
  const t = translateMaxContextLimit(250000, LIMIT);
  assert.equal(t.ok, false);
  assert.match(t.errors[0], /exceeds the model context limit/);
});

test("unsupported string forms are refused", () => {
  assert.equal(translateMaxContextLimit("banana", LIMIT).ok, false);
  assert.equal(translateMaxContextLimit("120%", LIMIT).ok, false);
});

test("near-emergency translations produce a warning", () => {
  const t = translateMaxContextLimit(196000, LIMIT); // 98%
  assert.ok(t.ok);
  assert.ok(t.warnings.some((w) => /emergency/.test(w)));
});

test("old-only keys are dropped with recorded reasons", () => {
  const t = translateCompressSettings(
    {
      minContextLimit: 80000,
      summaryBuffer: 1000,
      allowSubAgents: true,
      contextLimitFallback: 128000,
      minNudgeContextPercent: 0.3,
      permission: { compress: "allow" },
    },
    { modelContextLimit: LIMIT },
  );
  assert.deepEqual(
    t.dropped.map((d) => d.key).sort(),
    ["allowSubAgents", "contextLimitFallback", "minContextLimit", "minNudgeContextPercent", "permission", "summaryBuffer"].sort(),
  );
  for (const d of t.dropped) assert.ok(d.reason.length > 20, `reason for ${d.key}`);
  // none of them leaked into settings
  assert.deepEqual(t.settings, {});
});

test("minContextLimit is never mapped to a percentage key", () => {
  const t = translateCompressSettings({ minContextLimit: 90000 }, { modelContextLimit: LIMIT });
  assert.equal(t.settings.minContextLimitPct, undefined);
  assert.equal(t.settings.maxContextLimitPct, undefined);
  assert.ok("minContextLimit" in Object.fromEntries(t.dropped.map((d) => [d.key, d])));
});

test("pass-through keys are forwarded with unchanged meaning", () => {
  const settings = {
    modelContextLimit: 200000,
    emergencyThresholdPercent: "90%",
    nudgeGrowthTokens: 60000,
    preserveRecentMessages: 5,
    preserveRecentTokens: 5000,
    minCompressRange: 5000,
    minCompressRangeChars: 4800,
    stripImagesKeepRecent: 3,
    outputHeadroomMaxPct: 0.5,
    tiers: true,
    protectedTools: ["edit"],
    protectedLatestTools: ["bash"],
    neverPreserveRecentTools: [],
    preserveRecentTools: ["read"],
    absorb: { enabled: false },
    ccr: { enabled: false },
    imageCompression: { enabled: false },
    rules: true,
  };
  const t = translateCompressSettings(settings, { modelContextLimit: LIMIT });
  assert.deepEqual(t.errors, []);
  assert.deepEqual(t.dropped, []);
  for (const key of PASS_THROUGH_KEYS) {
    assert.deepEqual(t.settings[key], settings[key], key);
  }
});

test("nested pass-through objects are cloned, not aliased", () => {
  const absorb = { enabled: true };
  const t = translateCompressSettings({ absorb }, { modelContextLimit: LIMIT });
  t.settings.absorb.enabled = false;
  assert.equal(absorb.enabled, true);
});

test("unknown keys are dropped, not forwarded", () => {
  const t = translateCompressSettings({ someFutureKey: 1 }, { modelContextLimit: LIMIT });
  assert.equal(t.settings.someFutureKey, undefined);
  assert.equal(t.dropped[0].key, "someFutureKey");
  assert.match(t.dropped[0].reason, /not accepted/);
});

test("emitted max can never exceed emergency threshold", () => {
  const t = translateCompressSettings(
    { maxContextLimit: "97%", emergencyThresholdPercent: "95%" },
    { modelContextLimit: LIMIT },
  );
  assert.equal(t.ok === undefined ? true : t.errors.length > 0, true);
  assert.ok(t.errors.some((e) => /must not exceed emergencyThresholdPercent/.test(e)));
});

test("validateEmitted flags out-of-range fractions", () => {
  assert.ok(validateEmitted({ maxContextLimit: "150%" }).errors.length > 0);
  assert.ok(validateEmitted({ emergencyThresholdPercent: 1.5 }).errors.length > 0);
  assert.ok(validateEmitted({}).ok);
});

test("translateCompressConfig walks provider/model nesting with per-level limits", () => {
  const oldConfig = {
    compress: {
      maxContextLimit: 100000, // of 200000 -> 50%
      contextLimitFallback: 128000,
      providers: {
        anthropic: {
          maxContextLimit: 160000,
          models: {
            "claude-x": { maxContextLimit: 180000, minContextLimit: 50000 },
          },
        },
      },
    },
  };
  const t = translateCompressConfig(oldConfig, { modelContextLimit: LIMIT });
  assert.deepEqual(t.errors, []);
  assert.equal(t.config.compress.maxContextLimit, "50%");
  assert.equal(t.config.compress.providers.anthropic.maxContextLimit, "80%");
  assert.equal(t.config.compress.providers.anthropic.models["claude-x"].maxContextLimit, "90%");
  // provider-level nested override defines its own modelContextLimit? none set ->
  // falls back to host limit; minContextLimit dropped with scoped key
  assert.ok(
    t.dropped.some((d) => d.key === "compress.providers.anthropic.models.claude-x.minContextLimit"),
  );
  assert.ok(t.dropped.some((d) => d.key === "contextLimitFallback"));
});

test("nested absolute override without any resolvable limit errors instead of guessing", () => {
  const t = translateCompressConfig(
    {
      compress: {
        providers: { openai: { maxContextLimit: 160000 } },
      },
    },
    { modelContextLimit: undefined },
  );
  assert.ok(t.errors.some((e) => /model context limit/.test(e)));
});

test("every old-only key is documented", () => {
  for (const [key, reason] of Object.entries(OLD_ONLY_KEYS)) {
    assert.ok(reason.length > 20, key);
  }
});
