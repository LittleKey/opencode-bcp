import assert from 'node:assert/strict';
import { patchOmo, patchOmo307, omoTargetFor, PATCHES_3_0_1, PATCHES_3_0_3, PATCHES_3_0_4, PATCHES_3_0_5, PATCHES_3_0_6 } from './omo-patch.mjs';
import { createHash } from 'node:crypto';
import { FILE_ARCHIVE_307_REVERSALS } from './file-archive-307-reversals.mjs';

const inverseIDs = new Set(FILE_ARCHIVE_307_REVERSALS.map(p => p.id).concat([
  'readonly-result-delivery', 'readonly-result-tracked-call', 'readonly-result-current-call',
]));
const bundles = { '3.0.1': PATCHES_3_0_1, '3.0.3': PATCHES_3_0_3,
  '3.0.4': PATCHES_3_0_4, '3.0.5': PATCHES_3_0_5, '3.0.6': PATCHES_3_0_6 };
function assertFileArchiveTarget(original, options) {
  assert.notEqual(options.version, '2.2.25', 'File archive explicitly rejects legacy Council rollback 2.2.25');
  const target = omoTargetFor(createHash('sha256').update(original).digest('hex'));
  assert.notEqual(target?.version, '2.2.25', 'File archive explicitly rejects legacy Council rollback 2.2.25');
  return target;
}
function assertNoCouncilConsumer(source) {
  assert.ok(!source.includes('prepareCouncilPrompt') && !source.includes('omo-council.mjs'),
    'File archive source must not contain legacy BCP Council prompt consumers');
  // The only args.prompt rewrite added by the repo Council adapter uses this
  // helper; native upstream args.prompt accesses are not globally forbidden.
  assert.ok(!/args\.prompt\s*=[^;\n]*prepareCouncil/.test(source),
    'BCP Council args.prompt rewrite remains');
  return source;
}
function reversePresentation(source, patches, entry) {
  for (const patch of [...patches].reverse()) {
    if (!inverseIDs.has(patch.id)) continue;
    const pick = value => typeof value === 'string' ? value : value[entry];
    const before = pick(patch.replacement), after = pick(patch.anchor);
    assert.equal(source.split(before).length, 2, 'Unknown/nonunique consumer shape: ' + patch.id);
    source = source.replace(before, after);
  }
  // Every presentation call must be gone, not merely inert behind an adapter.
  const body = source.slice(source.indexOf('\n') + 1);
  assert.ok(!/\b(?:deliveryMetadata|deliverySuffix|presentDelivery|annotateDeliveryPart|presentRetainedChildDelivery)\s*\(/.test(body),
    'Unreviewed delivery consumer remains');
  return assertNoCouncilConsumer(source);
}

const legacyImport = 'import { deliveryMetadata, deliverySuffix, annotateDeliveryPart, presentDelivery } from "../omo-delivery.mjs";\n';
const fileImport = legacyImport.replace('../omo-delivery.mjs', '../omo-file-delivery.mjs');

/**
 * Pure, explicit opt-out for a byte-exact repo patch, before builder relocation.
 * Original must be a supported hash-pinned upstream bundle; unknown/drifted
 * patched bytes fail closed. Reverse only enumerated exact presentation patches;
 * retain all other lifecycle/identity fixes.
 * For multi-module 3.0.7 use prepareFileArchive307 instead.
 */
export function transformFileArchiveDelivery(original, patched, options = {}) {
  const target = assertFileArchiveTarget(original, options);
  const expected = patchOmo(original, options);
  assert.equal(patched, expected, 'File archive opt-out requires the exact repo-patched source');
  assert.ok(expected.startsWith(legacyImport), 'Unknown delivery helper import');
  assert.equal(expected.split(legacyImport).length, 2, 'Delivery helper import is not unique');
  assert.ok(bundles[target.version], 'File archive consumer reversal unsupported for ' + target.version);
  return reversePresentation(fileImport + expected.slice(legacyImport.length), bundles[target.version], target.entry);
}

// Future builders must explicitly select this function AND copy the file helper.
// Existing build/patch entry points and their legacy default remain unchanged.
export function prepareFileArchive(original, options = {}) {
  assertFileArchiveTarget(original, options);
  return transformFileArchiveDelivery(original, patchOmo(original, options), options);
}

/**
 * Validate every upstream module against OMO_307_MODULES through patchOmo307,
 * then every supplied patched module against that exact regenerated result.
 * Work on copies: neither input Map is mutated. No filesystem/global access.
 */
export function transformFileArchiveDelivery307(originals, patched, entry) {
  const expected = patchOmo307(new Map(originals), entry);
  assert.ok(patched instanceof Map, 'Expected patched module Map');
  assert.deepEqual([...patched.keys()].sort(), [...expected.modules.keys()].sort(),
    'File archive patched module set mismatch');
  const modules = new Map();
  const entryPath = entry === 'index' ? 'dist/index.js' : 'dist/server/index.js';
  for (const [path, source] of expected.modules) {
    assert.equal(patched.get(path), source, 'File archive patched module mismatch: ' + path);
    if (path === entryPath) {
      const prefix = legacyImport.replace('../omo-delivery.mjs',
        '../'.repeat(path.split('/').length - 1) + 'omo-delivery.mjs');
      assert.ok(source.startsWith(prefix), 'Unknown delivery helper import: ' + path);
      assert.equal(source.split(prefix).length, 2, 'Delivery helper import is not unique');
      modules.set(path, reversePresentation(
        prefix.replace('omo-delivery.mjs', 'omo-file-delivery.mjs') + source.slice(prefix.length),
        FILE_ARCHIVE_307_REVERSALS.filter(p => p.modules.includes(path)), entry));
    } else {
      modules.set(path, assertNoCouncilConsumer(source));
    }
  }
  return { modules, patches: expected.patches };
}

export function prepareFileArchive307(originals, entry) {
  const patched = patchOmo307(new Map(originals), entry);
  return transformFileArchiveDelivery307(originals, patched.modules, entry);
}
