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
 *   outputDir/vendor/**                   vendored runtime closure of the v1
 *                                         entry's external imports (3.0.1
 *                                         index only; see VENDOR_TARGETS_3_0_1_INDEX)
 *   outputDir/node_modules/**             copied dependency closure of the
 *                                         lazily-resolved runtime dependencies
 *                                         (3.0.1 only; see omo-closure.mjs)
 *   outputDir/package.json + declared     pinned package metadata, skills,
 *                                         resources (3.0.1 only; skills,
 *                                         schema, READMEs, LICENSE)
 *   outputDir/manifest.json               deterministic build manifest
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire, isBuiltin} from 'node:module';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {OMO_TARGETS, describeOmoPatches, patchOmo} from './omo-patch.mjs';
import {CLOSURE_ROOT_SPECIFIERS, OPTIONAL_CLOSURE_ROOTS, computeDependencyClosure} from './omo-closure.mjs';

export {CLOSURE_ROOT_SPECIFIERS, OMO_TARGETS, OPTIONAL_CLOSURE_ROOTS, computeDependencyClosure, describeOmoPatches};

// Helper files copied per version. 3.0.1 ships only the generic delivery helper:
// upstream Council stays byte-identical, so no council import is prepended and no
// council helper is deployed. The 2.2.25 rollback build reproduces the deployed
// integration and therefore still copies both helpers.
export const OMO_HELPER_FILES = {
  '2.2.25': ['omo-delivery.mjs', 'omo-council.mjs'],
  '3.0.1': ['omo-delivery.mjs'],
  '3.0.3': ['omo-delivery.mjs'],
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
 * Vendor the 3.0.1 v1 entry's external imports into `outputDir/vendor` and
 * rewrite the bundle to relative specifiers. Vendored files whose own bare
 * imports name another vendored package (the plugin's `import { z } from
 * "zod"`) are rewritten to the vendored copy as well; any other bare import
 * fails the build. Returns the vendor manifest entries and the rewritten bundle.
 */
function vendor3_0_1_IndexExternals({bundle, packageDir, outputDir}) {
  const vendorRoot = join(outputDir, 'vendor');
  const plans = VENDOR_TARGETS_3_0_1_INDEX.map(target => ({
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
    if (version === '3.0.1' || version === '3.0.3') {
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
  if (version === '3.0.1' || version === '3.0.3') {
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
