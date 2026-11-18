import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
// @ts-expect-error TS7016: executable fixture integration has no declaration file.
import { prepareFileArchive307 } from '../integrations/omo-slim/prepare-file-archive.mjs';
// @ts-expect-error TS7016: executable fixture integration has no declaration file.
import { patchOmo307, OMO_307_MODULES } from '../integrations/omo-slim/omo-patch.mjs';
// @ts-expect-error TS7016: executable fixture manifest has no declaration file.
import { FILE_ARCHIVE_307_REVERSALS } from '../integrations/omo-slim/file-archive-307-reversals.mjs';

// Only execute exact generated source boundaries; this is NOT a host/model wire test.
const root = process.env.OMO_307_PACKAGE;
assert.ok(root, 'Set OMO_307_PACKAGE to the existing pinned stock package');
const originals = new Map(Object.keys(OMO_307_MODULES.server).map(path =>
  [path, readFileSync(`${root}/${path}`, 'utf8')]));
const prepared = prepareFileArchive307(originals, 'server').modules;
const legacy = patchOmo307(new Map(originals), 'server').modules;
const entry = 'dist/server/index.js';
const stock = originals.get(entry)!;
const generated = prepared.get(entry)!;
function expression(source: string) {
  const start = source.indexOf('const text = [\n        `<task id="${run.taskID}" state="${state}">`,');
  assert.ok(start >= 0);
  const stop = source.indexOf(';', source.indexOf('].join(', start));
  return source.slice(start, stop + 1) + '\ntext;';
}
function digest(text: string) {
  const bytes = Buffer.from(text);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
test('actual stock/prepared notification render equivalence; in-memory copy smoke check only', () => {
  assert.equal(FILE_ARCHIVE_307_REVERSALS.length, 15);
  const captured: Buffer[] = [];
  const bodies = ['原文\none\ntwo', '', undefined, 'x'.repeat(100_000), '</task_result>\nwrapped 😀'];
  for (const [call, body] of bodies.entries()) {
    const context = {run: {taskID: 'same-child'}, state: 'completed',
      record: {resultSummary: body}, fallbackText: 'fallback', tag: 'task_result',
      summary: 'Background task completed: synthetic'};
    const native = vm.runInNewContext(expression(stock), {...context});
    const rendered = vm.runInNewContext(expression(generated), {...context});
    assert.equal(rendered, native);
    captured.push(Buffer.from(rendered)); // byte-copy, never mutate delivery
    assert.equal(captured.at(-1)!.toString(), rendered);
    console.log(JSON.stringify({boundary: 'notification-render', call, ...digest(rendered)}));
  }
  assert.equal(captured.length, bodies.length); // repeated child IDs must not deduplicate calls
  assert.equal(captured[3].includes(Buffer.from('x'.repeat(100_000))), true);
  const old = vm.runInNewContext(expression(legacy.get(entry)!), {
    run: {taskID: 'same-child'}, state: 'completed', record: {resultSummary: 'native'},
    fallbackText: 'fallback', tag: 'task_result', summary: 'summary', bcpMetadata: {},
    presentDelivery: () => 'REFERENCE', deliverySuffix: () => 'RECEIPT',
  });
  assert.ok(old.includes('REFERENCE'));
  assert.ok(old.includes('RECEIPT'));
});
function declaration(source: string, name: string, nextName: string) {
  const start = source.indexOf(`function ${name}(`);
  const stop = source.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && stop > start);
  return source.slice(start, stop).replace(/async\s*$/, '');
}
test('actual completion consumer returns unchanged prior notification for processed occurrence', async () => {
  const part = {type: 'text', synthetic: true, text: '<task id="same-child" state="completed">\nprior notification\n</task>', id: 'prior'};
  const message = {info: {sessionID: 'parent', id: 'old-message'}, parts: [part]};
  const before = structuredClone(message);
  for (const source of [stock, generated]) {
    // Execute exact real consumer prefix through its processed-occurrence return.
    // Later branches are intentionally unreachable, not simulated as successful.
    const start = source.indexOf('async function updateFromInjectedCompletion(');
    const stop = source.indexOf('  const status = parseTaskStatusOutput(part.text);', start);
    assert.ok(start >= 0 && stop > start);
    const code = source.slice(start, stop) + '\nthrow Error("processed early-return not taken");\n}\nupdateFromInjectedCompletion;';
    let lookups = 0;
    const consume = vm.runInNewContext(code, {
      parseTaskOutputHeader: () => ({taskID: 'same-child', state: 'completed'}),
      getExplicitOccurrenceID: () => 'prior',
      getCanonicalHostMessageID: () => 'old-message',
      findSyntheticTerminalOccurrence: () => { lookups++; return {kind: 'matched', origin: {phase: 'processed'}}; },
    });
    await consume({syntheticTerminalOccurrences: new Map([['prior', true]]),
      backgroundJobBoard: {get: () => ({generation: 1, taskGeneration: 1})}}, part, message, 0, 0);
    assert.equal(lookups, 1);
    assert.deepEqual(message, before);
  }
});
test('actual downstream child-ref wrapper matches native/prepared; denied synthetic observer is nonmutating', async () => {
  const results: string[] = [];
  for (const source of [stock, generated]) {
    const wrapperStart = source.indexOf('function appendRegisteredChildRef(');
    assert.ok(wrapperStart >= 0);
    const wrapper = source.slice(wrapperStart);
    // Function ends at next section comment; no bundled hook initialization is executed.
    const code = wrapper.slice(0, wrapper.indexOf('// src/hooks/task-session-manager/index.ts'));
    const suffix = declaration(source, 'appendChildRefSuffix', 'readAuthoritativeChildRef');
    const format = declaration(source, 'formatChildRef', 'isChildRef');
    const apply = vm.runInNewContext(code + suffix + format + '\nappendRegisteredChildRef;', {
      parseTaskIdFromTaskOutput: () => 'same-child',
      readAuthoritativeChildRef: () => undefined, // synthetic first-delivery parser stub
    });
    const output = {output: '<task id="same-child" state="completed">原文</task>'};
    const hookResult = output.output;
    apply(output, {taskID: 'same-child', alias: 'alias', agent: 'fixer', parentSessionID: 'parent'},
      {parentSessionId: 'parent', agentType: 'fixer'}, true, 'v1');
    assert.ok(output.output.startsWith(hookResult + '\n<!-- slim-child-ref:v1 '));
    assert.notEqual(output.output, hookResult);
    results.push(output.output);
    let observed = 0;
    const observer = async (text: string) => {
      observed++;
      assert.equal(text, output.output);
      throw Object.assign(new Error('synthetic retention denied'), {code: 'EACCES'});
    };
    const before = structuredClone(output);
    await assert.rejects(observer(output.output), /synthetic retention denied/);
    assert.equal(observed, 1);
    assert.deepEqual(output, before);
    console.log(JSON.stringify({boundary: 'child-ref-wrapper', ...digest(output.output)}));
  }
  assert.equal(results[0], results[1]);
});
test('actual prepared foreground hook boundary leaves fake tool result unchanged without retention', () => {
  const rule = FILE_ARCHIVE_307_REVERSALS.find((r: {id: string; anchor: string}) => r.id === 'foreground-delivery')!;
  assert.ok(generated.includes(rule.anchor));
  const boundary = rule.anchor.replace(/log\("\[task-session-manager\] foreground task status registered",$/, '');
  for (const generation of [1, 2, 2]) {
    const output = Object.freeze({output: '<task>原文</task>', metadata: Object.freeze({native: true})});
    const prior = structuredClone(output);
    vm.runInNewContext(boundary, {current: {generation}, record: {generation}, output,
      deliveryMetadata: () => { throw Error('retention unavailable/denied'); }});
    assert.deepEqual(output, prior);
    console.log(JSON.stringify({boundary: 'foreground-hook-only', generation, ...digest(output.output)}));
  }
});
test('actual promptParent queues synthetic text through SDK, not running tool result', () => {
  const start = generated.indexOf('  function promptParent(');
  const stop = generated.indexOf('  async function sendFallbackNotice(', start);
  assert.ok(start >= 0 && stop > start);
  const calls: unknown[] = [];
  // Internal part constructor is an explicit stub: SDK/host processing remains unexercised.
  const prompt = vm.runInNewContext(generated.slice(start, stop) + '\npromptParent;', {
    options: {input: {directory: '/synthetic'}},
    getClient: () => ({session: {promptAsync: (request: unknown) => calls.push(request)}}),
    createInternalAgentTextPart: (text: string, metadata: unknown) => ({type: 'text', synthetic: true, text, metadata}),
  });
  prompt('parent', undefined, 'terminal body', {revision: 1});
  const request = JSON.parse(JSON.stringify(calls[0]));
  assert.equal(request.delivery, 'queue');
  assert.equal(request.modelSelection, 'inherit');
  assert.equal(request.body.parts[0].text, 'terminal body');
});
