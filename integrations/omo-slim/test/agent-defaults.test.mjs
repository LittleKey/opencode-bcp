import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildOmoIntegration, OMO_TARGETS} from '../build-omo.mjs';
import {PATCHES_3_0_1} from '../omo-patch.mjs';

// Red/green coverage for the 3.0.1 v2 alias-fallback guard (omo-patch.mjs ids
// alias-host-entry-guard / alias-host-rule-guard / alias-visible-identity-decl /
// alias-visible-rules-guard). The guard removes the legacy
// `?? (legacyAlias ? … : undefined)` lookups in buildResolvedAgentRegistry that
// pasted the BUILTIN native draft snapshot (captured by the v2 adapter BEFORE
// user config agents exist, therefore config-immune) over the OMO explorer
// default — its description, mode and permission rules at minimum.
//
// The tests evaluate the EXACT patched plugin artifacts, not a reimplementation:
// both candidates are built here from the pinned 3.0.1 upstream through the
// real build-omo integration, then driven through the plugin's own surface by
// harness/v2-child.mjs (v2: the real setup entry + a realistic native draft
// snapshot; v1: the real OhMyOpenCodeLite factory). Fixtures reuse the frozen
// compatibility-remediation remediation-v2-20261006-r3 case read-only.
//
// Bounds: no host spawn, no network, no LLM, no production state — HOME and
// XDG_CONFIG_HOME are redirected per child, storage/session/mcp ctx members
// stay absent so background jobs and permission bridging remain process-local.
// Frozen remediation cases and the pinned upstream package are never mutated.

const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PKG_301 = '/home/littlekey/.cache/opencode/packages/oh-my-opencode-slim@3.0.1/node_modules/oh-my-opencode-slim';
const STOCK_SERVER = join(PKG_301, 'dist/server/index.js');
const STOCK_INDEX = join(PKG_301, 'dist/index.js');
const REMEDIATION_ROOT = join(SRC, '../../.slim/deepwork/upstream-defaults-20261006');
const R3 = join(REMEDIATION_ROOT, 'compatibility-remediation/cases/remediation-v2-20261006-r3');
const R3_CONFIG = join(R3, 'home/.config/opencode/oh-my-opencode-slim.json');
const R3_APPEND = join(R3, 'home/.config/opencode/oh-my-opencode-slim/explorer_append.md');
const R3_DOCWRITER = join(R3, 'home/.config/opencode/oh-my-opencode-slim/document-writer.md');
const HARNESS_CHILD = join(REMEDIATION_ROOT, 'alias-remediation/harness/v2-child.mjs');
const HARNESS_CONSTANTS = join(REMEDIATION_ROOT, 'alias-remediation/harness/extract-constants.mjs');

// Bounded children: finite timeout plus forced killSignal so a stuck child
// fails its test with ETIMEDOUT instead of hanging the whole run.
const BUILD_CHILD = {stdio: 'pipe', timeout: 120000, killSignal: 'SIGKILL'};
const EVAL_CHILD = {stdio: 'pipe', timeout: 60000, killSignal: 'SIGKILL'};

const OUT = mkdtempSync(join(realpathSync(tmpdir()), 'omo-agent-defaults-test-'));
after(() => rmSync(OUT, {recursive: true, force: true}));
const digest = value => createHash('sha256').update(value).digest('hex');

// Realistic native draft snapshot: the builtin agents a v2 host exposes BEFORE
// user config agents are applied, plus a canonical custom native agent. The
// explore entry carries distinctive markers (body, description, mode, model)
// so any paste of builtin snapshot data is observable in the served surface.
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
  'lark-operator': {
    prompt: 'LARK-NATIVE-BODY-MARKER: Handle Lark reads.',
    description: 'Native lark operator',
    mode: 'all',
    model: {providerID: 'toy', modelID: 'lark-native'},
  },
};
const nativesSnapshot = () => Object.fromEntries(
  Object.entries(NATIVE_MARKERS).map(([name, marker]) => [name, {id: name, ...marker}]),
);

const builtDirs = {};
const constantsByLabel = {};
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

// Served-body expectations are extracted from the CANDIDATE bundle itself (not
// stale constants): the upstream default role prompt, the task-rejection
// instruction, role descriptions and the alias map, evaluated exactly like the
// bundle evaluates them.
const bundleConstants = (bundle, label) => {
  if (constantsByLabel[label]) return constantsByLabel[label];
  const outPath = join(OUT, 'constants-' + label + '.json');
  execFileSync(process.execPath, [HARNESS_CONSTANTS, bundle, outPath], EVAL_CHILD);
  constantsByLabel[label] = JSON.parse(readFileSync(outPath, 'utf8'));
  return constantsByLabel[label];
};

// Fresh fixture home per scenario: the frozen r3 case config copied read-only,
// optionally patched with scenario-specific explorer configuration.
const makeHome = (label, mutateConfig) => {
  const home = join(OUT, 'home-' + label);
  const configDir = join(home, '.config/opencode');
  mkdirSync(configDir, {recursive: true});
  cpSync(join(R3, 'home/.config/opencode/oh-my-opencode-slim'), join(configDir, 'oh-my-opencode-slim'), {recursive: true});
  cpSync(join(R3, 'home/.config/opencode/agents'), join(configDir, 'agents'), {recursive: true});
  const config = JSON.parse(readFileSync(R3_CONFIG, 'utf8'));
  if (mutateConfig) mutateConfig(config);
  writeFileSync(join(configDir, 'oh-my-opencode-slim.json'), JSON.stringify(config, null, 2) + '\n');
  return home;
};

const runPluginEval = (tag, {bundle, home, flavor}) => {
  if (runCache.has(tag)) return runCache.get(tag);
  const nativesPath = join(OUT, 'natives.json');
  if (!existsSync(nativesPath)) writeFileSync(nativesPath, JSON.stringify(nativesSnapshot(), null, 2));
  const resultPath = join(OUT, 'result-' + tag + '.json');
  execFileSync(process.execPath, [HARNESS_CHILD, bundle, join(OUT, 'project'), resultPath, flavor, nativesPath], {
    ...EVAL_CHILD,
    env: {...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config')},
  });
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.error, undefined, 'plugin evaluation failed: ' + (result.error || ''));
  runCache.set(tag, result);
  return result;
};

const v2UpdatesByName = result => Object.fromEntries(result.updates.map(update => [update.name, update.value]));
const updateNames = result => result.updates.map(update => update.name);
const permissionRule = (agent, action) => (agent.permissions ?? []).find(rule => rule.action === action);
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

const CANDIDATE_SERVER_BUNDLE = () => join(buildCandidate('server', 'server'), 'dist/server/index.js');
const CANDIDATE_INDEX_BUNDLE = () => join(buildCandidate('index', 'index'), 'dist/index.js');

test('pinned upstream matches the locked target digests', () => {
  assert.equal(digest(readFileSync(STOCK_SERVER)), OMO_TARGETS['3.0.1'].entries.server);
  assert.equal(digest(readFileSync(STOCK_INDEX)), OMO_TARGETS['3.0.1'].entries.index);
});

test('alias guard patches are server-scoped and keep the suite contract', () => {
  const guardIds = ['alias-host-entry-guard', 'alias-permission-guard', 'alias-visible-identity-decl-guard', 'alias-visible-rules-guard'];
  const byId = Object.fromEntries(PATCHES_3_0_1.map(patch => [patch.id, patch]));
  for (const id of guardIds) {
    const patch = byId[id];
    assert.ok(patch, 'missing guard patch ' + id);
    const indexAnchor = pickAnchor(patch, 'index');
    assert.equal(typeof indexAnchor, 'string', id + ' must keep a defined index anchor (frozen build suite asserts every patch on both entries)');
    assert.equal(pickReplacement(patch, 'index'), indexAnchor, id + ' index anchor must self-replace (v1 no-op: upstream alias behavior kept)');
    assert.equal(typeof pickAnchor(patch, 'server'), 'string', id + ' must anchor the server (v2) entry');
    assert.notEqual(pickReplacement(patch, 'server'), pickAnchor(patch, 'server'), id + ' server replacement must change the alias fallback');
  }
  assert.equal(PATCHES_3_0_1.length, 40, 'exactly the 33 proven patches, the 4 alias guard patches and the 3 setup-local native pin patches');
  assert.equal(PATCHES_3_0_1[0].id, 'ack-injected-resume-def', 'existing patch order head untouched');
  assert.equal(PATCHES_3_0_1[PATCHES_3_0_1.length - 1].id, 'revive-render-delivery', 'revive-render-delivery stays last (contract asserted by omo-build.test.mjs)');
});
const pickAnchor = (patch, entry) => (typeof patch.anchor === 'string' ? patch.anchor : patch.anchor?.[entry]);
const pickReplacement = (patch, entry) => (typeof patch.replacement === 'string' ? patch.replacement : patch.replacement?.[entry]);

test('patched v2 serves the upstream explorer default with a single append, config model and write deny', () => {
  const bundle = CANDIDATE_SERVER_BUNDLE();
  const constants = bundleConstants(bundle, 'candidate-server');
  const append = readFileSync(R3_APPEND, 'utf8');
  const home = makeHome('core');
  const result = runPluginEval('core-patched-v2', {bundle, home, flavor: 'v2'});
  const agents = v2UpdatesByName(result);

  assert.deepEqual(result.defaults, ['orchestrator'], 'orchestrator stays the default agent');
  assert.ok(agents.explorer, 'explorer must be served');
  const explorer = agents.explorer;
  const expectedPrompt = constants.EXPLORER_PROMPT + '\n\n' + constants.TASK_REJECTION_INSTRUCTION + '\n\n' + append;
  assert.equal(explorer.system, expectedPrompt, 'served body must be the upstream default prompt + rejection + local append');
  assert.equal(countOccurrences(explorer.system, append), 1, 'append must load exactly once');
  assert.equal(countOccurrences(explorer.system, 'BUILTIN-EXPLORE-MARKER'), 0, 'builtin explore body must not be pasted');
  assert.equal(explorer.description, constants.ROLE_DEFINITIONS.explorer.description, 'upstream default description restored (not the builtin snapshot copy)');
  assert.equal(explorer.mode, 'subagent', 'upstream subagent mode restored (not the builtin snapshot mode)');
  assert.deepEqual(explorer.model, {id: 'glm-5.3-flash', providerID: 'newapi', variant: 'max'}, 'configured preset model/variant must win over native metadata');
  assert.deepEqual(permissionRule(explorer, 'edit'), {action: 'edit', resource: '*', effect: 'deny'}, 'configured edit deny enforced');
  assert.deepEqual(permissionRule(explorer, 'apply_patch'), {action: 'apply_patch', resource: '*', effect: 'deny'}, 'configured apply_patch deny enforced');

  // No collision for other roles: the native builtin snapshot entries must not
  // be rewritten, and the served OMO agents keep their own identity.
  for (const name of ['explore', 'build', 'plan', 'general']) {
    assert.equal(updateNames(result).includes(name), false, 'native ' + name + ' must pass through the host draft untouched');
  }
  const servedBlob = JSON.stringify(agents);
  for (const name of ['build', 'plan', 'general', 'explore', 'lark-operator']) {
    assert.equal(servedBlob.includes(name.toUpperCase() + '-NATIVE-MARKER'), false, 'no native ' + name + ' paste anywhere');
  }
  assert.equal(servedBlob.includes('BUILTIN-EXPLORE-MARKER'), false, 'builtin explore paste must not leak into any served agent');
  assert.equal(servedBlob.includes('"builtin-explore"') && servedBlob.includes('"toy"'), false, 'native toy model metadata must not leak into any served agent');

  // Custom OMO agents keep their configured bodies and metadata.
  const docWriter = agents['document-writer'];
  assert.ok(docWriter, 'document-writer must be served');
  assert.equal(docWriter.system, readFileSync(R3_DOCWRITER, 'utf8'), 'document-writer full custom body preserved');
  assert.deepEqual(docWriter.model, {id: 'glm-5.3-flash', providerID: 'newapi', variant: 'max'}, 'document-writer configured model/variant served');
  assert.equal(docWriter.description, JSON.parse(readFileSync(R3_CONFIG, 'utf8')).agents['document-writer'].description, 'document-writer configured description served');
  const lark = agents['lark-operator'];
  assert.ok(lark, 'lark-operator must be served');
  assert.equal(countOccurrences(lark.system ?? '', 'BUILTIN-EXPLORE-MARKER'), 0, 'lark-operator must not receive the builtin explore paste');
  assert.deepEqual(lark.model, {id: 'glm-5.3', providerID: 'newapi', variant: 'max'}, 'lark-operator configured model/variant served (not the native toy metadata)');
});

test('unpatched upstream pastes builtin snapshot identity onto explorer (red baseline)', () => {
  const home = makeHome('core');
  const result = runPluginEval('core-stock-v2', {bundle: STOCK_SERVER, home, flavor: 'v2'});
  const explorer = v2UpdatesByName(result).explorer;
  assert.ok(explorer, 'explorer must be served pre-patch too');
  assert.equal(explorer.description, 'Builtin explore description', 'pre-patch clobbers the description from the builtin snapshot');
  assert.equal(explorer.mode, 'all', 'pre-patch clobbers the mode from the builtin snapshot');
});

test('guard changes no other role: patched output matches unpatched outside explorer', () => {
  const patched = runPluginEval('core-patched-v2', {bundle: CANDIDATE_SERVER_BUNDLE(), home: makeHome('core'), flavor: 'v2'});
  const stock = runPluginEval('core-stock-v2', {bundle: STOCK_SERVER, home: makeHome('core'), flavor: 'v2'});
  const patchedAgents = v2UpdatesByName(patched);
  const stockAgents = v2UpdatesByName(stock);
  assert.deepEqual(updateNames(patched).sort(), updateNames(stock).sort(), 'the same agent set must be served');
  for (const [name, value] of Object.entries(stockAgents)) {
    if (name === 'explorer') continue;
    assert.deepEqual(patchedAgents[name], value, 'guard must not change served ' + name);
  }
  assert.deepEqual(patched.defaults, stock.defaults, 'default agent selection unchanged');
});

test('explicit canonical explorer override wins on model, variant and description; upstream body retained', () => {
  const bundle = CANDIDATE_SERVER_BUNDLE();
  const constants = bundleConstants(bundle, 'candidate-server');
  const append = readFileSync(R3_APPEND, 'utf8');
  const home = makeHome('override', config => {
    config.presets.newapi.explorer = {
      model: 'newapi/glm-5.3',
      variant: 'high',
      description: 'Custom recon override',
      permission: {edit: 'deny'},
    };
  });
  const explorer = v2UpdatesByName(runPluginEval('override-patched-v2', {bundle, home, flavor: 'v2'})).explorer;
  assert.deepEqual(explorer.model, {id: 'glm-5.3', providerID: 'newapi', variant: 'high'}, 'explicit canonical override model/variant served');
  assert.equal(explorer.description, 'Custom recon override', 'explicit canonical override description served');
  const expectedPrompt = constants.EXPLORER_PROMPT + '\n\n' + constants.TASK_REJECTION_INSTRUCTION + '\n\n' + append;
  assert.equal(explorer.system, expectedPrompt, 'override keeps the upstream default body + single append');
});

test('alias-name user config: canonical entry wins collisions, alias-only entry still applies', () => {
  const bundle = CANDIDATE_SERVER_BUNDLE();

  // Collision (canonical `explorer` + alias `explore` both declared): upstream
  // canonicalizeAgentAliases deep-merges with the canonical entry winning, so
  // the guard must not change that either.
  const collisionHome = makeHome('alias-collision', config => {
    config.presets.newapi.explore = {model: 'newapi/glm-5.3', variant: 'high', description: 'Alias-name config override'};
  });
  const collisionExplorer = v2UpdatesByName(runPluginEval('alias-collision-patched-v2', {bundle, home: collisionHome, flavor: 'v2'})).explorer;
  assert.deepEqual(collisionExplorer.model, {id: 'glm-5.3-flash', providerID: 'newapi', variant: 'max'}, 'canonical entry wins conflicting fields (upstream semantics preserved)');
  assert.equal(collisionExplorer.description, 'Alias-name config override', 'collision deep-merges non-conflicting alias fields (upstream semantics preserved)');

  // Alias-only declaration (canonical `explorer` removed): the alias-named
  // config canonicalizes at load and must still apply — the guard must not
  // over-patch the supported user-config alias path.
  const aliasHome = makeHome('alias-config', config => {
    delete config.presets.newapi.explorer;
    config.presets.newapi.explore = {model: 'newapi/glm-5.3', variant: 'high', description: 'Alias-name config override'};
  });
  const aliasExplorer = v2UpdatesByName(runPluginEval('alias-config-patched-v2', {bundle, home: aliasHome, flavor: 'v2'})).explorer;
  assert.deepEqual(aliasExplorer.model, {id: 'glm-5.3', providerID: 'newapi', variant: 'high'}, 'alias-only user config model/variant still served');
  assert.equal(aliasExplorer.description, 'Alias-name config override', 'alias-only user config description still served');
  assert.equal(countOccurrences(aliasExplorer.system, 'BUILTIN-EXPLORE-MARKER'), 0, 'alias-name config must not unlock the builtin paste either');
});

test('guard leaves the v1 index surface behavior-identical', () => {
  const home = makeHome('core');
  const stock = runPluginEval('core-stock-v1', {bundle: STOCK_INDEX, home, flavor: 'v1'});
  const patched = runPluginEval('core-patched-v1', {bundle: CANDIDATE_INDEX_BUNDLE(), home, flavor: 'v1'});
  assert.deepEqual(patched.agents, stock.agents, 'patched v1 candidate must serve the exact stock v1 agent surface');
  const explorer = patched.agents.explorer;
  assert.equal(explorer.model, 'newapi/glm-5.3-flash', 'v1 explorer keeps the configured model');
  assert.equal(explorer.variant, 'max', 'v1 explorer keeps the configured variant');
  assert.ok(String(explorer.prompt).startsWith('You are Explorer - a fast codebase navigation specialist.'), 'v1 explorer keeps the upstream default body');
});

test('built candidate manifest records the guard patches in the server entry', () => {
  const manifest = JSON.parse(readFileSync(join(buildCandidate('server', 'server'), 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '3.0.1');
  assert.equal(manifest.entry, 'server');
  const ids = manifest.patches.map(patch => patch.id);
  for (const id of ['alias-host-entry-guard', 'alias-permission-guard', 'alias-visible-identity-decl-guard', 'alias-visible-rules-guard']) {
    assert.ok(ids.includes(id), 'manifest must record ' + id);
  }
  assert.equal(ids.length, 40, 'manifest patch count matches the source array');
});
