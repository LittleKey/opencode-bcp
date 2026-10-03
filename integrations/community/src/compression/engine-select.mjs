/**
 * Explicit legacy-ACP selection planning and dependency verification.
 *
 * The v1 host (and billion-context's v1 native entry) discovers a legacy ACP by
 * probing candidate locations, FIRST match wins, silently:
 *   1. $BILI_OPENCODE_ACP_SPEC -> <cacheHome>/opencode/packages/<spec>/node_modules/opencode-acp/dist/index.js
 *      (unshifted to the front — but ONLY when the path exists; otherwise the
 *      probe silently continues down the list)
 *   2. <cwd>/.opencode/node_modules/opencode-acp/dist/index.js
 *   3. <cwd>/node_modules/opencode-acp/dist/index.js
 *   4. <cacheHome>/opencode/packages/opencode-acp@<version>/... (newest first)
 *   5. ~/.local/lib/node_modules/opencode-acp/dist/index.js
 *   6. <configHome>/opencode/node_modules/opencode-acp/dist/index.js
 *
 * Unrepaired stock opencode-acp exists on this machine at the config-home
 * location, so an unset or broken explicit selection would silently arm the
 * stock engine. This module therefore implements selection as EXPLICIT-ONLY:
 * without a valid spec pointing at the repaired bytes, the wrapper refuses to
 * arm (status "blocked") instead of falling back.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256File } from "../lib/hash.mjs";

export const LEGACY_ACP_SPEC_ENV = "BILI_OPENCODE_ACP_SPEC";
export const LEGACY_ACP_RELATIVE_PATH = join("opencode-acp", "dist", "index.js");

function cacheHomeOf(env) {
  return env?.XDG_CACHE_HOME || join(homedir(), ".cache");
}

/**
 * Mirror of the candidate list the host / billion-context probe (pure given
 * inputs; no I/O). Used for auditing and documentation.
 */
export function legacyAcpCandidates({ cwd, env = process.env, configHome } = {}) {
  const out = [];
  const pushDir = (dir) => out.push(join(dir, LEGACY_ACP_RELATIVE_PATH));
  if (cwd) {
    pushDir(join(cwd, ".opencode", "node_modules"));
    pushDir(join(cwd, "node_modules"));
  }
  const packages = join(cacheHomeOf(env), "opencode", "packages");
  const spec = env?.[LEGACY_ACP_SPEC_ENV];
  if (spec && spec.length > 0) {
    out.unshift(join(packages, spec, "node_modules", LEGACY_ACP_RELATIVE_PATH));
  }
  try {
    // Mirror of the host probe: readdir <cacheHome>/opencode/packages, keep
    // opencode-acp@* directory names, newest first (reverse sort). Reported so
    // the audit can warn about stock bytes inside probe range; selection still
    // requires the explicit spec.
    const installed = readdirSync(packages)
      .filter((name) => name.startsWith("opencode-acp@"))
      .sort()
      .reverse();
    for (const name of installed) {
      out.push(join(packages, name, "node_modules", LEGACY_ACP_RELATIVE_PATH));
    }
    if (installed.length === 0) {
      // documentation-only placeholder when the cache has no opencode-acp yet
      out.push(join(packages, "opencode-acp@<version>", "node_modules", LEGACY_ACP_RELATIVE_PATH));
    }
  } catch {
    // packages directory unreadable/absent — keep the documented placeholder
    out.push(join(packages, "opencode-acp@<version>", "node_modules", LEGACY_ACP_RELATIVE_PATH));
  }
  pushDir(join(homedir(), ".local", "lib", "node_modules"));
  pushDir(join(configHome || env?.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "node_modules"));
  return out;
}

/**
 * Plan the legacy-ACP selection for a v1 host.
 * Returns one of:
 *   { status: "ok", path }               — explicit spec present, file exists
 *                                          and hash-matches the repaired build.
 *   { status: "blocked", reason, path? } — explicit selection missing, broken,
 *                                          or not the repaired bytes. The
 *                                          caller must NOT arm; falling back
 *                                          to probe order would risk the
 *                                          stock engine.
 * `fsImpl` and `hashImpl` are injectable for tests.
 */
export async function planLegacySelection({
  env = process.env,
  repairedSha256,
  fsImpl = { existsSync },
  hashImpl = sha256File,
} = {}) {
  const spec = env?.[LEGACY_ACP_SPEC_ENV];
  if (!spec || spec.length === 0) {
    return {
      status: "blocked",
      reason:
        `${LEGACY_ACP_SPEC_ENV} is not set; legacy v1 ACP sessions require explicit selection of the repaired entry. ` +
        `Stock-candidate discovery is intentionally disabled (this machine has an unrepaired opencode-acp in probe range). ` +
        `Set ${LEGACY_ACP_SPEC_ENV}=<name> where <cacheHome>/opencode/packages/<name>/node_modules/${LEGACY_ACP_RELATIVE_PATH} holds the repaired bytes (see the emitted legacy-acp/ directory in the build bundle).`,
    };
  }
  const hinted = join(cacheHomeOf(env), "opencode", "packages", spec, "node_modules", LEGACY_ACP_RELATIVE_PATH);
  if (!fsImpl.existsSync(hinted)) {
    return {
      status: "blocked",
      path: hinted,
      reason:
        `${LEGACY_ACP_SPEC_ENV}=${spec} points at ${hinted} which does not exist; refusing to fall back to stock legacy candidates.`,
    };
  }
  if (repairedSha256) {
    const actual = await hashImpl(hinted);
    if (actual !== repairedSha256) {
      return {
        status: "blocked",
        path: hinted,
        reason: `legacy ACP slot content mismatch at ${hinted}: expected the repaired build (${repairedSha256}), found ${actual}. Refusing to arm a non-repaired engine.`,
      };
    }
  }
  return { status: "ok", path: hinted };
}

/**
 * List stock candidate locations that currently exist on disk (packaging
 * warning aid). Never used for selection.
 */
export function auditStockCandidates({ cwd, env = process.env, configHome, fsImpl = { existsSync } } = {}) {
  const existing = [];
  for (const candidate of legacyAcpCandidates({ cwd, env, configHome })) {
    if (candidate.includes("<version>")) continue;
    try {
      if (fsImpl.existsSync(candidate)) existing.push(candidate);
    } catch {
      // ignore unreadable entries
    }
  }
  return existing;
}

/**
 * Verify a billion-context checkout against pinned expectations BEFORE any
 * import happens. `expected` = { version, packageJsonSha256?, entries: { server?, v2? } }
 * where each entry = { path, sha256, label }.
 * Returns { ok, errors[] }.
 */
export async function verifyBillionContextPackage({ packageDir, expected, fsImpl = { existsSync } }) {
  const errors = [];
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const pkgPath = join(packageDir, "package.json");
  try {
    if (!fsImpl.existsSync(pkgPath)) throw new Error("package.json not found");
    const pkg = readJson(pkgPath);
    if (pkg.name !== "billion-context") {
      errors.push(`${pkgPath}: expected package name "billion-context", found ${JSON.stringify(pkg.name)}`);
    }
    if (expected.version && pkg.version !== expected.version) {
      errors.push(`${pkgPath}: expected version ${expected.version}, found ${pkg.version}`);
    }
  } catch (err) {
    errors.push(`${pkgPath}: unreadable (${err?.message ?? err})`);
    return { ok: false, errors };
  }
  for (const entry of [expected.entries?.server, expected.entries?.v2]) {
    if (!entry) continue;
    if (!fsImpl.existsSync(entry.path)) {
      errors.push(`${entry.label ?? entry.path}: file not found`);
      continue;
    }
    const actual = await sha256File(entry.path);
    if (actual !== entry.sha256) {
      errors.push(
        `${entry.label ?? entry.path}: sha256 mismatch for ${entry.path} (expected ${entry.sha256}, got ${actual}) — refusing to import an unpinned artifact`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
