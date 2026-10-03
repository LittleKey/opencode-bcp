import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Explicit dependency paths for tests. All read-only inputs:
 * - billion-context 0.1.175 from the pinned package cache
 * - repaired legacy ACP entry + manifest from the local-plugins build
 * - opencode-vibeguard 0.1.0 source
 */
export const DEPS = {
  billionContextDir:
    process.env.BCP_BILLION_CONTEXT_DIR ??
    "/home/littlekey/.cache/opencode/packages/billion-context@0.1.175/node_modules/billion-context",
  repairedAcpEntry: "/home/littlekey/.config/opencode/local-plugins/dist/acp.js",
  repairedAcpManifest: "/home/littlekey/.config/opencode/local-plugins/dist/manifest.json",
  vibeguardDir: "/home/littlekey/.config/opencode/local-plugins/node_modules/opencode-vibeguard",
};

export const PINS = {
  billionContextVersion: "0.1.175",
  packageJsonSha256: "4752eed4ad6a365cd5c7347c87f43940f56543cd7542e77e3fe2b670e69a3bdb",
  serverEntrySha256: "4abf8455a7703230e977ebef51d02b2890ada71033c3694c6440f571bed0648b",
  v2EntrySha256: "877e48735b271db4c3d7079f29a9fcb37af96d68550125e427eb6b568db14023",
  legacyAcpSha256: "f397a374b6b5b1116a75583b30ba3fb34dfc7777d8fb67032cc3bf02a213be2b",
  legacyAcpUpstreamSourceSha256: "f8e0e936f5e2d21ce457ba16b50c1cb6306681c8613949619072cbddac1766e8",
};

export function makeTempDir(label = "community-test") {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

/** Run `fn` with a fresh temp dir; cleaned up afterwards. */
export async function withTempDir(fn, label) {
  const dir = makeTempDir(label);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Save/restore a process.env value around `fn`. */
export async function withEnv(name, value, fn) {
  const had = Object.hasOwn(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

/**
 * Create a fake explicit legacy-ACP slot: <dir>/opencode/packages/<spec>/
 * node_modules/opencode-acp/dist/index.js holding a copy of `sourceFile`.
 * Tests point XDG_CACHE_HOME at <dir>.
 */
export function makeLegacyAcpSlot(cacheRoot, spec, sourceFile) {
  const target = join(cacheRoot, "opencode", "packages", spec, "node_modules", "opencode-acp", "dist");
  mkdirSync(target, { recursive: true });
  const targetFile = join(target, "index.js");
  cpSync(sourceFile, targetFile);
  return targetFile;
}

/** Recursively collect all string leaves of a value. */
export function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") for (const key of Object.keys(value)) collectStrings(value[key], out);
  return out;
}

// Non-greedy, collision-suffix aware: adjacent placeholders must split into
// separate matches (the stock greedy `[A-Za-z0-9_]+_` form merges them, which
// is exactly the session.js bug the privacy patch repairs).
export const PLACEHOLDER_RE = /__[A-Za-z0-9_]*?VG_[A-Za-z0-9_]+?_[a-f0-9A-F]{12}(?:_\d+)?__/;
