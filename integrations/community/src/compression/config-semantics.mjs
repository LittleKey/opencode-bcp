/**
 * Configuration semantics translation: old ACP-style `compress` settings
 * (opencode-acp 1.18.x behavior) -> billion-context 0.1.175 compress settings.
 *
 * Semantics were extracted from the pinned published artifacts (read-only):
 *
 * OLD (opencode-acp 1.18.2, dist/index.js, sha256 f8e0e936…766e8):
 *   resolveContextTokenLimit(): a NUMBER is absolute tokens; a "NN%" string is
 *   resolved against the effective model context limit (rounded, clamped 0..100).
 *   Trigger: `currentTokens > maxContextLimit(+summaryBuffer)` /
 *   `currentTokens >= minContextLimit` — absolute token comparisons.
 *
 * NEW (billion-context 0.1.175, dist/index.js, sha256 4752eed4…/877e4873…):
 *   parseCompressSettings() accepts exactly:
 *     numberOrPercent: modelContextLimit, maxContextLimit, emergencyThresholdPercent
 *     finite numbers:  nudgeGrowthTokens, preserveRecentMessages,
 *                      preserveRecentTokens, minCompressRange,
 *                      minCompressRangeChars, stripImagesKeepRecent
 *     plus: outputHeadroomMaxPct, tiers, protectedTools, protectedLatestTools,
 *           neverPreserveRecentTools, preserveRecentTools, absorb, ccr,
 *           imageCompression, rules
 *   parsePercent(): a NUMBER is already a fraction of the context (0.8 = 80%);
 *   only a "NN%" string is divided by 100. There is no absolute-token meaning
 *   for maxContextLimit anymore.
 *   applyCompressSettings(): maxContextLimit -> nudge.maxContextLimitPct;
 *   emergencyThresholdPercent -> nudge.emergencyThresholdPct AND
 *   truncate.threshold; nudgeGrowthTokens>0 -> nudge.growthFloor = growthCap.
 *   validateConfig(): minContextLimitPct <= maxContextLimitPct <=
 *   emergencyThresholdPct (defaults 0.45 / 0.75 / 0.95).
 *
 * Therefore an OLD absolute-token maxContextLimit (e.g. 160000) forwarded
 * unchanged would become maxContextLimitPct = 160000 and silently disable
 * nudging. This module translates by behavior: absolute tokens become an
 * explicit percent of the model context limit, and settings with no faithful
 * new equivalent are DROPPED with a recorded reason instead of being mapped to
 * a different-meaning key.
 */

/** Keys the new parser accepts and forwards with unchanged meaning. */
export const PASS_THROUGH_KEYS = [
  "modelContextLimit",
  "emergencyThresholdPercent",
  "nudgeGrowthTokens",
  "preserveRecentMessages",
  "preserveRecentTokens",
  "minCompressRange",
  "minCompressRangeChars",
  "stripImagesKeepRecent",
  "outputHeadroomMaxPct",
  "tiers",
  "protectedTools",
  "protectedLatestTools",
  "neverPreserveRecentTools",
  "preserveRecentTools",
  "absorb",
  "ccr",
  "imageCompression",
  "rules",
];

/** Old-only keys with no faithful equivalent in 0.1.175. Never forward these. */
export const OLD_ONLY_KEYS = {
  minContextLimit:
    "old meaning is an absolute-token threshold; the new nudge.minContextLimitPct is a different concept (compression target fraction) and must not receive this value",
  summaryBuffer:
    "old meaning extends the max threshold by ACTIVE summary token usage (dynamic); no new equivalent",
  allowSubAgents:
    "old ACP subagent session scoping; new hosts handle derived sessions via session.created parentID identity registration",
  contextLimitFallback:
    "old fallback model-context limit used only when the model limit is unknown; forwarding as modelContextLimit would override the real limit (different behavior)",
  minNudgeContextPercent:
    "old nudge tuning key; not accepted by the 0.1.175 compress settings parser",
  permission:
    "old v1 tool-permission configuration; the v2 proxy manages tool permissions differently",
};

const PERCENT_STRING = /^\d+(\.\d+)?\s*%$/;

/** Mirrors kernel parsePercent: number stays a fraction; "NN%" -> fraction. */
export function parsePercentLike(value) {
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (s.endsWith("%")) return Number(s.slice(0, -1)) / 100;
  return Number(s);
}

function formatPercentString(fraction) {
  // Up to 4 fraction digits of the percentage, trailing zeros trimmed.
  const pct = fraction * 100;
  const fixed = pct.toFixed(4).replace(/\.?0+$/, "");
  return `${fixed}%`;
}

/**
 * Translate one old `maxContextLimit` value into new semantics.
 * - "NN%" string: same relative meaning in old and new; pass through.
 * - number > 1: OLD absolute tokens -> percent of `modelContextLimit`.
 * - number in (0, 1]: AMBIGUOUS under the two semantics — refuse with an error
 *   instead of silently reinterpreting (old = 0..1 tokens, new = fraction).
 * Returns { ok, value?, errors[], warnings[] }.
 */
export function translateMaxContextLimit(value, modelContextLimit) {
  const errors = [];
  const warnings = [];
  if (typeof value === "string") {
    if (!PERCENT_STRING.test(value.trim())) {
      errors.push(
        `maxContextLimit: unsupported value ${JSON.stringify(value)}; expected "NN%" or a positive absolute-token number`,
      );
      return { ok: false, errors, warnings };
    }
    const pct = Number(value.trim().replace(/\s|%$/g, ""));
    if (!(pct > 0) || pct > 100) {
      errors.push(`maxContextLimit: percent ${value.trim()} is out of (0, 100]`);
      return { ok: false, errors, warnings };
    }
    return { ok: true, value: formatPercentString(pct / 100), errors, warnings };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(
      `maxContextLimit: unsupported value ${JSON.stringify(value)}; expected "NN%" or a positive absolute-token number`,
    );
    return { ok: false, errors, warnings };
  }
  if (value <= 0) {
    errors.push(`maxContextLimit: ${value} must be > 0`);
    return { ok: false, errors, warnings };
  }
  if (value <= 1) {
    errors.push(
      `maxContextLimit: ${value} is ambiguous — old semantics treat numbers as absolute tokens (this would be ${value} token(s)), new semantics treat numbers as a context fraction (this would disable nudging). Give an explicit "NN%" string or an absolute-token number > 1.`,
    );
    return { ok: false, errors, warnings };
  }
  if (!(modelContextLimit > 0)) {
    errors.push(
      `maxContextLimit: absolute-token value ${value} requires a known model context limit to translate into a percent; pass modelContextLimit`,
    );
    return { ok: false, errors, warnings };
  }
  const fraction = value / modelContextLimit;
  if (fraction > 1) {
    errors.push(
      `maxContextLimit: ${value} tokens exceeds the model context limit ${modelContextLimit}`,
    );
    return { ok: false, errors, warnings };
  }
  if (fraction >= 0.95) {
    warnings.push(
      `maxContextLimit: translated threshold ${formatPercentString(fraction)} meets or exceeds the default emergency threshold (95%); nudging would only fire near overflow`,
    );
  }
  return { ok: true, value: formatPercentString(fraction), errors, warnings };
}

function clonePassThrough(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return { ...value };
  return value;
}

/**
 * Validate emitted settings against the kernel constraints that reachable
 * emitted keys can violate (subset of kernel validateConfig).
 * Returns { ok, errors[] }.
 */
export function validateEmitted(settings) {
  const errors = [];
  const max = parsePercentLike(settings.maxContextLimit ?? 0.75);
  if (!(max > 0) || max > 1) {
    errors.push(`emitted maxContextLimit ${JSON.stringify(settings.maxContextLimit)} must resolve to a fraction in (0, 1]`);
  }
  const emergency = parsePercentLike(settings.emergencyThresholdPercent ?? 0.95);
  if (!(emergency > 0) || emergency > 1) {
    errors.push(`emitted emergencyThresholdPercent ${JSON.stringify(settings.emergencyThresholdPercent)} must resolve to a fraction in (0, 1]`);
  }
  if (max > emergency) {
    errors.push(
      `emitted maxContextLimit (${formatPercentString(max)} of context) must not exceed emergencyThresholdPercent (${formatPercentString(emergency)})`,
    );
  }
  const mcl = settings.modelContextLimit;
  if (mcl !== undefined) {
    if (typeof mcl === "number") {
      if (!(mcl > 0)) errors.push(`emitted modelContextLimit ${mcl} must be > 0`);
    } else if (typeof mcl === "string") {
      if (!PERCENT_STRING.test(mcl.trim())) {
        errors.push(`emitted modelContextLimit ${JSON.stringify(mcl)} must be a positive number or "NN%"`);
      }
    } else {
      errors.push(`emitted modelContextLimit must be a number or "NN%"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Translate one old compress-settings object (no provider nesting).
 * `modelContextLimit` (optional): the known effective model context limit used
 * to translate absolute-token thresholds.
 * Returns { settings, dropped: [{key, reason}], errors[], warnings[] }.
 * Settings is only meaningful when errors is empty.
 */
export function translateCompressSettings(oldSettings, { modelContextLimit } = {}) {
  const settings = {};
  const dropped = [];
  const errors = [];
  const warnings = [];
  if (!oldSettings || typeof oldSettings !== "object" || Array.isArray(oldSettings)) {
    return { settings, dropped, errors: ["compress settings must be an object"], warnings };
  }
  for (const key of Object.keys(oldSettings)) {
    const value = oldSettings[key];
    if (key === "maxContextLimit") {
      const t = translateMaxContextLimit(value, modelContextLimit);
      errors.push(...t.errors);
      warnings.push(...t.warnings);
      if (t.ok) settings[key] = t.value;
      continue;
    }
    if (key in OLD_ONLY_KEYS) {
      dropped.push({ key, reason: OLD_ONLY_KEYS[key] });
      continue;
    }
    if (PASS_THROUGH_KEYS.includes(key)) {
      settings[key] = clonePassThrough(value);
      continue;
    }
    dropped.push({
      key,
      reason: "not accepted by the billion-context 0.1.175 compress settings parser; forwarding would be silently ignored",
    });
  }
  const v = validateEmitted(settings);
  errors.push(...v.errors);
  return { settings, dropped, errors, warnings };
}

function modelLimitForLevel(levels, hostModelContextLimit) {
  for (const level of levels) {
    const raw = level?.modelContextLimit;
    if (typeof raw === "number" && raw > 0) return raw;
  }
  return hostModelContextLimit;
}

/**
 * Translate an old config's compress block INCLUDING the old provider/model
 * override nesting: compress.providers[providerId]{...fields, models[modelId]}.
 * Old resolution: provider fields override global, model fields override
 * provider — same precedence the new system applies (model ?? provider ?? global),
 * so the nesting is preserved shape-for-shape with translated values.
 *
 * Returns { config, dropped, errors, warnings } where config = { compress }
 * suitable for merging into a new-style opencode.json.
 */
export function translateCompressConfig(oldConfig, { modelContextLimit } = {}) {
  const dropped = [];
  const errors = [];
  const warnings = [];
  const oldCompress = oldConfig?.compress;
  if (oldCompress === undefined) {
    return { config: { compress: undefined }, dropped, errors, warnings };
  }
  if (!oldCompress || typeof oldCompress !== "object" || Array.isArray(oldCompress)) {
    return {
      config: { compress: undefined },
      dropped,
      errors: ["compress must be an object"],
      warnings,
    };
  }
  const { providers, ...topSettings } = oldCompress;
  const top = translateCompressSettings(topSettings, { modelContextLimit });
  dropped.push(...top.dropped);
  errors.push(...top.errors);
  warnings.push(...top.warnings);

  const newProviders = {};
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    for (const providerId of Object.keys(providers)) {
      const entry = providers[providerId];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`compress.providers.${providerId} must be an object`);
        continue;
      }
      const { models, ...providerFields } = entry;
      const providerLimit = modelLimitForLevel([providerFields, topSettings], modelContextLimit);
      const providerTranslated = translateCompressSettings(providerFields, {
        modelContextLimit: providerLimit,
      });
      dropped.push(...providerTranslated.dropped.map((d) => ({ ...d, key: `compress.providers.${providerId}.${d.key}` })));
      errors.push(...providerTranslated.errors.map((e) => `compress.providers.${providerId}: ${e}`));
      warnings.push(...providerTranslated.warnings.map((w) => `compress.providers.${providerId}: ${w}`));
      const providerResult = { ...providerTranslated.settings };

      if (models !== undefined) {
        if (!models || typeof models !== "object" || Array.isArray(models)) {
          errors.push(`compress.providers.${providerId}.models must be an object`);
        } else {
          const newModels = {};
          for (const modelId of Object.keys(models)) {
            const modelFields = models[modelId];
            const modelLimit = modelLimitForLevel([modelFields, providerFields, topSettings], modelContextLimit);
            const modelTranslated = translateCompressSettings(modelFields, {
              modelContextLimit: modelLimit,
            });
            dropped.push(...modelTranslated.dropped.map((d) => ({ ...d, key: `compress.providers.${providerId}.models.${modelId}.${d.key}` })));
            errors.push(...modelTranslated.errors.map((e) => `compress.providers.${providerId}.models.${modelId}: ${e}`));
            warnings.push(...modelTranslated.warnings.map((w) => `compress.providers.${providerId}.models.${modelId}: ${w}`));
            newModels[modelId] = modelTranslated.settings;
          }
          providerResult.models = newModels;
        }
      }
      newProviders[providerId] = providerResult;
    }
  } else if (providers !== undefined) {
    errors.push("compress.providers must be an object");
  }

  const compress = { ...top.settings };
  if (Object.keys(newProviders).length > 0) compress.providers = newProviders;
  return { config: { compress }, dropped, errors, warnings };
}
