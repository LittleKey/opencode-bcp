/**
 * Dependency/resource closure helper for the OMO 3.0.1 packaging builder
 * (consumed only by build-omo.mjs).
 *
 * The patched 3.0.1 bundles still resolve a small, fixed set of runtime
 * dependencies through ordinary node resolution from their own file location:
 *   - `createRequire(import.meta.url).resolve("jsdom")` + dynamic import
 *     (src/utils/jsdom.ts, both entries): the webfetch runtime. A relocated
 *     artifact without a resolvable jsdom logs "jsdom probe failed; webfetch
 *     tool will not work" on a real isolated host.
 *   - `require("@ast-grep/cli/package.json")` and
 *     `require.resolve("<platform package>/package.json")` (src/utils/ast-grep.ts,
 *     both entries, try/catch-guarded): ast-grep binary discovery; without the
 *     packages the upstream fallback path leads to a network download.
 *   - static `from "jsonc-parser"` in the v2 (server) entry only; the v1 entry's
 *     jsonc/zod/plugin imports are vendored to ../vendor by build-omo.mjs.
 *   - js-yaml's optional `!!js/function` support: `_require("esprima")`
 *     (try/catch-guarded, inlined js-yaml).
 *
 * The builder ships these as a copied `node_modules` closure so ordinary node
 * resolution keeps working after relocation — exact pinned versions copied
 * verbatim from the pinned cache, no import rewriting, no new packages, and
 * the search is bounded so nothing outside the pinned cache can be resolved.
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';

// Closure roots per 3.0.1 entry, derived from the emitted callsites above.
// zod/@opencode-ai/plugin/jsonc-parser are NOT roots on `index` (vendored by
// build-omo.mjs); jsonc-parser is a root on `server` (still bare there).
// esprima is a try/catch-guarded optional root (see OPTIONAL_CLOSURE_ROOTS).
export const CLOSURE_ROOT_SPECIFIERS = {
  index: ['jsdom', '@ast-grep/cli', 'esprima'],
  server: ['jsonc-parser', 'jsdom', '@ast-grep/cli', 'esprima'],
};
// Roots whose absence upstream guards with try/catch (feature degrades instead
// of crashing). jsdom, @ast-grep/cli and jsonc-parser are required: their
// absence silently disables webfetch/search or breaks the v2 import outright.
export const OPTIONAL_CLOSURE_ROOTS = new Set(['esprima']);

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const toPosix = value => value.split(sep).join('/');
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Node's NODE_MODULES_PATHS candidate order for `fromDir`, bounded at
 * `stopAt` (the pinned cache's node_modules root): the search never looks
 * above the pinned cache, so nothing outside it can satisfy a closure
 * dependency.
 */
function candidateNodeModulesDirs(fromDir, stopAt) {
  const stop = resolve(stopAt);
  const dirs = [];
  let dir = resolve(fromDir);
  for (;;) {
    dirs.push(basename(dir) === 'node_modules' ? dir : join(dir, 'node_modules'));
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** Resolve one package name the way node would from `fromDir`, bounded by cacheRoot. */
export function resolveClosurePackage(fromDir, name, cacheRoot) {
  const segments = name.split('/');
  for (const nodeModules of candidateNodeModulesDirs(fromDir, cacheRoot)) {
    const pkgDir = join(nodeModules, ...segments);
    const manifestPath = join(pkgDir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== name) {
      throw new Error('closure dependency "' + name + '" resolved to a mismatched package "' + manifest.name + '" at ' + pkgDir);
    }
    return {dir: pkgDir, manifest};
  }
  return undefined;
}

/**
 * Copy every regular file of one package verbatim, computing content digests.
 * Any symlink inside the closure is rejected: links into a global store are
 * not portable, and silently dereferencing could leak unrelated content.
 */
function walkPackageFiles(pkgDir) {
  const files = [];
  const visit = dir => {
    const entries = readdirSync(dir, {withFileTypes: true}).sort((a, b) => byString(a.name, b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('symlink inside the dependency closure is not portable: ' + full + ' -> ' + realpathSync(full));
      }
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) throw new Error('unsupported directory entry in the dependency closure: ' + full);
      const bytes = readFileSync(full);
      files.push({path: toPosix(relative(pkgDir, full)), digest: sha256Hex(bytes), bytes: bytes.byteLength, copyFrom: full});
    }
  };
  visit(pkgDir);
  files.sort((a, b) => byString(a.path, b.path));
  return files;
}

/**
 * Compute the transitive dependency closure of `roots` inside the pinned
 * cache. Dependencies resolve at their real locations: a nested copy (e.g.
 * parse5 inside jsdom/node_modules) stays nested and ships inside the
 * parent's verbatim copy — distinct versions are never flattened.
 */
export function computeDependencyClosure({packageDir, roots, optionalRoots = OPTIONAL_CLOSURE_ROOTS}) {
  packageDir = resolve(packageDir);
  const cacheRoot = dirname(packageDir);
  if (basename(cacheRoot) !== 'node_modules') {
    throw new Error('the pinned OMO package must live directly inside a node_modules directory: ' + packageDir);
  }
  const cacheRealPath = realpathSync(cacheRoot);
  const packages = new Map();
  const missing = [];
  const requiredMissing = [];
  const queue = roots.map(name => ({name, fromDir: packageDir, kind: 'callsite-root'}));
  while (queue.length > 0) {
    const {name, fromDir, kind} = queue.shift();
    if (name === 'oh-my-opencode-slim') throw new Error('closure must not ship the OMO package itself');
    const found = resolveClosurePackage(fromDir, name, cacheRoot);
    if (!found) {
      missing.push({name, kind, requestedFrom: toPosix(relative(cacheRoot, fromDir)) || '.'});
      if (kind === 'callsite-root' || kind === 'dependency') {
        if (!optionalRoots.has(name)) requiredMissing.push(name);
      }
      continue;
    }
    if (packages.has(found.dir)) continue;
    const realDir = realpathSync(found.dir);
    if (realDir !== resolve(found.dir) && !realDir.startsWith(cacheRealPath + sep)) {
      throw new Error('closure dependency "' + name + '" escapes the pinned cache via symlink: ' + found.dir + ' -> ' + realDir);
    }
    const installPath = toPosix(relative(cacheRoot, found.dir));
    for (const existing of packages.values()) {
      if (existing.installPath === installPath) {
        throw new Error('closure path conflict: ' + installPath + ' would be produced by two different resolved locations');
      }
    }
    const files = walkPackageFiles(found.dir);
    // Top-level = a direct child of the cache root, possibly under one @scope
    // directory (dirname is NOT the cache root for scoped names). Anything
    // nested deeper (a '/node_modules/' marker) ships inside its parent copy.
    const topLevel = !installPath.includes('/node_modules/');
    const shippedVia = topLevel ? undefined : installPath.split('/node_modules/')[0];
    packages.set(found.dir, {
      name,
      version: found.manifest.version ?? null,
      engines: found.manifest.engines ?? null,
      installPath,
      topLevel,
      shippedVia,
      linked: realDir !== resolve(found.dir) ? realDir : undefined,
      dependencies: Object.keys(found.manifest.dependencies ?? {}).sort(byString),
      peerDependencies: Object.keys(found.manifest.peerDependencies ?? {}).sort(byString),
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
    });
    for (const dep of Object.keys(found.manifest.dependencies ?? {}).sort(byString)) {
      queue.push({name: dep, fromDir: found.dir, kind: 'dependency'});
    }
    for (const dep of Object.keys(found.manifest.optionalDependencies ?? {}).sort(byString)) {
      queue.push({name: dep, fromDir: found.dir, kind: 'optional-dependency'});
    }
  }
  const list = [...packages.values()].sort((a, b) => byString(a.installPath, b.installPath));
  missing.sort((a, b) => byString(a.name + '\u0000' + a.kind + '\u0000' + a.requestedFrom, b.name + '\u0000' + b.kind + '\u0000' + b.requestedFrom));
  return {cacheRoot, packages: list, missing, requiredMissing: [...new Set(requiredMissing)]};
}
