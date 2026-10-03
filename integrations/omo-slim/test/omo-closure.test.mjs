import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildOmoIntegration, CLOSURE_ROOT_SPECIFIERS} from '../build-omo.mjs';

const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PKG_301 = '/home/littlekey/.cache/opencode/packages/oh-my-opencode-slim@3.0.1/node_modules/oh-my-opencode-slim';
const PKG_2225 = '/home/littlekey/.config/opencode/local-plugins/node_modules/oh-my-opencode-slim';
// Bounded child processes (same pattern as omo-build.test.mjs): node:test's
// --test-timeout cannot interrupt a sync execFileSync, so every child carries a
// finite timeout plus a forced killSignal; the per-test budget stays at 20s.
const CHILD_TIMEOUT_MS = 15000;
const CHILD = {stdio: 'pipe', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL'};

const PERSISTENT_OUT = process.env.OMO_BUILD_TEST_OUT;
const OUT = PERSISTENT_OUT || mkdtempSync(join(realpathSync(tmpdir()), 'omo-closure-test-'));
mkdirSync(OUT, {recursive: true});
if (!PERSISTENT_OUT) after(() => rmSync(OUT, {recursive: true, force: true}));
const uniqueOut = label => {
  const dir = join(OUT, label + '-' + process.pid + '-' + Math.random().toString(36).slice(2));
  rmSync(dir, {recursive: true, force: true});
  return dir;
};
const digest = value => createHash('sha256').update(value).digest('hex');

// Builds are expensive (the closure digests ~80MB per entry), so share one
// build per label across the tests in this file.
const buildCache = new Map();
const buildOnce = async (label, options) => {
  if (!buildCache.has(label)) buildCache.set(label, buildOmoIntegration(options));
  return buildCache.get(label);
};
const v1Build = () => buildOnce('v1', {packageDir: PKG_301, sourceDir: SRC, outputDir: uniqueOut('v1-closure'), version: '3.0.1', entry: 'index'});
const v2Build = () => buildOnce('v2', {packageDir: PKG_301, sourceDir: SRC, outputDir: uniqueOut('v2-closure'), version: '3.0.1', entry: 'server'});
const sourceCompanionManifest = () => JSON.parse(readFileSync(join(PKG_301, 'src/companion/companion-manifest.json'), 'utf8'));
const sourceSkillMdPaths = () => {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === 'SKILL.md') found.push(dir.slice(PKG_301.length + 1));
    }
  })(join(PKG_301, 'src/skills'));
  return found.sort();
};

test('closure set: pinned roots only, exact top-level layout, version conflicts stay nested', async () => {
  const v1 = (await v1Build()).manifest.closure;
  const v2 = (await v2Build()).manifest.closure;
  assert.equal(v1.strategy, 'copied-node-modules-closure');
  assert.equal(v2.strategy, 'copied-node-modules-closure');
  assert.deepEqual(v1.roots, CLOSURE_ROOT_SPECIFIERS.index);
  assert.deepEqual(v2.roots, CLOSURE_ROOT_SPECIFIERS.server);
  for (const closure of [v1, v2]) {
    assert.ok(closure.packages.length > 30, 'closure resolved the real dependency tree');
    const installPaths = closure.packages.map(p => p.installPath);
    assert.equal(new Set(installPaths).size === installPaths.length ? 0 : 1, 0, 'package install paths are unique');
    // NOTE: names may legitimately repeat — the same package name at two depths
    // is a nested version conflict (e.g. whatwg-url 16 inside data-urls + 17
    // top level) and must ship at both locations.
    for (const record of closure.packages) {
      assert.equal(typeof record.version, 'string');
      assert.ok(record.fileCount > 0, record.name + ' shipped actual files');
      assert.ok(record.totalBytes > 0, record.name + ' shipped actual bytes');
      // file lists are only recorded for top-level packages; nested entries
      // (version conflicts) are contained in their parent's verbatim copy
      if (!record.topLevel) continue;
      for (const file of record.files) {
        assert.match(file.path, /^[\w@.\-/]+$/);
        assert.match(file.digest, /^[0-9a-f]{64}$/);
      }
    }
    for (const missing of closure.missing) {
      assert.equal(missing.kind, 'optional-dependency', 'only optional dependencies may be unresolvable');
      assert.match(missing.name, /^@ast-grep\/cli-/, 'missing entries are the other-platform ast-grep binaries');
    }
    for (const resource of closure.resources) {
      assert.notEqual(resource.path, 'dist', 'dist is not a packaged resource');
      assert.match(resource.digest, /^[0-9a-f]{64}$/);
    }
    const resourcePaths = closure.resources.map(r => r.path);
    for (const required of ['package.json', 'src/companion/companion-manifest.json', 'oh-my-opencode-slim.schema.json', 'src/skills/simplify/SKILL.md', 'LICENSE']) {
      assert.ok(resourcePaths.includes(required), 'closure ships ' + required);
    }
  }
  const names = closure => closure.packages.map(p => p.name);
  // v1 vendors plugin/jsonc/zod: they must not be duplicated in the closure.
  assert.ok(names(v1).includes('jsdom') && names(v1).includes('@ast-grep/cli') && names(v1).includes('esprima'), 'v1 ships the lazily resolved roots');
  assert.equal(names(v1).includes('zod'), false, 'vendored zod is not duplicated');
  assert.equal(names(v1).includes('jsonc-parser'), false, 'vendored jsonc-parser is not duplicated');
  assert.equal(names(v1).includes('@opencode-ai/plugin'), false, 'vendored plugin is not duplicated');
  // v2 bundles zod itself but still resolves jsonc/jsdom/ast-grep at runtime.
  assert.deepEqual(names(v2).filter(n => n === 'jsonc-parser'), ['jsonc-parser']);
  assert.equal(v2.packages.find(p => p.name === 'jsonc-parser').version, '3.3.1');
  assert.equal(v2.packages.find(p => p.name === 'jsdom').version, '30.1.1');
  // Version conflicts must remain nested verbatim, never flattened.
  const parse5 = v2.packages.find(p => p.name === 'parse5');
  assert.equal(parse5.version, '8.0.1');
  assert.equal(parse5.shippedVia, 'jsdom');
  assert.equal(parse5.installPath, 'node_modules/jsdom/node_modules/parse5');
  assert.equal(names(v2).includes('parse5') && v2.packages.filter(p => p.name === 'parse5').length, 1, 'exactly one parse5 record, the nested one');
  const whatwgUrls = v2.packages.filter(p => p.name === 'whatwg-url');
  assert.deepEqual(whatwgUrls.map(p => p.version).sort(), ['16.0.1', '17.1.2'], 'both whatwg-url generations ship at their own depths');
  const entities = v2.packages.find(p => p.name === 'entities');
  assert.equal(entities.version, '8.1.0');
  assert.equal(entities.shippedVia, 'jsdom');
});

test('closure copy is byte-complete and self-contained on disk', async () => {
  const built = await v2Build();
  const closure = built.manifest.closure;
  // Derive the real output root from the helper record, which carries an
  // absolute path inside the output dir.
  const outputRoot = outputRootOf(built);
  // 1. every recorded file exists on disk with the recorded digest (includes
  //    the multi-megabyte ast-grep binaries). installPath already carries the
  //    'node_modules/' prefix in the build manifest; file lists exist only for
  //    top-level packages (nested entries ship inside their parent's copy, so
  //    their bytes are covered by the parent's digest check).
  for (const record of closure.packages.filter(p => p.topLevel)) {
    for (const file of record.files) {
      const diskPath = join(outputRoot, record.installPath, file.path);
      assert.equal(existsSync(diskPath), true, diskPath + ' exists');
      assert.equal(digest(readFileSync(diskPath)), file.digest, diskPath + ' bytes match the manifest digest');
    }
  }
  for (const resource of closure.resources) {
    const diskPath = join(outputRoot, resource.path);
    assert.equal(existsSync(diskPath), true, diskPath + ' exists');
    assert.equal(digest(readFileSync(diskPath)), resource.digest, diskPath + ' bytes match the manifest digest');
  }
  // 2. the top-level node_modules layout is exactly the recorded set.
  const onDisk = readdirSync(join(outputRoot, 'node_modules'), {withFileTypes: true})
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .flatMap(name => (name.startsWith('@')
      ? readdirSync(join(outputRoot, 'node_modules', name), {withFileTypes: true}).filter(e => e.isDirectory()).map(e => name + '/' + e.name)
      : [name]));
  assert.deepEqual(onDisk.sort(), closure.packages.filter(p => p.topLevel).map(p => p.name).sort());
  // 3. self-contained reachability: every dependency of every top-level
  //    package resolves from the copied tree alone (nested copy or hoisted
  //    top level). Anything in closure.missing failed to resolve at build
  //    time and is optional by construction (required-missing fails the
  //    build) — the other-platform ast-grep binaries.
  const unresolvable = new Set(closure.missing.map(m => m.name));
  for (const record of closure.packages.filter(p => p.topLevel)) {
    for (const dep of record.dependencies ?? []) {
      const near = existsSync(join(outputRoot, record.installPath, 'node_modules', dep, 'package.json'));
      const top = existsSync(join(outputRoot, 'node_modules', dep, 'package.json'));
      assert.ok(near || top || unresolvable.has(dep), record.name + ' dependency ' + dep + ' resolves inside the copied closure');
    }
  }
  // 4. skills survive the copy exactly as the runtime reads them.
  const shippedSkills = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === 'SKILL.md') shippedSkills.push(dir.slice(outputRoot.length + 1));
    }
  })(join(outputRoot, 'src/skills'));
  assert.deepEqual(shippedSkills.sort(), sourceSkillMdPaths());
});

test('dry-run writes nothing; closure manifest is deterministic across builds', async () => {
  const dryOut = uniqueOut('dry-a');
  const dryA = await buildOnce('dry-a', {packageDir: PKG_301, sourceDir: SRC, outputDir: dryOut, version: '3.0.1', entry: 'server', dryRun: true});
  assert.equal(existsSync(dryOut), false, 'dryRun created no output directory');
  const dryB = await buildOnce('dry-b', {packageDir: PKG_301, sourceDir: SRC, outputDir: uniqueOut('dry-b'), version: '3.0.1', entry: 'server', dryRun: true});
  assert.deepEqual(dryB.manifest.closure, dryA.manifest.closure, 'closure manifest is byte-deterministic');
  const real = (await v2Build()).manifest.closure;
  assert.deepEqual(real.packages, dryA.manifest.closure.packages, 'dry-run closure matches the real build');
});

test('2.2.25 rollback build ships no closure (byte-identical rollback path unchanged)', async () => {
  const {manifest, files} = await buildOnce('2225', {packageDir: PKG_2225, sourceDir: SRC, outputDir: uniqueOut('2225-closure'), version: '2.2.25', entry: 'index'});
  assert.equal(manifest.closure, undefined, 'no closure manifest on the rollback target');
  assert.equal(files.some(f => f.path.includes('node_modules')), false, 'no node_modules records on the rollback target');
  assert.equal(existsSync(join(dirname(manifest.bundle.path), '..', '..', 'node_modules')), false, 'rollback output ships no node_modules');
});

const smokeScriptV2 = `
import {createRequire} from 'node:module';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const bundlePath = process.env.OMO_BUNDLE_PATH;
const require = createRequire(bundlePath);
const mod = await import(pathToFileURL(bundlePath).href);
const d = mod.default;
if (!d || d.id !== 'oh-my-opencode-slim' || typeof d.setup !== 'function') {
  throw new Error('unexpected default export: ' + JSON.stringify(Object.keys(mod)));
}
// walk-up package.json discovery, exactly like the upstream runtime locator
let pkgRoot = null;
let pkg = null;
{
  let dir = dirname(bundlePath);
  for (let i = 0; i < 10 && !pkgRoot; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed && parsed.name === 'oh-my-opencode-slim') { pkgRoot = dir; pkg = parsed; break; }
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
}
if (!pkgRoot) throw new Error('runtime package.json walk-up failed from ' + bundlePath);
if (!pkg || !pkg.version) throw new Error('relocated package.json lacks name/version');
const nm = join(pkgRoot, 'node_modules') + sep;
// jsdom: resolved and loaded purely from the relocated closure, then exercised
const jsdomEntry = require.resolve('jsdom');
if (!jsdomEntry.startsWith(nm)) throw new Error('jsdom escaped the relocated closure: ' + jsdomEntry);
// jsdom's entry is <pkg>/lib/api.js, so the package manifest sits above the
// resolved file — walk up to the package root exactly like real resolvers do
let jsdomPkgDir = null;
{
  let dir = dirname(jsdomEntry);
  for (let i = 0; i < 10 && !jsdomPkgDir; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === 'jsdom') { jsdomPkgDir = dir; break; }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
}
if (!jsdomPkgDir) throw new Error('jsdom package root not found above ' + jsdomEntry);
const jsdomManifest = JSON.parse(readFileSync(join(jsdomPkgDir, 'package.json'), 'utf8'));
const {JSDOM} = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><p id="probe">hi</p></body></html>');
const node = dom.window.document.createElement('div');
node.id = 'bcp-closure';
node.textContent = 'omo';
dom.window.document.body.appendChild(node);
if (dom.window.document.getElementById('bcp-closure').textContent !== 'omo') throw new Error('jsdom DOM operation failed');
if (dom.window.document.querySelector('#probe').textContent !== 'hi') throw new Error('jsdom parse mismatch');
// local static HTML read through the same jsdom pipeline the webfetch tool
// uses for local files; no network access happens here
const page = await JSDOM.fromFile(process.env.OMO_SMOKE_HTML);
if (page.window.document.title !== 'BCP Closure Probe') throw new Error('JSDOM.fromFile title mismatch: ' + page.window.document.title);
// jsonc-parser through the same closure; package.json sits at the package
// root above the resolved CJS entry (lib/umd/main.js), so walk up for it
const jsoncEntry = require.resolve('jsonc-parser');
if (!jsoncEntry.startsWith(nm)) throw new Error('jsonc-parser escaped the relocated closure: ' + jsoncEntry);
let jsoncPkgDir = null;
{
  let dir = dirname(jsoncEntry);
  for (let i = 0; i < 10 && !jsoncPkgDir; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === 'jsonc-parser') { jsoncPkgDir = dir; break; }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
}
if (!jsoncPkgDir) throw new Error('jsonc-parser package root not found above ' + jsoncEntry);
if (require('jsonc-parser').parse('{"a": /*c*/ 1}').a !== 1) throw new Error('jsonc parse mismatch');
// bundled skills as the runtime reads them: packageRoot + SKILL.md walk
const skillsFound = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else if (entry.name === 'SKILL.md') skillsFound.push(dir.slice(pkgRoot.length + 1));
  }
})(join(pkgRoot, 'src/skills'));
// companion manifest resolves from the installed layout
const companionPath = join(dirname(dirname(pkgRoot)), 'node_modules', 'oh-my-opencode-slim', 'src', 'companion', 'companion-manifest.json');
const companion = JSON.parse(readFileSync(companionPath, 'utf8'));
console.log('OMO_CLOSURE_SMOKE ' + JSON.stringify({
  runtime: process.version,
  packageVersion: pkg.version,
  jsdomVersion: jsdomManifest.version,
  jsdomEngines: jsdomManifest.engines || null,
  jsoncVersion: JSON.parse(readFileSync(join(jsoncPkgDir, 'package.json'), 'utf8')).version,
  companionVersion: companion.version || null,
  companionTag: companion.tag || null,
  skillsFound,
}));
`;

// The helper record carries an absolute path inside the output root and is
// unique per build (dirname = output dir).
const outputRootOf = build => dirname(build.manifest.helpers[0].file);
const relocateAndRun = async (command, argsFor) => {
  const v2 = await buildCache.get('v2');
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'omo-relocate-'));
  mkdirSync(join(scratch, 'cache'), {recursive: true});
  const relocation = join(scratch, 'inst', 'node_modules', 'oh-my-opencode-slim');
  cpSync(outputRootOf(v2), relocation, {recursive: true});
  const scriptPath = join(scratch, 'omo-smoke.mjs');
  const htmlPath = join(scratch, 'probe.html');
  writeFileSync(scriptPath, smokeScriptV2);
  writeFileSync(htmlPath, '<!doctype html><html><head><title>BCP Closure Probe</title></head><body>local only</body></html>');
  try {
    return {
      stdout: execFileSync(command, argsFor(scriptPath), {
        cwd: scratch,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: scratch,
          XDG_CACHE_HOME: join(scratch, 'cache'),
          BUN_INSTALL_CACHE_DIR: join(scratch, 'cache'),
          OMO_BUNDLE_PATH: join(relocation, 'dist/server/index.js'),
          OMO_SMOKE_HTML: htmlPath,
        },
        ...CHILD,
      }).toString(),
      scratch,
    };
  } catch (error) {
    rmSync(scratch, {recursive: true, force: true});
    throw error;
  }
};

test('v2 closure works relocated: real jsdom DOM, local webfetch smoke, jsonc, resources (node)', {timeout: 20000}, async () => {
  await v2Build();
  const {stdout, scratch} = await relocateAndRun(process.execPath, script => [script]);
  try {
    const line = stdout.split('\n').find(l => l.startsWith('OMO_CLOSURE_SMOKE '));
    assert.ok(line, 'smoke script reported: ' + stdout.slice(0, 400));
    const payload = JSON.parse(line.slice('OMO_CLOSURE_SMOKE '.length));
    // Record the jsdom engine advisory without hiding it: this machine's node
    // (v25.x) is outside jsdom 30's engines range, which upstream only
    // documents via package.json engines; the real outcome is that the DOM
    // operations above actually ran.
    assert.ok(payload.jsdomEngines && typeof payload.jsdomEngines.node === 'string', 'jsdom engines recorded');
    console.log('[advisory] jsdom ' + payload.jsdomVersion + ' engines ' + payload.jsdomEngines.node + ' under runtime ' + payload.runtime);
    const closure = (await v2Build()).manifest.closure;
    assert.equal(payload.packageVersion, '3.0.1');
    assert.equal(payload.jsdomVersion, closure.packages.find(p => p.name === 'jsdom').version);
    assert.equal(payload.jsoncVersion, closure.packages.find(p => p.name === 'jsonc-parser').version);
    const source = sourceCompanionManifest();
    assert.equal(payload.companionVersion, source.version);
    assert.equal(payload.companionTag, source.tag);
    assert.deepEqual(payload.skillsFound.sort(), sourceSkillMdPaths());
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});

test('v2 closure works relocated under bun', {timeout: 20000}, async () => {
  const bunBin = '/home/littlekey/.bun/bin/bun';
  if (!existsSync(bunBin)) return;
  await v2Build();
  const {stdout, scratch} = await relocateAndRun(bunBin, script => [script]);
  try {
    const line = stdout.split('\n').find(l => l.startsWith('OMO_CLOSURE_SMOKE '));
    assert.ok(line, 'bun smoke script reported: ' + stdout.slice(0, 400));
    const payload = JSON.parse(line.slice('OMO_CLOSURE_SMOKE '.length));
    assert.equal(payload.jsdomVersion, (await v2Build()).manifest.closure.packages.find(p => p.name === 'jsdom').version);
    assert.equal(payload.companionVersion, sourceCompanionManifest().version);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});

const smokeScriptV1 = `
import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const bundlePath = process.env.OMO_BUNDLE_PATH;
const require = createRequire(bundlePath);
const mod = await import(pathToFileURL(bundlePath).href);
const d = mod.default;
if (!d || d.id !== 'oh-my-opencode-slim' || typeof d.setup !== 'function') {
  throw new Error('unexpected default export: ' + JSON.stringify(Object.keys(mod)));
}
let pkgRoot = null;
{
  let dir = dirname(bundlePath);
  for (let i = 0; i < 10 && !pkgRoot; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed && parsed.name === 'oh-my-opencode-slim') { pkgRoot = dir; break; }
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
}
if (!pkgRoot) throw new Error('runtime package.json walk-up failed from ' + bundlePath);
const nm = join(pkgRoot, 'node_modules') + sep;
const jsdomEntry = require.resolve('jsdom');
if (!jsdomEntry.startsWith(nm)) throw new Error('jsdom escaped the relocated closure: ' + jsdomEntry);
const {JSDOM} = require('jsdom');
const dom = new JSDOM('<!doctype html><body><b>ok</b></body></html>');
if (dom.window.document.querySelector('b').textContent !== 'ok') throw new Error('jsdom DOM operation failed');
// the vendored externals must not be resolvable through node_modules
for (const name of ['jsonc-parser', 'zod', '@opencode-ai/plugin']) {
  let threw = false;
  try { require.resolve(name); } catch { threw = true; }
  if (!threw) throw new Error('vendored ' + name + ' unexpectedly resolvable through node_modules');
  if (existsSync(join(nm, name))) throw new Error('vendored ' + name + ' duplicated under node_modules');
}
console.log('OMO_CLOSURE_SMOKE ' + JSON.stringify({runtime: process.version, ok: true}));
`;

test('v1 relocation: jsdom via closure, vendored externals absent (node)', {timeout: 20000}, async () => {
  const v1 = await v1Build();
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'omo-relocate-v1-'));
  mkdirSync(join(scratch, 'cache'), {recursive: true});
  const relocation = join(scratch, 'inst', 'node_modules', 'oh-my-opencode-slim');
  cpSync(outputRootOf(v1), relocation, {recursive: true});
  const scriptPath = join(scratch, 'omo-smoke-v1.mjs');
  writeFileSync(scriptPath, smokeScriptV1);
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: scratch,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: scratch,
        XDG_CACHE_HOME: join(scratch, 'cache'),
        BUN_INSTALL_CACHE_DIR: join(scratch, 'cache'),
        OMO_BUNDLE_PATH: join(relocation, 'dist/index.js'),
      },
      ...CHILD,
    }).toString();
    const line = stdout.split('\n').find(l => l.startsWith('OMO_CLOSURE_SMOKE '));
    assert.ok(line, 'v1 smoke script reported: ' + stdout.slice(0, 400));
    assert.equal(JSON.parse(line.slice('OMO_CLOSURE_SMOKE '.length)).ok, true);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});
