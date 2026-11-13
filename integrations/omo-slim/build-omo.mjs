/**
 * Callable builder/patcher for the OMO integration. Takes explicit package,
 * source and output locations — nothing is installed globally and no shared
 * state outside the caller-provided paths is touched.
 *
 * Layout produced under `outputDir` (mirrors the plugin package so a deploy is
 * a plain copy):
 *   outputDir/omo-delivery.mjs            copied helper (byte-identical source)
 *   outputDir/omo-council.mjs             copied helper, 2.2.25 rollback build only
 *                                         (3.0.1 keeps upstream Council byte-identical)
 *   outputDir/dist/index.js               patched v1 entry      (entry: "index")
 *   outputDir/dist/server/index.js        patched v2 entry      (entry: "server")
 *   outputDir/dist/**                     3.0.7: entry + its reachable chunks
 *                                         only (pinned per-module graph), other
 *                                         versions: the single patched entry
 *   outputDir/vendor/**                   vendored runtime closure of the v1
 *                                         entry's external imports (index only;
 *                                         see VENDOR_TARGETS_3_0_1_INDEX)
 *   outputDir/node_modules/**             copied dependency closure of the
 *                                         lazily-resolved runtime dependencies
 *                                         (3.0.1 and 3.0.7; see omo-closure.mjs,
 *                                         3.0.7 root tables there; jsdom and
 *                                         @ast-grep/cli required on 3.0.7)
 *   outputDir/package.json + declared     pinned package metadata, skills,
 *                                         resources (3.0.1 and 3.0.7; skills,
 *                                         schema, READMEs, LICENSE)
 *   outputDir/manifest.json               deterministic build manifest
 *                                         (3.0.7 additionally records each
 *                                         module's input/output digest and the
 *                                         per-module patch records)
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire, isBuiltin} from 'node:module';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {OMO_307_MODULES, OMO_TARGETS, describeOmoPatches, patchOmo, patchOmo307} from './omo-patch.mjs';
import {CLOSURE_ROOT_SPECIFIERS, CLOSURE_ROOT_SPECIFIERS_3_0_7, OPTIONAL_CLOSURE_ROOTS, computeDependencyClosure} from './omo-closure.mjs';

export {CLOSURE_ROOT_SPECIFIERS, CLOSURE_ROOT_SPECIFIERS_3_0_7, OMO_TARGETS, OPTIONAL_CLOSURE_ROOTS, computeDependencyClosure, describeOmoPatches};

// Helper files copied per version. 3.0.1 ships only the generic delivery helper:
// upstream Council stays byte-identical, so no council import is prepended and no
// council helper is deployed. The 2.2.25 rollback build reproduces the deployed
// integration and therefore still copies both helpers.
export const OMO_HELPER_FILES = {
  '2.2.25': ['omo-delivery.mjs', 'omo-council.mjs'],
  '3.0.1': ['omo-delivery.mjs'],
  '3.0.3': ['omo-delivery.mjs'],
  '3.0.4': ['omo-delivery.mjs'],
  '3.0.5': ['omo-delivery.mjs'],
  '3.0.6': ['omo-delivery.mjs'],
  '3.0.7': ['omo-delivery.mjs'],
};
export const omoHelperFiles = version => {
  const files = OMO_HELPER_FILES[version];
  if (!files) throw new Error('Unknown OMO version: ' + version);
  return files;
};

export function omoEntryRelativePath(entry) {
  if (entry === 'index') return join('dist', 'index.js');
  if (entry === 'server') return join('dist', 'server', 'index.js');
  throw new Error('Unknown OMO entry: ' + entry + ' (expected "index" or "server")');
}

/** Resolve the exact zod copy owned by the OMO package (never the host SDK's hoisted zod). */
export function omoZodFileURL(packageDir) {
  const requireFromPackage = createRequire(join(resolve(packageDir), 'package.json'));
  return pathToFileURL(requireFromPackage.resolve('zod')).href;
}

// ---------------------------------------------------------------------------
// Vendored externals for the 3.0.1 v1 entry (`index`).
//
// The upstream v1 bundle imports @opencode-ai/plugin, zod and jsonc-parser as
// bare module specifiers. A real v1 host that lacks these in its own
// node_modules fails to load the plugin outright (observed on opencode
// 1.18.33: "Cannot find module '@opencode-ai/plugin'"), and pinning them to
// absolute file:// URLs inside the builder's global package cache (the
// previous zod strategy) makes the artifact host-location-dependent. For
// 3.0.1 the builder therefore copies the exact runtime import closure of each
// external into `outputDir/vendor/**` and rewrites the bundle (and the vendored
// files' own bare imports) to relative specifiers, so the artifact is
// independently loadable from any cwd/HOME with no extra node_modules.
//
// Entry points match what a host actually resolves: ESM "import" conditions
// for @opencode-ai/plugin (dist/index.js) and zod (index.js, the ESM dual
// build — named ESM imports do not reliably cross into the CJS build).
// jsonc-parser vendors the ESM build (lib/esm/main.js) instead of the package
// main (UMD, no exports map): node ESM cannot take named imports from a UMD
// module (cjs-module-lexer cannot see UMD exports; real relocated load failure:
// "does not provide an export named 'applyEdits'"). The ESM build's own
// extensionless relative imports ("./impl/format") are normalized to explicit
// .js files during vendoring (appendEsmRelativeExtensions) because node ESM
// performs no extension resolution.
// The 2.2.25 rollback build and the self-contained v2 (server) entry are NOT
// vendored: 2.2.25 must reproduce the deployed integration byte-for-byte (its
// deployed location carries node_modules), and the server bundle already
// bundles its dependencies.
// ---------------------------------------------------------------------------
export const VENDOR_TARGETS_3_0_1_INDEX = [
  {name: '@opencode-ai/plugin', entryPath: 'dist/index.js', kind: 'esm'},
  {name: 'jsonc-parser', entryPath: 'lib/esm/main.js', kind: 'esm'},
  {name: 'zod', entryPath: 'index.js', kind: 'esm'},
];

function resolveVendorPackageRoot(packageDir, name) {
  // The pinned OMO package always lives inside a node_modules directory; its
  // dependencies resolve as siblings. (Some packages do not export
  // './package.json', so require.resolve cannot be used for all of them.)
  const segments = name.split('/');
  const parent = dirname(resolve(packageDir));
  const nodeModules = parent.endsWith('node_modules') ? parent : join(parent, 'node_modules');
  const candidate = join(nodeModules, ...segments);
  const candidateManifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
  if (candidateManifest.name !== name) {
    throw new Error('vendored dependency ' + name + ' resolved to a mismatched package: ' + candidate);
  }
  return candidate;
}

const ESM_RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
const CJS_RELATIVE_REQUIRE = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
// Guard against matching `from`/`import`/`require` inside quoted strings or as
// identifier suffixes (e.g. `case "import":`, `importFile(`).
const BARE_GUARD = '(?<!["\'\\w.$])';
const ANY_MODULE_SPECIFIER = new RegExp(
  BARE_GUARD + '(?:from|import)\\s*\\(?\\s*["\']([^"\']+)["\']|' + BARE_GUARD + 'require\\(\\s*["\']([^"\']+)["\']\\s*\\)',
  'g'
);

const toPosix = value => value.split('\\').join('/');

/**
 * Remove line comments and block comments while respecting string/template
 * literals, so that documentation prose mentioning module names (e.g. zod's
 * comment text `import "zod/compile"`) is not mistaken for an import site.
 */
function stripJsComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function resolutionCandidates(target, kind) {
  if (kind === 'esm') return [target, target + '.js', join(target, 'index.js')];
  return [target, target + '.js', target + '.cjs', target + '.json', join(target, 'index.js'), join(target, 'index.cjs')];
}

// Relative ESM import sites with any quote style ("from './x'" / 'import("./x")'),
// guarded so identifier suffixes and quoted prose do not match.
const ESM_RELATIVE_SITE = new RegExp(
  BARE_GUARD + '(?:from|import)\\s*\\(?\\s*([\'"])(\\.[^\'"]+)\\1',
  'g'
);

/**
 * Normalize extensionless relative ESM import sites in one vendored file to
 * explicit file specifiers ("./impl/format" → "./impl/format.js"): node ESM
 * performs no extension resolution. A site is rewritten only when the target
 * file is itself part of the vendored closure (<specifier>.js, or
 * <specifier>/index.js), so documentation prose and dynamic strings survive.
 * Returns the normalized content plus per-occurrence rewrite records.
 */
function appendEsmRelativeExtensions(content, fileRelPath, closureRelPaths) {
  const relDir = dirname(fileRelPath);
  const rewritten = [];
  const replaced = content.replace(ESM_RELATIVE_SITE, (site, quote, specifier) => {
    if (specifier.includes('${')) return site;
    if (/\.(m|c)?js$/.test(specifier) || specifier.endsWith('.json')) return site;
    const base = toPosix(join(relDir, specifier));
    if (closureRelPaths.has(base + '.js')) {
      rewritten.push({from: specifier, to: specifier + '.js'});
      return site.slice(0, -1) + '.js' + quote;
    }
    const indexBase = toPosix(join(base, 'index.js'));
    if (closureRelPaths.has(indexBase)) {
      rewritten.push({from: specifier, to: specifier + '/index.js'});
      return site.slice(0, -1) + '/index.js' + quote;
    }
    return site;
  });
  return {content: replaced, rewritten};
}

/** Walk the runtime import/require closure of one vendored entry, following relative specifiers only. */
export function vendorFileClosure(startFile, kind) {
  const pattern = kind === 'esm' ? ESM_RELATIVE_IMPORT : CJS_RELATIVE_REQUIRE;
  const files = new Map();
  const bareSpecifiers = new Set();
  const stack = [resolve(startFile)];
  while (stack.length > 0) {
    const file = stack.pop();
    if (files.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    files.set(file, source);
    for (const match of source.matchAll(pattern)) {
      const target = resolve(dirname(file), match[1]);
      for (const candidate of resolutionCandidates(target, kind)) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          stack.push(candidate);
          break;
        }
      }
    }
    for (const match of stripJsComments(source).matchAll(ANY_MODULE_SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.includes('${')) continue;
      bareSpecifiers.add(specifier);
    }
  }
  return {files, bareSpecifiers};
}

/** Bare (non-relative, non-node:) module specifiers still present in a bundle's import/require sites. */
export function bareExternalSpecifiers(bundle) {
  const found = [];
  for (const match of stripJsComments(bundle).matchAll(ANY_MODULE_SPECIFIER)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.includes('${')) continue;
    found.push(specifier);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Runtime dependency closure (3.0.1).
//
// The patched bundles keep a few lazily-resolved runtime dependencies outside
// their code (see omo-closure.mjs for the full callsite inventory: jsdom for
// webfetch, @ast-grep/cli for search, esprima via inlined js-yaml, and
// jsonc-parser on the v2 entry). These are NOT rewritten: the artifact ships a
// copied node_modules closure so ordinary node resolution keeps working from
// the artifact's own location, with the exact pinned versions. The bundle
// import forms found in the pinned bundles are covered by BUNDLE_MODULE_LOOKUP
// (static from/import, `requireN(...)` including bun-style aliases, aliased
// `_require(...)` inside inlined CJS, and `x.resolve("spec")` method calls;
// promise resolvers like `resolve3("timeout")` do not match). —
// validateBundleSpecifiers is the fail-closed counterpart: after vendoring,
// every bare module lookup left in a bundle must be explainable by the closure
// (closure roots, vendored names, or node builtins) — anything else fails the
// build here instead of surfacing as a broken feature on a real isolated host.
// ---------------------------------------------------------------------------
const BUNDLE_MODULE_LOOKUP = new RegExp(
  BARE_GUARD + '(?:from|import)\\s*\\(?\\s*["\']([^"\']+)["\']' +
  '|' +
  '\\.\\s*resolve\\s*\\(\\s*["\']([^"\']+)["\']' +
  '|' +
  BARE_GUARD + '_*\\w*require\\d*\\s*\\(\\s*["\']([^"\']+)["\']',
  'g'
);

export function validateBundleSpecifiers({bundle, allowedNames, context}) {
  const violations = [];
  for (const match of stripJsComments(bundle).matchAll(BUNDLE_MODULE_LOOKUP)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.includes('${') || isBuiltin(specifier)) continue;
    const root = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (allowedNames.has(root) && (specifier === root || specifier.startsWith(root + '/'))) continue;
    violations.push(specifier);
  }
  if (violations.length > 0) {
    throw new Error(context + ' unexpectedly resolves bare module(s) outside the packaging closure: ' + [...new Set(violations)].join(', '));
  }
}

/**
 * Declared package files (package.json "files" minus the upstream dist/,
 * which the builder replaces with its own patched entries) copied verbatim so
 * the relocated output behaves like the pinned package: findPackageJsonUp
 * requires a package.json named oh-my-opencode-slim above the bundle (bundled
 * skill registration and version detection walk up from it), the skill loader
 * reads src/skills/<name>/SKILL.md and the companion bootstrap reads
 * src/companion/companion-manifest.json. A declared-but-missing file is
 * upstream drift and fails the build instead of shipping a truncated package.
 */
function planPackageResources({packageDir, packageManifest}) {
  const records = [];
  const visit = (absolutePath, relativePath) => {
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      const entries = readdirSync(absolutePath).sort();
      if (entries.length === 0) throw new Error('declared package directory is empty: ' + toPosix(relativePath));
      for (const entry of entries) visit(join(absolutePath, entry), join(relativePath, entry));
      return;
    }
    if (!stat.isFile()) throw new Error('declared package file is neither file nor directory: ' + toPosix(relativePath));
    const bytes = readFileSync(absolutePath);
    records.push({path: toPosix(relativePath), copyFrom: absolutePath, digest: digestOf(bytes), bytes: bytes.byteLength});
  };
  const declared = ['package.json', ...(packageManifest.files ?? []).filter(entry => entry !== 'dist')];
  for (const entry of declared) {
    const absolutePath = join(packageDir, entry);
    if (!existsSync(absolutePath)) {
      throw new Error('declared package file missing from the pinned package: ' + entry);
    }
    visit(absolutePath, entry);
  }
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return records;
}

/**
 * Vendor the exact runtime import closure of each entry in `targets` into
 * `outputDir/vendor` and return the vendor manifest entries (with file
 * records) plus the lookup tables needed to rewrite importers to the vendored
 * copies. Vendored files whose own bare imports name another vendored package
 * (the plugin's `import { z } from "zod"`) are rewritten to the vendored copy
 * as well; any other bare import fails the build. The 3.0.1 v1 entry and the
 * 3.0.7 index entry share this closure strategy — the same three package
 * entry points (see VENDOR_TARGETS_3_0_1_INDEX), newer pinned versions.
 */
function buildVendorClosures({packageDir, outputDir, targets}) {
  const vendorRoot = join(outputDir, 'vendor');
  const plans = targets.map(target => ({
    ...target,
    packageRoot: resolveVendorPackageRoot(packageDir, target.name),
  }));
  const planByName = new Map(plans.map(plan => [plan.name, plan]));
  const nameSet = new Set(planByName.keys());
  const closures = new Map();
  for (const plan of plans) {
    const startFile = join(plan.packageRoot, plan.entryPath);
    if (!existsSync(startFile)) throw new Error('vendored entry missing: ' + startFile);
    const closure = vendorFileClosure(startFile, plan.kind);
    for (const specifier of closure.bareSpecifiers) {
      if (!nameSet.has(specifier)) {
        throw new Error('vendored dependency ' + plan.name + ' unexpectedly imports bare module "' + specifier + '"');
      }
    }
    closures.set(plan.name, closure);
  }
  const vendor = [];
  for (const plan of plans) {
    const {files, bareSpecifiers} = closures.get(plan.name);
    const vendoredFiles = [];
    const rewrites = [];
    const relativePaths = [...files.keys()].map(file => relative(plan.packageRoot, file)).sort();
    const closureRelPaths = new Set(relativePaths);
    for (const rel of relativePaths) {
      const sourcePath = join(plan.packageRoot, rel);
      const outPath = join(vendorRoot, plan.name, rel);
      let content = files.get(sourcePath);
      if (plan.kind === 'esm') {
        // extensionless relative ESM imports cannot load under node — normalize
        // them to the explicit closure file before any other rewrite
        const normalized = appendEsmRelativeExtensions(content, rel, closureRelPaths);
        content = normalized.content;
        const occurrences = new Map();
        for (const entry of normalized.rewritten) {
          const key = entry.from + '\u0000' + entry.to;
          const existing = occurrences.get(key);
          if (existing) existing.occurrences += 1;
          else occurrences.set(key, {...entry, occurrences: 1});
        }
        for (const entry of occurrences.values()) {
          rewrites.push({file: toPosix(join('vendor', plan.name, rel)), from: entry.from, to: entry.to, occurrences: entry.occurrences});
        }
      }
      for (const specifier of bareSpecifiers) {
        const targetPlan = planByName.get(specifier);
        if (!targetPlan) continue;
        const targetSpecifier = posixRelative(dirname(outPath), join(vendorRoot, targetPlan.name, targetPlan.entryPath));
        let occurrences = 0;
        for (const pattern of ['from "' + specifier + '"', 'import("' + specifier + '")', 'require("' + specifier + '")']) {
          const count = content.split(pattern).length - 1;
          if (count === 0) continue;
          content = content.replaceAll(pattern, pattern.slice(0, pattern.indexOf('"') + 1) + targetSpecifier + '"');
          occurrences += count;
        }
        if (occurrences > 0) {
          rewrites.push({file: toPosix(join('vendor', plan.name, rel)), from: specifier, to: targetSpecifier, occurrences});
        }
      }
      vendoredFiles.push({path: join(outputDir, 'vendor', plan.name, rel), content, digest: digestOf(content)});
    }
    // closure completeness of the vendored files themselves
    for (const file of vendoredFiles) {
      for (const match of stripJsComments(file.content).matchAll(ANY_MODULE_SPECIFIER)) {
        const specifier = match[1] ?? match[2];
        if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.includes('${')) continue;
        throw new Error('vendored file still carries bare import after rewrite: ' + specifier);
      }
    }
    if (plan.kind === 'esm') {
      // extension normalization must be idempotent: no closure file may keep an
      // extensionless relative import that the rewrite was supposed to fix
      for (const file of vendoredFiles) {
        const rel = relative(join(vendorRoot, plan.name), file.path);
        const residual = appendEsmRelativeExtensions(file.content, rel, closureRelPaths).rewritten;
        if (residual.length > 0) {
          throw new Error('vendored ESM file still carries an extensionless relative import after normalization: ' + toPosix(join('vendor', plan.name, rel)) + ' (' + residual[0].from + ')');
        }
      }
    }
    vendor.push({
      name: plan.name,
      kind: plan.kind,
      entry: toPosix(join('vendor', plan.name, plan.entryPath)),
      resolvedFrom: plan.packageRoot,
      files: vendoredFiles.map(file => ({path: toPosix(relative(outputDir, file.path)), digest: file.digest})),
      fileRecords: vendoredFiles,
      rewrites,
    });
  }
  return {vendor, planByName, vendorRoot};
}

/**
 * Vendor the 3.0.1 v1 entry's external imports into `outputDir/vendor` and
 * rewrite the bundle to relative specifiers. Returns the vendor manifest
 * entries and the rewritten bundle.
 */
function vendor3_0_1_IndexExternals({bundle, packageDir, outputDir}) {
  const {vendor, planByName, vendorRoot} = buildVendorClosures({packageDir, outputDir, targets: VENDOR_TARGETS_3_0_1_INDEX});
  // rewrite the bundle's own bare imports to the vendored copies
  const bundleDir = dirname(join(outputDir, omoEntryRelativePath('index')));
  const rewriteTo = name => posixRelative(bundleDir, join(vendorRoot, name, planByName.get(name).entryPath));
  const externalStats = [];
  for (const name of ['@opencode-ai/plugin', 'jsonc-parser', 'zod']) {
    const target = rewriteTo(name);
    const patterns = [['from "' + name + '"', 'from "' + target + '"'], ['import("' + name + '")', 'import("' + target + '")']];
    let staticOccurrences = 0;
    let dynamicOccurrences = 0;
    for (const [before, after] of patterns) {
      const count = bundle.split(before).length - 1;
      if (count === 0) continue;
      bundle = bundle.replaceAll(before, after);
      if (before.startsWith('import(')) dynamicOccurrences += count;
      else staticOccurrences += count;
    }
    if (staticOccurrences + dynamicOccurrences === 0) {
      throw new Error('expected bare imports of "' + name + '" in the v1 bundle, found none');
    }
    externalStats.push({name, staticOccurrences, dynamicOccurrences});
  }
  const statsByName = new Map(externalStats.map(stat => [stat.name, stat]));
  const zodStats = statsByName.get('zod');
  const zod = {strategy: 'vendored', resolved: rewriteTo('zod'), occurrences: zodStats.staticOccurrences, dynamicOccurrences: zodStats.dynamicOccurrences};
  return {bundle, vendor, zod};
}

// ---------------------------------------------------------------------------
// 3.0.7: per-module pin + patch + verbatim-layout delivery.
//
// From 3.0.7 the upstream dist is a Bun --splitting multi-module ESM build:
// the entry imports reachable chunks, chunks import chunks, and bare externals
// (plugin/zod/jsonc-parser on `index`) appear in the chunks, not just the
// entry. The single-bundle vendoring above cannot express that, so 3.0.7 is
// built module-by-module instead of rebundled:
//   1. omo-patch.mjs pins the exact entry-reachable module graph (the entry
//      plus its reachable chunks, as enumerated by OMO_307_MODULES) with
//      per-module SHA-256 digests.
//   2. The builder re-reads each pinned module byte-exactly, walks its
//      relative import graph (static imports, re-exports and dynamic literal
//      import()s) and requires the pin set to equal the reachable set exactly.
//   3. patchOmo307 patches the modules in place (same delivery/identity
//      patches as older versions, now per module) and injects the
//      module-relative helper imports itself.
//   4. `index` only: the three external packages are vendored to ../vendor
//      (same buildVendorClosures strategy as 3.0.1-3.0.6, newer pins) and
//      every reachable module's bare imports are rewritten to the vendored
//      copies. `server` bundles its internals and keeps jsonc-parser as a
//      closure root instead.
//   5. The dependency closure (omo-closure.mjs, 3.0.7 root tables) ships as a
//      copied node_modules tree; jsdom and @ast-grep/cli are required roots —
//      a workarea missing either fails the build explicitly (the only
//      non-literal dynamic load in the graph, importJSDOM(), resolves and
//      imports the jsdom package main).
// The manifest records each module's input/output digest, the patch records,
// helper importers, vendor rewrites per module and the closure inventory.
// ---------------------------------------------------------------------------

/**
 * Walk the relative import graph of the pinned 3.0.7 module set starting at
 * `entryModule` and return the set of reachable module paths. Resolves
 * extensionless specifiers the way node/Bun do (exact, +.js, /index.js) and
 * rejects traversal outside the package root or imports landing outside the
 * pinned set — the pin must be exactly the graph.
 */
function walkOmo307ModuleGraph(modules, entryModule, context) {
  const syntheticRoot = '/omo307-walk-root';
  const resolveSite = (modulePath, specifier) => {
    const resolved = resolve(dirname(join(syntheticRoot, modulePath)), specifier);
    const rel = toPosix(relative(syntheticRoot, resolved));
    if (rel.startsWith('..')) {
      throw new Error(context + ': module "' + modulePath + '" imports "' + specifier + '" which escapes the package root');
    }
    return rel;
  };
  const reachable = new Set([entryModule]);
  const queue = [entryModule];
  while (queue.length > 0) {
    const modulePath = queue.pop();
    const source = stripJsComments(modules.get(modulePath));
    for (const match of source.matchAll(ESM_RELATIVE_SITE)) {
      const specifier = match[2];
      if (specifier.includes('${')) continue;
      const rel = resolveSite(modulePath, specifier);
      const target = [rel, rel + '.js', toPosix(join(rel, 'index.js'))].find(candidate => modules.has(candidate));
      if (!target) {
        throw new Error(context + ': module "' + modulePath + '" imports "' + specifier + '" which resolves to "' + rel + '" — not part of the pinned module set');
      }
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  return reachable;
}

/**
 * The patcher injects module-relative helper imports into the patched
 * modules; verify every shipped helper is actually imported by at least one
 * module through a specifier that resolves to it, and return the importer
 * map. A helper nothing imports would ship dead (or, worse, hint the patcher
 * injected imports that node cannot resolve).
 */
function validateOmo307HelperImports(patchedModules, outputDir, helpers, context) {
  const helperAbs = helpers.map(helper => resolve(join(outputDir, helper)));
  const importedBy = new Map(helpers.map(helper => [helper, []]));
  for (const modulePath of [...patchedModules.keys()].sort()) {
    const source = stripJsComments(patchedModules.get(modulePath));
    const moduleDir = dirname(join(outputDir, modulePath));
    for (const match of source.matchAll(ESM_RELATIVE_SITE)) {
      const specifier = match[2];
      if (specifier.includes('${')) continue;
      const resolved = resolve(moduleDir, specifier);
      helpers.forEach((helper, index) => {
        if (resolved === helperAbs[index] && !importedBy.get(helper).includes(modulePath)) {
          importedBy.get(helper).push(modulePath);
        }
      });
    }
  }
  for (const helper of helpers) {
    if (importedBy.get(helper).length === 0) {
      throw new Error(context + ': no patched module imports the helper with a resolving relative specifier: ' + helper);
    }
  }
  return importedBy;
}

/**
 * Vendor the 3.0.7 index entry's externals (plugin, jsonc-parser, zod — same
 * VENDOR_TARGETS_3_0_1_INDEX entry points, newer pinned versions) and rewrite
 * every reachable module's bare imports to relative specifiers into ../vendor.
 * Unlike the single-bundle rewriter this handles each module from its own
 * directory (chunks live in dist/chunks/, so their relative specifiers differ
 * from the entry's) and counts dynamic import() separately. Every expected
 * external must actually be rewritten somewhere; silent no-ops fail the build.
 */
function vendorOmo307IndexExternals({modules, modulePaths, packageDir, outputDir}) {
  const {vendor, planByName, vendorRoot} = buildVendorClosures({packageDir, outputDir, targets: VENDOR_TARGETS_3_0_1_INDEX});
  const names = ['@opencode-ai/plugin', 'jsonc-parser', 'zod'];
  const rewritten = new Map(modules);
  const externalModuleRewrites = [];
  const totals = new Map(names.map(name => [name, {staticOccurrences: 0, dynamicOccurrences: 0}]));
  for (const modulePath of modulePaths) {
    let source = rewritten.get(modulePath);
    const moduleDir = dirname(join(outputDir, modulePath));
    const moduleRewrites = [];
    for (const name of names) {
      const target = posixRelative(moduleDir, join(vendorRoot, name, planByName.get(name).entryPath));
      const patterns = [
        ['from "' + name + '"', 'from "' + target + '"', 'static'],
        ['import("' + name + '")', 'import("' + target + '")', 'dynamic'],
        ['require("' + name + '")', 'require("' + target + '")', 'static'],
      ];
      let staticOccurrences = 0;
      let dynamicOccurrences = 0;
      for (const [before, after, kind] of patterns) {
        const count = source.split(before).length - 1;
        if (count === 0) continue;
        source = source.replaceAll(before, after);
        if (kind === 'dynamic') dynamicOccurrences += count;
        else staticOccurrences += count;
      }
      if (staticOccurrences + dynamicOccurrences > 0) {
        moduleRewrites.push({name, target, staticOccurrences, dynamicOccurrences});
        totals.get(name).staticOccurrences += staticOccurrences;
        totals.get(name).dynamicOccurrences += dynamicOccurrences;
      }
    }
    if (moduleRewrites.length > 0) {
      rewritten.set(modulePath, source);
      externalModuleRewrites.push({module: modulePath, rewrites: moduleRewrites});
    }
  }
  for (const name of names) {
    const total = totals.get(name);
    if (total.staticOccurrences + total.dynamicOccurrences === 0) {
      throw new Error('expected bare imports of "' + name + '" across the 3.0.7 index modules, found none');
    }
  }
  const zodStats = totals.get('zod');
  const zod = {
    strategy: 'vendored',
    resolved: posixRelative(dirname(join(outputDir, omoEntryRelativePath('index'))), join(vendorRoot, 'zod', planByName.get('zod').entryPath)),
    occurrences: zodStats.staticOccurrences,
    dynamicOccurrences: zodStats.dynamicOccurrences,
  };
  return {modules: rewritten, vendor, zod, externalModuleRewrites};
}

/**
 * Build the 3.0.7 artifact: pin-validated module graph -> shared patcher ->
 * (index) per-module vendoring -> helper import validation -> specifier
 * validation -> dependency closure -> verbatim-layout delivery with a
 * per-module manifest. Signature, defaults and return shape match
 * buildOmoIntegration; dryRun writes nothing.
 */
async function buildOmo307Integration({packageDir, sourceDir, outputDir, packageManifest, entry, dryRun, upstreamPath, upstreamDigest}) {
  const context = 'OMO 3.0.7 ' + entry;
  const entryModulePath = omoEntryRelativePath(entry);
  const modulePins = OMO_307_MODULES[entry];
  if (!modulePins || typeof modulePins !== 'object' || !modulePins[entryModulePath]) {
    throw new Error(context + ': omo-patch.mjs pins no 3.0.7 module set for entry "' + entry + '"');
  }
  const omoTargetDigest = OMO_TARGETS['3.0.7']?.entries?.[entry];
  if (omoTargetDigest !== modulePins[entryModulePath]) {
    throw new Error(context + ': OMO_TARGETS["3.0.7"].entries.' + entry + ' (' + omoTargetDigest + ') does not match the pinned ' + entryModulePath + ' digest');
  }

  // Load the pinned module set byte-exactly; the per-module SHA is the copy
  // authority — anything else in the package is ignored, and any drift from
  // the pins fails the build here. Digests are captured before patching:
  // patchOmo307 writes the patched sources back into this same Map.
  const inputModules = new Map();
  const inputDigests = new Map();
  for (const modulePath of Object.keys(modulePins).sort()) {
    let source;
    try {
      source = await readFile(join(packageDir, modulePath), 'utf8');
    } catch (error) {
      throw new Error(context + ': pinned module "' + modulePath + '" is missing from ' + packageDir + ' (' + (error?.code ?? error?.message ?? String(error)) + ')');
    }
    const digest = digestOf(source);
    if (digest !== modulePins[modulePath]) {
      throw new Error(context + ': module digest mismatch for ' + modulePath + ': expected ' + modulePins[modulePath] + ', got ' + digest);
    }
    inputModules.set(modulePath, source);
    inputDigests.set(modulePath, digest);
  }

  // The pin set must be exactly the entry-reachable import graph — nothing
  // unreachable (dead weight) and nothing reachable but unpinned (unverified).
  const reachable = walkOmo307ModuleGraph(inputModules, entryModulePath, context);
  const unreachablePins = Object.keys(modulePins).filter(modulePath => !reachable.has(modulePath));
  const unpinnedReachable = [...reachable].filter(modulePath => !Object.hasOwn(modulePins, modulePath));
  if (unreachablePins.length > 0 || unpinnedReachable.length > 0) {
    throw new Error(context + ': pinned module set does not match the entry import graph'
      + (unreachablePins.length > 0 ? '; pinned but unreachable: ' + unreachablePins.join(', ') : '')
      + (unpinnedReachable.length > 0 ? '; reachable but unpinned: ' + unpinnedReachable.join(', ') : ''));
  }

  // Hand the exact pinned modules to the shared patcher and validate what
  // comes back before trusting it.
  const patched = await patchOmo307(inputModules, entry);
  let patchedModules = patched?.modules;
  if (!(patchedModules instanceof Map)) {
    throw new Error(context + ': patchOmo307 must return {modules: Map, patches}, got modules: ' + (patchedModules === null ? 'null' : typeof patchedModules));
  }
  const patchedPaths = [...patchedModules.keys()].sort();
  if (patchedPaths.length !== inputModules.size || patchedPaths.some(modulePath => !inputModules.has(modulePath))) {
    throw new Error(context + ': patchOmo307 module key set diverges from the pinned input set: ' + patchedPaths.join(', '));
  }
  const patchReport = patched.patches;
  if (!Array.isArray(patchReport)) {
    throw new Error(context + ': patchOmo307 must return {modules: Map, patches: Array}, got patches: ' + (patchReport === null ? 'null' : typeof patchReport));
  }
  for (const record of patchReport) {
    if (!record || typeof record.id !== 'string' || typeof record.path !== 'string' || typeof record.purpose !== 'string' || !inputModules.has(record.path)) {
      throw new Error(context + ': invalid patch record (need {id, path, purpose} with path inside the pinned module set): ' + JSON.stringify(record));
    }
  }
  // The shipped patch manifest must be exactly describeOmoPatches("3.0.7") —
  // the descriptor is the authority; the patcher's report must prove every
  // (id, path) application on this entry's module graph was actually applied,
  // with no missing, duplicate or extra records and no hardcoded counts.
  // describeOmoPatches describes the full cross-entry 3.0.7 set (the same
  // patches are registered against dist/index.js and dist/server/index.js
  // modules), so the expected list is scoped to the pinned entry graph; to
  // keep that scoping airtight, any descriptor path outside the two pinned
  // graphs is an explicit error instead of a silent entry-filter skip.
  const patchDescriptor = describeOmoPatches('3.0.7');
  const knownGraphPaths = new Set([...Object.keys(OMO_307_MODULES.index), ...Object.keys(OMO_307_MODULES.server)]);
  const expectedApplications = patchDescriptor.flatMap(patch => {
    if (!patch || typeof patch.id !== 'string' || !Array.isArray(patch.modules)) {
      throw new Error(context + ': invalid describeOmoPatches("3.0.7") record (need {id, purpose, modules}): ' + JSON.stringify(patch));
    }
    return patch.modules.map(modulePath => {
      if (!knownGraphPaths.has(modulePath)) {
        throw new Error(context + ': describeOmoPatches("3.0.7") references "' + modulePath + '" outside the pinned 3.0.7 module graphs');
      }
      return patch.id + '\u0000' + modulePath;
    });
  }).filter(key => inputModules.has(key.split('\u0000')[1]));
  const actualApplications = patchReport.map(record => record.id + '\u0000' + record.path);
  const expectedSet = new Set(expectedApplications);
  const actualSet = new Set(actualApplications);
  const missingApplications = expectedApplications.filter(key => !actualSet.has(key));
  const duplicateApplications = actualApplications.filter((key, index) => actualApplications.indexOf(key) !== index);
  const extraApplications = actualApplications.filter(key => !expectedSet.has(key));
  if (missingApplications.length > 0 || duplicateApplications.length > 0 || extraApplications.length > 0 || expectedApplications.length !== actualApplications.length) {
    throw new Error(context + ': patch report diverges from describeOmoPatches("3.0.7")'
      + (missingApplications.length > 0 ? '; missing: ' + [...new Set(missingApplications)].join(', ') : '')
      + (duplicateApplications.length > 0 ? '; duplicate: ' + [...new Set(duplicateApplications)].join(', ') : '')
      + (extraApplications.length > 0 ? '; extra: ' + [...new Set(extraApplications)].join(', ') : ''));
  }

  // index only: vendor the externals and rewrite bare imports per module.
  let vendor = null;
  let zod;
  let externalModuleRewrites = null;
  if (entry === 'index') {
    const vendored = vendorOmo307IndexExternals({modules: patchedModules, modulePaths: patchedPaths, packageDir, outputDir});
    patchedModules = vendored.modules;
    vendor = vendored.vendor;
    zod = vendored.zod;
    externalModuleRewrites = vendored.externalModuleRewrites;
  } else {
    zod = {strategy: 'bundled', resolved: null, occurrences: 0};
  }

  // The patcher's injected helper imports must actually resolve from each
  // importing module's directory.
  const helpers = omoHelperFiles('3.0.7');
  const importedBy = validateOmo307HelperImports(patchedModules, outputDir, helpers, context);

  // Remaining bare specifiers must be closure roots (on index the vendored
  // names must be gone entirely), and no absolute file:///home/ pins.
  const roots = CLOSURE_ROOT_SPECIFIERS_3_0_7[entry];
  for (const modulePath of patchedPaths) {
    validateBundleSpecifiers({
      bundle: patchedModules.get(modulePath),
      allowedNames: new Set([...roots, ...(vendor ?? []).map(v => v.name)]),
      context: context + ' module "' + modulePath + '"',
    });
  }
  if (vendor) {
    for (const modulePath of patchedPaths) {
      const bare = bareExternalSpecifiers(patchedModules.get(modulePath));
      if (bare.length > 0) {
        throw new Error(context + ': module "' + modulePath + '" still carries bare module imports after vendoring: ' + [...new Set(bare)].join(', '));
      }
      const pinnedUrls = [...stripJsComments(patchedModules.get(modulePath)).matchAll(ANY_MODULE_SPECIFIER)]
        .map(match => match[1] ?? match[2])
        .filter(specifier => specifier.includes('file://') || specifier.includes('/home/'));
      if (pinnedUrls.length > 0) {
        throw new Error(context + ': module "' + modulePath + '" unexpectedly pins absolute import locations: ' + [...new Set(pinnedUrls)].join(', '));
      }
    }
  }

  const computed = computeDependencyClosure({packageDir, roots});
  if (computed.requiredMissing.length > 0) {
    throw new Error('required dependency closure unresolved from the pinned cache: ' + computed.requiredMissing.join(', '));
  }
  const resources = planPackageResources({packageDir, packageManifest});

  const files = [];
  if (vendor) {
    for (const vendoredPackage of vendor) {
      for (const record of vendoredPackage.fileRecords) {
        files.push({path: record.path, content: record.content, digest: record.digest});
      }
    }
  }
  const helperManifest = [];
  for (const helper of helpers) {
    const content = await readFile(join(sourceDir, helper), 'utf8');
    const digest = digestOf(content);
    files.push({path: join(outputDir, helper), content, digest});
    helperManifest.push({file: join(outputDir, helper), digest, importedBy: [...new Set(importedBy.get(helper))].sort()});
  }
  const moduleRecords = patchedPaths.map(modulePath => {
    const content = patchedModules.get(modulePath);
    const record = {
      path: join(outputDir, modulePath),
      inputDigest: inputDigests.get(modulePath),
      outputDigest: digestOf(content),
      bytes: Buffer.byteLength(content),
    };
    files.push({path: record.path, content, digest: record.outputDigest});
    return record;
  });
  // Top-level closure packages ship verbatim (including their own nested
  // node_modules); nested entries are contained in the parent copy and are
  // only recorded in the manifest.
  for (const pkg of computed.packages) {
    if (!pkg.topLevel) continue;
    for (const file of pkg.files) {
      files.push({path: join(outputDir, 'node_modules', pkg.installPath, file.path), copyFrom: file.copyFrom, digest: file.digest});
    }
  }
  for (const resource of resources) {
    files.push({path: join(outputDir, resource.path), copyFrom: resource.copyFrom, digest: resource.digest});
  }

  const entryRecord = moduleRecords.find(record => record.path === join(outputDir, entryModulePath));
  const buildManifest = {
    name: 'oh-my-opencode-slim',
    version: '3.0.7',
    entry,
    upstream: {path: upstreamPath, digest: upstreamDigest},
    helpers: helperManifest,
    bundle: {path: entryRecord.path, digest: entryRecord.outputDigest},
    zod,
    ...(vendor ? {vendor: vendor.map(v => ({name: v.name, kind: v.kind, entry: v.entry, resolvedFrom: v.resolvedFrom, files: v.files, rewrites: v.rewrites}))} : {}),
    ...(externalModuleRewrites ? {externalModuleRewrites} : {}),
    modules: moduleRecords.map(record => ({path: record.path, inputDigest: record.inputDigest, outputDigest: record.outputDigest, bytes: record.bytes})),
    closure: {
      strategy: 'copied-node-modules-closure',
      cacheRoot: computed.cacheRoot,
      roots,
      packages: computed.packages.map(pkg => ({
        name: pkg.name,
        version: pkg.version,
        engines: pkg.engines,
        installPath: toPosix(join('node_modules', pkg.installPath)),
        topLevel: pkg.topLevel,
        ...(pkg.shippedVia ? {shippedVia: pkg.shippedVia} : {}),
        ...(pkg.linked ? {linkedFrom: pkg.linked} : {}),
        dependencies: pkg.dependencies,
        peerDependencies: pkg.peerDependencies,
        fileCount: pkg.fileCount,
        totalBytes: pkg.totalBytes,
        ...(pkg.topLevel ? {files: pkg.files.map(file => ({path: file.path, digest: file.digest, bytes: file.bytes}))} : {}),
      })),
      missing: computed.missing,
      resources: resources.map(resource => ({path: resource.path, digest: resource.digest, bytes: resource.bytes})),
    },
    patches: patchDescriptor,
  };
  files.push({path: join(outputDir, 'manifest.json'), content: JSON.stringify(buildManifest, null, 2) + '\n', digest: digestOf(JSON.stringify(buildManifest, null, 2) + '\n')});

  if (!dryRun) {
    for (const file of files) {
      await mkdir(dirname(file.path), {recursive: true});
      if (file.copyFrom !== undefined) await copyFile(file.copyFrom, file.path);
      else await writeFile(file.path, file.content);
    }
  }
  return {manifest: buildManifest, files};
}

const posixRelative = (from, to) => {
  const rel = relative(from, to).split('\\').join('/');
  return rel === '' ? '.' : rel;
};

const digestOf = value => createHash('sha256').update(value).digest('hex');

/**
 * Build one pinned OMO entry into `outputDir`. Throws on any version/hash
 * mismatch; unknown upstream content is never patched.
 */
export async function buildOmoIntegration({
  packageDir,
  sourceDir,
  outputDir,
  version,
  entry = 'index',
  dryRun = false,
}) {
  assert(packageDir, 'packageDir is required');
  assert(sourceDir, 'sourceDir is required');
  assert(outputDir, 'outputDir is required');
  if (!version || !OMO_TARGETS[version]) {
    throw new Error('version must be one of ' + Object.keys(OMO_TARGETS).join(', ') + '; got ' + String(version));
  }

  packageDir = resolve(packageDir);
  sourceDir = resolve(sourceDir);
  outputDir = resolve(outputDir);

  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (manifest.name !== 'oh-my-opencode-slim') {
    throw new Error('packageDir is not oh-my-opencode-slim: ' + manifest.name);
  }
  if (manifest.version !== version) {
    throw new Error('package version ' + manifest.version + ' does not match requested ' + version);
  }

  const upstreamPath = join(packageDir, omoEntryRelativePath(entry));
  const upstream = await readFile(upstreamPath, 'utf8');
  const upstreamDigest = digestOf(upstream);
  const expectedDigest = OMO_TARGETS[version].entries[entry];
  if (upstreamDigest !== expectedDigest) {
    throw new Error('Upstream ' + version + ' ' + entry + ' digest mismatch: expected ' + expectedDigest + ', got ' + upstreamDigest);
  }

  // 3.0.7 delivers a pinned, patcher-split module graph instead of one
  // patched bundle; the shared single-bundle path below stays untouched.
  if (version === '3.0.7') {
    return buildOmo307Integration({packageDir, sourceDir, outputDir, packageManifest: manifest, entry, dryRun, upstreamPath, upstreamDigest});
  }

  let bundle = patchOmo(upstream, {version, entry});

  // The v1 entry treats zod (and, on 3.0.1, @opencode-ai/plugin and
  // jsonc-parser) as external imports:
  //   - 3.0.1: vendor the exact runtime closure of each external into
  //     outputDir/vendor and rewrite the bundle to relative specifiers so the
  //     artifact loads from any cwd/HOME with no extra node_modules.
  //   - 2.2.25 (rollback build): pin static zod imports to the zod copy owned
  //     by the OMO package; must stay byte-identical to the deployed build.
  // The v2 entry bundles everything internally and must not keep bare
  // specifiers.
  let zod;
  let vendor;
  if (entry === 'index') {
    if (version === '3.0.1' || version === '3.0.3' || version === '3.0.4' || version === '3.0.5' || version === '3.0.6') {
      const vendored = vendor3_0_1_IndexExternals({bundle, packageDir, outputDir});
      bundle = vendored.bundle;
      vendor = vendored.vendor;
      zod = vendored.zod;
    } else {
      const zodURL = omoZodFileURL(packageDir);
      const occurrences = bundle.split('from "zod"').length - 1;
      if (occurrences === 0) throw new Error('Expected static zod imports in the v1 entry');
      bundle = bundle.replaceAll('from "zod"', 'from "' + zodURL + '"');
      zod = {strategy: 'static-import-rewrite', resolved: zodURL, occurrences};
    }
  } else {
    if (bundle.includes('from "zod"')) throw new Error('v2 entry unexpectedly keeps bare zod imports');
    zod = {strategy: 'bundled', resolved: null, occurrences: 0};
  }

  const bundleDir = dirname(join(outputDir, omoEntryRelativePath(entry)));
  const helperPrefix = posixRelative(bundleDir, outputDir);
  for (const helper of omoHelperFiles(version)) {
    const specifier = '../' + helper;
    const count = bundle.split('"' + specifier + '"').length - 1;
    if (count !== 1) throw new Error('Expected exactly one ' + specifier + ' import, found ' + count);
    bundle = bundle.replaceAll('"' + specifier + '"', '"' + helperPrefix + '/' + helper + '"');
  }

  // 3.0.1 keeps a small set of lazily-resolved runtime dependencies outside
  // the bundles (see omo-closure.mjs). Ship them as an ordinary copied
  // node_modules closure plus the declared package resources, so node
  // resolution keeps working after relocation with no import rewriting. The
  // 2.2.25 rollback build stays byte-identical to the deployed integration and
  // ships none of this.
  let closure;
  let resources;
  if (version === '3.0.1' || version === '3.0.3' || version === '3.0.4' || version === '3.0.5' || version === '3.0.6') {
    const roots = CLOSURE_ROOT_SPECIFIERS[entry];
    validateBundleSpecifiers({
      bundle,
      allowedNames: new Set([...roots, ...(vendor ?? []).map(v => v.name)]),
      context: 'OMO ' + version + ' ' + entry + ' bundle',
    });
    const computed = computeDependencyClosure({packageDir, roots});
    if (computed.requiredMissing.length > 0) {
      throw new Error('required dependency closure unresolved from the pinned cache: ' + computed.requiredMissing.join(', '));
    }
    resources = planPackageResources({packageDir, packageManifest: manifest});
    closure = computed;
  }

  if (vendor) {
    const bare = bareExternalSpecifiers(bundle);
    if (bare.length > 0) {
      throw new Error('v1 bundle still carries bare module imports after vendoring: ' + [...new Set(bare)].join(', '));
    }
    const pinnedUrls = [...stripJsComments(bundle).matchAll(ANY_MODULE_SPECIFIER)]
      .map(match => match[1] ?? match[2])
      .filter(specifier => specifier.includes('file://') || specifier.includes('/home/'));
    if (pinnedUrls.length > 0) {
      throw new Error('v1 bundle unexpectedly pins absolute import locations: ' + [...new Set(pinnedUrls)].join(', '));
    }
  }

  const files = [];
  if (vendor) {
    for (const vendored of vendor) {
      for (const record of vendored.fileRecords) {
        files.push({path: record.path, content: record.content, digest: record.digest});
      }
    }
  }
  for (const helper of omoHelperFiles(version)) {
    const content = await readFile(join(sourceDir, helper), 'utf8');
    files.push({path: join(outputDir, helper), content, digest: digestOf(content)});
  }
  const bundleRecord = {path: join(outputDir, omoEntryRelativePath(entry)), content: bundle, digest: digestOf(bundle)};
  files.push(bundleRecord);
  if (closure) {
    // Top-level closure packages ship verbatim (including their own nested
    // node_modules, so nested version conflicts like parse5-inside-jsdom stay
    // nested); nested entries are contained in the parent copy and are only
    // recorded in the manifest.
    for (const pkg of closure.packages) {
      if (!pkg.topLevel) continue;
      for (const file of pkg.files) {
        files.push({path: join(outputDir, 'node_modules', pkg.installPath, file.path), copyFrom: file.copyFrom, digest: file.digest});
      }
    }
    for (const resource of resources) {
      files.push({path: join(outputDir, resource.path), copyFrom: resource.copyFrom, digest: resource.digest});
    }
  }

  const buildManifest = {
    name: 'oh-my-opencode-slim',
    version,
    entry,
    upstream: {path: upstreamPath, digest: upstreamDigest},
    helpers: files.filter(f => f.path.endsWith('.mjs') && dirname(f.path) === outputDir).map(f => ({file: f.path, digest: f.digest})),
    bundle: {path: bundleRecord.path, digest: bundleRecord.digest},
    zod,
    ...(vendor ? {vendor: vendor.map(v => ({name: v.name, kind: v.kind, entry: v.entry, resolvedFrom: v.resolvedFrom, files: v.files, rewrites: v.rewrites}))} : {}),
    ...(closure ? {
      closure: {
        strategy: 'copied-node-modules-closure',
        cacheRoot: closure.cacheRoot,
        roots: CLOSURE_ROOT_SPECIFIERS[entry],
        packages: closure.packages.map(pkg => ({
          name: pkg.name,
          version: pkg.version,
          engines: pkg.engines,
          installPath: toPosix(join('node_modules', pkg.installPath)),
          topLevel: pkg.topLevel,
          ...(pkg.shippedVia ? {shippedVia: pkg.shippedVia} : {}),
          ...(pkg.linked ? {linkedFrom: pkg.linked} : {}),
          dependencies: pkg.dependencies,
          peerDependencies: pkg.peerDependencies,
          fileCount: pkg.fileCount,
          totalBytes: pkg.totalBytes,
          ...(pkg.topLevel ? {files: pkg.files.map(file => ({path: file.path, digest: file.digest, bytes: file.bytes}))} : {}),
        })),
        missing: closure.missing,
        resources: resources.map(resource => ({path: resource.path, digest: resource.digest, bytes: resource.bytes})),
      },
    } : {}),
    patches: describeOmoPatches(version),
  };
  files.push({path: join(outputDir, 'manifest.json'), content: JSON.stringify(buildManifest, null, 2) + '\n', digest: digestOf(JSON.stringify(buildManifest, null, 2) + '\n')});

  if (!dryRun) {
    for (const file of files) {
      await mkdir(dirname(file.path), {recursive: true});
      if (file.copyFrom !== undefined) await copyFile(file.copyFrom, file.path);
      else await writeFile(file.path, file.content);
    }
  }
  return {manifest: buildManifest, files};
}
