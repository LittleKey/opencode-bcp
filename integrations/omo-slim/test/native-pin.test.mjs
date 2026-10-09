import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildOmoIntegration, OMO_TARGETS} from '../build-omo.mjs';
import {PATCHES_3_0_1} from '../omo-patch.mjs';

// Red/green coverage for the Gate1 blocker1 correction (omo-patch.mjs id
// native-explicit-pin-retain). The v2 host re-runs BOTH the config-agent
// effect and this plugin's projection on every agent.reload(), with the host
// config effect registered first. A custom role whose body/mode live ONLY in
// the native opencode.json (agent.<name>.system / agent.<name>.mode — absent
// from OMO's own config and from the one-shot PRE-config captureAgentDraft
// snapshot, so the hostEntries merge cannot see it either) was clobbered back
// to the generic specialist body and the classified subagent mode on the
// reload after config landed: served subagent/142B instead of the pinned
// all/3275B.
//
// The tests evaluate the EXACT patched plugin artifacts, not a reimplementation:
// the candidate is built here from the pinned 3.0.1 upstream through the real
// build-omo integration, then driven through the plugin's own v2 setup entry by
// native-pin-child.mjs across MULTIPLE transform passes, with the host
// config-agent effect's per-field upsert simulated between passes on the same
// registry. Fixtures reuse the frozen compatibility-remediation
// remediation-v2-20261006-r3 case read-only.
//
// Bounds: no host spawn, no network, no LLM, no production state — HOME and
// XDG_CONFIG_HOME are redirected per child, storage/session/mcp ctx members
// stay absent so background jobs and permission bridging remain process-local.
// Frozen remediation cases and the pinned upstream package are never mutated.

const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PKG_301 = '/home/littlekey/.cache/opencode/packages/oh-my-opencode-slim@3.0.1/node_modules/oh-my-opencode-slim';
const STOCK_SERVER = join(PKG_301, 'dist/server/index.js');
const STOCK_INDEX = join(PKG_301, 'dist/index.js');
const REMEDIATION_ROOT = process.env.OMO_REMEDIATION_ROOT ?? join(SRC, '../../.slim/deepwork/upstream-defaults-20261006');
const R3 = join(REMEDIATION_ROOT, 'compatibility-remediation/cases/remediation-v2-20261006-r3');
const R3_CONFIG = join(R3, 'home/.config/opencode/oh-my-opencode-slim.json');
const HARNESS_CHILD = join(SRC, 'test/native-pin-child.mjs');

// Bounded children: finite timeout plus forced killSignal so a stuck child
// fails its test with ETIMEDOUT instead of hanging the whole run.
const BUILD_CHILD = {stdio: 'pipe', timeout: 120000, killSignal: 'SIGKILL'};
const EVAL_CHILD = {stdio: 'pipe', timeout: 60000, killSignal: 'SIGKILL'};

const OUT = mkdtempSync(join(realpathSync(tmpdir()), 'omo-native-pin-test-'));
after(() => rmSync(OUT, {recursive: true, force: true}));
const digest = value => createHash('sha256').update(value).digest('hex');

// Realistic native draft snapshot: ONLY the builtin agents a v2 host exposes
// BEFORE user config agents are applied — deliberately WITHOUT lark-operator,
// because the proven failure trajectory is that the host config effect creates
// that entry AFTER this plugin's registration (the one-shot captureAgentDraft
// snapshot therefore misses it, which is exactly what the hostEntries merge
// cannot compensate for on the following reloads).
const NATIVE_MARKERS = {
  build: {prompt: 'You are BUILD-NATIVE-MARKER.', description: 'Build agent', mode: 'primary', model: {providerID: 'toy', modelID: 'build-native'}},
  plan: {prompt: 'You are PLAN-NATIVE-MARKER.', description: 'Plan agent', mode: 'primary'},
  general: {prompt: 'You are GENERAL-NATIVE-MARKER.', description: 'General agent', mode: 'all'},
  explore: {
    prompt: 'You are BUILTIN-EXPLORE-MARKER. Beep boop search agent.',
    description: 'Builtin explore description',
    mode: 'all',
    model: {providerID: 'toy', modelID: 'builtin-explore'},
  },
};
const natives = () => Object.fromEntries(
  Object.entries(NATIVE_MARKERS).map(([name, marker]) => [name, {id: name, ...marker}]),
);

// The explicit native pin the host config effect applies between passes
// (verbatim marker bytes stand in for the 3275B pinned body).
const PIN_BODY_V1 = '# Pinned Operator\n- EXPLICIT-NATIVE-PIN-V1 body marker served verbatim.\n';
const PIN_BODY_V2 = '# Pinned Operator\n- EXPLICIT-NATIVE-PIN-V2 body marker after a config edit.\n';
const PIN_MODE = 'all';

const builtDirs = {};
const runCache = new Map();

const buildCandidate = (entry, label) => {
  if (builtDirs[label]) return builtDirs[label];
  const outputDir = join(OUT, 'candidate-' + label);
  // Build through the real integration (same pattern as omo-build.test.mjs).
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    const {buildOmoIntegration} = await import(${JSON.stringify(join(SRC, 'build-omo.mjs'))});
    await buildOmoIntegration({
      packageDir: ${JSON.stringify(PKG_301)},
      sourceDir: ${JSON.stringify(SRC)},
      outputDir: ${JSON.stringify(outputDir)},
      version: '3.0.1',
      entry: ${JSON.stringify(entry)},
    });
  `], BUILD_CHILD);
  builtDirs[label] = outputDir;
  return outputDir;
};

const CANDIDATE_SERVER_BUNDLE = () => join(buildCandidate('server', 'server'), 'dist/server/index.js');
const CANDIDATE_INDEX_BUNDLE = () => join(buildCandidate('index', 'index'), 'dist/index.js');

// Fresh fixture home per scenario: the frozen r3 case config copied read-only
// (it declares agents.lark-operator with model/variant/skills/permissions but
// NO body/mode — the body/mode live only in the native opencode.json).
const makeHome = label => {
  const home = join(OUT, 'home-' + label);
  const configDir = join(home, '.config/opencode');
  mkdirSync(configDir, {recursive: true});
  cpSync(join(R3, 'home/.config/opencode/oh-my-opencode-slim'), join(configDir, 'oh-my-opencode-slim'), {recursive: true});
  cpSync(join(R3, 'home/.config/opencode/agents'), join(configDir, 'agents'), {recursive: true});
  writeFileSync(join(configDir, 'oh-my-opencode-slim.json'), readFileSync(R3_CONFIG, 'utf8'));
  return home;
};

const runPasses = (tag, {bundle, passes, instances}) => {
  if (runCache.has(tag)) return runCache.get(tag);
  const scenarioPath = join(OUT, 'scenario-' + tag + '.json');
  writeFileSync(scenarioPath, JSON.stringify({natives: natives(), passes, instances}, null, 2));
  const resultPath = join(OUT, 'result-' + tag + '.json');
  execFileSync(process.execPath, [HARNESS_CHILD, bundle, join(OUT, 'project'), resultPath, scenarioPath], {
    ...EVAL_CHILD,
    env: {...process.env, HOME: makeHome(tag), XDG_CONFIG_HOME: join(OUT, 'home-' + tag, '.config')},
  });
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.error, undefined, 'plugin evaluation failed: ' + (result.error || ''));
  const byPass = result.passes.map(pass => Object.fromEntries(pass.updates.map(update => [update.name, update.value])));
  runCache.set(tag, byPass);
  return byPass;
};

const permissionRule = (agent, action) => (agent.permissions ?? []).find(rule => rule.action === action);

test('pinned upstream matches the locked target digests', () => {
  assert.equal(digest(readFileSync(STOCK_SERVER)), OMO_TARGETS['3.0.1'].entries.server);
  assert.equal(digest(readFileSync(STOCK_INDEX)), OMO_TARGETS['3.0.1'].entries.index);
});

test('native-explicit-pin-retain patch is server-scoped and keeps the suite contract', () => {
  const patch = PATCHES_3_0_1.find(candidate => candidate.id === 'native-explicit-pin-retain');
  assert.ok(patch, 'missing native-explicit-pin-retain patch');
  const indexAnchor = typeof patch.anchor === 'string' ? patch.anchor : patch.anchor?.index;
  assert.equal(typeof indexAnchor, 'string', 'patch must keep a defined index anchor (frozen build suite asserts every patch on both entries)');
  const indexReplacement = typeof patch.replacement === 'string' ? patch.replacement : patch.replacement?.index;
  assert.equal(indexReplacement, indexAnchor, 'index anchor must self-replace (v1 no-op: upstream behavior kept)');
  assert.equal(typeof patch.anchor?.server, 'string', 'patch must anchor the server (v2) entry');
  assert.notEqual(patch.replacement?.server, patch.anchor?.server, 'server replacement must add the pin retention');
  // Existing 33 proven + 4 alias guard patches stay intact, in order.
  const ids = PATCHES_3_0_1.map(candidate => candidate.id);
  assert.equal(ids.length, 40, '33 proven + 4 alias guards + 3 setup-local native pin patches');
  assert.equal(ids[0], 'ack-injected-resume-def', 'existing patch order head untouched');
  assert.equal(ids[ids.length - 1], 'revive-render-delivery', 'revive-render-delivery stays last (contract asserted by omo-build.test.mjs)');
  for (const id of [
    'ack-injected-resume-def', 'ack-injected-resume-call', 'hook-deps-wiring', 'native-dispatch-now',
    'register-launch-now', 'native-terminal-reconcile', 'native-terminal-reconcile-loop',
    'read-settlement-contrast', 'read-settlement-blocked', 'verdict-origin', 'classifier-origin',
    'shim-user-text-and-parentid', 'shim-context-transcript-identity', 'shim-paged-transcript-identity',
    'commit-signature', 'commit-store-origin', 'commit-transcript-origin', 'clear-origin-reconciled',
    'clear-origin-failed', 'update-origin-merge', 'foreground-delivery', 'task-result-delivery',
    'task-result-evidence-delivery', 'notify-delivery-metadata', 'notify-delivery-body',
    'injection-state-directory', 'synthetic-processed-annotate', 'synthetic-remembered-annotate',
    'synthetic-updated-annotate', 'revive-unknown-delivery', 'revive-latest-delivery',
    'revive-render-signature', 'alias-host-entry-guard', 'alias-permission-guard',
    'alias-visible-identity-decl-guard', 'alias-visible-rules-guard',
  ]) {
    assert.ok(ids.includes(id), 'pre-existing patch ' + id + ' must stay registered');
  }
  // The pin patch sits after the alias guards, before the final delivery patch.
  assert.ok(ids.indexOf('native-explicit-pin-retain') > ids.indexOf('alias-visible-rules-guard'), 'pin patch ordered after the alias guards');
  assert.ok(ids.indexOf('native-explicit-pin-retain') < ids.length - 1, 'pin patch ordered before revive-render-delivery');
});

test('explicit native system+mode survive the post-config reload; OMO model/variant/permissions retained', () => {
  const passes = runPasses('pin-retained', {
    bundle: CANDIDATE_SERVER_BUNDLE(),
    passes: [
      null, // pass 1: OMO registration projection (native pre-config registry)
      {config: {'lark-operator': {system: PIN_BODY_V1, mode: PIN_MODE}}}, // host config effect lands
      null, // a further plain reload must keep the pin (sticky)
      {config: {'lark-operator': {system: PIN_BODY_V2}}}, // config edit re-detected
    ],
  });
  assert.ok(passes[0]['lark-operator'], 'pass 1 must serve lark-operator from the OMO config');
  const first = passes[0]['lark-operator'];
  assert.equal(first.mode, 'subagent', 'pass 1 keeps the classified subagent mode (no pin seen yet)');
  assert.ok(first.model, 'pass 1 writes the configured model');

  const pinned = passes[1]['lark-operator'];
  assert.ok(pinned, 'post-config pass must still serve lark-operator');
  assert.equal(pinned.system, PIN_BODY_V1, 'explicit native system retained verbatim (not clobbered to the generic body)');
  assert.equal(pinned.mode, PIN_MODE, 'explicit native mode retained (not the classified subagent)');
  assert.deepEqual(pinned.model, {id: 'glm-5.3', providerID: 'newapi', variant: 'max'}, 'OMO configured model/variant retained');
  assert.deepEqual(pinned.permissions, first.permissions, 'OMO permission semantics retained unchanged');
  assert.equal(pinned.description, first.description, 'OMO description retained');
  assert.equal(pinned.hidden, false, 'visibility semantics unchanged');

  const sticky = passes[2]['lark-operator'];
  assert.equal(sticky.system, PIN_BODY_V1, 'pin survives a plain reload');
  assert.equal(sticky.mode, PIN_MODE, 'mode pin survives a plain reload');

  const edited = passes[3]['lark-operator'];
  assert.equal(edited.system, PIN_BODY_V2, 'a changed explicit pin is re-detected verbatim');
  assert.equal(edited.mode, PIN_MODE, 'unchanged mode pin stays');
  assert.deepEqual(edited.model, {id: 'glm-5.3', providerID: 'newapi', variant: 'max'}, 'model/variant still retained after re-detection');
});

test('unpatched upstream clobbers the explicit pin on the post-config reload (red baseline)', () => {
  const passes = runPasses('pin-stock', {
    bundle: STOCK_SERVER,
    passes: [
      null,
      {config: {'lark-operator': {system: PIN_BODY_V1, mode: PIN_MODE}}},
      null,
    ],
  });
  const stockPinned = passes[1]['lark-operator'];
  assert.ok(stockPinned, 'stock pass 2 must still write lark-operator');
  assert.notEqual(stockPinned.system, PIN_BODY_V1, 'stock projection clobbers the explicit native system');
  assert.equal(stockPinned.mode, 'subagent', 'stock projection clobbers the explicit native mode back to the classified subagent');
  assert.equal(passes[2]['lark-operator'].mode, 'subagent', 'clobber persists on further reloads');
});

test('no native override fallback: without a pin, every served agent is pass-identical', () => {
  const passes = runPasses('pin-no-fallback', {
    bundle: CANDIDATE_SERVER_BUNDLE(),
    passes: [null, null, null],
  });
  assert.ok(passes.length >= 2, 'at least two passes observed');
  const [first, second, third] = passes;
  assert.deepEqual(
    Object.fromEntries(Object.entries(second).map(([name, value]) => [name, {...value, permissions: value.permissions}])),
    Object.fromEntries(Object.entries(first).map(([name, value]) => [name, {...value, permissions: value.permissions}])),
    'reload without config writes must not drift any served agent',
  );
  assert.deepEqual(third, second, 'a third plain reload stays identical (no fabricated fallback)');
  const blob = JSON.stringify(passes.flat());
  for (const marker of ['NATIVE-MARKER', 'EXPLICIT-NATIVE-PIN']) {
    assert.equal(blob.includes(marker), false, 'no native snapshot paste or pin leakage without an explicit config write: ' + marker);
  }
});

test('document-writer (custom role without a native pin) keeps the OMO-served body across reloads', () => {
  const passes = runPasses('pin-docwriter', {
    bundle: CANDIDATE_SERVER_BUNDLE(),
    passes: [null, {config: {'lark-operator': {system: PIN_BODY_V1, mode: PIN_MODE}}}],
  });
  const first = passes[0]['document-writer'];
  const second = passes[1]['document-writer'];
  assert.ok(first && second, 'document-writer must be served in both passes');
  assert.deepEqual(second, first, 'a custom role with no native pin must not change across the config reload');
  assert.ok(String(first.system).length > 0, 'document-writer keeps its configured body');
});

test('built candidate manifest records the native pin patch in the server entry', () => {
  const manifest = JSON.parse(readFileSync(join(buildCandidate('server', 'server'), 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '3.0.1');
  assert.equal(manifest.entry, 'server');
  const ids = manifest.patches.map(patch => patch.id);
  assert.ok(ids.includes('native-explicit-pin-retain'), 'manifest must record native-explicit-pin-retain');
  assert.equal(ids.length, 40, 'manifest patch count matches the source array');
});

test('two setup instances in one module keep late native pins isolated', () => {
  const passes = runPasses('two-instances', {
    bundle: CANDIDATE_SERVER_BUNDLE(),
    instances: { a: natives(), b: natives() },
    passes: [
      {instance: 'a'},
      {instance: 'a', config: {'lark-operator': {system: PIN_BODY_V1, mode: PIN_MODE}}},
      {instance: 'b'},
      {instance: 'b', config: {'lark-operator': {system: PIN_BODY_V2, mode: PIN_MODE}}},
      {instance: 'a'}, {instance: 'b'},
    ],
  });
  assert.equal(passes[2]['lark-operator'].system, passes[0]['lark-operator'].system, 'unconfigured B must serve its own projection');
  assert.equal(passes[2]['lark-operator'].mode, 'subagent', 'A cannot promote B to all');
  assert.equal(passes[4]['lark-operator'].system, PIN_BODY_V1);
  assert.equal(passes[5]['lark-operator'].system, PIN_BODY_V2);
});

test('deleting or clearing native fields releases the late pin', () => {
  const passes = runPasses('clear-pin', {
    bundle: CANDIDATE_SERVER_BUNDLE(),
    passes: [null,
      {config: {'lark-operator': {system: PIN_BODY_V1, mode: PIN_MODE}}},
      {deleteFields: {'lark-operator': ['system', 'mode']}},
      {config: {'lark-operator': {system: PIN_BODY_V2, mode: PIN_MODE}}},
      {config: {'lark-operator': {system: '', mode: ''}}},
    ],
  });
  for (const index of [2, 4]) {
    assert.equal(passes[index]['lark-operator'].system, passes[0]['lark-operator'].system, 'cleared body returns to the instance projection');
    assert.equal(passes[index]['lark-operator'].mode, 'subagent');
  }
});
