import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, existsSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {patchOmo, OMO_TARGETS, PATCHES_3_0_4, describeOmoPatches, helperImportsFor} from '../omo-patch.mjs';
import {buildOmoIntegration, bareExternalSpecifiers} from '../build-omo.mjs';
import {presentDelivery, deliverySuffix, deliveryMetadata} from '../omo-delivery.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageDir = process.env.OMO_304_PACKAGE ?? join(repoRoot, '.slim/omo-3.0.4-upgrade-20261011/node_modules/oh-my-opencode-slim');
const sourceDir = fileURLToPath(new URL('..', import.meta.url));
const bun = process.env.BUN_BIN ?? join(homedir(), '.bun/bin/bun');
if (process.env.BUN_BIN !== undefined) assert.ok(bun && existsSync(bun), 'BUN_BIN must name an existing Bun executable');
const stock304 = existsSync(join(packageDir, 'dist/index.js'));
const scratch = mkdtempSync(join(tmpdir(), 'omo-304-'));
after(() => rmSync(scratch, {recursive: true, force: true}));
const digest = value => createHash('sha256').update(value).digest('hex');
const entryPath = entry => entry === 'index' ? 'dist/index.js' : 'dist/server/index.js';
const stock = entry => readFileSync(join(packageDir, entryPath(entry)), 'utf8');
const patched = entry => patchOmo(stock(entry), {version: '3.0.4', entry});
const skip304 = t => { if (!stock304) { t.skip('stock oh-my-opencode-slim 3.0.4 package not available at ' + packageDir); return true; } return false; };

// Pinned bundles use column-zero function declarations and closing braces.
// Execute the actual declaration; mock only host I/O, not the attribution logic.
function declaration(source, name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name + ' declaration');
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name + ' body');
  return source.slice(start, end + 2);
}
function load(source, names, dependencies = {}) {
  return new Function(...Object.keys(dependencies), names.map(n => declaration(source, n)).join('\n') + '\nreturn {' + names.join(',') + '};')(...Object.values(dependencies));
}
// Region slice for logic nested inside factories (never column-zero).
function region(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, 'region start marker: ' + startMarker.slice(0, 60));
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, 'region end marker: ' + endMarker.slice(0, 60));
  return source.slice(start, end + endMarker.length);
}
const classifiers = ['isRecord3', 'isRecord4', 'responseError', 'stringifyError', 'isCompactionRound', 'verdictFromEvidence', 'transcriptEntries', 'classifyTerminalEvidence', 'classifyAssistantTurnEvidence'];
const round = (n, parentID = 'msg_input' + n) => [
  {info: {id: 'msg_input' + n, role: 'user'}, parts: [{type: 'text', text: 'question ' + n}]},
  {info: {id: 'msg_final' + n, role: 'assistant', parentID, finish: 'stop', time: {completed: n * 100}}, parts: [{type: 'text', text: 'answer ' + n}]},
];
const side = (value, entry) => typeof value === 'string' ? value : value[entry];

test('3.0.4 pins exact upstream bytes and rejects drift, wrong version and wrong entry', () => {
  if (skip304(test)) return;
  for (const entry of ['index', 'server']) {
    assert.equal(digest(stock(entry)), OMO_TARGETS['3.0.4']?.entries[entry]);
    assert.throws(() => patchOmo(stock(entry) + '\n// drift'), /Unsupported/);
    assert.throws(() => patchOmo(stock(entry), {version: '3.0.3'}), /was requested/);
    assert.throws(() => patchOmo(stock(entry), {entry: entry === 'index' ? 'server' : 'index'}), /was requested/);
  }
  assert.deepEqual(helperImportsFor('3.0.4'), ['../omo-delivery.mjs']);
});

test('3.0.4 applies all 43 patches with unique anchors on both entries', () => {
  if (skip304(test)) return;
  const ids = describeOmoPatches('3.0.4').map(p => p.id);
  assert.equal(ids.length, 43);
  assert.deepEqual(ids, PATCHES_3_0_4.map(p => p.id));
  assert.ok(ids.every(id => id && describeOmoPatches('3.0.4').find(p => p.id === id).purpose));
  for (const entry of ['index', 'server']) {
    const original = stock(entry), result = patched(entry);
    assert.notEqual(result, original);
    assert.ok(result.startsWith('import { deliveryMetadata, deliverySuffix, annotateDeliveryPart, presentDelivery } from "../omo-delivery.mjs";\n'));
    for (const patch of PATCHES_3_0_4) {
      const before = side(patch.anchor, entry), after = side(patch.replacement, entry);
      assert.equal(original.split(before).length, 2, patch.id + ' anchor must be unique in stock ' + entry);
      assert.equal(result.split(after).length, 2, patch.id + ' replacement must appear exactly once in patched ' + entry);
      assert.equal(result.split(before).length - 1, after.includes(before) ? 1 : 0, patch.id + ' anchor must be consumed in patched ' + entry);
    }
  }
});

test('3.0.4 identity attribution via the real classifier on both entries', () => {
  if (skip304(test)) return;
  for (const entry of ['index', 'server']) {
    const {classifyTerminalEvidence} = load(patched(entry), classifiers);
    const response = {data: [...round(1), ...round(2)]};
    for (const [options, n] of [[{}, 2], [{baselineMessageID: 'msg_final1'}, 2], [{promptMessageID: 'msg_input1'}, 1]]) {
      const result = classifyTerminalEvidence(response, options);
      assert.equal(result.text, 'answer ' + n);
      assert.deepEqual(result.bcpOrigin, {inputMessageID: 'msg_input' + n, terminalMessageID: 'msg_final' + n});
    }
    const orphan = round(1); delete orphan[1].info.parentID;
    assert.equal(classifyTerminalEvidence({data: orphan}).bcpOrigin.inputMessageID, undefined);
    assert.equal(classifyTerminalEvidence(response, {promptMessageID: 'msg_missing'}).verdict, 'retry');
    assert.equal(classifyTerminalEvidence(response, {runStartedAt: 201}).verdict, 'absent');
  }
});

test('3.0.4 shim retains new upstream text/time/source metadata and binds only available real input', () => {
  if (skip304(test)) return;
  const {toV1Transcript} = load(patched('server'), ['isRecord3', 'isRecord4', 'messageTime', 'toV1Message', 'toV1Transcript']);
  const mapped = toV1Transcript([
    {id: 'msg_u1', type: 'user', time: 10, payload: {text: 'question'}},
    {id: 'msg_a1', type: 'assistant', text: 'answer', time: {completed: 20}},
    {id: 'idle1', type: 'idle', outcome: 'completed'},
    {id: 'msg_u2', type: 'user', text: 'next'},
    {id: 'msg_a2', type: 'assistant', parentID: 'msg_explicit', text: 'next answer'},
  ]);
  assert.deepEqual(mapped[0].parts, [{type: 'text', text: 'question'}]);
  assert.deepEqual(mapped[0].info.time, {created: 10});
  assert.equal(mapped[0].info.sourceType, 'user');
  assert.equal(mapped[1].info.parentID, 'msg_u1');
  assert.equal(mapped[2].info.role, 'system');
  assert.equal(mapped[2].info.parentID, undefined);
  assert.equal(mapped[4].info.parentID, 'msg_explicit');
  assert.equal(toV1Transcript([{id: 'orphan', type: 'assistant', text: 'orphan'}])[0].info.parentID, undefined);
});

test('3.0.4 native retained-child suffix keeps compact delivery and authoritative recovery identity', () => {
  if (skip304(test)) return;
  const body = 'Verified original body.\n'.repeat(500);
  const ref = {parentSessionID:'ses_parent',agent:'fixer',alias:'fix-1',sessionID:'ses_child'};
  const metadata = {association:'host_message_identity',execution:{state:'completed',task_id:'ses_child',terminal_message_id:'msg_final',input_message_id:'msg_input'},result_reference:{id:'bb://aaaa-bbbb/cccc-dddd/e000001',bytes:Buffer.byteLength(body),text_sha256:digest(body),description:'Retained original',writer:{session_id:'ses_child',message_id:'msg_final',agent:'fixer'},input_message_id:'msg_input'}};
  const names=['isRecord3','isRecord4','stringField','isChildRef','formatChildRef','lastOuterClose','readAuthoritativeChildRef','parseTaskIdFromTaskOutput','parseTaskOutputHeader','parseTagAttributes','presentRetainedChildDelivery'];
  for(const entry of ['index','server']) {
    const f=load(patched(entry),names,{presentDelivery,deliverySuffix});
    const marker='\n'+f.formatChildRef(ref);
    const wrapper='<task id="ses_child" state="completed">\n<task_result>\n'+body+'\n</task_result>\n</task>';
    const input=wrapper+marker;
    assert.equal(presentDelivery(input,metadata),input,'old strict boundary is a real negative baseline');
    const output=f.presentRetainedChildDelivery(input,metadata,'ses_parent');
    assert.ok(!output.includes(body),'original replaced with verified reference');
    assert.ok(output.includes('<bcp_result_reference>'));
    assert.ok(output.endsWith(marker),'original suffix preserved at the authoritative tail');
    assert.deepEqual(f.readAuthoritativeChildRef(output),ref,'real upstream parser can recover the same child');
    for(const changed of [{parentSessionID:'ses_other'},{agent:'oracle'}]) {
      const foreign=wrapper+'\n'+f.formatChildRef({...ref,...changed});
      assert.equal(f.presentRetainedChildDelivery(foreign,metadata,'ses_parent'),foreign,'mismatched owner/agent is not compacted');
    }
    const stale={...metadata,result_reference:{...metadata.result_reference,input_message_id:'msg_old'}};
    assert.ok(f.presentRetainedChildDelivery(input,stale,'ses_parent').includes(body),'stale input remains full');
    assert.ok(f.presentRetainedChildDelivery(input+'\nunknown trailer',metadata,'ses_parent').includes(body),'unknown trailer remains full');
    assert.ok(f.presentRetainedChildDelivery(wrapper.replace(body,body+'changed')+marker,metadata,'ses_parent').includes(body),'changed body remains full');
  }
});

test('3.0.4 verified cancellation commits only with runtime stability and a valid lease', async () => {
  if (skip304(test)) return;
  for (const entry of ['index', 'server']) {
    const functions = load(patched(entry), [...classifiers, 'createBackgroundJobTerminalGate', 'consumeTerminalCommitToken', 'observationIdentity', 'raceEvidenceDeadline', 'isForegroundNativeTerminal'], {
      terminalCommitBrand: Symbol('test'), authorizedByGate: new WeakMap(), log: () => {},
      STOPPED_WITHOUT_TERMINAL_RESULT: 'Background session stopped before a terminal task result was received.',
      EVIDENCE_UNAVAILABLE_DIAGNOSTIC: 'Terminal evidence could not be read after repeated attempts; task termination is unconfirmed (observation unavailable).',
    });
    // Scenario 1: cancellation while the runtime is not yet stable never commits.
    {
      let record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 0, activityRevision: 1, state: 'running'};
      let gate, commits = 0;
      const board = {
        get: () => record,
        validateLease: () => true,
        bindTerminalGate: value => { gate = value; },
        markStatusUncertain: () => ({}),
        commitTerminal: (input, authorization) => {
          assert.equal(functions.consumeTerminalCommitToken(gate, authorization, record, input), true);
          commits++;
          record = {...record, ...input, terminalRevision: record.terminalRevision + 1};
          return record;
        },
      };
      functions.createBackgroundJobTerminalGate({backgroundJobBoard: board, now: () => 1000, graceMs: 1, readTimeoutMs: 0, promptMessageIDFor: () => 'msg_input1', readRuntime: async () => ({kind: 'quiescent', origin: 'cancel-verifier', stable: false, observedAt: 1000}), readTerminalEvidence: async () => ({data: []})});
      try {
        const result = await gate.reconcile({taskID: record.taskID, generation: record.generation}, {kind: 'cancel', lease: 'lease-unstable', reason: 'user cancelled'});
        assert.equal(commits, 0, 'unstable runtime must not authorize cancellation');
        assert.notEqual(result.kind, 'committed');
        assert.equal(record.state, 'running');
      } finally { gate.dispose(); }
    }
    // Scenario 2: stable runtime + valid lease commits cancelled with the lease retained.
    {
      let record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 0, activityRevision: 1, state: 'running'};
      let gate, commits = 0, leaseSeen;
      const board = {
        get: () => record,
        validateLease: lease => lease === 'lease-valid',
        bindTerminalGate: value => { gate = value; },
        markStatusUncertain: () => ({}),
        commitTerminal: (input, authorization) => {
          assert.equal(functions.consumeTerminalCommitToken(gate, authorization, record, input), true);
          commits++;
          leaseSeen = input.cancellationLease;
          record = {...record, ...input, terminalRevision: record.terminalRevision + 1};
          return record;
        },
      };
      functions.createBackgroundJobTerminalGate({backgroundJobBoard: board, now: () => 1000, graceMs: 1, readTimeoutMs: 0, promptMessageIDFor: () => 'msg_input1', readRuntime: async () => ({kind: 'quiescent', origin: 'cancel-verifier', stable: true, observedAt: 1000}), readTerminalEvidence: async () => ({data: []})});
      try {
        const result = await gate.reconcile({taskID: record.taskID, generation: record.generation}, {kind: 'cancel', lease: 'lease-valid', reason: 'user cancelled'});
        assert.equal(result.kind, 'committed');
        assert.equal(commits, 1);
        assert.equal(record.state, 'cancelled');
        assert.equal(record.resultSummary, 'user cancelled');
        assert.equal(leaseSeen, 'lease-valid', 'the verified cancellation lease must ride the commit');
      } finally { gate.dispose(); }
    }
    // Scenario 3: a stale lease cannot cancel; evidence drives the outcome instead.
    {
      let record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 0, activityRevision: 1, state: 'running'};
      let gate, commits = 0, cancelled = 0, runtimeCall = 0, now = 1000;
      const board = {
        get: () => record,
        validateLease: () => false,
        bindTerminalGate: value => { gate = value; },
        markStatusUncertain: () => ({}),
        commitTerminal: (input, authorization) => {
          assert.equal(functions.consumeTerminalCommitToken(gate, authorization, record, input), true);
          commits++;
          if (input.state === 'cancelled') cancelled++;
          record = {...record, ...input, terminalRevision: record.terminalRevision + 1};
          return record;
        },
      };
      functions.createBackgroundJobTerminalGate({backgroundJobBoard: board, now: () => now, graceMs: 1, readTimeoutMs: 0, promptMessageIDFor: () => 'msg_input1', readRuntime: async () => ({kind: 'quiescent', origin: 'cancel-verifier', stable: ++runtimeCall > 1, observedAt: now}), readTerminalEvidence: async () => ({data: []})});
      try {
        const first = await gate.reconcile({taskID: record.taskID, generation: record.generation}, {kind: 'cancel', lease: 'lease-stale', reason: 'user cancelled'});
        assert.notEqual(first.kind, 'committed', 'stale lease must never cancel');
        assert.equal(cancelled, 0, 'stale lease must never cancel');
        now = 5000;
        const result = await gate.reconcile({taskID: record.taskID, generation: record.generation}, {kind: 'cancel', lease: 'lease-stale', reason: 'user cancelled'});
        assert.equal(result.kind, 'committed');
        assert.equal(record.state, 'stopped', 'evidence-based outcome replaces the unverifiable cancel');
        assert.equal(commits, 1);
      } finally { gate.dispose(); }
    }
  }
});

test('3.0.4 gate stability window starts at the later of quiescence and attempt start', async () => {
  if (skip304(test)) return;
  for (const entry of ['index', 'server']) {
    const functions = load(patched(entry), [...classifiers, 'createBackgroundJobTerminalGate', 'consumeTerminalCommitToken', 'observationIdentity', 'raceEvidenceDeadline', 'isForegroundNativeTerminal'], {
      terminalCommitBrand: Symbol('test'), authorizedByGate: new WeakMap(), log: () => {},
      STOPPED_WITHOUT_TERMINAL_RESULT: 'Background session stopped before a terminal task result was received.',
      EVIDENCE_UNAVAILABLE_DIAGNOSTIC: 'Terminal evidence could not be read after repeated attempts; task termination is unconfirmed (observation unavailable).',
    });
    let record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 0, activityRevision: 1, state: 'running', runStartedAt: 500};
    let gate, commits = 0, now = 1000;
    const board = {
      get: () => record,
      validateLease: () => true,
      bindTerminalGate: value => { gate = value; },
      markStatusUncertain: () => ({}),
      commitTerminal: (input, authorization) => {
        assert.equal(functions.consumeTerminalCommitToken(gate, authorization, record, input), true);
        commits++;
        record = {...record, ...input, terminalRevision: record.terminalRevision + 1};
        return record;
      },
    };
    functions.createBackgroundJobTerminalGate({backgroundJobBoard: board, now: () => now, graceMs: 5000, readTimeoutMs: 0, promptMessageIDFor: () => 'msg_input1', attemptStartedAtFor: () => 500, readRuntime: async () => ({kind: 'quiescent', origin: 'cancel-verifier', stable: now >= 6000, observedAt: now}), readTerminalEvidence: async () => ({data: []})});
    try {
      await gate.reconcile({taskID: record.taskID, generation: record.generation});
      assert.equal(commits, 0);
      now = 3000;
      const early = await gate.reconcile({taskID: record.taskID, generation: record.generation}, {kind: 'cancel', lease: 'lease-early', reason: 'user cancelled'});
      assert.equal(commits, 0, 'grace window must block both cancel and evidence commits');
      assert.notEqual(early.kind, 'committed');
      now = 6500;
      const late = await gate.reconcile({taskID: record.taskID, generation: record.generation}, {kind: 'cancel', lease: 'lease-late', reason: 'user cancelled'});
      assert.equal(late.kind, 'committed');
      assert.equal(record.state, 'cancelled');
      assert.equal(commits, 1);
    } finally { gate.dispose(); }
    // Attempt starting AFTER quiescence extends the stability window: the old
    // quiescence-only rule would already commit 'stopped' at now=6500
    // (6500-1000 >= 5000), but stability must measure from the attempt start.
    {
      let record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 0, activityRevision: 1, state: 'running', runStartedAt: 500};
      let gate, commits = 0, now = 1000;
      const board = {
        get: () => record,
        validateLease: () => true,
        bindTerminalGate: value => { gate = value; },
        markStatusUncertain: () => ({}),
        commitTerminal: (input, authorization) => {
          assert.equal(functions.consumeTerminalCommitToken(gate, authorization, record, input), true);
          commits++;
          record = {...record, ...input, terminalRevision: record.terminalRevision + 1};
          return record;
        },
      };
      functions.createBackgroundJobTerminalGate({backgroundJobBoard: board, now: () => now, graceMs: 5000, readTimeoutMs: 0, promptMessageIDFor: () => undefined, attemptStartedAtFor: () => 7000, readRuntime: async () => ({kind: 'quiescent', origin: 'cancel-verifier', observedAt: now}), readTerminalEvidence: async () => ({data: []})});
      try {
        await gate.reconcile({taskID: record.taskID, generation: record.generation});
        assert.equal(commits, 0, 'quiescence at 1000 with attempt start 7000 is not yet stable');
        now = 6500;
        await gate.reconcile({taskID: record.taskID, generation: record.generation});
        assert.equal(commits, 0, 'quiescence-only aging must not commit while the attempt is younger than the grace window');
        now = 12500;
        const result = await gate.reconcile({taskID: record.taskID, generation: record.generation});
        assert.equal(result.kind, 'committed');
        assert.equal(record.state, 'stopped');
        assert.equal(commits, 1);
      } finally { gate.dispose(); }
    }
  }
});

test('3.0.4 observation-pending fence blocks ordinary completion but not verified cancellation', async () => {
  if (skip304(test)) return;
  for (const entry of ['index', 'server']) {
    const functions = load(patched(entry), [...classifiers, 'createBackgroundJobTerminalGate', 'consumeTerminalCommitToken', 'observationIdentity', 'raceEvidenceDeadline', 'isForegroundNativeTerminal'], {
      terminalCommitBrand: Symbol('test'), authorizedByGate: new WeakMap(), log: () => {},
      STOPPED_WITHOUT_TERMINAL_RESULT: 'Background session stopped before a terminal task result was received.',
      EVIDENCE_UNAVAILABLE_DIAGNOSTIC: 'Terminal evidence could not be read after repeated attempts; task termination is unconfirmed (observation unavailable).',
    });
    const build = pending => {
      let record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 0, activityRevision: 1, state: 'running'};
      let gate;
      const state = {commits: 0, refusedAuthorization: 0};
      const board = {
        get: () => record,
        validateLease: lease => lease === 'lease-valid',
        bindTerminalGate: value => { gate = value; },
        markStatusUncertain: () => ({}),
        commitTerminal: (input, authorization) => {
          if (!functions.consumeTerminalCommitToken(gate, authorization, record, input)) {
            state.refusedAuthorization++;
            return record;
          }
          state.commits++;
          record = {...record, ...input, terminalRevision: record.terminalRevision + 1};
          return record;
        },
      };
      return {recordRef: () => record, state, gateRef: () => gate, board};
    };
    // (1) observation pending + verified cancellation: the commit authorization
    // waives the fence for the cancelled state, so the cancel commits.
    {
      const h = build(true);
      functions.createBackgroundJobTerminalGate({backgroundJobBoard: h.board, now: () => 1000, graceMs: 1, readTimeoutMs: 0, promptMessageIDFor: () => 'msg_input1', isObservationPending: () => true, readRuntime: async () => ({kind: 'quiescent', origin: 'cancel-verifier', stable: true, observedAt: 1000}), readTerminalEvidence: async () => ({data: []})});
      try {
        const result = await h.gateRef().reconcile({taskID: 'ses_child', generation: 2}, {kind: 'cancel', lease: 'lease-valid', reason: 'user cancelled'});
        assert.equal(result.kind, 'committed');
        assert.equal(h.state.commits, 1);
        assert.equal(h.recordRef().state, 'cancelled');
        assert.equal(h.recordRef().resultSummary, 'user cancelled');
      } finally { h.gateRef().dispose(); }
    }
    // (2) observation pending + ordinary completion evidence: the commit
    // authorization rejects the transcript attribution, so nothing publishes.
    {
      const h = build(true);
      functions.createBackgroundJobTerminalGate({backgroundJobBoard: h.board, now: () => 1000, graceMs: 1, readTimeoutMs: 0, promptMessageIDFor: () => 'msg_input1', isObservationPending: () => true, readTerminalEvidence: async () => ({data: [...round(1), ...round(2)]})});
      try {
        const result = await h.gateRef().reconcile({taskID: 'ses_child', generation: 2});
        assert.notEqual(result.kind, 'committed');
        assert.equal(h.state.refusedAuthorization, 1, 'the completed commit must be refused by its authorization');
        assert.equal(h.state.commits, 0);
        assert.equal(h.recordRef().state, 'running');
      } finally { h.gateRef().dispose(); }
    }
    // (3) control: the same completion evidence with no pending observation commits normally.
    {
      const h = build(false);
      functions.createBackgroundJobTerminalGate({backgroundJobBoard: h.board, now: () => 1000, graceMs: 1, readTimeoutMs: 0, promptMessageIDFor: () => 'msg_input1', isObservationPending: () => false, readTerminalEvidence: async () => ({data: [...round(1), ...round(2)]})});
      try {
        const result = await h.gateRef().reconcile({taskID: 'ses_child', generation: 2});
        assert.equal(result.kind, 'committed');
        assert.equal(h.state.commits, 1);
        assert.equal(h.recordRef().state, 'completed');
        assert.equal(h.recordRef().resultSummary, 'answer 1');
      } finally { h.gateRef().dispose(); }
    }
  }
});

test('3.0.4 v2 background default flips only omitted args, never explicit values', () => {
  if (skip304(test)) return;
  const startMarker = 'if (deps.hostFlavor === "v2" && deps.isBackgroundDefaultFlipArmed?.()) {';
  for (const entry of ['index', 'server']) {
    const source = patched(entry);
    if (!source.includes(startMarker)) { assert.ok(source.includes('isBackgroundDefaultFlipArmed'), entry + ' retains flip wiring'); continue; }
    const start = source.indexOf(startMarker);
    const close = source.indexOf('\n  }', start);
    assert.ok(close > start, entry + ' flip block closes');
    const body = source.slice(start, close + 4);
    const logs = [];
    const drive = (deps, args) => new Function('deps', 'log', 'isRecord4', 'input', 'output', 'const args = output.args;\n' + body + '\nreturn args;')(
      deps, message => logs.push(String(message)), value => typeof value === 'object' && value !== null, {sessionID: 'ses caller'}, {args},
    );
    const armed = {hostFlavor: 'v2', isBackgroundDefaultFlipArmed: () => true};
    assert.equal(drive(armed, {}).background, true, 'omitted args default to background on v2 when armed');
    assert.equal(drive(armed, {background: false}).background, false, 'explicit false stays foreground');
    assert.equal(drive(armed, {background: true}).background, true, 'explicit true stays background');
    assert.equal(drive({hostFlavor: 'v2', isBackgroundDefaultFlipArmed: () => false}, {}).background, undefined, 'unarmed flip changes nothing');
    assert.equal(drive({hostFlavor: 'v1', isBackgroundDefaultFlipArmed: () => true}, {}).background, undefined, 'v1 keeps upstream default');
    assert.ok(logs.some(m => m.includes('v2 background default applied')), 'flip is observable');
    assert.ok(logs.some(m => m.includes('v2 background explicit')), 'explicit value is logged, untouched');
  }
});

test('3.0.4 foreground delivery races: retry loop stops on committed and CAS drops stale metadata', async () => {
  if (skip304(test)) return;
  const startMarker = 'const nativeSignal = {';
  const endMarker = 'log("[task-session-manager] foreground task status registered"';
  for (const entry of ['index', 'server']) {
    const source = patched(entry);
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start > 0 && end > start, entry + ' foreground delivery region found');
    const body = source.slice(start, end);
    const depsFn = new Function('deps', 'record', 'status', 'pending', 'exactCallConfirmed', 'hostConfirmedBackground', 'childRefAllowed', 'output', 'raceEvidenceDeadline', 'log', 'deliveryMetadata', 'presentRetainedChildDelivery', 'return async () => {\n' + body + '\n}');
    const build = () => {
      const record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 3, activityRevision: 7, state: 'running', alias: 'fix-1'};
      const reconciles = [], raced = [];
      const gate = {reconcile: async (observed, signal) => { reconciles.push({observed: observed.taskID, generation: observed.generation, signal: signal.kind}); return gate.responses.shift() ?? {kind: 'committed'}; }, responses: []};
      const deps = {
        directory: '/fixture', hostFlavor: 'v2',
        terminalGate: gate,
        backgroundJobBoard: {get: () => record},
        bindConcurrencyTicket: () => {}, clearRehydrateTombstone: () => {},
      };
      const pending = {callId: 'call_1', parentSessionId: 'ses_parent', agentType: 'fixer'};
      const status = {taskID: 'ses_child', state: 'completed'};
      const meta = {association: 'host_message_identity', marker: 'meta'};
      const racedFn = async (retryAfter, ms) => { raced.push({retryAfter, ms}); return 'raced'; };
      const run = (overrides = {}) => depsFn(
        deps, overrides.record ?? record, status, pending, true, false, true,
        overrides.output ?? {output: 'raw output', metadata: {}},
        overrides.raceEvidenceDeadline ?? racedFn,
        () => {},
        overrides.deliveryMetadata ?? (async () => meta),
        overrides.presentRetainedChildDelivery ?? ((text, metadata, parentSessionID) => 'DELIVERED<' + parentSessionID + '>' + metadata.marker),
      )();
      return {run, deps, gate, record, reconciles, raced, meta};
    };
    // (a) deferred-then-committed: loop honors retryAfter via raceEvidenceDeadline, re-reconciles, then delivers fresh.
    {
      const h = build();
      h.gate.responses.push({kind: 'deferred', retryAfter: 'retry-signal'}, {kind: 'committed'});
      const output = {output: 'raw output', metadata: {}};
      await h.run({output});
      assert.deepEqual(h.reconciles, [{observed: 'ses_child', generation: 2, signal: 'output'}, {observed: 'ses_child', generation: 2, signal: 'output'}]);
      assert.deepEqual(h.raced, [{retryAfter: 'retry-signal', ms: 2000}]);
      assert.equal(output.output, 'DELIVERED<ses_parent>meta', 'fresh execution delivers with verified metadata');
      assert.equal(output.metadata.bcp_delivery, h.meta, 'delivery metadata is attached for consumers');
    }
    // (b) generation change during the loop breaks retries.
    {
      const h = build();
      h.gate.responses.push({kind: 'deferred', retryAfter: 'retry-signal'});
      h.deps.backgroundJobBoard.get = () => (h.reconciles.length >= 1 ? {...h.record, generation: 9} : h.record);
      await h.run();
      assert.equal(h.reconciles.length, 1, 'generation change must break the retry loop');
    }
    // (c) CAS passes when the record is unchanged through the metadata await.
    {
      const h = build();
      let delivered;
      await h.run({presentRetainedChildDelivery: (text, metadata, parentSessionID) => { delivered = {parentSessionID, marker: metadata.marker}; return 'DELIVERED'; }});
      assert.deepEqual(delivered, {parentSessionID: 'ses_parent', marker: 'meta'});
    }
    // (d) CAS drops delivery when activityRevision moves during the metadata await.
    {
      const h = build();
      let resolveMeta;
      const metaPromise = new Promise(resolve => { resolveMeta = resolve; });
      let live = h.record;
      h.deps.backgroundJobBoard.get = () => live;
      const pendingRun = h.run({
        deliveryMetadata: async () => { live = {...live, activityRevision: 8}; await metaPromise; return h.meta; },
        presentRetainedChildDelivery: () => { throw new Error('must not deliver on stale execution'); },
      });
      resolveMeta();
      await pendingRun;
    }
  }
});

test('3.0.4 terminal notification suppresses stale sends via the real currentness fence and preserves lease release', async () => {
  if (skip304(test)) return;
  const startMarker = 'async function notifyParent(run, record) {';
  const currentMarker = 'function isCurrentNotification(run, record, notification) {';
  const retryMarker = 'function scheduleNotificationRetry(run, record, notification) {';
  const closeMarker = '\n  }';
  for (const entry of ['index', 'server']) {
    const source = patched(entry);
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, 'notifyParent in ' + entry);
    const end = source.indexOf(closeMarker, start);
    const body = source.slice(start, end + closeMarker.length);
    const curStart = source.indexOf(currentMarker);
    assert.ok(curStart >= 0, 'isCurrentNotification in ' + entry);
    const curBody = source.slice(curStart, source.indexOf(closeMarker, curStart) + closeMarker.length);
    const retryStart = source.indexOf(retryMarker);
    assert.ok(retryStart >= 0, 'scheduleNotificationRetry in ' + entry);
    const retryBody = source.slice(retryStart, source.indexOf(closeMarker, retryStart) + closeMarker.length);
    // The real responseError/stringifyError reference module-scope isRecord4
    // and isRecord3 guards; inject identical one-liners as free bindings.
    const {terminalOutcome, responseError, stringifyError: bundleStringifyError} = load(patched(entry), ['terminalOutcome', 'responseError', 'stringifyError'], {
      isRecord3: value => typeof value === 'object' && value !== null && !Array.isArray(value),
      isRecord4: value => typeof value === 'object' && value !== null,
    });
    // The REAL upstream transport wrapper: it defers the send operation by a
    // microtask (Promise.resolve().then(operation)) and invokes the acceptance
    // callback in a later hop — exactly the deferral windows that can race a
    // board change between the freshness comparison and the send/accept.
    const realTransport = new Function('responseError', 'stringifyError', 'NotificationTransportTimeoutError', 'TERMINAL_NOTIFICATION_TIMEOUT_MS', 'return ' + declaration(patched(entry), 'awaitNotificationTransport') + ';')(
      responseError, bundleStringifyError, class extends Error {}, 10000,
    );
    const build = (overrides = {}) => {
      const notification = {sent: false, pending: false, attempts: 0, ownershipReleased: false};
      const run = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 1, terminalState: 'completed', description: 'do work', notification};
      const record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 1, activityRevision: 5, state: 'completed', resultSummary: 'done work'};
      let live = record;
      let resolveMeta;
      const metaPromise = new Promise(resolve => { resolveMeta = resolve; });
      let metaReachedResolve;
      const metaReached = new Promise(resolve => { metaReachedResolve = resolve; });
      let metaWait = false;
      const hooks = {};
      const calls = {promptParent: [], acquired: [], released: [], transport: 0, suppressed: [], logs: [], ownershipReleased: []};
      const options2 = {
        input: {directory: '/fixture'},
        resolveSelection: async () => ({agent: 'fixer'}),
        onOwnershipReleased: (...args) => { calls.ownershipReleased.push(args); },
        backgroundJobBoard: {
          get: () => live,
          acquireTerminalNotificationLease: (taskID, generation, terminalRevision) => { calls.acquired.push([taskID, generation, terminalRevision]); return overrides.noLease ? undefined : {token: 'lease-1'}; },
          validateLease: () => true,
          releaseLease: lease => { calls.released.push(lease); },
        },
      };
      // The REAL upstream currentness fence, extracted and driven with the
      // same tracker state it sees in production (runs map, disposed flag,
      // live board record); only host transport/IO below are stubs.
      const isCurrentNotification = new Function('options2', 'disposed', 'runs', 'terminalOutcome', 'return ' + curBody + ';')(options2, false, new Map([[run.taskID, run]]), terminalOutcome);
      const log = (message, fields) => { calls.logs.push([String(message), fields]); if (String(message).includes('suppressed')) calls.suppressed.push({message, fields}); };
      const failedLogged = () => calls.logs.some(([message]) => message.includes('notification failed'));
      const changeBoard = () => { live = {...record, activityRevision: 6}; };
      // The REAL upstream retry scheduler, extracted with its production
      // closure shape: its guard consults the real currentness fence, so a
      // stale notification can never re-arm a retry timer. The retry loop
      // re-invokes the real notifyParent after retryDelayMs.
      let realNotifyParent;
      const scheduleNotificationRetry = new Function('options2', 'isCurrentNotification', 'notifyParent', 'maxNotificationRetries', 'retryDelayMs', 'log', 'setTimeout', 'return ' + retryBody + ';')(
        options2, isCurrentNotification, runArg => realNotifyParent(runArg, record), 2, 5, log, setTimeout,
      );
      const deps = {
        options2,
        isCurrentNotification,
        promptParent: async (parentSessionID, selection, text) => {
          calls.promptParent.push({parentSessionID, selection, text});
          if (overrides.mutateAfterSend) {
            // Lands in the deferral window between the transport send and the
            // acceptance callback: the wrapper invokes onAccepted one
            // microtask after the operation resolves.
            queueMicrotask(changeBoard);
          }
          return {id: 'msg_sent'};
        },
        scheduleNotificationRetry,
        log,
        deliveryMetadata: async (directory, value) => {
          if (metaWait) {
            // The perturbation lands during the metadata await — after both
            // upstream pre-await currentness checks have already passed with
            // the then-unchanged live record — so the patched POST-await
            // comparison is what observes the change.
            hooks.perturb?.();
            metaReachedResolve();
            await metaPromise;
            return {association: 'host_message_identity'};
          }
          return {association: 'host_message_identity'};
        },
        presentDelivery: (text, metadata) => {
          if (overrides.mutateInPresentation) {
            // Lands after the post-await comparison but before the transport
            // boundary: the real wrapper defers the send operation by a
            // microtask, so this change is only caught at the send boundary.
            changeBoard();
          }
          return 'PRESENTED[' + metadata.association + ']:' + text;
        },
        deliverySuffix: metadata => '\n<bcp_delivery_metadata>' + JSON.stringify(metadata) + '</bcp_delivery_metadata>',
        awaitNotificationTransport: overrides.realTransport ? realTransport : async (send, onAccept) => {
          calls.transport++;
          if (overrides.transportFails) throw new Error('transport down');
          const result = await send();
          await onAccept?.(result);
          return result;
        },
        NotificationTransportTimeoutError: class extends Error {},
          // Real bundle-level record guards used by the real responseError
          // inside the transport wrapper (module-scope bindings upstream).
          isRecord3: value => typeof value === 'object' && value !== null && !Array.isArray(value),
          isRecord4: value => typeof value === 'object' && value !== null,
          stringifyError: error => String(error?.message ?? error),
      };
      realNotifyParent = new Function(...Object.keys(deps), 'return ' + body + ';')(...Object.values(deps));
      return {notifyParent: realNotifyParent, run, record, notification, calls, hooks, isCurrentNotification, setLive: value => { live = value; }, resolveMeta, metaReached, armMetaWait: () => { metaWait = true; }, failedLogged};
    };
    // (0) the real fence is in play: current before any change, stale after —
    // including an activity-only change (the new currentness dimension).
    {
      const h = build();
      assert.equal(h.isCurrentNotification(h.run, h.record, h.notification), true);
      h.setLive({...h.record, generation: 3});
      assert.equal(h.isCurrentNotification(h.run, h.record, h.notification), false, 'real currentness must consult the live board record');
      h.setLive({...h.record, activityRevision: 6});
      assert.equal(h.isCurrentNotification(h.run, h.record, h.notification), false, 'an activity-only change must invalidate currentness');
    }
    // (a) fresh execution: transport awaited, metadata confirmed, lease released.
    {
      const h = build();
      await h.notifyParent(h.run, h.record);
      assert.equal(h.calls.transport, 1, 'notification transport must be awaited');
      assert.equal(h.calls.acquired.length, 1);
      assert.deepEqual(h.calls.acquired[0], ['ses_child', 2, 1]);
      assert.equal(h.calls.promptParent.length, 1);
      assert.ok(h.calls.promptParent[0].text.includes('PRESENTED[host_message_identity]:done work'));
      assert.ok(h.calls.promptParent[0].text.includes('"association":"host_message_identity"'));
      assert.equal(h.notification.sent, true);
      assert.equal(h.calls.released.length, 1, 'lease must be released in finally');
      assert.equal(h.notification.pending, false);
    }
    // (b/c) each staleness dimension changing during the metadata await
    // suppresses the notification entirely: no presentation, no transport,
    // no stale retry; the lease is still released and pending is cleared.
    for (const [field, value] of [['generation', 3], ['terminalRevision', 2], ['activityRevision', 6]]) {
      const h = build();
      h.armMetaWait();
      h.hooks.perturb = () => h.setLive({...h.record, [field]: value});
      const pendingSend = h.notifyParent(h.run, h.record);
      h.resolveMeta();
      await pendingSend;
      assert.equal(h.calls.acquired.length, 1, 'the lease was acquired before the await');
      assert.equal(h.calls.promptParent.length, 0, field + ' change must suppress the send');
      assert.equal(h.calls.transport, 0, field + ' change must never reach the transport');
      assert.equal(h.notification.retryTimer, undefined, field + ' change must not arm a stale retry timer');
      assert.equal(h.notification.sent, false, field + ' change must leave the notification unsent');
      assert.equal(h.notification.attempts, 1, 'the attempt stays accounted');
      assert.equal(h.calls.released.length, 1, 'finally must still release the lease');
      assert.equal(h.notification.pending, false);
      assert.equal(h.calls.suppressed.length, 1, field + ' suppression must be observable in the log');
      assert.deepEqual(h.calls.suppressed[0].fields, {taskID: 'ses_child', generation: 2, parentSessionID: 'ses_parent', attempt: 1});
    }
    // (g) the re-review race, verbatim shape: the metadata resolves, and the
    // board change is queued as a microtask right at that resolution. The
    // patched comparison runs as a statement AFTER the enclosing await —
    // i.e. strictly after every microtask queued at resolution — so the
    // change is observed and the notification is suppressed for each of the
    // three revisions independently.
    for (const [field, value] of [['generation', 3], ['terminalRevision', 2], ['activityRevision', 6]]) {
      const h = build();
      h.armMetaWait();
      const pendingSend = h.notifyParent(h.run, h.record);
      await h.metaReached;
      h.resolveMeta();
      queueMicrotask(() => h.setLive({...h.record, [field]: value}));
      await pendingSend;
      assert.equal(h.calls.acquired.length, 1, 'the lease was acquired before the await');
      assert.equal(h.calls.promptParent.length, 0, field + ' change queued at metadata resolution must suppress the send');
      assert.equal(h.calls.transport, 0, field + ' change queued at metadata resolution must never reach the transport');
      assert.equal(h.notification.retryTimer, undefined, 'no stale retry timer may be armed');
      assert.equal(h.notification.sent, false, field + ' change queued at metadata resolution must leave the notification unsent');
      assert.equal(h.notification.attempts, 1);
      assert.equal(h.calls.released.length, 1, 'finally must still release the lease');
      assert.equal(h.notification.pending, false);
      assert.equal(h.calls.suppressed.length, 1, 'suppression must be observable in the log');
    }
    // (d) staleness before the call: the real upstream pre-await fence returns
    // without any attempt at all.
    {
      const h = build();
      h.setLive({...h.record, terminalRevision: 2});
      await h.notifyParent(h.run, h.record);
      assert.equal(h.calls.acquired.length, 0);
      assert.equal(h.calls.promptParent.length, 0);
      assert.equal(h.notification.retryTimer, undefined);
      assert.equal(h.calls.released.length, 0);
      assert.equal(h.notification.attempts, 0, 'the pre-check refund nothing because nothing was attempted');
      assert.equal(h.notification.pending, false);
    }
    // (e) lease unavailable: no send, the real retry scheduler re-arms and
    // re-attempts with fresh records while the notification stays current;
    // attempts stay refunded and nothing is released.
    {
      const h = build({noLease: true});
      await h.notifyParent(h.run, h.record);
      assert.equal(h.calls.promptParent.length, 0);
      assert.ok(h.notification.retryTimer !== undefined, 'a retry timer is armed for the deferred lease');
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.ok(h.calls.acquired.length >= 3, 'the retry loop re-attempts with fresh records: acquired=' + h.calls.acquired.length);
      assert.equal(h.calls.promptParent.length, 0);
      assert.equal(h.calls.released.length, 0);
      assert.equal(h.notification.attempts, 0, 'failed acquisition refunds the attempt');
      assert.equal(h.notification.ownershipReleased, false, 'refunded attempts never exhaust the retry budget');
      clearTimeout(h.notification.retryTimer);
    }
    // (f) transport failure: the real retry scheduler re-attempts once, then
    // releases notification ownership at the retry budget; the lease is
    // released by finally on every attempt and nothing is sent.
    {
      const h = build({transportFails: true});
      await h.notifyParent(h.run, h.record);
      assert.equal(h.calls.promptParent.length, 0, 'transport failure must not deliver');
      assert.ok(h.failedLogged(), 'transport failure must be logged as failed');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(h.notification.ownershipReleased, true, 'the retry budget must release notification ownership');
      assert.equal(h.calls.ownershipReleased.length, 1, 'the parent must be told once');
      assert.equal(h.notification.retryTimer, undefined, 'no timer survives ownership release');
      assert.equal(h.notification.attempts, 2, 'both attempts stay accounted');
      assert.equal(h.calls.released.length, 2, 'each attempt releases its lease in finally');
      assert.equal(h.notification.sent, false);
      assert.equal(h.notification.pending, false);
    }
    // (h) the transport-wrapper deferral window, real wrapper: the board
    // changes after the post-await comparison (during presentation) and is
    // caught only at the real send boundary — no delivery, no retry timer
    // (the real retry guard refuses stale notifications), lease released.
    {
      const h = build({realTransport: true, mutateInPresentation: true});
      await h.notifyParent(h.run, h.record);
      assert.equal(h.calls.promptParent.length, 0, 'a change landing before the send boundary must suppress the delivery');
      assert.equal(h.notification.sent, false);
      assert.ok(h.failedLogged(), 'the boundary refusal is logged as a failed notification attempt');
      assert.equal(h.notification.retryTimer, undefined, 'the real retry guard must refuse to re-arm a stale notification');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(h.calls.promptParent.length, 0, 'no delayed retry may deliver stale output');
      assert.equal(h.notification.attempts, 1);
      assert.equal(h.calls.released.length, 1, 'finally must still release the lease');
      assert.equal(h.notification.pending, false);
      assert.equal(h.calls.suppressed.length, 0, 'the sentinel suppression path is not taken for a boundary refusal');
    }
    // (i) the acceptance-callback window, real wrapper: the send itself wins
    // the race but the board changes before the acceptance callback runs —
    // the real acceptance guard must refuse, so the notification is never
    // marked sent and no retry is armed.
    {
      const h = build({realTransport: true, mutateAfterSend: true});
      await h.notifyParent(h.run, h.record);
      assert.equal(h.calls.promptParent.length, 1, 'the physical send raced ahead');
      assert.equal(h.notification.sent, false, 'a raced acceptance must not mark a stale delivery as sent');
      assert.equal(h.notification.retryTimer, undefined);
      assert.equal(h.notification.attempts, 1);
      assert.equal(h.calls.released.length, 1, 'finally must still release the lease');
      assert.equal(h.notification.pending, false);
      assert.equal(h.failedLogged(), false, 'an acceptance refusal is not an error: ' + JSON.stringify(h.calls.logs));
    }
    // (j) control: the same real wrapper with no race delivers exactly once
    // and marks the notification sent.
    {
      const h = build({realTransport: true});
      await h.notifyParent(h.run, h.record);
      assert.equal(h.calls.promptParent.length, 1);
      assert.equal(h.notification.sent, true);
      assert.ok(h.calls.logs.some(([message]) => message.includes('notification accepted')));
      assert.equal(h.calls.released.length, 1);
      assert.equal(h.notification.pending, false);
    }
  }
});

test('3.0.4 readonly consumed-result path carries identity, retains ownership fences and rejects changed execution', async () => {
  if (skip304(test)) return;
  for (const entry of ['index', 'server']) {
    let seen;
    const record = {taskID: 'ses_child', parentSessionID: 'ses_parent', state: 'completed', generation: 2, terminalRevision: 1, activityRevision: 4, resultSummary: 'answer', bcpOrigin: {inputMessageID: 'msg_input2', terminalMessageID: 'msg_final2'}};
    let latest = record;
    const {readonlyTerminalResult} = load(patched(entry), ['readonlyTerminalResult'], {
      deliveryMetadata: async (directory, value) => { seen = {directory, value}; return {association: 'confirmed'}; },
      presentDelivery: text => text,
      deliverySuffix: () => '\nreceipt',
    });
    const board = {get: () => latest};
    assert.equal(await readonlyTerminalResult('ses_child', record, '/fixture', board), 'answer\nreceipt');
    assert.deepEqual(seen.value.bcpOrigin, record.bcpOrigin);
    assert.equal(seen.directory, '/fixture');
    for (const [field, value] of [['generation', 3], ['terminalRevision', 2], ['activityRevision', 5], ['parentSessionID', 'ses_other']]) {
      latest = {...record, [field]: value};
      await assert.rejects(() => readonlyTerminalResult('ses_child', record, '/fixture', board), /changed/, field + ' mismatch must refuse');
    }
    latest = record;
    await assert.rejects(() => readonlyTerminalResult('ses_child', {...record, state: 'running'}, '/fixture', board), /No action was sent/);
  }
});

test('3.0.4 untracked task resolution refuses disposed and refused identities before any board fallback', async () => {
  if (skip304(test)) return;
  for (const entry of ['index', 'server']) {
    const {resolveTaskRecord} = load(patched(entry), ['resolveTaskRecord']);
    const options2 = {
      resolveCanonicalTaskRef: async () => ({kind: 'refused', reason: 'parent session no longer tracks this task'}),
    };
    const refused = await resolveTaskRecord(options2, 'ses_parent', 'fix-1');
    assert.deepEqual(refused, {kind: 'refused', reason: 'parent session no longer tracks this task'});
    const disposed = await resolveTaskRecord({
      resolveCanonicalTaskRef: async () => undefined,
      isDisposed: () => true,
    }, 'ses_parent', 'fix-1');
    assert.equal(disposed.kind, 'disposed');
    const canonical = await resolveTaskRecord({
      resolveCanonicalTaskRef: async () => ({taskID: 'ses_child'}),
      isDisposed: () => false,
      backgroundJobBoard: {get: identity => ({taskID: identity, state: 'running'})},
    }, 'ses_parent', 'fix-1');
    assert.equal(canonical.kind, 'resolved');
    assert.deepEqual(canonical.job, {taskID: 'ses_child', state: 'running'});
    assert.equal(canonical.canonical, true);
    const legacy = await resolveTaskRecord({
      resolveCanonicalTaskRef: async () => undefined,
      isDisposed: () => false,
      backgroundJobBoard: {resolve: (parentSessionID, requested) => ({taskID: 'ses_legacy', parentSessionID, requested})},
    }, 'ses_parent', 'fix-1');
    assert.equal(legacy.kind, 'resolved');
    assert.equal(legacy.canonical, false);
    assert.equal(legacy.job.taskID, 'ses_legacy');
  }
});

test('3.0.4 untracked task_result returns the attributed result through real delivery metadata', async () => {
  if (skip304(test)) return;
  const BRIDGE = Symbol.for('opencode.bcp.delivery.v1');
  const parseMetadata = text => JSON.parse(/<bcp_delivery_metadata>\n([\s\S]*)\n<\/bcp_delivery_metadata>/.exec(text)[1].replaceAll('\\u003c', '<'));
  for (const entry of ['index', 'server']) {
    let transcriptFixture;
    // esbuild renames the tool-definition helper per entry (index: tool10, server: tool).
    const toolWrapper = entry === 'index' ? 'tool10' : 'tool';
    const loaded = load(patched(entry), ['createTaskResultTool', 'resolveTaskRecord', 'readUntrackedEvidence', 'readTranscript', 'readonlyTerminalResult', 'pending2', ...classifiers], {
      [toolWrapper]: factory => factory,
      taskRefArgs: () => ({sessionID: {type: 'string'}}),
      idParamFor: () => 'sessionID',
      readTaskRef: (args, idParam) => args[idParam],
      pluginDisposedMessage: () => 'plugin disposed',
      SESSION_ID_PATTERN: /^ses_[A-Za-z0-9_-]+$/,
      createBackgroundJobTerminalGate: () => { throw new Error('gate must not be constructed when options2.terminalGate is provided'); },
      getRuntimeSessionStatusSnapshot: async () => ({error: undefined, malformedSessionIDs: new Set(), statuses: new Map()}),
      runtimeObservationFromSnapshot: () => undefined,
      runtimeSessionStatus: () => undefined,
      getClient: () => ({session: {get: async () => ({data: {parentID: 'ses_parent'}})}}),
      DEFAULT_READ_TIMEOUT_MS: 3000,
      boundedRead: read => read(),
      fetchChildTranscript: async () => transcriptFixture,
      classifyV2HistoricalRound: () => { throw new Error('v2 classifier must not be used on the v1 untracked path'); },
      deliveryMetadata, presentDelivery, deliverySuffix,
    });
    const run = async transcript => {
      transcriptFixture = transcript;
      const options2 = {
        input: {directory: '/fixture'},
        readTimeoutMs: 3000,
        terminalGate: {capture: () => { throw new Error('gate.capture must not run for untracked reads'); }, observe: () => { throw new Error('gate.observe must not run for untracked reads'); }},
        resolveCanonicalTaskRef: async () => undefined,
        isDisposed: () => false,
        backgroundJobBoard: {resolve: () => undefined, get: () => undefined},
      };
      const tool = loaded.createTaskResultTool(options2).task_result;
      return tool.execute({sessionID: 'ses_child'}, {sessionID: 'ses_parent'});
    };
    // (1) successful origin return: a real classifier-attributed completion
    // round-trips its identity through the real delivery metadata bridge.
    {
      const requests = [];
      const previous = globalThis[BRIDGE];
      globalThis[BRIDGE] = new Map([['/fixture', async request => {
        requests.push(request);
        const confirmed = Boolean(request.inputMessageID && request.terminalMessageID);
        return {schema_version: 1, execution: {task_id: request.taskID, generation: request.generation ?? null, terminal_revision: request.terminalRevision ?? null, state: request.state, input_message_id: request.inputMessageID, terminal_message_id: request.terminalMessageID}, association: confirmed ? 'host_message_identity' : 'unconfirmed', ...confirmed ? {} : {reason: 'input_identity_unavailable'}, candidates: [], coverage: 'verified', applicability: 'applicable'};
      }]]);
      try {
        const text = await run({data: [...round(1), ...round(2)]});
        assert.ok(text.startsWith('answer 2\n'), 'terminal evidence text is presented');
        const metadata = parseMetadata(text);
        assert.equal(metadata.association, 'host_message_identity');
        assert.equal(metadata.execution.task_id, 'ses_child');
        assert.equal(metadata.execution.state, 'completed');
        assert.equal(metadata.execution.input_message_id, 'msg_input2');
        assert.equal(metadata.execution.terminal_message_id, 'msg_final2');
        assert.deepEqual(requests, [{callerSessionID: 'ses_parent', taskID: 'ses_child', generation: undefined, terminalRevision: undefined, state: 'completed', inputMessageID: 'msg_input2', terminalMessageID: 'msg_final2'}]);
      } finally { globalThis[BRIDGE] = previous; }
    }
    // (2) missing identity: an orphan transcript yields no attributable input
    // message, and the receipt degrades to unconfirmed instead of inventing one.
    {
      const orphan = round(1);
      delete orphan[1].info.parentID;
      const requests = [];
      const previous = globalThis[BRIDGE];
      globalThis[BRIDGE] = new Map([['/fixture', async request => {
        requests.push(request);
        return {schema_version: 1, association: 'unconfirmed', reason: 'input_identity_unavailable'};
      }]]);
      try {
        const text = await run({data: orphan});
        assert.ok(text.startsWith('answer 1\n'));
        const metadata = parseMetadata(text);
        assert.equal(metadata.association, 'unconfirmed');
        assert.equal(requests[0].inputMessageID, undefined, 'the orphan transcript must not fabricate an input identity');
        assert.equal(requests[0].terminalMessageID, 'msg_final1', 'the terminal message is still reported');
      } finally { globalThis[BRIDGE] = previous; }
    }
  }
});

test('3.0.4 index and server build relocatable standalone artifacts with complete resource hashes', async () => {
  if (skip304(test)) return;
  for (const entry of ['index', 'server']) {
    const out = join(scratch, entry), relocated = join(scratch, 'relocated-' + entry);
    const {manifest, files} = await buildOmoIntegration({packageDir, sourceDir, outputDir: out, version: '3.0.4', entry});
    assert.equal(manifest.name, 'oh-my-opencode-slim');
    assert.equal(manifest.version, '3.0.4');
    assert.equal(manifest.upstream.digest, OMO_TARGETS['3.0.4'].entries[entry]);
    assert.equal(manifest.patches.length, 43);
    assert.ok(manifest.closure.packages.length > 0);
    for (const file of files) assert.equal(digest(readFileSync(file.path)), file.digest);
    assert.equal(existsSync(join(out, 'omo-council.mjs')), false);
    if (entry === 'index') assert.deepEqual(bareExternalSpecifiers(readFileSync(join(out, entryPath(entry)), 'utf8')), []);
    renameSync(out, relocated);
    const nativePackages = manifest.closure.packages.filter(pkg => pkg.name.startsWith('@ast-grep/cli-')).filter(pkg => {
      const meta = JSON.parse(readFileSync(join(relocated, pkg.installPath, 'package.json')));
      return meta.os?.includes(process.platform) && meta.cpu?.includes(process.arch);
    });
    assert.ok(nativePackages.length > 0, 'target-platform ast-grep package must be present');
    for (const pkg of nativePackages) {
      const binary = join(relocated, pkg.installPath, process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
      assert.match(execFileSync(binary, ['--version'], {timeout: 10000}).toString(), /ast-grep/);
    }
    const home = join(scratch, 'home-' + entry); mkdirSync(home);
    const program = `const mod = await import(process.env.BUNDLE); if(mod.default?.id !== 'oh-my-opencode-slim') throw new Error('wrong plugin'); const {JSDOM}=await import(process.env.JSDOM); if(new JSDOM('<p>closure</p>').window.document.querySelector('p').textContent !== 'closure') throw new Error('closure'); console.log('loaded');`;
    for (const runtime of [process.execPath, ...existsSync(bun) ? [bun] : []]) {
      const output = execFileSync(runtime, ['--input-type=module', '-e', program], {cwd: home, env: {HOME: home, XDG_CACHE_HOME: home, BUN_INSTALL_CACHE_DIR: home, PATH: '/usr/bin:/bin', BUNDLE: pathToFileURL(join(relocated, entryPath(entry))).href, JSDOM: pathToFileURL(join(relocated, 'node_modules/jsdom/lib/api.js')).href}, timeout: 20000, killSignal: 'SIGKILL'}).toString();
      assert.match(output, /loaded/);
    }
  }
});
