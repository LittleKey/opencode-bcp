import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {bareExternalSpecifiers, buildOmoIntegration, OMO_TARGETS, omoZodFileURL} from '../build-omo.mjs';

const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PKG_301 = '/home/littlekey/.cache/opencode/packages/oh-my-opencode-slim@3.0.1/node_modules/oh-my-opencode-slim';
const PKG_2225 = '/home/littlekey/.config/opencode/local-plugins/node_modules/oh-my-opencode-slim';
const DEPLOYED_OMO = '/home/littlekey/.config/opencode/local-plugins/dist/omo.js';
// Bounded child processes: node:test's --test-timeout cannot interrupt a sync
// execFileSync (the runner would block forever on a stuck child), so every
// child carries a finite timeout below the runner budget plus a forced
// killSignal; a stuck child fails its test with ETIMEDOUT instead of hanging
// the whole run.
const CHILD_TIMEOUT_MS = 15000;
const CHILD = {stdio: 'pipe', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL'};

// Scratch root for build outputs and syntax probes. Set OMO_BUILD_TEST_OUT to
// keep artifacts in a caller-chosen persistent directory; by default a fresh
// private mkdtemp is created per run and removed in the root after-hook, so
// there is no fixed /tmp date path to go stale or collide across machines/runs.
const PERSISTENT_OUT = process.env.OMO_BUILD_TEST_OUT;
const OUT = PERSISTENT_OUT || mkdtempSync(join(realpathSync(tmpdir()), 'omo-build-test-'));

mkdirSync(OUT, {recursive: true});
if (!PERSISTENT_OUT) after(() => rmSync(OUT, {recursive: true, force: true}));
const uniqueOut = label => {
  const dir = join(OUT, label + '-' + process.pid + '-' + Math.random().toString(36).slice(2));
  rmSync(dir, {recursive: true, force: true});
  return dir;
};
const digest = value => createHash('sha256').update(value).digest('hex');
const syntaxCheck = async content => {
  const file = join(OUT, 'syntax-' + Math.random().toString(36).slice(2) + '.mjs');
  writeFileSync(file, content);
  try {
    execFileSync(process.execPath, ['--check', file], CHILD);
  } finally {
    rmSync(file, {force: true});
  }
};

test('build rejects unknown versions, mismatched params and tampered upstream', async () => {
  await assert.rejects(() => buildOmoIntegration({packageDir: PKG_301, sourceDir: SRC, outputDir: uniqueOut('x'), version: '2.2.26'}), /version must be one of/);
  await assert.rejects(() => buildOmoIntegration({packageDir: PKG_2225, sourceDir: SRC, outputDir: uniqueOut('x'), version: '3.0.1'}), /does not match requested/);
  await assert.rejects(() => buildOmoIntegration({packageDir: PKG_301, sourceDir: SRC, outputDir: uniqueOut('x'), version: '3.0.1', entry: 'tui'}), /Unknown OMO entry/);
  const tampered = uniqueOut('pkg-tampered');
  rmSync(tampered, {recursive: true, force: true});
  execFileSync('cp', ['-a', PKG_301, tampered], CHILD);
  const bundle = join(tampered, 'dist/index.js');
  writeFileSync(bundle, readFileSync(bundle, 'utf8') + '\n// drift\n');
  await assert.rejects(() => buildOmoIntegration({packageDir: tampered, sourceDir: SRC, outputDir: uniqueOut('x'), version: '3.0.1'}), /digest mismatch/);
  rmSync(tampered, {recursive: true, force: true});
});

test('patchOmo rejects any source not matching the pinned digests', async () => {
  const {patchOmo} = await import('../omo-patch.mjs');
  assert.throws(() => patchOmo('const x = 1\n'), /Unsupported oh-my-opencode-slim source/);
  const stock = readFileSync(join(PKG_301, 'dist/index.js'), 'utf8');
  assert.throws(() => patchOmo(stock + '// changed'), /Unsupported oh-my-opencode-slim source/);
});

test('3.0.1 v1 build: externals vendored to relative specifiers, helpers beside dist, manifest deterministic', async () => {
  const out = uniqueOut('v1');
  const {manifest, files} = await buildOmoIntegration({packageDir: PKG_301, sourceDir: SRC, outputDir: out, version: '3.0.1', entry: 'index'});
  const bundle = readFileSync(join(out, 'dist/index.js'), 'utf8');
  assert.equal(manifest.version, '3.0.1');
  assert.equal(manifest.entry, 'index');
  assert.equal(manifest.upstream.digest, OMO_TARGETS['3.0.1'].entries.index);
  // every external import is rewritten to the vendored runtime closure
  assert.equal(bundle.split('from "../vendor/@opencode-ai/plugin/dist/index.js"').length - 1, 12, 'all 12 plugin imports vendored');
  assert.equal(bundle.split('from "../vendor/jsonc-parser/lib/esm/main.js"').length - 1, 3, 'all 3 jsonc-parser imports vendored (ESM build: node cannot take named imports from the UMD build)');
  assert.equal(bundle.split('from "../vendor/zod/index.js"').length - 1, 8, 'all 8 static zod imports vendored');
  assert.equal(bundle.split('import("../vendor/zod/index.js")').length - 1, 1, 'single dynamic zod import vendored');
  assert.deepEqual(manifest.zod, {strategy: 'vendored', resolved: '../vendor/zod/index.js', occurrences: 8, dynamicOccurrences: 1});
  assert.equal(bundle.includes('from "@opencode-ai/plugin"'), false, 'real 1.18.33 load failure (Cannot find module) must be impossible');
  assert.equal(bundle.includes('from "zod"'), false, 'no bare static zod import remains');
  assert.equal(bundle.includes('from "jsonc-parser"'), false, 'no bare jsonc-parser import remains');
  assert.deepEqual(bareExternalSpecifiers(bundle), [], 'closure assertion: no bare non-node module imports remain');
  for (const occurrence of [...bundle.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(m => m[1])) {
    assert.ok(!occurrence.includes('file://') && !occurrence.includes('/home/'), 'no absolute import pinning: ' + occurrence);
  }
  // vendored closure on disk matches the manifest byte-for-byte
  assert.deepEqual(manifest.vendor.map(v => v.name), ['@opencode-ai/plugin', 'jsonc-parser', 'zod']);
  for (const vendored of manifest.vendor) {
    assert.ok(vendored.files.length > 0, vendored.name + ' ships runtime files');
    for (const file of vendored.files) {
      assert.ok(existsSync(join(out, file.path)), file.path + ' written');
      assert.equal(digest(readFileSync(join(out, file.path), 'utf8')), file.digest, file.path + ' digest matches manifest');
    }
    for (const rewrite of vendored.rewrites) {
      const fileBody = readFileSync(join(out, rewrite.file), 'utf8');
      // rewrite targets appear quoted with either quote style (jsonc-parser's
      // ESM build uses single quotes; extension rewrites preserve them)
      assert.ok(fileBody.includes('"' + rewrite.to + '"') || fileBody.includes("'" + rewrite.to + "'"), rewrite.file + ' carries rewrite to ' + rewrite.to);
    }
  }
  for (const helper of ['omo-delivery.mjs']) {
    assert.equal(readFileSync(join(out, helper), 'utf8'), readFileSync(join(SRC, helper), 'utf8'), 'helper copied byte-identical');
  }
  assert.equal(existsSync(join(out, 'omo-council.mjs')), false, 'council helper must not ship with 3.0.1 (upstream Council)');
  assert.ok(bundle.includes('from "../omo-delivery.mjs"'));
  assert.equal(bundle.includes('omo-council.mjs'), false, 'no council helper import on 3.0.1');
  assert.equal(manifest.helpers.length, 1);
  // determinism: same inputs → byte-identical code artifacts (manifest embeds
  // this build's absolute locations by design, so compare code only)
  const second = await buildOmoIntegration({packageDir: PKG_301, sourceDir: SRC, outputDir: uniqueOut('v1b'), version: '3.0.1', entry: 'index'});
  const code = files => files.filter(f => f.content !== undefined && !f.path.endsWith('manifest.json')).map(f => f.content);
  assert.deepEqual(code(second.files), code(files));
  // syntax
  await syntaxCheck(bundle);
});

test('3.0.1 v1 artifact loads standalone: clean cwd/HOME, vendored deps not duplicated in node_modules (real import on node and bun)', async () => {
  const out = uniqueOut('load');
  await buildOmoIntegration({packageDir: PKG_301, sourceDir: SRC, outputDir: out, version: '3.0.1', entry: 'index'});
  // the v1 entry ships the lazily-resolved jsdom closure (webfetch), but its
  // vendored externals must never be duplicated under node_modules
  assert.equal(existsSync(join(out, 'node_modules', 'jsdom', 'package.json')), true, 'artifact ships the jsdom closure for the lazy webfetch loader');
  assert.equal(existsSync(join(out, 'node_modules', 'zod')), false, 'vendored zod is not duplicated under node_modules');
  assert.equal(existsSync(join(out, 'node_modules', 'jsonc-parser')), false, 'vendored jsonc-parser is not duplicated under node_modules');
  assert.equal(existsSync(join(out, 'node_modules', '@opencode-ai')), false, 'vendored plugin is not duplicated under node_modules');
  const importScript = 'const mod = await import(process.env.OMO_BUNDLE_URL); const d = mod.default;' +
    ' if (!d || d.id !== "oh-my-opencode-slim" || typeof d.setup !== "function")' +
    ' throw new Error("unexpected default export: " + JSON.stringify(Object.keys(mod))); console.log("loaded", d.id);';
  const bunBin = '/home/littlekey/.bun/bin/bun';
  for (const [label, command, args] of [
    ['node', process.execPath, ['--input-type=module', '-e', importScript]],
    ...(existsSync(bunBin) ? [['bun', bunBin, ['-e', importScript]]] : []),
  ]) {
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'omo-load-'));
    mkdirSync(join(scratch, 'cache'), {recursive: true});
    try {
      const stdout = execFileSync(command, args, {
        cwd: scratch,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: scratch,
          XDG_CACHE_HOME: join(scratch, 'cache'),
          BUN_INSTALL_CACHE_DIR: join(scratch, 'cache'),
          OMO_BUNDLE_URL: pathToFileURL(join(out, 'dist/index.js')).href,
        },
        ...CHILD,
      }).toString();
      assert.ok(stdout.includes('loaded oh-my-opencode-slim'), label + ' loaded the artifact with an empty HOME and no node_modules');
    } finally {
      rmSync(scratch, {recursive: true, force: true});
    }
  }
});

test('3.0.1 v2 build: no zod rewrite needed, helper imports climb two levels, output compiles', async () => {
  const out = uniqueOut('v2');
  const {manifest} = await buildOmoIntegration({packageDir: PKG_301, sourceDir: SRC, outputDir: out, version: '3.0.1', entry: 'server'});
  const bundle = readFileSync(join(out, 'dist/server/index.js'), 'utf8');
  assert.equal(manifest.upstream.digest, OMO_TARGETS['3.0.1'].entries.server);
  assert.equal(manifest.zod.strategy, 'bundled');
  assert.ok(bundle.includes('from "../../omo-delivery.mjs"'), 'helpers resolved two levels up');
  assert.equal(bundle.includes('omo-council.mjs'), false, 'no council helper import on 3.0.1');
  assert.equal(bundle.includes('from "zod"'), false);
  await syntaxCheck(bundle);
});

test('2.2.25 rollback build is byte-identical to the deployed integration', async () => {
  assert.ok(existsSync(DEPLOYED_OMO), 'deployed omo.js must exist for the rollback check');
  const out = uniqueOut('legacy');
  const {manifest} = await buildOmoIntegration({packageDir: PKG_2225, sourceDir: SRC, outputDir: out, version: '2.2.25', entry: 'index'});
  const zodURL = omoZodFileURL(PKG_2225);
  assert.equal(manifest.zod.occurrences, 4);
  const bundle = readFileSync(join(out, 'dist/index.js'), 'utf8');
  assert.equal(bundle, readFileSync(DEPLOYED_OMO, 'utf8'), 'legacy output must reproduce the deployed integration byte-for-byte');
});

const stockBundles = () => ({
  index: readFileSync(join(PKG_301, 'dist/index.js'), 'utf8'),
  server: readFileSync(join(PKG_301, 'dist/server/index.js'), 'utf8'),
});
const anchorFor = (patch, entry) => (typeof patch.anchor === 'string' ? patch.anchor : patch.anchor[entry]);

// Shape locks against unmodified upstream: stock 3.0.1 carries none of the BCP
// injection markers (so retained repairs cannot double-apply), and every retained
// repair targets an existing, unique upstream site (so application stays safe).
// This is a TEXTUAL shape check only: marker/anchor absence or presence is NOT
// proof that an upstream runtime lifecycle bug still exists or is fixed — that is
// decided by behavior verification in the acceptance lane, not here.
test('stock 3.0.1 shape locks on both entries: no BCP markers, retained-repair anchors unique', async () => {
  const {PATCHES_3_0_1} = await import('../omo-patch.mjs');
  for (const [entry, stock] of Object.entries(stockBundles())) {
    assert.equal(createHash('sha256').update(stock).digest('hex'), OMO_TARGETS['3.0.1'].entries[entry]);
    for (const marker of ['bcp_delivery', 'acknowledgeInjectedNativeResume', 'nativeCallStartedAt']) {
      assert.equal(stock.includes(marker), false, `stock ${entry} unexpectedly already provides ${marker}`);
    }
    // upstream council procedure is kept byte-identical on 3.0.1; lock its shape
    // (present exactly once) so the no-splice guarantee stays checkable
    assert.equal(stock.split('1. If the question references an external resource (PR, URL, issue, doc)').length - 1, 1, `upstream council procedure not unique in stock ${entry}`);
    assert.equal(stock.split("5. Present the council's synthesized report.").length - 1, 1, `council presentation step not unique in stock ${entry}`);
    // every retained repair targets an existing, unique upstream site — the stock
    // shape itself is locked here, independently of patchOmo's runtime assert
    for (const patch of PATCHES_3_0_1) {
      assert.equal(stock.split(anchorFor(patch, entry)).length - 1, 1, `anchor of ${patch.id} not unique in stock ${entry}`);
    }
  }
});

test('patched 3.0.1 output carries every retained repair, keeps upstream Council byte-identical, preserves untouched text on both entries', async () => {
  const {patchOmo, PATCHES_3_0_1} = await import('../omo-patch.mjs');
  for (const [entry, stock] of Object.entries(stockBundles())) {
    const patched = patchOmo(stock, {version: '3.0.1', entry});
    assert.ok(patched.startsWith('import { deliveryMetadata'), `helper prelude missing on ${entry}`);
    for (const marker of ['bcp_delivery', 'acknowledgeInjectedNativeResume', 'nativeCallStartedAt']) {
      assert.ok(patched.includes(marker), `patched ${entry} lost ${marker}`);
    }
    // upstream Council stays byte-identical: no private agenda splice, no
    // finalizeCouncil/prepareCouncilPrompt wiring, no council helper import
    for (const marker of ['prepareCouncilPrompt', 'finalizeCouncil', 'council_host_sources', 'omo-council.mjs']) {
      assert.equal(patched.includes(marker), false, `patched ${entry} unexpectedly injects ${marker}`);
    }
    assert.equal(patched.split('1. If the question references an external resource (PR, URL, issue, doc)').length - 1, 1, `upstream council procedure lost on ${entry}`);
    assert.equal(patched.split("5. Present the council's synthesized report.").length - 1, 1, `council presentation step lost on ${entry}`);
    // the wired delivery helper owns the runtime receipt surface
    assert.ok(readFileSync(join(SRC, 'omo-delivery.mjs'), 'utf8').includes('bcp_delivery_metadata'), 'delivery helper lost receipt metadata');
    // every anchor substituted exactly as specified: the surviving occurrence
    // count equals the occurrences embedded in the replacement itself (zero for
    // replace-style patches, one for prefix-insertion patches) — no lost or
    // duplicated anchor context
    for (const patch of PATCHES_3_0_1) {
      const replacement = typeof patch.replacement === 'string' ? patch.replacement : patch.replacement[entry];
      const expected = replacement.split(anchorFor(patch, entry)).length - 1;
      assert.equal(patched.split(anchorFor(patch, entry)).length - 1, expected, `${patch.id} anchor substitution wrong in patched ${entry}`);
    }
    await syntaxCheck(patched);
  }
});

test('builder contract: manifest pins upstream digest, patch list and helper digests for both entries', async () => {
  const {describeOmoPatches, PATCHES_3_0_1} = await import('../omo-patch.mjs');
  const expectedPatches = describeOmoPatches('3.0.1');
  assert.equal(expectedPatches.length, PATCHES_3_0_1.length, 'describeOmoPatches must list every 3.0.1 patch');
  assert.equal(expectedPatches[0].id, 'ack-injected-resume-def');
  assert.equal(expectedPatches[expectedPatches.length - 1].id, 'revive-render-delivery');
  assert.equal(expectedPatches.some(p => p.id.startsWith('council-')), false, '3.0.1 must not list private council patches (upstream Council)');
  for (const entry of ['index', 'server']) {
    const out = uniqueOut('contract-' + entry);
    const {manifest} = await buildOmoIntegration({packageDir: PKG_301, sourceDir: SRC, outputDir: out, version: '3.0.1', entry});
    assert.equal(manifest.name, 'oh-my-opencode-slim');
    assert.equal(manifest.version, '3.0.1');
    assert.equal(manifest.entry, entry);
    assert.equal(manifest.upstream.digest, OMO_TARGETS['3.0.1'].entries[entry]);
    assert.deepEqual(manifest.patches, expectedPatches);
    assert.deepEqual(manifest.helpers.map(h => h.file.split('/').pop()), ['omo-delivery.mjs']);
    for (const helper of manifest.helpers) {
      assert.equal(helper.digest, digest(readFileSync(join(SRC, helper.file.split('/').pop()), 'utf8')), 'manifest helper digest must match the lane source byte-for-byte');
    }
    // manifest on disk is the returned manifest, and the bundle on disk carries
    // the manifest's recorded digest
    const persisted = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(persisted, manifest);
    const bundlePath = entry === 'index' ? join(out, 'dist/index.js') : join(out, 'dist/server/index.js');
    assert.equal(manifest.bundle.digest, digest(readFileSync(bundlePath, 'utf8')));
  }
});

// Behavior verification of the native terminal identity binding, executed
// against the REAL patched bundle: the v2 client shim (buildPluginInput →
// client.session.messages → toV1Message/toV1Transcript) and the terminal
// classifier (classifyTerminalEvidence → verdictFromEvidence) are extracted
// verbatim from the built output (not re-implemented) and driven with the REAL
// v2 host message shapes recorded in the failing dual-host case
// (user {id,time,type,text}, assistant {content[],finish,time.completed,agent},
// synthetic {type:"idle"}). Off-path diagnostics/bookkeeping helpers (log and
// the internal synthetic admission bookkeeping inside promptAsync) are stubbed;
// every function on the identity path is the bundle's own code. End-to-end
// attribution on a live host is the acceptance lane's serial real-host run;
// this test proves the identity source itself.

// Extract top-level declarations (column-0 `function NAME(`/`var NAME = `)
// with balanced braces, skipping string literals and comments.
function extractDeclarations(source, names) {
  const skipString = (text, start) => {
    const quote = text[start];
    for (let i = start + 1; i < text.length; i += 1) {
      if (text[i] === '\\') { i += 1; continue; }
      if (text[i] === quote) return i;
    }
    throw new Error('unterminated string during extraction');
  };
  const sliceDeclaration = (text, declStart) => {
    // locate the body-opening brace: the first '{' at paren depth 0 (skips
    // default params like `options2 = {}`); a ';' at depth 0 ends a plain var
    let paren = 0, braceAt = -1, semiAt = -1;
    for (let i = declStart; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '"' || ch === "'" || ch === '`') { i = skipString(text, i); continue; }
      if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
      if (ch === '(') paren += 1;
      else if (ch === ')') paren -= 1;
      else if (ch === '{' && paren === 0) { braceAt = i; break; }
      else if (ch === ';' && paren === 0) { semiAt = i; break; }
    }
    if (braceAt < 0) {
      const lineEnd = text.indexOf('\n', semiAt);
      return text.slice(declStart, lineEnd);
    }
    let depth = 0;
    for (let i = braceAt; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '"' || ch === "'" || ch === '`') { i = skipString(text, i); continue; }
      if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
      if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) return text.slice(declStart, i + 1); }
    }
    throw new Error('unbalanced declaration extraction');
  };
  const pieces = [];
  for (const name of names) {
    let start = -1;
    for (const intro of [`\nfunction ${name}(`, `\nvar ${name} = `]) {
      const at = source.indexOf(intro);
      if (at >= 0 && (start < 0 || at < start)) start = at;
    }
    assert.ok(start >= 0, `declaration of ${name} present in the patched bundle`);
    pieces.push(sliceDeclaration(source, start));
  }
  return pieces.join('\n');
}

test('v2 facade identity chain: real host shapes map to classifier-ready transcripts with bound input/terminal identity (extracted from the patched bundle)', async () => {
  const {patchOmo} = await import('../omo-patch.mjs');
  const patched = patchOmo(stockBundles().server, {version: '3.0.1', entry: 'server'});
  const extracted = extractDeclarations(patched, [
    // terminal classifier chain, verbatim
    'isRecord3', 'responseError', 'stringifyError', 'verdictFromEvidence', 'classifyTerminalEvidence', 'classifyAssistantTurnEvidence',
    // v2 client shim, verbatim
    'INTERNAL_INITIATOR_METADATA_KEY', 'isInternalInitiatorPart', 'resolveV2Directory', 'sessionIDOf',
    'textFromBody', 'filesFromBody', 'modelRefFromBody', 'internalInitiatorMetadataFromBody', 'isPureInternalInitiatorBody',
    'toV1Message', 'toV1Transcript', 'toV1SessionInfo', 'warnedListUnavailable', 'warnedRemoveUnavailable',
    'resetClientShimGenerationWarnings', 'createSessionListShim', 'buildPluginInput',
  ]);
  // log + internal synthetic admission bookkeeping are off the identity path
  const load = new Function('log', 'createInternalSyntheticMessageID', 'recordInternalAdmission', extracted + `
    return {buildPluginInput, classifyTerminalEvidence};`);
  if (process.env.OMO_DEBUG_EXTRACT) (await import('node:fs')).writeFileSync(process.env.OMO_DEBUG_EXTRACT, extracted);
  const {buildPluginInput, classifyTerminalEvidence} = load(() => {}, () => 'msg_synth', () => {});

  const SID = 'ses_child_v2case';
  // REAL v2 host message shapes; IDs verbatim from the failing dual-host case
  // (collaboration/cases/v2-native-identity/artifacts/child-messages.json):
  // user text is a flat `text` field, assistant carries content[]/finish/time.completed,
  // synthetic session-idle markers are type "idle", and no message carries parentID.
  const realV2Child = [
    {id: 'msg_0f54c9dc8001o3g6CIxCY9bdnt', type: 'user', time: {created: 1790821834224}, text: 'first native delegation prompt'},
    {id: 'msg_0f54c9df9001q0I1Ye25xFfe2b', type: 'assistant', agent: 'fixer', model: {id: 'fixture-worker', providerID: 'fixture', variant: 'default'}, finish: 'stop', time: {created: 1790821834269, streamed: 1790821834295, completed: 1790821834298}, content: [{type: 'text', text: 'final answer one'}]},
    {id: 'msg_0f54c9e4100120J5X7ch3j2Qs3', type: 'idle', time: {created: 1790821834305}, outcome: {reason: 'session idle'}},
    {id: 'msg_0f54ca22a001FVK5GdIgF6eVZK', type: 'user', time: {created: 1790821835346}, text: 'resume prompt'},
    {id: 'msg_0f54ca25c001h2MNp9jvVNP1jj', type: 'assistant', agent: 'fixer', model: {id: 'fixture-worker', providerID: 'fixture', variant: 'default'}, finish: 'stop', time: {created: 1790821835378, streamed: 1790821835397, completed: 1790821835399}, content: [{type: 'text', text: 'final answer two'}]},
    {id: 'msg_0f54ca28b001r9x2O1i24XvAa9', type: 'idle', time: {created: 1790821835403}, outcome: {reason: 'session idle'}},
  ];
  const input1 = 'msg_0f54c9dc8001o3g6CIxCY9bdnt';
  const term1 = 'msg_0f54c9df9001q0I1Ye25xFfe2b';
  const input2 = 'msg_0f54ca22a001FVK5GdIgF6eVZK';
  const term2 = 'msg_0f54ca25c001h2MNp9jvVNP1jj';

  // the exact facade construction and transcript read the plugin performs on v2
  const pluginInput = buildPluginInput({session: {context: async () => realV2Child}, location: {directory: '/w'}}, {});
  assert.equal(pluginInput.hostFlavor, 'v2');
  const response = await pluginInput.client.session.messages({path: {id: SID}, query: {directory: '/w'}});

  // mapping: the v2 user text enters transcript parts (flat text field), assistant content passes through
  assert.deepEqual(response.data[0].parts, [{type: 'text', text: 'first native delegation prompt'}]);
  assert.deepEqual(response.data[4].parts, [{type: 'text', text: 'final answer two'}]);
  // association: each assistant binds to the NEAREST PRECEDING REAL user input;
  // synthetic (idle→system) never poses as user input and never carries identity
  assert.equal(response.data[1].info.parentID, input1);
  assert.equal(response.data[2].info.role, 'system');
  assert.equal(response.data[2].info.parentID, undefined, 'synthetic never carries input identity');
  assert.equal(response.data[3].info.parentID, undefined, 'user entries never carry parentID');
  assert.equal(response.data[4].info.parentID, input2, 'same-child round 2 binds to its own input');

  // classification through the exact path the native completion branch reads
  // (classifyTerminalEvidence already returns the final verdict object)
  const ready = classifyTerminalEvidence(response, {});
  assert.equal(ready.verdict, 'completed');
  assert.deepEqual(ready.bcpOrigin, {inputMessageID: input2, terminalMessageID: term2},
    'input/terminal message identity is bound from real host messages (bridge no_terminal_identity precondition removed)');

  // baseline path: a native continuation attributes the segment after the previous terminal message
  const continued = classifyTerminalEvidence(response, {baselineMessageID: term1});
  assert.equal(continued.verdict, 'completed');
  assert.deepEqual(continued.bcpOrigin, {inputMessageID: input2, terminalMessageID: term2});

  // a completion older than the observed run stays absent (fail-closed staleness)
  assert.deepEqual(classifyTerminalEvidence(response, {runStartedAt: 1790821835399 + 1}), {verdict: 'absent'});

  // fail-closed: no preceding real user → parentID stays undefined → the delivery
  // bridge precondition (!inputMessageID → no_terminal_identity) still holds; nothing is invented
  const orphanFacade = buildPluginInput({session: {context: async () => [realV2Child[1], realV2Child[2]]}}, {});
  const orphanResponse = await orphanFacade.client.session.messages({path: {id: SID}, query: {directory: '/w'}});
  const orphan = classifyTerminalEvidence(orphanResponse, {});
  assert.equal(orphan.verdict, 'completed');
  assert.equal(orphan.bcpOrigin.terminalMessageID, term1);
  assert.equal(orphan.bcpOrigin.inputMessageID, undefined, 'no input identity is guessed');

  // a host-provided parentID wins over the nearest-user inference
  const linkedFacade = buildPluginInput({session: {context: async () => [realV2Child[0], {...realV2Child[1], parentID: 'msg_host_input'}]}}, {});
  const linkedResponse = await linkedFacade.client.session.messages({path: {id: SID}, query: {directory: '/w'}});
  assert.equal(linkedResponse.data[1].info.parentID, 'msg_host_input');

  // paginated transcript path: desc page rebuilt ascending with the same binding
  let pagedArgs;
  const pagedFacade = buildPluginInput({session: {
    context: async () => realV2Child,
    messages: async args => { pagedArgs = args; return {data: [...realV2Child].reverse()}; },
  }}, {});
  const pagedResponse = await pagedFacade.client.session.messages({path: {id: SID}, query: {directory: '/w', limit: 200}});
  assert.deepEqual(pagedArgs, {sessionID: SID, limit: 200, order: 'desc'});
  assert.deepEqual(pagedResponse.data.map(entry => entry.info.id), realV2Child.map(entry => entry.id));
  assert.equal(pagedResponse.data[4].info.parentID, input2);

  // malformed transcript entries fail closed in the classifier (no guessing)
  const junkFacade = buildPluginInput({session: {context: async () => [{}, realV2Child[1]]}}, {});
  const junkResponse = await junkFacade.client.session.messages({path: {id: SID}, query: {directory: '/w'}});
  assert.deepEqual(classifyTerminalEvidence(junkResponse, {}), {verdict: 'retry', reason: 'malformed transcript entries'});
});

// Behavior verification of the delivery helper that shapes the native completion
// branch: metadata is only confirmable with real host identity, and receipts
// replace the original only on exact whole-byte proof. Direct ESM import of the
// shipped helper.
test('delivery helper: no_terminal_identity without host identity, confirmed identity binds input+terminal, receipts elide only exact bytes', async () => {
  const delivery = await import('../omo-delivery.mjs');
  const directory = '/tmp/whatever-project';
  const baseRecord = {
    parentSessionID: 'ses_parent0001',
    taskID: 'ses_child0001',
    generation: 3,
    terminalRevision: 1,
    state: 'completed',
  };
  // no bridge → unknown(bcp_unavailable)
  assert.equal((await delivery.deliveryMetadata(directory, baseRecord)).reason, 'bcp_unavailable');
  // without bcpOrigin the bridge request carries NO identity (the exact precondition of the bridge's no_terminal_identity verdict)
  let seenRequest;
  globalThis[Symbol.for('opencode.bcp.delivery.v1')] = new Map([[directory, async request => {
    seenRequest = request;
    return {schema_version: 1, association: 'unconfirmed', reason: 'no_terminal_identity'};
  }]]);
  try {
    await delivery.deliveryMetadata(directory, baseRecord);
    assert.equal(seenRequest.inputMessageID, undefined);
    assert.equal(seenRequest.terminalMessageID, undefined);
    assert.equal(seenRequest.callerSessionID, 'ses_parent0001');
    assert.equal(seenRequest.taskID, 'ses_child0001');
    assert.equal(seenRequest.state, 'completed');
    // with bcpOrigin both identities are bound and passed through
    const record = {...baseRecord, bcpOrigin: {inputMessageID: 'msg_in1', terminalMessageID: 'msg_term1'}};
    await delivery.deliveryMetadata(directory, record);
    assert.equal(seenRequest.inputMessageID, 'msg_in1');
    assert.equal(seenRequest.terminalMessageID, 'msg_term1');
    // reconciled state maps to terminalState
    await delivery.deliveryMetadata(directory, {...record, state: 'reconciled', terminalState: 'completed'});
    assert.equal(seenRequest.state, 'completed');
    // bridge failure → unknown(inspection_unavailable); oversized response → metadata_size_limit
    globalThis[Symbol.for('opencode.bcp.delivery.v1')] = new Map([[directory, async () => {
      throw new Error('bridge down');
    }]]);
    assert.equal((await delivery.deliveryMetadata(directory, record)).reason, 'inspection_unavailable');
    globalThis[Symbol.for('opencode.bcp.delivery.v1')] = new Map([[directory, async () => 'x'.repeat(70000)]]);
    assert.equal((await delivery.deliveryMetadata(directory, record)).reason, 'metadata_size_limit');
    // slow bridge → unknown(inspection_timeout) after the 2s bound
    globalThis[Symbol.for('opencode.bcp.delivery.v1')] = new Map([[directory, () => new Promise(() => {})]]);
    const started = Date.now();
    assert.equal((await delivery.deliveryMetadata(directory, record)).reason, 'inspection_timeout');
    assert.ok(Date.now() - started >= 1900, 'timeout waits the bounded 2s window');
  } finally {
    delete globalThis[Symbol.for('opencode.bcp.delivery.v1')];
  }
  // receipt elision: a verified reference replaces the exact original
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const original = 'RESULT-'.repeat(1200) + 'END'; // > REFERENCE_MIN_BYTES bytes
  const reference = {
    id: 'bb://01234567-89ab-cdef-0123-456789abcdef/01234567-89ab-cdef-0123-456789abcdef/e000001',
    bytes: Buffer.byteLength(original),
    text_sha256: sha256(original),
    description: 'final result',
    writer: {session_id: 'ses_child0001', message_id: 'msg_term1', agent: 'fixer'},
    input_message_id: 'msg_in1',
  };
  const metadata = {
    schema_version: 1,
    execution: {task_id: 'ses_child0001', generation: 3, terminal_revision: 1, state: 'completed',
      input_message_id: 'msg_in1', terminal_message_id: 'msg_term1'},
    association: 'host_message_identity',
    reason: undefined,
    candidates: [],
    coverage: 'exact',
    applicability: 'current',
    result_reference: reference,
  };
  const elided = delivery.presentDelivery(original, metadata);
  assert.ok(elided.includes('<bcp_result_reference>'), 'receipt replaces the original');
  assert.ok(!elided.includes('RESULT-'), 'original body elided');
  assert.ok(elided.includes('board_get'), 'receipt carries the read instruction');
  // exact body inside the native task_result wrapper is also elidable
  const native = 'task_id: ses_child0001 (for resuming to continue this task if needed)\n\n<task_result>\n' + original + '\n</task_result>';
  const nativeElided = delivery.presentDelivery(native, metadata);
  assert.ok(nativeElided.includes('<bcp_result_reference>'));
  assert.ok(!nativeElided.includes('RESULT-'), 'wrapper body elided');
  // refusal cases keep the original untouched:
  assert.equal(delivery.presentDelivery(original, {...metadata, association: 'unconfirmed'}), original, 'unconfirmed association never elides');
  assert.equal(delivery.presentDelivery(original, {...metadata, result_reference: {...reference, text_sha256: sha256(original + 'x')}}), original, 'hash mismatch never elides');
  assert.equal(delivery.presentDelivery(original, {...metadata, result_reference: {...reference, bytes: reference.bytes - 1}}), original, 'byte-count mismatch never elides');
  assert.equal(delivery.presentDelivery(original, {...metadata, result_reference: {...reference, writer: {...reference.writer, message_id: 'msg_other'}}}), original, 'writer identity mismatch never elides');
  assert.equal(delivery.presentDelivery(original, {...metadata, result_reference: {...reference, input_message_id: 'msg_other'}}), original, 'input identity mismatch never elides');
  assert.equal(delivery.presentDelivery(original, {...metadata, execution: {...metadata.execution, state: 'running'}}), original, 'non-terminal execution never elides');
  assert.equal(delivery.presentDelivery(original.slice(0, 8000), metadata), original.slice(0, 8000), 'below REFERENCE_MIN_BYTES never elides');
  assert.equal(delivery.presentDelivery(original, {...metadata, result_reference: {...reference, id: 'not-a-bb-id'}}), original, 'malformed id never elides');
  // wrapped body whose wrapper names another task never elides
  const foreign = 'task_id: ses_other (for resuming to continue this task if needed)\n\n<task_result>\n' + original + '\n</task_result>';
  assert.equal(delivery.presentDelivery(foreign, metadata), foreign, 'foreign task wrapper never elides');
});

// Native v2 completion shape: the upstream subagent tool part renders the child
// body wrapped in `<subagent sessionID=… state="completed">`, not the v1
// `<task_result>` wrapper. The fixture is the exact byte-for-byte replay of a
// real live v2 completion capture (dual-host 2.0 freshness lane, tool part
// call-handoff-1 of ses_f04e92aabffeoftWYBSMqarQvr; body 11604 bytes,
// sha256 1ece6530…292a == result_reference.text_sha256), including the
// delivery metadata suffix annotateDeliveryPart appends after presentation.
test('delivery helper: native v2 subagent wrapper elides only the exact session-bound body, wrapper kept byte-for-byte', async () => {
  const delivery = await import('../omo-delivery.mjs');
  const captured = readFileSync(join(SRC, 'test/fixtures/v2-native-subagent-capture.txt'), 'utf8');
  assert.equal(digest(captured), '6f9e0d66273ca38a3c6716371c627487f046a199065203bc6055778ff6b4598a', 'fixture is the unmodified real live capture');
  // the fixture ends with the metadata suffix that annotateDeliveryPart appends afterwards
  const MARK = '\n\n<bcp_delivery_metadata>\n';
  const markAt = captured.lastIndexOf(MARK);
  assert.ok(markAt > 0, 'fixture carries the delivery metadata block');
  const metadata = JSON.parse(captured.slice(markAt + MARK.length, captured.length - '\n</bcp_delivery_metadata>'.length).replaceAll('\\u003c', '<'));
  const suffix = delivery.deliverySuffix(metadata);
  assert.ok(captured.endsWith(suffix), 'fixture tail is exactly the helper delivery suffix');
  const presentedText = captured.slice(0, captured.length - suffix.length);
  // exact real bounds derived from the confirmed metadata, not hardcoded text
  const SID = metadata.execution.task_id;
  const OPEN = '<subagent sessionID="' + SID + '" state="completed">\n';
  const CLOSE = '\n</subagent>';
  assert.ok(presentedText.startsWith(OPEN) && presentedText.endsWith(CLOSE), 'exact real v2 wrapper bounds');
  const body = presentedText.slice(OPEN.length, presentedText.length - CLOSE.length);
  assert.equal(Buffer.byteLength(body), metadata.result_reference.bytes, 'body byte count matches the reference');
  assert.equal(digest(body), metadata.result_reference.text_sha256, 'body hash matches the reference');
  // presentation keeps the wrapper byte-for-byte and elides only the exact body
  const presented = delivery.presentDelivery(presentedText, metadata);
  assert.ok(presented.startsWith(OPEN), 'wrapper open preserved byte-for-byte');
  assert.ok(presented.endsWith(CLOSE), 'wrapper close preserved byte-for-byte');
  const receipt = presented.slice(OPEN.length, presented.length - CLOSE.length);
  assert.ok(receipt.startsWith('<bcp_result_reference>\n') && receipt.endsWith('\n</bcp_result_reference>'), 'receipt replaces only the body region');
  const receiptRef = JSON.parse(receipt.slice('<bcp_result_reference>\n'.length, -'\n</bcp_result_reference>'.length).replaceAll('\\u003c', '<'));
  assert.equal(receiptRef.id, metadata.result_reference.id, 'receipt carries the same reference id');
  assert.ok(Buffer.byteLength(receipt) < metadata.result_reference.bytes, 'receipt is shorter than the original');
  assert.ok(!presented.includes('Deterministic verification'), 'original body content elided');
  // idempotent: already-annotated text (suffix present) is never re-processed
  assert.equal(delivery.presentDelivery(captured, metadata), captured, 'annotated text is not re-processed');
  // refusal cases on the real shape keep the input untouched:
  const otherSession = presentedText.replace(OPEN, '<subagent sessionID="ses_otherchild00000000000000000" state="completed">\n');
  assert.equal(delivery.presentDelivery(otherSession, metadata), otherSession, 'wrong session wrapper never elides');
  for (const state of ['running', 'failed']) {
    const wrong = presentedText.replace(OPEN, '<subagent sessionID="' + SID + '" state="' + state + '">\n');
    assert.equal(delivery.presentDelivery(wrong, metadata), wrong, state + ' wrapper never elides');
  }
  const extraPrefix = 'preamble\n' + presentedText;
  assert.equal(delivery.presentDelivery(extraPrefix, metadata), extraPrefix, 'extra prefix never elides');
  const extraTail = presentedText + '\npostamble';
  assert.equal(delivery.presentDelivery(extraTail, metadata), extraTail, 'extra tail never elides');
  const repeatedClose = presentedText + CLOSE;
  assert.equal(delivery.presentDelivery(repeatedClose, metadata), repeatedClose, 'repeated close never elides');
  const nested = OPEN + presentedText + CLOSE;
  assert.equal(delivery.presentDelivery(nested, metadata), nested, 'nested wrapper never elides');
  const tampered = presentedText.slice(0, OPEN.length) + 'X' + presentedText.slice(OPEN.length + 1);
  assert.equal(delivery.presentDelivery(tampered, metadata), tampered, 'body drift never elides');
  const noNewline = presentedText.replace(OPEN, '<subagent sessionID="' + SID + '" state="completed">');
  assert.equal(delivery.presentDelivery(noNewline, metadata), noNewline, 'wrapper without the exact open newline never elides');
  // same behavior on a synthetic shape (independent of the live fixture bytes)
  const syntheticBody = 'V2-' + 'RESULT-'.repeat(1180) + 'END'; // > REFERENCE_MIN_BYTES bytes
  const syntheticMeta = {
    ...metadata,
    result_reference: {
      ...metadata.result_reference,
      id: 'bb://01234567-89ab-cdef-0123-456789abcdef/01234567-89ab-cdef-0123-456789abcdef/e000009',
      bytes: Buffer.byteLength(syntheticBody),
      text_sha256: digest(syntheticBody),
    },
  };
  const synthetic = OPEN + syntheticBody + CLOSE;
  const syntheticElided = delivery.presentDelivery(synthetic, syntheticMeta);
  assert.ok(syntheticElided.startsWith(OPEN) && syntheticElided.endsWith(CLOSE), 'synthetic wrapper bounds preserved');
  assert.ok(syntheticElided.includes('<bcp_result_reference>'), 'synthetic body replaced by receipt');
  assert.ok(!syntheticElided.includes('V2-RESULT-'), 'synthetic body elided');
});
