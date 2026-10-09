import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, existsSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {patchOmo, OMO_TARGETS, describeOmoPatches} from '../omo-patch.mjs';
import {buildOmoIntegration, bareExternalSpecifiers} from '../build-omo.mjs';
import {presentDelivery, deliverySuffix} from '../omo-delivery.mjs';

const packageDir = process.env.OMO_303_PACKAGE ?? join(homedir(), '.cache/opencode/packages/oh-my-opencode-slim@3.0.3/node_modules/oh-my-opencode-slim');
const sourceDir = fileURLToPath(new URL('..', import.meta.url));
const bun = process.env.BUN_BIN ?? join(homedir(), '.bun/bin/bun');
if (process.env.BUN_BIN !== undefined) assert.ok(bun && existsSync(bun), 'BUN_BIN must name an existing Bun executable');
const scratch = mkdtempSync(join(tmpdir(), 'omo-303-'));
after(() => rmSync(scratch, {recursive: true, force: true}));
const digest = value => createHash('sha256').update(value).digest('hex');
const entryPath = entry => entry === 'index' ? 'dist/index.js' : 'dist/server/index.js';
const stock = entry => readFileSync(join(packageDir, entryPath(entry)), 'utf8');
const patched = entry => patchOmo(stock(entry), {version: '3.0.3', entry});

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
const classifiers = ['isRecord3', 'isRecord4', 'responseError', 'stringifyError', 'isCompactionRound', 'verdictFromEvidence', 'transcriptEntries', 'classifyTerminalEvidence', 'classifyAssistantTurnEvidence'];
const round = (n, parentID = 'msg_input' + n) => [
  {info: {id: 'msg_input' + n, role: 'user'}, parts: [{type: 'text', text: 'question ' + n}]},
  {info: {id: 'msg_final' + n, role: 'assistant', parentID, finish: 'stop', time: {completed: n * 100}}, parts: [{type: 'text', text: 'answer ' + n}]},
];

test('3.0.3 upstream lacks BCP origin even on its new queued-prompt classifier path', () => {
  for (const entry of ['index', 'server']) {
    const {classifyTerminalEvidence} = load(stock(entry), classifiers);
    const result = classifyTerminalEvidence({data: [...round(1), ...round(2)]}, {promptMessageID: 'msg_input1'});
    assert.equal(result.text, 'answer 1');
    assert.equal(result.bcpOrigin, undefined, 'unmodified upstream is the negative baseline');
  }
});

test('3.0.3 locks exact inputs and rejects altered bytes, wrong version and wrong entry', () => {
  for (const entry of ['index', 'server']) {
    assert.equal(digest(stock(entry)), OMO_TARGETS['3.0.3']?.entries[entry]);
    assert.throws(() => patchOmo(stock(entry) + '\n// drift'), /Unsupported/);
    assert.throws(() => patchOmo(stock(entry), {version: '3.0.1'}), /was requested/);
    assert.throws(() => patchOmo(stock(entry), {entry: entry === 'index' ? 'server' : 'index'}), /was requested/);
  }
});

test('3.0.3 preserves input identity for first, resumed and queued rounds; missing identity stays absent', () => {
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

test('3.0.3 shim retains new upstream text/time/source metadata and binds only available real input', () => {
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

test('3.0.3 native retained-child suffix keeps compact delivery and authoritative recovery identity', () => {
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

test('3.0.3 queued gate commits the requested input through real authorization and rejects a stale read', async () => {
  for (const entry of ['index', 'server']) {
    for (const changedDuringRead of [false, true]) {
      const functions = load(patched(entry), [...classifiers, 'createBackgroundJobTerminalGate', 'consumeTerminalCommitToken', 'observationIdentity', 'raceEvidenceDeadline', 'isForegroundNativeTerminal'], {
        terminalCommitBrand: Symbol('test'), authorizedByGate: new WeakMap(), log: () => {},
      });
      let record = {taskID: 'ses_child', parentSessionID: 'ses_parent', generation: 2, terminalRevision: 0, activityRevision: 1, state: 'running'};
      let gate, commits = 0;
      const board = {
        get: () => record,
        bindTerminalGate: value => { gate = value; },
        commitTerminal: (input, authorization) => {
          assert.equal(functions.consumeTerminalCommitToken(gate, authorization, record, input), true);
          commits++;
          record = {...record, ...input, terminalRevision: 1};
          return record;
        },
      };
      functions.createBackgroundJobTerminalGate({backgroundJobBoard: board, now: () => 1000, graceMs: 1, readTimeoutMs: 0, promptMessageIDFor: () => 'msg_input1', readTerminalEvidence: async () => {
        if (changedDuringRead) record = {...record, generation: 3};
        return {data: [...round(1), ...round(2)]};
      }});
      try {
        const result = await gate.reconcile({taskID: record.taskID, generation: record.generation});
        assert.equal(result.kind, changedDuringRead ? 'stale' : 'committed');
        assert.equal(commits, changedDuringRead ? 0 : 1);
        if (!changedDuringRead) {
          assert.equal(record.resultSummary, 'answer 1');
          assert.deepEqual(record.bcpOrigin, {inputMessageID: 'msg_input1', terminalMessageID: 'msg_final1'});
        }
      } finally { gate.dispose(); }
    }
  }
});

test('3.0.3 read-only disposed-result path carries identity, retains ownership fences and rejects changed execution', async () => {
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
    latest = {...record, generation: 3};
    await assert.rejects(() => readonlyTerminalResult('ses_child', record, '/fixture', board), /changed/);
    await assert.rejects(() => readonlyTerminalResult('ses_child', {...record, state: 'running'}, '/fixture', board), /No action was sent/);
  }
});

test('3.0.3 retires absorbed alias backports, retains both terminal commit paths and upstream Council', () => {
  const ids = describeOmoPatches('3.0.3').map(p => p.id);
  assert.equal(ids.some(id => id.startsWith('alias-')), false);
  assert.ok(ids.includes('commit-queued-transcript-origin'));
  for (const entry of ['index', 'server']) {
    const original = stock(entry), result = patched(entry);
    const start = "1. If the question references an external resource (PR, URL, issue, doc)";
    const end = "5. Present the council's synthesized report.";
    const agenda = text => text.slice(text.indexOf(start), text.indexOf(end) + end.length);
    assert.equal(agenda(result), agenda(original));
    assert.equal(result.includes('prepareCouncilPrompt'), false);
    assert.equal(result.split('return commit(token, evidence.verdict, evidence.text, undefined, "transcript", evidence.bcpOrigin);').length - 1, 2);
  }
});

test('3.0.3 index and server build relocatable standalone artifacts with complete resource hashes', async () => {
  for (const entry of ['index', 'server']) {
    const out = join(scratch, entry), relocated = join(scratch, 'relocated-' + entry);
    const {manifest, files} = await buildOmoIntegration({packageDir, sourceDir, outputDir: out, version: '3.0.3', entry});
    assert.equal(manifest.upstream.digest, OMO_TARGETS['3.0.3'].entries[entry]);
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
