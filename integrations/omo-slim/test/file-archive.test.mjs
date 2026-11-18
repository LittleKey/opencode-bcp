import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as helper from '../omo-file-delivery.mjs';
import { prepareFileArchive, transformFileArchiveDelivery, prepareFileArchive307, transformFileArchiveDelivery307 } from '../prepare-file-archive.mjs';
import { patchOmo, patchOmo307, OMO_307_MODULES } from '../omo-patch.mjs';
import { FILE_ARCHIVE_307_REVERSALS } from '../file-archive-307-reversals.mjs';
import vm from 'node:vm';

test('file-only helper preserves native text and parts without touching any bridge or arguments', async () => {
  const symbol = Symbol.for('opencode.bcp.delivery.v1');
  const previous = Object.getOwnPropertyDescriptor(globalThis, symbol);
  let bridgeReads = 0;
  Object.defineProperty(globalThis, symbol, { configurable: true, get() {
    bridgeReads++;
    throw new Error('bridge forbidden');
  } });
  const poison = new Proxy({}, { get() { throw new Error('argument inspection forbidden'); } });
  const texts = ['原生通知\n', '<task_result>\nbody\n</task_result>', '', '<bcp_result_reference>historical text</bcp_result_reference>'];
  try {
    assert.equal(await helper.deliveryMetadata(poison, poison), undefined);
    assert.equal(helper.deliverySuffix(poison), '');
    for (const text of texts) {
      const part = Object.freeze({ type: 'text', text });
      assert.equal(helper.presentDelivery(text, poison) + helper.deliverySuffix(poison), text);
      await helper.annotateDeliveryPart(poison, part, poison, poison, () => {
        throw new Error('callback forbidden');
      });
      assert.deepEqual(part, { type: 'text', text });
    }
    await helper.annotateDeliveryPart(poison, poison, poison, poison, poison);
    assert.equal(bridgeReads, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, symbol, previous);
    else delete globalThis[symbol];
  }
});

test('unknown upstream and synthetic patched shapes fail closed', () => {
  assert.throws(() => prepareFileArchive('untrusted', {version: '2.2.25'}), /explicitly rejects legacy Council rollback/);
  assert.throws(() => transformFileArchiveDelivery('untrusted', 'untrusted', {version: '2.2.25'}), /explicitly rejects legacy Council rollback/);
  assert.throws(() => prepareFileArchive('unknown'), /Unsupported/);
  assert.throws(() => transformFileArchiveDelivery('unknown',
    'import { deliveryMetadata } from "../omo-delivery.mjs";'), /Unsupported/);
});

test('pinned real fixture reverses presentation and rejects patched drift', t => {
  // Optional local stock artifact: never downloads or installs dependencies.
  const path = process.env.OMO_FILE_ARCHIVE_FIXTURE;
  if (!path) return t.skip('Set OMO_FILE_ARCHIVE_FIXTURE to a supported stock bundle for positive pinned-source validation');
  const original = readFileSync(path, 'utf8');
  const legacy = patchOmo(original);
  const prepared = prepareFileArchive(original);
  assert.ok(!prepared.includes('prepareCouncilPrompt'));
  assert.ok(!prepared.includes('omo-council.mjs'));
  assert.notEqual(prepared, legacy);
  assert.ok(!prepared.includes('bcp_delivery: metadata'));
  assert.equal(transformFileArchiveDelivery(original, legacy), prepared);
  assert.throws(() => transformFileArchiveDelivery(original, legacy + '\n'), /exact repo-patched source/);
});

test('helper has no imports, global access, IO, model calls or mutation', () => {
  const source = readFileSync(new URL('../omo-file-delivery.mjs', import.meta.url), 'utf8');
  // Exact source fixture pins the entire deliberately tiny executable surface.
  const executable = source.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
  assert.equal(executable, `export async function deliveryMetadata(directory, record) {
  return undefined;
}
export function deliverySuffix(metadata) {
  return '';
}
export function presentDelivery(text, metadata) {
  return text;
}
export async function annotateDeliveryPart(directory, part, record, parentSessionID, isCurrent) {
}
`);
});

test('3.0.7 exact manifest closures prepare without mutating inputs; unknown bytes fail closed', () => {
  const root = process.env.OMO_307_PACKAGE;
  assert.ok(root, 'OMO_307_PACKAGE must point to an existing stock 3.0.7 package (no download)');
  for (const entry of ['index', 'server']) {
    const originals = new Map(Object.keys(OMO_307_MODULES[entry]).map(path =>
      [path, readFileSync(`${root}/${path}`, 'utf8')]));
    const snapshot = new Map(originals);
    const legacy = patchOmo307(new Map(originals), entry);
    const prepared = prepareFileArchive307(originals, entry);
    for (const source of prepared.modules.values()) {
      assert.ok(!source.includes('prepareCouncilPrompt'));
      assert.ok(!source.includes('omo-council.mjs'));
      assert.ok(!/args\.prompt\s*=[^;\n]*prepareCouncil/.test(source));
    }
    const entryPath = entry === 'index' ? 'dist/index.js' : 'dist/server/index.js';
    for (const [path, source] of legacy.modules) {
      if (path !== entryPath) assert.equal(prepared.modules.get(path), source);
      else {
        let expected = source.replace('omo-delivery.mjs', 'omo-file-delivery.mjs');
        for (const rule of [...FILE_ARCHIVE_307_REVERSALS].reverse()) {
          assert.equal(expected.split(rule.replacement).length, 2, rule.id);
          expected = expected.replace(rule.replacement, rule.anchor);
        }
        assert.equal(prepared.modules.get(path), expected);
        const generated = prepared.modules.get(path);
        // Execute the actual generated notification array, including its join.
        const start = generated.indexOf('const text = [\n        `<task id="${run.taskID}" state="${state}">`,');
        assert.ok(start >= 0);
        const end = generated.indexOf('].join(', start);
        assert.ok(end > start);
        const stop = generated.indexOf(';', end);
        const code = generated.slice(start, stop + 1) + '\ntext;';
        const context = { run: {taskID: 'ses_native'}, state: 'completed',
          record: {resultSummary: '原文\nbody'}, fallbackText: 'fallback', tag: 'task_result', summary: 'native summary' };
        const actual = vm.runInNewContext(code, context);
        assert.equal(actual, '<task id="ses_native" state="completed">\n<summary>native summary</summary>\n<task_result>\n原文\nbody\n</task_result>\n</task>');
        const stock = originals.get(path);
        const nativeStart = stock.indexOf('const text = [\n        `<task id="${run.taskID}" state="${state}">`,');
        assert.ok(nativeStart >= 0);
        const nativeEnd = stock.indexOf(';', stock.indexOf('].join(', nativeStart));
        const nativeCode = stock.slice(nativeStart, nativeEnd + 1) + '\ntext;';
        for (const body of ['原文\nbody', '', undefined]) {
          const inputs = {...context, record: {resultSummary: body}};
          assert.equal(vm.runInNewContext(code, {...inputs}), vm.runInNewContext(nativeCode, {...inputs}));
        }
        // Execute restored foreground delivery boundary with a frozen native
        // output: any metadata assignment, bridge await or extra CAS now fails.
        const rule = FILE_ARCHIVE_307_REVERSALS.find(p => p.id === 'foreground-delivery');
        const at = generated.indexOf(rule.anchor);
        assert.ok(at >= 0);
        const boundary = generated.slice(at, at + rule.anchor.length);
        const nativeOutput = Object.freeze({metadata: Object.freeze({native: true}), output: 'native'});
        vm.runInNewContext(boundary.replace(/log\("\[task-session-manager\] foreground task status registered",$/, '') + '\nupdated;', {
          current: {generation: 1}, record: {generation: 1}, output: nativeOutput,
        });
        assert.deepEqual(nativeOutput, {metadata: {native: true}, output: 'native'});
      }
    }
    assert.deepEqual(originals, snapshot);
    assert.deepEqual(transformFileArchiveDelivery307(originals, legacy.modules, entry), prepared);
    const drift = new Map(legacy.modules);
    drift.set(entryPath, drift.get(entryPath) + '\n');
    assert.throws(() => transformFileArchiveDelivery307(originals, drift, entry), /patched module mismatch/);
    drift.delete(entryPath);
    assert.throws(() => transformFileArchiveDelivery307(originals, drift, entry), /module set mismatch/);
    const bad = new Map(originals);
    bad.set(entryPath, bad.get(entryPath) + '\n');
    assert.throws(() => prepareFileArchive307(bad, entry), /upstream digest mismatch/);
    bad.delete(entryPath);
    assert.throws(() => prepareFileArchive307(bad, entry), /module set mismatch/);
    console.log(`3.0.7 ${entry}: ${originals.size} manifest-pinned modules validated; 15 presentation patches reversed; native generated notification/foreground boundary executed`);
  }
});

test('undefined metadata is observable in memory, omitted by ordinary JSON but not universally wire-neutral', async () => {
  const metadata = await helper.deliveryMetadata();
  const output = { metadata: { native: true } };
  output.metadata = { ...output.metadata, bcp_delivery: metadata };
  assert.equal(Object.hasOwn(output.metadata, 'bcp_delivery'), true);
  assert.deepEqual(Object.keys(output.metadata), ['native', 'bcp_delivery']);
  assert.equal(JSON.stringify(output), '{"metadata":{"native":true}}');
  const stale = { bcp_delivery: { old: 'receipt' } };
  assert.equal(JSON.stringify({ ...stale, bcp_delivery: metadata }), '{}');
});
