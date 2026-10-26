import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchOmo, OMO_TARGETS, PATCHES_3_0_6, PATCHES_3_0_5, describeOmoPatches, helperImportsFor} from '../omo-patch.mjs';
import {buildOmoIntegration, bareExternalSpecifiers} from '../build-omo.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
// OMO 3.0.6 has no repo-pinned workarea yet; the verifier assembles one (the
// package must live directly inside a node_modules directory for the closure
// planner) and points OMO_306_PACKAGE at it.
const packageDir = process.env.OMO_306_PACKAGE ?? '/tmp/opencode/omo-306-workarea/node_modules/oh-my-opencode-slim';
const sourceDir = fileURLToPath(new URL('..', import.meta.url));
const stock306 = existsSync(join(packageDir, 'dist/index.js'));
const scratch = mkdtempSync(join(tmpdir(), 'omo-306-'));
after(() => rmSync(scratch, {recursive: true, force: true}));
const digest = value => createHash('sha256').update(value).digest('hex');
const entryPath = entry => entry === 'index' ? 'dist/index.js' : 'dist/server/index.js';
const stock = entry => readFileSync(join(packageDir, entryPath(entry)), 'utf8');
const patched = entry => patchOmo(stock(entry), {version: '3.0.6', entry});
const skip306 = t => { if (!stock306) { t.skip('stock oh-my-opencode-slim 3.0.6 package not available at ' + packageDir); return true; } return false; };

test('3.0.6 pins exact upstream bytes and rejects drift, wrong version and wrong entry', () => {
  if (skip306(test)) return;
  for (const entry of ['index', 'server']) {
    assert.equal(digest(stock(entry)), OMO_TARGETS['3.0.6']?.entries[entry]);
    assert.throws(() => patchOmo(stock(entry) + '\n// drift'), /Unsupported/);
    assert.throws(() => patchOmo(stock(entry), {version: '3.0.5'}), /was requested/);
    assert.throws(() => patchOmo(stock(entry), {entry: entry === 'index' ? 'server' : 'index'}), /was requested/);
  }
  assert.deepEqual(helperImportsFor('3.0.6'), ['../omo-delivery.mjs']);
});

test('3.0.6 applies all 42 patches with unique anchors on both entries', () => {
  if (skip306(test)) return;
  const ids = PATCHES_3_0_6.map(patch => patch.id);
  assert.equal(ids.length, 42);
  assert.deepEqual(describeOmoPatches('3.0.6'), PATCHES_3_0_6.map(({id, purpose}) => ({id, purpose})));
  // Two 3.0.5 patches retire on 3.0.6 (upstream #1652/#1649 reconciles
  // injections through the terminal gate at injection time), one is added
  // (the context shim return split into history + tail paths).
  for (const retired of ['ack-injected-resume-def', 'ack-injected-resume-call']) {
    assert.ok(PATCHES_3_0_5.some(patch => patch.id === retired), retired + ' existed on 3.0.5');
    assert.equal(ids.includes(retired), false, retired + ' retired on 3.0.6');
  }
  assert.ok(ids.includes('shim-context-tail-transcript-identity'), 'tail-shim addition present');
  for (const patch of PATCHES_3_0_6) assert.ok(patch.purpose, patch.id + ' purpose');
  for (const entry of ['index', 'server']) {
    const source = stock(entry);
    const result = patched(entry);
    assert.ok(result.startsWith('import { deliveryMetadata, deliverySuffix, annotateDeliveryPart, presentDelivery } from "../omo-delivery.mjs";\n'));
    for (const patch of PATCHES_3_0_6) {
      const anchor = typeof patch.anchor === 'string' ? patch.anchor : patch.anchor[entry];
      const replacement = typeof patch.replacement === 'string' ? patch.replacement : patch.replacement[entry];
      assert.equal(source.split(anchor).length, 2, 'anchor unique in stock: ' + patch.id);
      assert.equal(result.split(replacement).length, 2, 'replacement exactly once in patched: ' + patch.id + ' (' + entry + ')');
      assert.equal(result.split(anchor).length - 1, replacement.includes(anchor) ? 1 : 0, 'anchor consumed: ' + patch.id + ' (' + entry + ')');
    }
  }
});

test('3.0.6 stock bundles carry no BCP delivery markers', () => {
  if (skip306(test)) return;
  for (const entry of ['index', 'server']) {
    const source = stock(entry);
    for (const marker of ['bcp_delivery_metadata', 'bcp_result_reference', 'opencode.bcp.delivery.v1', 'deliverySuffix(', 'presentDelivery(', 'deliveryMetadata(', 'bcpOrigin', 'annotateDeliveryPart(', 'toV1Transcript']) {
      assert.equal(source.includes(marker), false, entry + ' stock must not carry ' + marker);
    }
  }
});

test('3.0.6 re-anchored patches wire the delivery pipeline into the new upstream shape', () => {
  if (skip306(test)) return;
  for (const entry of ['index', 'server']) {
    const result = patched(entry);
    // Context shim: the 3.0.6 split returns both bind through toV1Transcript,
    // defined by the inherited shim patch before both uses; the old raw path
    // is gone.
    const definition = result.indexOf('function toV1Transcript(messages2)');
    const history = result.indexOf('toV1Transcript(history.reverse())');
    const tail = result.indexOf('toV1Transcript(tail)');
    assert.ok(definition >= 0 && definition < history && definition < tail, 'toV1Transcript defined before both shim uses (' + entry + ')');
    assert.equal(result.split('toV1Transcript(history.reverse())').length - 1, 1, entry);
    assert.equal(result.split('toV1Transcript(tail)').length - 1, 1, entry);
    assert.equal(result.includes('data: raw.map(toV1Message),'), false, 'raw transcript path replaced (' + entry + ')');
    // task_result delivery: gate.capture pre/post fence lands in the
    // standalone readTaskResult, whose upstream read call keeps its new
    // hostInfo argument.
    assert.equal(result.split('gate.capture(current)').length - 1 >= 2, true, 'pre/post metadata capture (' + entry + ')');
    assert.ok(result.includes('}, taskID, hostInfo);'), 'upstream readUntrackedEvidence call preserved (' + entry + ')');
    // Exactly two CAS-guarded delivery sites carry the refusal: the
    // task_result path (this upgrade) and the inherited readonly-result path.
    assert.equal(result.split('Task changed while delivery metadata was inspected; retrieve its current result.').length - 1, 2, 'CAS failure message (' + entry + ')');
    // Transcript-evidence fallback: readTaskResult now closes directly before
    // the 3.0.6 DIAGNOSTIC_TERMINALS table.
    const evidenceBlock = result.indexOf('bcpOrigin: evidence.bcpOrigin');
    const diagnosticTable = result.indexOf('var DIAGNOSTIC_TERMINALS');
    assert.ok(evidenceBlock > 0 && diagnosticTable > evidenceBlock, 'evidence delivery precedes DIAGNOSTIC_TERMINALS (' + entry + ')');
    // Synthetic completion annotation now sits between the stale guard and
    // upstream's processed-completion log (the terminalUnreconciled
    // early-return branch is gone upstream).
    const annotate = result.indexOf('await annotateDeliveryPart(state.bcpDirectory, part, updated, message.info?.sessionID, () => {');
    const log = result.indexOf('log("[task-session-manager] processed injected background completion"');
    assert.ok(annotate > 0 && log > annotate, 'annotation precedes the processed log (' + entry + ')');
    assert.equal(result.split('await annotateDeliveryPart(state.bcpDirectory, part, updated').length - 1, 1, entry);
    // Retired injected-resume machinery leaves no dangling references.
    for (const gone of ['acknowledgeInjectedNativeResume', 'acknowledgeInjectedResume', 'terminalJobsInjectedByParent', 'reconcileConsumedTerminalJobs']) {
      assert.equal(result.includes(gone), false, entry + ' must not reference retired ' + gone);
    }
    // Hook wiring keeps only the plugin directory.
    assert.ok(result.includes('"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      directory: _ctx.directory,\n      shouldManageSession:'), 'directory-only wiring (' + entry + ')');
  }
});

test('3.0.6 builds relocatable standalone artifacts with the full patch manifest on both entries', async () => {
  if (skip306(test)) return;
  for (const entry of ['index', 'server']) {
    const out = join(scratch, entry);
    const {manifest, files} = await buildOmoIntegration({packageDir, sourceDir, outputDir: out, version: '3.0.6', entry});
    assert.equal(manifest.name, 'oh-my-opencode-slim');
    assert.equal(manifest.version, '3.0.6');
    assert.equal(manifest.upstream.digest, OMO_TARGETS['3.0.6'].entries[entry]);
    assert.equal(manifest.patches.length, 42);
    assert.deepEqual(manifest.patches, describeOmoPatches('3.0.6'));
    assert.ok(manifest.closure.packages.length > 0);
    for (const file of files) assert.equal(digest(readFileSync(file.path)), file.digest);
    assert.equal(existsSync(join(out, 'omo-council.mjs')), false, 'no council helper on 3.0.6');
    assert.ok(existsSync(join(out, 'omo-delivery.mjs')), 'delivery helper shipped');
    const bundle = readFileSync(join(out, entryPath(entry)), 'utf8');
    assert.ok(bundle.includes('omo-delivery.mjs'), 'delivery helper import rewritten (' + entry + ')');
    for (const marker of ['toV1Transcript(history.reverse())', 'toV1Transcript(tail)', 'gate.capture(current)', 'DIAGNOSTIC_TERMINALS']) {
      assert.ok(bundle.includes(marker), 'built ' + entry + ' carries ' + marker);
    }
    if (entry === 'index') assert.deepEqual(bareExternalSpecifiers(bundle), []);
  }
});
