import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Version-bounded OMO adapters. Every supported upstream version/entry is pinned by
// its exact SHA-256; unknown content fails the build instead of patching fuzzily.
export const OMO_TARGETS = {
  '2.2.25': {
    entries: {
      index: '1a8a7a69db029f1c0fea19c4c8ded674281a8e674bedf72b4c8380e0b6de6e1f',
    },
  },
  '3.0.1': {
    entries: {
      // v1 plugin entry (externals: @opencode-ai/*, zod).
      index: '442740caaf18e89deb327ea7313d27462cc313e47f1a7e86aa73d32f4c9a80b1',
      // v2 entry (self-contained bun bundle; zod and the plugin SDK bundled inside).
      server: 'd0db4526a00e257dd5bbf7924a465cc095eec3fa39d5fca85ec8db9e973a989f',
    },
  },
  '3.0.3': {
    entries: {
      index: '160c7bfb22f1105fd88c558d1a0686c549864a3f7b0efca5586319d7c663ec27',
      server: 'e31460f6c754370020717d70f4e2ba88ba8003e67ed59cc91ca599279d509e40',
    },
  },
  '3.0.4': {
    entries: {
      // npm registry tarball oh-my-opencode-slim-3.0.4.tgz (exact-version pin,
      // workarea install verified byte-identical to the prep extraction).
      index: 'a34d6d4342a1c29bdd93a224c183220ea9ac8747ba463d5c609534a5e46bd248',
      server: '03149fd3e9bf33f849b5766db470e98c8c5bf9addb785d5d37cee0fb6df2335e',
    },
  },
  '3.0.5': {
    entries: {
      // npm registry tarball oh-my-opencode-slim-3.0.5.tgz (exact-version pin,
      // prep extraction verified by SHA-256 before patching).
      index: '43d499d1dab3f21797476bf9e32a7c30bf1c6ee6b9c60deb0d17f3815da85827',
      server: 'e04dd74f4115c721a5fc2b31f14b129834120eb9fcf13d97285ab744eab42a3d',
    },
  },
  '3.0.6': {
    entries: {
      // npm registry tarball oh-my-opencode-slim-3.0.6.tgz (exact-version pin,
      // prep extraction verified by SHA-256 before patching).
      index: '68815becae2a17c3173a3bb5da1b5f2460b933ae67ff27bda757449cb9dd0c0f',
      server: 'ff9082e851490e00dcd80cb093d2db2e615754f4b4e17a7b9ca388c53da02951',
    },
  },
  '3.0.7': {
    entries: {
      // npm registry tarball oh-my-opencode-slim-3.0.7.tgz (exact-version pin,
      // prep extraction verified by SHA-256 before patching). 3.0.7 moves to a
      // multi-module dist layout: patching goes through patchOmo307() with the
      // per-module OMO_307_MODULES pins, not the single-bundle patchOmo().
      index: '47ec8c7070c648c8860ab4becfb2391257cf833957c4b56ccf3cbaad5e6f5052',
      server: '485f34ad29e4f9ffa0b2fd9c52dad3d8db401ff68394f40b6f6f93866cbf9237',
    },
  },
};

export function omoTargetFor(digest) {
  for (const [version, target] of Object.entries(OMO_TARGETS)) {
    for (const [entry, expected] of Object.entries(target.entries)) {
      if (digest === expected) return {version, entry};
    }
  }
  return undefined;
}

// Helper-module specifiers prepended by each patch flavor. The builder rewrites
// these to the real relative location of the built output. 3.0.1 follows upstream
// Council (2026-10-01 scope reduction): it prepends only the generic delivery
// helper; the council helper is prepended on the 2.2.25 rollback path only.
// 3.0.7 is multi-module: one specifier per patched entry module, in
// [index entry, server entry] order (both get the delivery helper import).
export const helperImportsFor = version =>
  version === '2.2.25' ? ['../omo-delivery.mjs', '../omo-council.mjs']
  : version === '3.0.7' ? ['../omo-delivery.mjs', '../../omo-delivery.mjs']
  : ['../omo-delivery.mjs'];

const DELIVERY_IMPORT =
  'import { deliveryMetadata, deliverySuffix, annotateDeliveryPart, presentDelivery } from "../omo-delivery.mjs";\n';
const COUNCIL_IMPORT = 'import { prepareCouncilPrompt } from "../omo-council.mjs";\n';

// 2.2.25 rollback path only: replaces the upstream council agenda to reproduce the
// deployed legacy integration byte-for-byte. 3.0.1 never uses this (upstream Council).
const COUNCIL_PROCEDURE = `1. Resolve required external material into authorized readable source artifacts first, using the appropriate specialist. Give seats exact source locations and necessary original excerpts, not a rewritten conclusion. Mark unavailable material explicitly.
2. Dispatch the same question and evidence boundary independently to each configured seat in PARALLEL via \${vocab.tool}():
\${dispatchList}
3. Collect the actual ses_* task IDs or standard cou-N aliases and completion states. Respect the task budget; report failed, empty or unfinished seats explicitly. Do not replace a missing opinion or retry just to manufacture agreement.
4. Call \${vocab.tool}(\${vocab.agentParam}='council', description='Synthesize council report') with the original question and the explicit seat task IDs or aliases. Do not copy or paraphrase their responses and do not claim their model identities yourself. The host will attach bounded, verified original replies and actual provenance; unavailable or oversized evidence remains a visible gap.
`;

// ---------------------------------------------------------------------------
// OMO 2.2.25 (legacy deployment; kept reproducible for rollback).
// This path also carries the private Council procedure splice and the
// finalizeCouncil wiring — required to reproduce the deployed dist/omo.js
// byte-for-byte. New 3.0.1 builds deliberately omit both (upstream Council).
// ---------------------------------------------------------------------------
function patchOmo2_2_25(original) {
  assert.equal(createHash('sha256').update(original).digest('hex'), OMO_TARGETS['2.2.25'].entries.index);
  let source = original;
  function once(before, after) {
    assert.equal(source.split(before).length, 2, 'OMO patch anchor is not unique: ' + before.slice(0, 90));
    source = source.replace(before, after);
  }
  const councilStart = source.indexOf('1. If the question references an external resource (PR, URL, issue, doc)');
  const councilEnd = source.indexOf('5. Present the council\'s synthesized report.', councilStart);
  assert(councilStart >= 0 && councilEnd > councilStart, 'Council procedure anchors missing');
  source = source.slice(0, councilStart) + COUNCIL_PROCEDURE + source.slice(councilEnd);
  once('  const agentType = args.subagent_type.trim();\n  let background = args.background === true;',
    `  const agentType = args.subagent_type.trim();
   const finalizeCouncil = agentType === "council" && typeof args.prompt === "string"
     ? await prepareCouncilPrompt(deps.directory, deps.backgroundJobBoard, input.sessionID, args.prompt) : undefined;
   let background = args.background === true;`);
  once('  log("[task-session-manager] tool.execute.before task — pending call created", {',
    '  if (finalizeCouncil) args.prompt = finalizeCouncil();\n  log("[task-session-manager] tool.execute.before task — pending call created", {');
  // A native resume is itself consumption of the previously injected terminal result.
  // Acknowledge only that exact owned execution via the existing reconciliation path.
  once('function reconcileConsumedTerminalJobs(state, parentSessionID, promptShapeKey) {',
    `function acknowledgeInjectedNativeResume(state, parentSessionID, requested, agent) {
  const job = state.backgroundJobBoard.resolve(parentSessionID, requested);
  if (!job || job.parentSessionID !== parentSessionID || job.agent !== agent || !job.terminalUnreconciled || job.state === "running") return;
  const entry = state.terminalJobsInjectedByParent.get(parentSessionID);
  for (const [key, execution] of entry?.executions ?? []) {
    if (execution.taskID !== job.taskID || execution.generation !== job.generation || execution.terminalRevision !== job.terminalRevision) continue;
    reconcileExecutionBatch(state, parentSessionID, [execution]);
    const after = state.backgroundJobBoard.get(job.taskID);
    if (after?.state === "reconciled" && after.generation === execution.generation && after.terminalRevision === execution.terminalRevision) {
      entry.executions.delete(key);
      if (!entry.executions.size) state.terminalJobsInjectedByParent.delete(parentSessionID);
    }
    return;
  }
}
function reconcileConsumedTerminalJobs(state, parentSessionID, promptShapeKey) {`);
  once('const remembered = deps.backgroundJobBoard.resolveReusable(input.sessionID, requested, agentType) ??',
    'if (input.callID) deps.acknowledgeInjectedResume?.(input.sessionID, requested, agentType);\n    const remembered = deps.backgroundJobBoard.resolveReusable(input.sessionID, requested, agentType) ??');
  once('"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      shouldManageSession:',
    '"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      directory: _ctx.directory,\n      acknowledgeInjectedResume: (parent, requested, agent) => acknowledgeInjectedNativeResume(injectionState, parent, requested, agent),\n      shouldManageSession:');
  // A native resume is registered when its output arrives. Its observation window must
  // start at dispatch, not after the already-completed assistant; otherwise the terminal
  // classifier rejects the new result as pre-run history and loses its input identity.
  once('lifecycleEpoch: deps.getLifecycleEpoch?.() ?? 0,\n    releaseLease:',
    'lifecycleEpoch: deps.getLifecycleEpoch?.() ?? 0,\n    nativeCallStartedAt: Date.now(),\n    releaseLease:');
  once('return deps.backgroundJobBoard.registerLaunch({\n      taskID,\n      parentSessionID: pending.parentSessionId,',
    'return deps.backgroundJobBoard.registerLaunch({\n      taskID,\n      now: pending.nativeCallStartedAt,\n      parentSessionID: pending.parentSessionId,');
  once('await deps.terminalGate.reconcile(record, {\n        kind: "output",',
    'const nativeSignal = {\n        kind: "output",');
  once('callIDConfirmed: exactCallConfirmed\n        }\n      });\n      const current = deps.backgroundJobBoard.get(status.taskID);',
    `callIDConfirmed: exactCallConfirmed
        }
      };
      let reconciliation = await deps.terminalGate.reconcile(record, nativeSignal);
      // Re-observe a superseded activity token through the SAME gate, never bypass it.
      // Bound retries; a changed generation, cancellation or unresolved signal stays fenced.
       for (let attempt = 0; ["stale", "deferred"].includes(reconciliation?.kind) && attempt < 2; attempt++) {
         if (reconciliation.retryAfter) await raceEvidenceDeadline(reconciliation.retryAfter, 2000);
         const observed = deps.backgroundJobBoard.get(record.taskID);
        if (!exactCallConfirmed || observed?.generation !== record.generation || observed.state !== "running" || observed.cancellationRequested) break;
        reconciliation = await deps.terminalGate.reconcile(observed, nativeSignal);
      }
       const current = deps.backgroundJobBoard.get(status.taskID);`);
  // Expose the existing single-flight read's settlement to the native caller. Await the
  // actual dependency, not a sleep/poll or additional model turn; never bypass the gate.
  once('value.pendingRuntimeContrast.token = token;\n      return deferred(token, diagnostic);',
    'value.pendingRuntimeContrast.token = token;\n      return { ...deferred(token, diagnostic), retryAfter: readSettled };');
  once('return deferred(token, diagnostic);\n  }\n  async function read(key, token, operation)',
    'return { ...deferred(token, diagnostic), retryAfter: readSettled };\n  }\n  async function read(key, token, operation)');
  once('return { verdict: "completed", text: evidence.text };',
    'return { verdict: "completed", text: evidence.text, bcpOrigin: evidence.bcpOrigin };');
  once('return text.length > 0 ? { kind: "ready", text } : { kind: "textless" };',
    'return text.length > 0 ? { kind: "ready", text, bcpOrigin: { inputMessageID: last.info.parentID, terminalMessageID: last.info.id } } : { kind: "textless" };');
  once('function commit(token, state, text, lease, attribution = "event") {',
    'function commit(token, state, text, lease, attribution = "event", bcpOrigin) {');
  once('resultSummary: text,\n      cancellationLease: lease,', 'resultSummary: text,\n      bcpOrigin,\n      cancellationLease: lease,');
  once('return commit(token, evidence.verdict, evidence.text, undefined, "transcript");',
    'return commit(token, evidence.verdict, evidence.text, undefined, "transcript", evidence.bcpOrigin);');
  once('resultSummary: undefined,\n        lastStatusError: undefined,', 'resultSummary: undefined,\n        bcpOrigin: undefined,\n        lastStatusError: undefined,');
  once('resultSummary: undefined,\n      lastStatusError:', 'resultSummary: undefined,\n      bcpOrigin: undefined,\n      lastStatusError:');
  once('resultSummary: input.resultSummary ?? existing.resultSummary,\n      lastStatusError:',
    'resultSummary: input.resultSummary ?? existing.resultSummary,\n      bcpOrigin: input.bcpOrigin ?? existing.bcpOrigin,\n      lastStatusError:');
  // Foreground task: after OMO validates native call ownership and reconciles its terminal generation.
  once('const updated = current?.generation === record.generation ? current : undefined;\n      log("[task-session-manager] foreground task status registered",',
     `const updated = current?.generation === record.generation ? current : undefined;
       log("[bcp-native-delivery] terminal observation", { taskID: record.taskID, generation: record.generation, verdict: reconciliation?.kind, diagnostic: updated?.lastStatusError });
       if (updated) {
        const metadata = await deliveryMetadata(deps.directory, updated);
        const latest = deps.backgroundJobBoard.get(updated.taskID);
        if (latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision) {
          output.metadata = { ...output.metadata, bcp_delivery: metadata };
           output.output = presentDelivery(output.output, metadata) + deliverySuffix(metadata);
        }
      }
      log("[task-session-manager] foreground task status registered",`);
  // Read-only result retrieval, after existing ownership / terminal guards, with a fresh CAS after inspection.
  once('return current.resultSummary;\n        }\n        snapshot = await getRuntimeSessionStatusSnapshot(options.input);',
    `const metadata = await deliveryMetadata(options.input.directory, current);
          const afterDelivery = board.get(taskID);
          if (afterDelivery?.generation !== current.generation || afterDelivery.terminalRevision !== current.terminalRevision || afterDelivery.activityRevision !== current.activityRevision)
            throw new Error("Task changed while delivery metadata was inspected; retrieve its current result.");
           return presentDelivery(current.resultSummary, metadata) + deliverySuffix(metadata);
        }
        snapshot = await getRuntimeSessionStatusSnapshot(options.input);`);
  once('return evidence.text;\n      }\n    })\n  };\n}\n// src/tools/task-revive.ts',
    `const metadata = await deliveryMetadata(options.input.directory, { taskID, parentSessionID, state: "completed", bcpOrigin: evidence.bcpOrigin });
         return evidence.text + deliverySuffix(metadata);
      }
    })
  };
}
// src/tools/task-revive.ts`);
  // Background notification: appended outside author's task_result. Existing lease check runs after this await.
  once('const notifyAgent = selection?.agent ?? "orchestrator";\n      const text = [',
    'const notifyAgent = selection?.agent ?? "orchestrator";\n      const bcpMetadata = await deliveryMetadata(options.input.directory, record);\n      const text = [');
  once('record.resultSummary ?? (state === "completed" ? "Completed." : "Failed."),\n        `</${tag}>`,\n        "</task>"',
    'presentDelivery(record.resultSummary ?? (state === "completed" ? "Completed." : "Failed."), bcpMetadata),\n        `</${tag}>`,\n        "</task>",\n        deliverySuffix(bcpMetadata)');
  // Native first-run background notifications arrive through the host's synthetic-message lane.
  once('const injectionState = {\n    backgroundJobBoard,', 'const injectionState = {\n    bcpDirectory: _ctx.directory,\n    backgroundJobBoard,');
  once('if (origin?.phase === "processed")\n    return;',
    `if (origin?.phase === "processed") {
    if (existing && origin.generationAtObservation === existing.generation && (deletionEpoch === undefined || origin.lifecycleEpochAtObservation >= deletionEpoch))
      await annotateDeliveryPart(state.bcpDirectory, part, existing, message.info?.sessionID, () => {
        const latest = state.backgroundJobBoard.get(existing.taskID);
        return latest?.generation === existing.generation && latest.terminalRevision === existing.terminalRevision && latest.activityRevision === existing.activityRevision;
      });
    return;
  }`);
  once('if (hasRememberedInjectedCompletion(state, status.taskID, occurrenceId, provenanceKind, existing?.generation)) {\n    return;\n  }',
    `if (hasRememberedInjectedCompletion(state, status.taskID, occurrenceId, provenanceKind, existing?.generation)) {
    const fence = state.injectedCompletionFences?.get(injectedCompletionKey(status.taskID, occurrenceId, provenanceKind));
    if (existing && fence?.generation === existing.generation && (deletionEpoch === undefined || fence.lifecycleEpoch >= deletionEpoch))
      await annotateDeliveryPart(state.bcpDirectory, part, existing, message.info?.sessionID, () => {
        const latest = state.backgroundJobBoard.get(existing.taskID);
        return latest?.generation === existing.generation && latest.terminalRevision === existing.terminalRevision && latest.activityRevision === existing.activityRevision;
      });
    return;
  }`);
  once('const updated = result.kind === "stale" ? undefined : result.record;\n  if (!updated)\n    return;\n  if (updated.terminalUnreconciled',
    `const updated = result.kind === "stale" ? undefined : result.record;
  if (!updated)
    return;
  await annotateDeliveryPart(state.bcpDirectory, part, updated, message.info?.sessionID, () => {
    const latest = state.backgroundJobBoard.get(updated.taskID);
    return latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision;
  });
  if (updated.terminalUnreconciled`);
  // Revival normally returns running; report unknown there. A terminal result uses identical inspection.
  once('return renderReviveOutput(current, true);', 'return renderReviveOutput(current, true, options.input.directory, options.backgroundJobBoard);');
  once('return renderReviveOutput(latest);', 'return renderReviveOutput(latest, false, options.input.directory, options.backgroundJobBoard);');
  once('function renderReviveOutput(record, admissionUnknown = false) {',
    'async function renderReviveOutput(record, admissionUnknown = false, directory, board) {');
  once('return lines.join(`\n`);\n}\nfunction getCurrentReviveJob',
    `const metadata = await deliveryMetadata(directory, admissionUnknown ? { ...record, bcpOrigin: undefined } : record);
  const latest = board?.get(record.taskID);
  if (latest?.generation !== record.generation || latest.terminalRevision !== record.terminalRevision || latest.activityRevision !== record.activityRevision)
    return lines.join("\\n") + deliverySuffix({ ...metadata, association: "unconfirmed", candidates: [], reason: "execution_changed" });
   return presentDelivery(lines.join("\\n"), metadata) + deliverySuffix(metadata);
}
function getCurrentReviveJob`);
  return DELIVERY_IMPORT + COUNCIL_IMPORT + source;
}

// ---------------------------------------------------------------------------
// OMO 3.0.1 (dual entry: `index` for v1 hosts, `server` for v2 hosts).
// The v2 bundle renames shadowed locals (input→input2, record→record2/record3,
// output→output2); anchors and replacements are variant-aware where needed.
// Patch semantics are identical to the 2.2.25 set except where noted.
// Council stays upstream byte-identical on 3.0.1: no COUNCIL_PROCEDURE swap and
// no finalizeCouncil/prepareCouncilPrompt wiring (2026-10-01 scope reduction).
// ---------------------------------------------------------------------------
const V = (index, server) => (server === undefined ? index : {index, server});
const pick = (value, entry) => (typeof value === 'string' ? value : value[entry]);

// Server-only patches need a defined anchor for BOTH entries (the frozen build
// suite asserts uniqueness/substitution for every patch on every entry). The
// alias guard anchors self-replace on the index entry: the v1 host applies user
// config agents before plugin capture, so v1 keeps upstream alias behavior
// byte-identical while the v2 capture-before-config snapshot stays guarded.
const OMO_ALIAS_GUARD_INDEX_NOOP = 'var AGENT_ALIASES = {\n  explore: "explorer",\n  "frontend-ui-ux-engineer": "designer"\n};';

// 3.0.5 adds the upstream librarian alias to the same module-level table, so the
// index-entry self-anchoring no-op must match the new table verbatim.
const OMO_ALIAS_GUARD_INDEX_NOOP_3_0_5 = 'var AGENT_ALIASES = {\n  explore: "explorer",\n  librarian: "explorer",\n  "frontend-ui-ux-engineer": "designer"\n};';

export const PATCHES_3_0_1 = [
  {
    id: 'ack-injected-resume-def',
    purpose: 'A native resume consumes the previously injected terminal result; acknowledge exactly that owned execution (taskID+generation+terminalRevision) via the existing reconciliation path.',
    anchor: 'function reconcileConsumedTerminalJobs(state, parentSessionID, promptShapeKey) {',
    replacement: `function acknowledgeInjectedNativeResume(state, parentSessionID, requested, agent) {
  const job = state.backgroundJobBoard.resolve(parentSessionID, requested);
  if (!job || job.parentSessionID !== parentSessionID || job.agent !== agent || !job.terminalUnreconciled || job.state === "running") return;
  const entry = state.terminalJobsInjectedByParent.get(parentSessionID);
  for (const [key, execution] of entry?.executions ?? []) {
    if (execution.taskID !== job.taskID || execution.generation !== job.generation || execution.terminalRevision !== job.terminalRevision) continue;
    reconcileExecutionBatch(state, parentSessionID, [execution]);
    const after = state.backgroundJobBoard.get(job.taskID);
    if (after?.state === "reconciled" && after.generation === execution.generation && after.terminalRevision === execution.terminalRevision) {
      entry.executions.delete(key);
      if (!entry.executions.size) state.terminalJobsInjectedByParent.delete(parentSessionID);
    }
    return;
  }
}
function reconcileConsumedTerminalJobs(state, parentSessionID, promptShapeKey) {`,
  },
  {
    id: 'ack-injected-resume-call',
    purpose: 'Run the injected-resume acknowledgment before reusable lookup on every explicit task(task_id=…) call.',
    anchor: V(
      'const remembered = deps.backgroundJobBoard.resolveReusable(input.sessionID, requested, agentType) ??',
      'const remembered = deps.backgroundJobBoard.resolveReusable(input2.sessionID, requested, agentType) ??'),
    replacement: V(
      'if (input.callID) deps.acknowledgeInjectedResume?.(input.sessionID, requested, agentType);\n    const remembered = deps.backgroundJobBoard.resolveReusable(input.sessionID, requested, agentType) ??',
      'if (input2.callID) deps.acknowledgeInjectedResume?.(input2.sessionID, requested, agentType);\n    const remembered = deps.backgroundJobBoard.resolveReusable(input2.sessionID, requested, agentType) ??'),
  },
  {
    id: 'hook-deps-wiring',
    purpose: 'Pass the plugin directory and the injected-resume acknowledgment into the task-session-manager hook.',
    anchor: V(
      '"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      shouldManageSession:',
      '"tool.execute.before": (input2, output2) => handleToolExecuteBefore(input2, output2, {\n      shouldManageSession:'),
    replacement: V(
      '"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      directory: _ctx.directory,\n      acknowledgeInjectedResume: (parent, requested, agent) => acknowledgeInjectedNativeResume(injectionState, parent, requested, agent),\n      shouldManageSession:',
      '"tool.execute.before": (input2, output2) => handleToolExecuteBefore(input2, output2, {\n      directory: _ctx.directory,\n      acknowledgeInjectedResume: (parent, requested, agent) => acknowledgeInjectedNativeResume(injectionState, parent, requested, agent),\n      shouldManageSession:'),
  },
  {
    id: 'native-dispatch-now',
    purpose: 'Record the dispatch time of a native foreground task call; its terminal observation window must start at dispatch, not after the already-completed assistant.',
    anchor: 'lifecycleEpoch: deps.getLifecycleEpoch?.() ?? 0,\n    releaseLease:',
    replacement: 'lifecycleEpoch: deps.getLifecycleEpoch?.() ?? 0,\n    nativeCallStartedAt: Date.now(),\n    releaseLease:',
  },
  {
    id: 'register-launch-now',
    purpose: 'Register the native launch with the dispatch-time clock so the terminal classifier attributes the new result to this run.',
    anchor: 'return deps.backgroundJobBoard.registerLaunch({\n      taskID,\n      parentSessionID: pending.parentSessionId,',
    replacement: 'return deps.backgroundJobBoard.registerLaunch({\n      taskID,\n      now: pending.nativeCallStartedAt,\n      parentSessionID: pending.parentSessionId,',
  },
  {
    id: 'native-terminal-reconcile',
    purpose: 'Re-observe a superseded activity token through the SAME terminal gate with bounded retries (≤2); changed generation, cancellation or an unresolved signal stays fenced.',
    anchor: V(
      'await deps.terminalGate.reconcile(record, {\n        kind: "output",',
      'await deps.terminalGate.reconcile(record2, {\n        kind: "output",'),
    replacement: V('const nativeSignal = {\n        kind: "output",', 'const nativeSignal = {\n        kind: "output",'),
  },
  {
    id: 'native-terminal-reconcile-loop',
    purpose: 'Run the bounded stale/deferred reconciliation loop against the native output signal, awaiting the exposed evidence-read settlement.',
    anchor: 'callIDConfirmed: exactCallConfirmed\n        }\n      });\n      const current = deps.backgroundJobBoard.get(status.taskID);',
    replacement: V(
      `callIDConfirmed: exactCallConfirmed
        }
      };
      let reconciliation = await deps.terminalGate.reconcile(record, nativeSignal);
       for (let attempt = 0; ["stale", "deferred"].includes(reconciliation?.kind) && attempt < 2; attempt++) {
         if (reconciliation.retryAfter) await raceEvidenceDeadline(reconciliation.retryAfter, 2000);
         const observed = deps.backgroundJobBoard.get(record.taskID);
        if (!exactCallConfirmed || observed?.generation !== record.generation || observed.state !== "running" || observed.cancellationRequested) break;
        reconciliation = await deps.terminalGate.reconcile(observed, nativeSignal);
      }
       const current = deps.backgroundJobBoard.get(status.taskID);`,
      `callIDConfirmed: exactCallConfirmed
        }
      };
      let reconciliation = await deps.terminalGate.reconcile(record2, nativeSignal);
       for (let attempt = 0; ["stale", "deferred"].includes(reconciliation?.kind) && attempt < 2; attempt++) {
         if (reconciliation.retryAfter) await raceEvidenceDeadline(reconciliation.retryAfter, 2000);
         const observed = deps.backgroundJobBoard.get(record2.taskID);
        if (!exactCallConfirmed || observed?.generation !== record2.generation || observed.state !== "running" || observed.cancellationRequested) break;
        reconciliation = await deps.terminalGate.reconcile(observed, nativeSignal);
      }
       const current = deps.backgroundJobBoard.get(status.taskID);`),
  },
  {
    id: 'read-settlement-contrast',
    purpose: 'Expose the existing single-flight evidence read settlement (readSettled) on the deferred contrast result so the native caller awaits the real dependency instead of polling.',
    anchor: 'value.pendingRuntimeContrast.token = token;\n      return deferred(token, diagnostic2);',
    replacement: 'value.pendingRuntimeContrast.token = token;\n      return { ...deferred(token, diagnostic2), retryAfter: readSettled };',
  },
  {
    id: 'read-settlement-blocked',
    purpose: 'Expose the single-flight read settlement on the deferred result returned after an open read, keyed by the same readSettled promise.',
    anchor: 'return deferred(token, diagnostic2);\n  }\n  async function read(key, token, operation)',
    replacement: 'return { ...deferred(token, diagnostic2), retryAfter: readSettled };\n  }\n  async function read(key, token, operation)',
  },
  {
    id: 'verdict-origin',
    purpose: 'Carry the terminal classifier’s input/terminal message identity (bcpOrigin) through the completed verdict.',
    anchor: 'return { verdict: "completed", text: evidence.text };',
    replacement: 'return { verdict: "completed", text: evidence.text, bcpOrigin: evidence.bcpOrigin };',
  },
  {
    id: 'classifier-origin',
    purpose: 'Record inputMessageID/terminalMessageID from the terminal assistant message so later receipts can be verified against host identity.',
    anchor: 'return text.length > 0 ? { kind: "ready", text } : { kind: "textless" };',
    replacement: 'return text.length > 0 ? { kind: "ready", text, bcpOrigin: { inputMessageID: last.info.parentID, terminalMessageID: last.info.id } } : { kind: "textless" };',
  },
  {
    id: 'shim-user-text-and-parentid',
    purpose: 'v2 host transcripts carry the run input as a flat text field on the user message and no parentID on assistant messages; map the user text into transcript parts and preserve a host-provided parentID. Without this, the terminal classifier binds bcpOrigin.inputMessageID=undefined and the delivery bridge refuses with no_terminal_identity (real dual-host evidence: ctx.session.context returns user {id,time,type,text}, assistant {content[],finish,time.completed}, synthetic {type:"idle"}).',
    anchor: `function toV1Message(m) {
  const role = m.role ?? m.type;
  return {
    info: {
      id: m.id,
      role: role === "idle" ? "system" : role,
      ...isRecord3(m.time) ? { time: m.time } : {},
      ...m.finish !== undefined ? { finish: m.finish } : {},
      ...m.error !== undefined ? { error: m.error } : {}
    },
    parts: Array.isArray(m.content) ? m.content.map((p) => ({ ...p })) : []
  };
}`,
    replacement: `function toV1Message(m) {
  const role = m.role ?? m.type;
  return {
    info: {
      id: m.id,
      role: role === "idle" ? "system" : role,
      ...typeof m.parentID === "string" && m.parentID ? { parentID: m.parentID } : {},
      ...isRecord3(m.time) ? { time: m.time } : {},
      ...m.finish !== undefined ? { finish: m.finish } : {},
      ...m.error !== undefined ? { error: m.error } : {}
    },
    parts: Array.isArray(m.content) ? m.content.map((p) => ({ ...p })) : typeof m.text === "string" && m.text ? [{ type: "text", text: m.text }] : []
  };
}
// v2 transcripts carry no parentID on assistant messages, so rebuild the input
// link from the real ordered transcript: each assistant binds to the nearest
// preceding REAL user message; synthetic lanes (idle→system) never become an
// input identity; a host-provided parentID wins; with no real source the field
// stays undefined and downstream attribution fails closed.
function toV1Transcript(messages2) {
  const mapped = [];
  let inputID;
  for (const entry of messages2) {
    const message = toV1Message(entry);
    if (message.info.role === "user")
      inputID = message.info.id;
    else if (message.info.role === "assistant" && message.info.parentID === undefined && typeof inputID === "string")
      message.info.parentID = inputID;
    mapped.push(message);
  }
  return mapped;
}`,
  },
  {
    id: 'shim-context-transcript-identity',
    purpose: 'Bind each transcript message to its real run input through the ordered host context — the exact path fetchChildTranscript reads on real v2 hosts (client.session.messages is always shim-provided there, so a client.message.list fallback can never run).',
    anchor: `          return {
            data: (await s.context?.({ sessionID: sessionIDOf(args) }) ?? []).map(toV1Message)
          };`,
    replacement: `          return {
            data: toV1Transcript((await s.context?.({ sessionID: sessionIDOf(args) })) ?? [])
          };`,
  },
  {
    id: 'shim-paged-transcript-identity',
    purpose: 'Apply the same input binding to the paginated transcript path after the desc page is rebuilt ascending.',
    anchor: `            return { data: items.slice().reverse().map(toV1Message) };`,
    replacement: `            return { data: toV1Transcript(items.slice().reverse()) };`,
  },
  {
    id: 'commit-signature',
    purpose: 'Thread bcpOrigin through the terminal-gate commit.',
    anchor: 'function commit(token, state, text, lease, attribution = "event") {',
    replacement: 'function commit(token, state, text, lease, attribution = "event", bcpOrigin) {',
  },
  {
    id: 'commit-store-origin',
    purpose: 'Store bcpOrigin on the board record at commit time.',
    anchor: 'resultSummary: text,\n      cancellationLease: lease,',
    replacement: 'resultSummary: text,\n      bcpOrigin,\n      cancellationLease: lease,',
  },
  {
    id: 'commit-transcript-origin',
    purpose: 'Commit transcript-attributed evidence with its message identity.',
    anchor: 'return commit(token, evidence.verdict, evidence.text, undefined, "transcript");',
    replacement: 'return commit(token, evidence.verdict, evidence.text, undefined, "transcript", evidence.bcpOrigin);',
  },
  {
    id: 'clear-origin-reconciled',
    purpose: 'Drop stale bcpOrigin when a reconciled record is cleared.',
    anchor: 'resultSummary: undefined,\n        lastStatusError: undefined,',
    replacement: 'resultSummary: undefined,\n        bcpOrigin: undefined,\n        lastStatusError: undefined,',
  },
  {
    id: 'clear-origin-failed',
    purpose: 'Drop stale bcpOrigin when a failed record is cleared.',
    anchor: 'resultSummary: undefined,\n      lastStatusError:',
    replacement: 'resultSummary: undefined,\n      bcpOrigin: undefined,\n      lastStatusError:',
  },
  {
    id: 'update-origin-merge',
    purpose: 'Merge bcpOrigin on record updates so identity survives activity revisions.',
    anchor: V(
      'resultSummary: input.resultSummary ?? existing.resultSummary,\n      lastStatusError:',
      'resultSummary: input2.resultSummary ?? existing.resultSummary,\n      lastStatusError:'),
    replacement: V(
      'resultSummary: input.resultSummary ?? existing.resultSummary,\n      bcpOrigin: input.bcpOrigin ?? existing.bcpOrigin,\n      lastStatusError:',
      'resultSummary: input2.resultSummary ?? existing.resultSummary,\n      bcpOrigin: input2.bcpOrigin ?? existing.bcpOrigin,\n      lastStatusError:'),
  },
  {
    id: 'foreground-delivery',
    purpose: 'After OMO validates native call ownership and reconciles the terminal generation, attach verified delivery metadata and the reference receipt with a generation/terminal/activity CAS.',
    anchor: V(
      'const updated = current?.generation === record.generation ? current : undefined;\n      log("[task-session-manager] foreground task status registered",',
      'const updated = current?.generation === record2.generation ? current : undefined;\n      log("[task-session-manager] foreground task status registered",'),
    replacement: V(
      `const updated = current?.generation === record.generation ? current : undefined;
       log("[bcp-native-delivery] terminal observation", { taskID: record.taskID, generation: record.generation, verdict: reconciliation?.kind, diagnostic: updated?.lastStatusError });
       if (updated) {
        const metadata = await deliveryMetadata(deps.directory, updated);
        const latest = deps.backgroundJobBoard.get(updated.taskID);
        if (latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision) {
          output.metadata = { ...output.metadata, bcp_delivery: metadata };
           output.output = presentDelivery(output.output, metadata) + deliverySuffix(metadata);
        }
      }
      log("[task-session-manager] foreground task status registered",`,
      `const updated = current?.generation === record2.generation ? current : undefined;
       log("[bcp-native-delivery] terminal observation", { taskID: record2.taskID, generation: record2.generation, verdict: reconciliation?.kind, diagnostic: updated?.lastStatusError });
       if (updated) {
        const metadata = await deliveryMetadata(deps.directory, updated);
        const latest = deps.backgroundJobBoard.get(updated.taskID);
        if (latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision) {
          output2.metadata = { ...output2.metadata, bcp_delivery: metadata };
           output2.output = presentDelivery(output2.output, metadata) + deliverySuffix(metadata);
        }
      }
      log("[task-session-manager] foreground task status registered",`),
  },
  {
    id: 'task-result-delivery',
    purpose: 'Read-only result retrieval returns the verified receipt after existing ownership/terminal guards, with a fresh CAS after metadata inspection.',
    anchor: 'return current.resultSummary;\n        }\n        snapshot = await getRuntimeSessionStatusSnapshot(options2.input);',
    replacement: `const metadata = await deliveryMetadata(options2.input.directory, current);
          const afterDelivery = board.get(taskID);
          if (afterDelivery?.generation !== current.generation || afterDelivery.terminalRevision !== current.terminalRevision || afterDelivery.activityRevision !== current.activityRevision)
            throw new Error("Task changed while delivery metadata was inspected; retrieve its current result.");
           return presentDelivery(current.resultSummary, metadata) + deliverySuffix(metadata);
        }
        snapshot = await getRuntimeSessionStatusSnapshot(options2.input);`,
  },
  {
    id: 'task-result-evidence-delivery',
    purpose: 'Transcript-evidence fallback of task_result keeps the author text and appends the delivery metadata suffix.',
    anchor: 'return evidence.text;\n      }\n    })\n  };\n}\n// src/tools/task-revive.ts',
    replacement: `const metadata = await deliveryMetadata(options2.input.directory, { taskID, parentSessionID, state: "completed", bcpOrigin: evidence.bcpOrigin });
         return evidence.text + deliverySuffix(metadata);
      }
    })
  };
}
// src/tools/task-revive.ts`,
  },
  {
    id: 'notify-delivery-metadata',
    purpose: 'Background terminal notifications carry verified delivery metadata; the existing lease check still runs after this await.',
    anchor: 'const notifyAgent = selection?.agent ?? "orchestrator";\n      const text = [',
    replacement: V(
      'const notifyAgent = selection?.agent ?? "orchestrator";\n      const bcpMetadata = await deliveryMetadata(options2.input.directory, record);\n      const text = [',
      'const notifyAgent = selection?.agent ?? "orchestrator";\n      const bcpMetadata = await deliveryMetadata(options2.input.directory, record2);\n      const text = ['),
  },
  {
    id: 'notify-delivery-body',
    purpose: 'Present the receipt in place of the author body and append the metadata suffix outside the task_result wrapper.',
    anchor: V(
      'record.resultSummary ?? (state === "completed" ? "Completed." : "Failed."),\n        `</${tag}>`,\n        "</task>"',
      'record2.resultSummary ?? (state === "completed" ? "Completed." : "Failed."),\n        `</${tag}>`,\n        "</task>"'),
    replacement: V(
      'presentDelivery(record.resultSummary ?? (state === "completed" ? "Completed." : "Failed."), bcpMetadata),\n        `</${tag}>`,\n        "</task>",\n        deliverySuffix(bcpMetadata)',
      'presentDelivery(record2.resultSummary ?? (state === "completed" ? "Completed." : "Failed."), bcpMetadata),\n        `</${tag}>`,\n        "</task>",\n        deliverySuffix(bcpMetadata)'),
  },
  {
    id: 'injection-state-directory',
    purpose: 'Give the synthetic injection lane the plugin directory for delivery annotation.',
    anchor: 'const injectionState = {\n    backgroundJobBoard,',
    replacement: 'const injectionState = {\n    bcpDirectory: _ctx.directory,\n    backgroundJobBoard,',
  },
  {
    id: 'synthetic-processed-annotate',
    purpose: 'Annotate already-processed injected completions with delivery metadata behind the generation/observation-epoch/deletion fences.',
    anchor: 'if (origin?.phase === "processed")\n    return;',
    replacement: `if (origin?.phase === "processed") {
    if (existing && origin.generationAtObservation === existing.generation && (deletionEpoch === undefined || origin.lifecycleEpochAtObservation >= deletionEpoch))
      await annotateDeliveryPart(state.bcpDirectory, part, existing, message.info?.sessionID, () => {
        const latest = state.backgroundJobBoard.get(existing.taskID);
        return latest?.generation === existing.generation && latest.terminalRevision === existing.terminalRevision && latest.activityRevision === existing.activityRevision;
      });
    return;
  }`,
  },
  {
    id: 'synthetic-remembered-annotate',
    purpose: 'Annotate remembered injected completions with delivery metadata behind the same fences.',
    anchor: 'if (hasRememberedInjectedCompletion(state, status.taskID, occurrenceId, provenanceKind, existing?.generation)) {\n    return;\n  }',
    replacement: `if (hasRememberedInjectedCompletion(state, status.taskID, occurrenceId, provenanceKind, existing?.generation)) {
    const fence = state.injectedCompletionFences?.get(injectedCompletionKey(status.taskID, occurrenceId, provenanceKind));
    if (existing && fence?.generation === existing.generation && (deletionEpoch === undefined || fence.lifecycleEpoch >= deletionEpoch))
      await annotateDeliveryPart(state.bcpDirectory, part, existing, message.info?.sessionID, () => {
        const latest = state.backgroundJobBoard.get(existing.taskID);
        return latest?.generation === existing.generation && latest.terminalRevision === existing.terminalRevision && latest.activityRevision === existing.activityRevision;
      });
    return;
  }`,
  },
  {
    id: 'synthetic-updated-annotate',
    purpose: 'Annotate freshly reconciled injected completions with delivery metadata and a current-record fence.',
    anchor: 'const updated = result.kind === "stale" ? undefined : result.record;\n  if (!updated)\n    return;\n  if (updated.terminalUnreconciled',
    replacement: `const updated = result.kind === "stale" ? undefined : result.record;
  if (!updated)
    return;
  await annotateDeliveryPart(state.bcpDirectory, part, updated, message.info?.sessionID, () => {
    const latest = state.backgroundJobBoard.get(updated.taskID);
    return latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision;
  });
  if (updated.terminalUnreconciled`,
  },
  {
    id: 'revive-unknown-delivery',
    purpose: 'Revive admission-unknown output is annotated with delivery metadata for inspection.',
    anchor: 'return renderReviveOutput(idParam, current, true);',
    replacement: 'return renderReviveOutput(idParam, current, true, options2.input.directory, options2.backgroundJobBoard);',
  },
  {
    id: 'revive-latest-delivery',
    purpose: 'Revive terminal output is annotated with delivery metadata for inspection.',
    anchor: 'return renderReviveOutput(idParam, latest);',
    replacement: 'return renderReviveOutput(idParam, latest, false, options2.input.directory, options2.backgroundJobBoard);',
  },
  {
    id: 'revive-render-signature',
    purpose: 'renderReviveOutput accepts the plugin directory and board for verified inspection.',
    anchor: V(
      'function renderReviveOutput(idParam, record, admissionUnknown = false) {',
      'function renderReviveOutput(idParam, record3, admissionUnknown = false) {'),
    replacement: V(
      'async function renderReviveOutput(idParam, record, admissionUnknown = false, directory, board) {',
      'async function renderReviveOutput(idParam, record3, admissionUnknown = false, directory, board) {'),
  },
  {
    // Phase1 defaults restoration, alias fallback correction (server/v2 entry
    // only — the index entries below are intentional no-ops). The v2 adapter
    // captures the host draft BEFORE user config agents exist, so the legacy
    // AGENT_ALIASES reverse lookup in buildResolvedAgentRegistry always finds
    // the builtin `explore` snapshot and pastes it over the OMO explorer
    // regardless of any configuration — proven config-immune in
    // compatibility-remediation/results/REPORT.md. Explicit user config keeps
    // winning: canonical name and normalized displayName lookups are untouched,
    // and the distinct alias-name user config path (overrideFor) is untouched.
    // The v1 host applies user config agents before plugin capture, so its
    // alias path can serve real user config — v1 keeps upstream behavior
    // unchanged (self-anchoring no-op), verified by the v1 equality test.
    // Upstream 3.0.2 dropped exactly these legacy-alias fallbacks; mirror it.
    id: 'alias-host-entry-guard',
    purpose: 'Registry stops pasting the builtin-snapshot host entry found via the legacy AGENT_ALIASES reverse lookup over OMO role defaults (prompt, model, variant, description); canonical and displayName user config still win. Server entry only; index keeps upstream behavior (no-op anchor).',
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP, `    const legacyAlias = Object.keys(AGENT_ALIASES).find((key) => AGENT_ALIASES[key] === name);\n    const hostEntry = hostEntries[name] ?? hostEntries[displayName] ?? (legacyAlias ? hostEntries[legacyAlias] : undefined);`),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP, `    const hostEntry = hostEntries[name] ?? hostEntries[displayName];`),
  },
  {
    id: 'alias-permission-guard',
    purpose: 'Host permission rules stop flowing in through the same builtin-snapshot legacy-alias reverse lookup, so OMO role permission boundaries (explorer write denial) are not overridden by the pre-config builtin explore rules. Server entry only; index keeps upstream behavior (no-op anchor).',
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP, `    const legacyAlias = Object.keys(AGENT_ALIASES).find((key) => AGENT_ALIASES[key] === name);\n    const visibleNativeRules = definition.displayName ? Object.entries(nativeRules).find(([agentName]) => normalizeAgentName(agentName).toLowerCase() === normalizeAgentName(definition.displayName).toLowerCase())?.[1] : undefined;\n    const hostRuleSet = nativeRules[name] ?? visibleNativeRules ?? (legacyAlias ? nativeRules[legacyAlias] : undefined) ?? [];`),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP, `    const visibleNativeRules = definition.displayName ? Object.entries(nativeRules).find(([agentName]) => normalizeAgentName(agentName).toLowerCase() === normalizeAgentName(definition.displayName).toLowerCase())?.[1] : undefined;\n    const hostRuleSet = nativeRules[name] ?? visibleNativeRules ?? [];`),
  },
  {
    id: 'alias-visible-identity-decl-guard',
    purpose: 'getSdkAgentProjection drops the unused legacy-alias declaration for the visible alias identity; the distinct displayName (aliasHost) merge the upstream kept stays untouched. Server entry only; index keeps upstream behavior (no-op anchor).',
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP, `      const legacyAlias = Object.keys(AGENT_ALIASES).find((key) => AGENT_ALIASES[key] === definition.name);\n      const canonicalConfig = finalAgentConfig[definition.name];`),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP, `      const canonicalConfig = finalAgentConfig[definition.name];`),
  },
  {
    id: 'alias-visible-rules-guard',
    purpose: 'Visible alias-identity projection stops pasting builtin-snapshot permission rules found via the legacy-alias reverse lookup over the OMO role rules. Server entry only; index keeps upstream behavior (no-op anchor).',
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP, `      const visibleRules = nativeRules[display] ?? nativeRules[definition.name] ?? (legacyAlias ? nativeRules[legacyAlias] : undefined) ?? [];`),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP, `      const visibleRules = nativeRules[display] ?? nativeRules[definition.name] ?? [];`),
  },
  {
    // Gate1 blocker1 correction (server/v2 entry only — the index entry below
    // is an intentional no-op). Proven host behavior (v2.0.20 source): the
    // config-agent effect applies explicit user config agent.system/agent.mode
    // per-field onto the SAME registry entries this projection rewrites, and
    // both transforms re-run on every agent.reload() with the host config
    // effect registered BEFORE this plugin. The upstream projection below
    // unconditionally overwrites mode (=v1.mode ?? classified fallback) and
    // system (=v1.prompt), so a custom role whose body/mode live ONLY in the
    // native opencode.json (absent from the one-shot pre-config
    // captureAgentDraft snapshot, therefore also absent from the hostEntries
    // merge) is clobbered back to the generic specialist body and the
    // classified subagent mode on the reload after config lands — served
    // matrix subagent/142B instead of the pinned all/3275B.
    //
    // After this setup instance's first projection write, retain nonempty
    // system/mode fields from the live registry. No second copy of those
    // fields is cached: deletion/empty values return to the instance's
    // projection. A setup-local Set enforces first-write safety without
    // sharing role state between projects. The FIRST write for a name uses
    // the projection (a host-seeded default cannot be mistaken for a pin).
    // Merely stopping a config effect is not a deletion of its registry data.
    // Model, variant,
    // temperature, permission, description and hidden semantics are untouched.
    // v1 hosts apply user config agents before plugin code reads them, so the
    // index entry keeps upstream behavior byte-identical (self-anchoring
    // no-op), verified by the v1 equality test.
    id: 'native-explicit-pin-retain',
    purpose: 'Retain live nonempty native system/mode after the setup instance first writes its projection, without caching field values; cleared fields fall back to that projection. OMO model/variant/permissions and v1 bytes remain unchanged. Server entry only.',
    anchor: V(
      OMO_ALIAS_GUARD_INDEX_NOOP,
      `function applyAgentToDraft(draft, name, v1, compiledPermissions) {
  const model = parseModelRef(v1.model);
  draft.update(name, (agent) => {
    agent.id = name;
    agent.name = name;
    agent.mode = v1.mode ?? (name === "orchestrator" ? "primary" : "subagent");
    agent.hidden = v1.hidden === true;
    if (typeof v1.description === "string")
      agent.description = v1.description;
    if (typeof v1.prompt === "string")
      agent.system = v1.prompt;`),
    replacement: V(
      OMO_ALIAS_GUARD_INDEX_NOOP,
      `function applyAgentToDraft(draft, name, v1, compiledPermissions, nativeAgentWrites) {
  const model = parseModelRef(v1.model);
  draft.update(name, (agent) => {
    const projectedSystem = typeof v1.prompt === "string" ? v1.prompt : undefined;
    const projectedMode = v1.mode ?? (name === "orchestrator" ? "primary" : "subagent");
    const written = nativeAgentWrites.has(name);
    const nativeSystem = written && typeof agent.system === "string" && agent.system.length > 0 ? agent.system : undefined;
    const nativeMode = written && typeof agent.mode === "string" && agent.mode.length > 0 ? agent.mode : undefined;
    agent.id = name;
    agent.name = name;
    agent.mode = nativeMode ?? projectedMode;
    agent.hidden = v1.hidden === true;
    if (typeof v1.description === "string")
      agent.description = v1.description;
    const explicitSystem = nativeSystem ?? projectedSystem;
    if (explicitSystem !== undefined)
      agent.system = explicitSystem;
    nativeAgentWrites.add(name);`),
  },
  {
    id: 'native-pin-instance-state',
    purpose: 'Own first-write tracking inside each v2 setup instance; no module-global pin cache or cross-project state.',
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP, '      let resolvedAgents;\n      let finalizedRegistry;'),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP, '      const nativeAgentWrites = new Set();\n      let resolvedAgents;\n      let finalizedRegistry;'),
  },
  {
    id: 'native-pin-instance-call',
    purpose: 'Pass the setup-local first-write set to each registry projection write.',
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP, '          applyAgentToDraft(draft, name, cfg, registry4.nativePolicies[name]?.rules);'),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP, '          applyAgentToDraft(draft, name, cfg, registry4.nativePolicies[name]?.rules, nativeAgentWrites);'),
  },
  {
    id: 'revive-render-delivery',
    purpose: 'Revive output carries the verified receipt; a changed execution degrades to an explicit execution_changed suffix instead of stale text.',
    anchor: 'return lines.join(`\n`);\n}\nfunction getCurrentReviveJob',
    replacement: V(
      `const metadata = await deliveryMetadata(directory, admissionUnknown ? { ...record, bcpOrigin: undefined } : record);
  const latest = board?.get(record.taskID);
  if (latest?.generation !== record.generation || latest.terminalRevision !== record.terminalRevision || latest.activityRevision !== record.activityRevision)
    return lines.join("\\n") + deliverySuffix({ ...metadata, association: "unconfirmed", candidates: [], reason: "execution_changed" });
   return presentDelivery(lines.join("\\n"), metadata) + deliverySuffix(metadata);
}
function getCurrentReviveJob`,
      `const metadata = await deliveryMetadata(directory, admissionUnknown ? { ...record3, bcpOrigin: undefined } : record3);
  const latest = board?.get(record3.taskID);
  if (latest?.generation !== record3.generation || latest.terminalRevision !== record3.terminalRevision || latest.activityRevision !== record3.activityRevision)
    return lines.join("\\n") + deliverySuffix({ ...metadata, association: "unconfirmed", candidates: [], reason: "execution_changed" });
   return presentDelivery(lines.join("\\n"), metadata) + deliverySuffix(metadata);
}
function getCurrentReviveJob`),
  },
];

// 3.0.3 keeps the reviewed BCP delivery contract. Its four alias fallbacks were
// removed upstream; never reapply those backports. Upstream now maps user text,
// parentID and time itself, but does not reconstruct absent input identity or
// propagate it through the terminal gate. Keep those distinct responsibilities.
const PATCH_OVERRIDES_3_0_3 = {
  'foreground-delivery': {
    replacement: Object.fromEntries(['index', 'server'].map(entry => {
      const output = entry === 'index' ? 'output' : 'output2';
      return [entry, pick(PATCHES_3_0_1.find(patch => patch.id === 'foreground-delivery').replacement, entry)
        .replace(`presentDelivery(${output}.output, metadata) + deliverySuffix(metadata)`,
          `presentRetainedChildDelivery(${output}.output, metadata, updated.parentSessionID)`)];
    })),
  },
  'register-launch-now': {
    anchor: 'return deps.backgroundJobBoard.registerLaunch({\n      taskID,\n      parentSessionID: pending2.parentSessionId,',
    replacement: 'return deps.backgroundJobBoard.registerLaunch({\n      taskID,\n      now: pending2.nativeCallStartedAt,\n      parentSessionID: pending2.parentSessionId,',
  },
  'ack-injected-resume-call': {
    anchor: V(
      'let remembered = deps.backgroundJobBoard.resolveReusable(input.sessionID, requested, agentType) ??',
      'let remembered = deps.backgroundJobBoard.resolveReusable(input2.sessionID, requested, agentType) ??'),
    replacement: V(
      'if (input.callID) deps.acknowledgeInjectedResume?.(input.sessionID, requested, agentType);\n    let remembered = deps.backgroundJobBoard.resolveReusable(input.sessionID, requested, agentType) ??',
      'if (input2.callID) deps.acknowledgeInjectedResume?.(input2.sessionID, requested, agentType);\n    let remembered = deps.backgroundJobBoard.resolveReusable(input2.sessionID, requested, agentType) ??'),
  },
  'shim-user-text-and-parentid': {
    purpose: 'Keep upstream 3.0.3 message mapping intact and bind an assistant without parentID to the preceding real user, without inventing an ID when the input is unavailable.',
    anchor: 'var warnedListUnavailable = false;',
    replacement: `function toV1Transcript(messages2) {
  const mapped = [];
  let inputID;
  for (const entry of messages2) {
    const message = toV1Message(entry);
    if (message.info.role === "user")
      inputID = message.info.id;
    else if (message.info.role === "assistant" && message.info.parentID === undefined && typeof inputID === "string")
      message.info.parentID = inputID;
    mapped.push(message);
  }
  return mapped;
}
var warnedListUnavailable = false;`,
  },
  'shim-context-transcript-identity': {
    anchor: 'data: raw.map(toV1Message),',
    replacement: 'data: toV1Transcript(raw),',
  },
  'shim-paged-transcript-identity': {
    anchor: V(
      'data: page.data.slice().reverse().map((message) => toV1Message(isRecord4(message) ? message : { type: "unknown" }))',
      'data: page.data.slice().reverse().map((message) => toV1Message(isRecord3(message) ? message : { type: "unknown" }))'),
    replacement: V(
      'data: toV1Transcript(page.data.slice().reverse().map((message) => isRecord4(message) ? message : { type: "unknown" }))',
      'data: toV1Transcript(page.data.slice().reverse().map((message) => isRecord3(message) ? message : { type: "unknown" }))'),
  },
  'commit-transcript-origin': {
    anchor: '\n      return commit(token, evidence.verdict, evidence.text, undefined, "transcript");',
    replacement: '\n      return commit(token, evidence.verdict, evidence.text, undefined, "transcript", evidence.bcpOrigin);',
  },
  'task-result-delivery': {
    anchor: 'return current.resultSummary;\n        }\n        const v2 = options2.input.hostFlavor === "v2";',
    replacement: `const metadata = await deliveryMetadata(options2.input.directory, current);
          const afterDelivery = board.get(taskID);
          if (afterDelivery?.generation !== current.generation || afterDelivery.terminalRevision !== current.terminalRevision || afterDelivery.activityRevision !== current.activityRevision)
            throw new Error("Task changed while delivery metadata was inspected; retrieve its current result.");
          return presentDelivery(current.resultSummary, metadata) + deliverySuffix(metadata);
        }
        const v2 = options2.input.hostFlavor === "v2";`,
  },
  'revive-unknown-delivery': {
    anchor: 'return renderReviveOutput(idParam, queueContinuation ? launched ?? current : current, true);',
    replacement: 'return renderReviveOutput(idParam, queueContinuation ? launched ?? current : current, true, options2.input.directory, options2.backgroundJobBoard);',
  },
  'native-pin-instance-state': {
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP, '      let finalizedRegistry;'),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP, '      const nativeAgentWrites = new Set();\n      let finalizedRegistry;'),
  },
};

const readonlyResultBody = name => `function readonlyTerminalResult(requested, ${name}) {
  const state = ${name}?.state === "reconciled" ? ${name}.terminalState : ${name}?.state;
  const summary = ${name}?.resultSummary?.trim();
  if (state === "completed" && summary)
    return summary;
  throw new Error(\`Task \${requested} result was not consumed. No action was sent.\`);
}`;
const readonlyDeliveryBody = name => `async function readonlyTerminalResult(requested, ${name}, directory, board) {
  const state = ${name}?.state === "reconciled" ? ${name}.terminalState : ${name}?.state;
  const summary = ${name}?.resultSummary?.trim();
  if (state === "completed" && summary) {
    const metadata = await deliveryMetadata(directory, ${name});
    const latest = board.get(${name}.taskID);
    if (latest?.generation !== ${name}.generation || latest.terminalRevision !== ${name}.terminalRevision || latest.activityRevision !== ${name}.activityRevision || latest.parentSessionID !== ${name}.parentSessionID)
      throw new Error("Task changed while delivery metadata was inspected; retrieve its current result.");
    return presentDelivery(summary, metadata) + deliverySuffix(metadata);
  }
  throw new Error(\`Task \${requested} result was not consumed. No action was sent.\`);
}`;

export const PATCHES_3_0_3 = [
  ...PATCHES_3_0_1.filter(patch => !patch.id.startsWith('alias-')).map(patch => ({...patch, ...PATCH_OVERRIDES_3_0_3[patch.id]})),
  {
    id: 'native-retained-child-delivery',
    purpose: 'Validate the new retained-child suffix against the current owner and execution, compact only exact verified body bytes, and keep the upstream recovery marker authoritative at the tail.',
    anchor: 'function formatChildRef(ref) {',
    replacement: `function presentRetainedChildDelivery(text, metadata, parentSessionID) {
  const ref = readAuthoritativeChildRef(text);
  if (!ref) return presentDelivery(text, metadata) + deliverySuffix(metadata);
  const marker = "\\n" + formatChildRef(ref);
  if (ref.parentSessionID !== parentSessionID || ref.sessionID !== metadata?.execution?.task_id ||
      ref.agent !== metadata?.result_reference?.writer?.agent || !text.endsWith(marker)) return text;
  const original = text.slice(0, -marker.length);
  const close = original.endsWith("</task>") ? "</task>" : original.endsWith("</subagent>") ? "</subagent>" : undefined;
  if (!close) return text;
  const delivered = presentDelivery(original, metadata);
  return delivered.slice(0, -close.length) + deliverySuffix(metadata) + "\\n" + close + marker;
}
function formatChildRef(ref) {`,
  },
  {
    id: 'commit-queued-transcript-origin',
    purpose: 'Carry the exact queued prompt/terminal identity through the new inspectQueuedAnswer commit, independently of the ordinary completion path.',
    anchor: '\n    return commit(token, evidence.verdict, evidence.text, undefined, "transcript");',
    replacement: '\n    return commit(token, evidence.verdict, evidence.text, undefined, "transcript", evidence.bcpOrigin);',
  },
  {
    id: 'readonly-result-delivery',
    purpose: 'The new disposed-plugin read-only result path returns a verified receipt after existing ownership checks, with a fresh execution/ownership check after the metadata await.',
    anchor: V(readonlyResultBody('record'), readonlyResultBody('record3')),
    replacement: V(readonlyDeliveryBody('record'), readonlyDeliveryBody('record3')),
  },
  {
    id: 'readonly-result-tracked-call',
    purpose: 'Pass the directory and board to the disposed-plugin tracked-result delivery path.',
    anchor: 'return readonlyTerminalResult(requested, tracked);',
    replacement: 'return readonlyTerminalResult(requested, tracked, options2.input.directory, board);',
  },
  {
    id: 'readonly-result-current-call',
    purpose: 'Pass the directory and board to the disposed-plugin current-result delivery path.',
    anchor: 'return readonlyTerminalResult(requested, current);',
    replacement: 'return readonlyTerminalResult(requested, current, options2.input.directory, board);',
  },
];

// 3.0.4 upstream renamed the shadowed v2 bundle locals back to their canonical
// names (input/record/diagnostic — the server entry now matches the index
// entry) and reshaped three delivery sites (task_result evidence fallback,
// background notification anchor, native pin registry access). Only the deltas
// below differ from PATCHES_3_0_3; every other anchor still matches both 3.0.4
// entries byte-for-byte and is inherited unchanged.
const PATCH_OVERRIDES_3_0_4 = {
  'register-launch-now': {
    // 3.0.4 keeps the unshadowed `pending` local, so the 3.0.1 plain form is
    // correct again and the 3.0.3 pending2 override is neutralized.
    anchor: PATCHES_3_0_1.find(patch => patch.id === 'register-launch-now').anchor,
    replacement: PATCHES_3_0_1.find(patch => patch.id === 'register-launch-now').replacement,
  },
  'ack-injected-resume-call': {
    anchor: 'let remembered = deps.backgroundJobBoard.resolveReusable(input.sessionID, requested, agentType) ??',
    replacement: 'if (input.callID) deps.acknowledgeInjectedResume?.(input.sessionID, requested, agentType);\n    let remembered = deps.backgroundJobBoard.resolveReusable(input.sessionID, requested, agentType) ??',
  },
  'hook-deps-wiring': {
    anchor: '"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      shouldManageSession:',
    replacement: '"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      directory: _ctx.directory,\n      acknowledgeInjectedResume: (parent, requested, agent) => acknowledgeInjectedNativeResume(injectionState, parent, requested, agent),\n      shouldManageSession:',
  },
  'native-terminal-reconcile': {
    anchor: 'await deps.terminalGate.reconcile(record, {\n        kind: "output",',
    replacement: 'const nativeSignal = {\n        kind: "output",',
  },
  'native-terminal-reconcile-loop': {
    replacement: pick(PATCHES_3_0_1.find(patch => patch.id === 'native-terminal-reconcile-loop').replacement, 'index'),
  },
  'read-settlement-contrast': {
    anchor: 'value.pendingRuntimeContrast.token = token;\n      return deferred(token, diagnostic);',
    replacement: 'value.pendingRuntimeContrast.token = token;\n      return { ...deferred(token, diagnostic), retryAfter: readSettled };',
  },
  'read-settlement-blocked': {
    anchor: 'return deferred(token, diagnostic);\n  }\n  async function read(key, token, operation)',
    replacement: 'return { ...deferred(token, diagnostic), retryAfter: readSettled };\n  }\n  async function read(key, token, operation)',
  },
  'update-origin-merge': {
    anchor: 'resultSummary: input.resultSummary ?? existing.resultSummary,\n      lastStatusError:',
    replacement: 'resultSummary: input.resultSummary ?? existing.resultSummary,\n      bcpOrigin: input.bcpOrigin ?? existing.bcpOrigin,\n      lastStatusError:',
  },
  'foreground-delivery': {
    anchor: pick(PATCHES_3_0_1.find(patch => patch.id === 'foreground-delivery').anchor, 'index'),
    replacement: pick(PATCHES_3_0_1.find(patch => patch.id === 'foreground-delivery').replacement, 'index')
      .replace('presentDelivery(output.output, metadata) + deliverySuffix(metadata)',
        'presentRetainedChildDelivery(output.output, metadata, updated.parentSessionID)'),
  },
  'task-result-delivery': {
    anchor: 'return current.resultSummary;\n        }\n        const read = await readUntrackedEvidence({ input: options2.input, readTimeoutMs: options2.readTimeoutMs }, taskID);',
    replacement: `const metadata = await deliveryMetadata(options2.input.directory, current);
          const afterDelivery = board.get(taskID);
          if (afterDelivery?.generation !== current.generation || afterDelivery.terminalRevision !== current.terminalRevision || afterDelivery.activityRevision !== current.activityRevision)
            throw new Error("Task changed while delivery metadata was inspected; retrieve its current result.");
          return presentDelivery(current.resultSummary, metadata) + deliverySuffix(metadata);
        }
        const read = await readUntrackedEvidence({ input: options2.input, readTimeoutMs: options2.readTimeoutMs }, taskID);`,
  },
  'task-result-evidence-delivery': {
    anchor: 'return completedText;\n      }\n    })\n  };\n}\n// src/tools/task-revive.ts',
    replacement: `const metadata = await deliveryMetadata(options2.input.directory, { taskID, parentSessionID, state: "completed", bcpOrigin: evidence.bcpOrigin });
         return completedText + deliverySuffix(metadata);
      }
    })
  };
}
// src/tools/task-revive.ts`,
  },
  'notify-delivery-metadata': {
    anchor: 'const text = [\n        `<task id="${run.taskID}" state="${state}">`,',
    purpose: 'Background terminal notifications carry verified delivery metadata; a failed post-await freshness comparison suppresses the notification before presentation and transport.',
    // The metadata await must not leak a stale receipt: re-verify the full
    // generation/terminal/activity triple as a synchronous statement AFTER the
    // enclosing await resolves — never inside a .then continuation, where a
    // microtask queued during metadata resolution can slip between the
    // comparison and the notifier's resumption. A failure throws a sentinel
    // that suppresses the notification entirely — no presentation, no
    // transport send, no retry scheduling for an already-known-stale output.
    // Lease release and pending-flag cleanup stay in the upstream finally
    // block; the await happens after lease acquisition, before send.
    replacement: 'const bcpMetadata = await deliveryMetadata(options2.input.directory, record);\n      {\n        const latest = options2.backgroundJobBoard.get(record.taskID);\n        if (!latest || latest.generation !== record.generation || latest.terminalRevision !== record.terminalRevision || latest.activityRevision !== record.activityRevision) {\n          const superseded = new Error("Execution changed while the terminal notification was inspected; its captured output is stale.");\n          superseded.bcpNotificationSuperseded = true;\n          throw superseded;\n        }\n      }\n      const text = [\n        `<task id="${run.taskID}" state="${state}">`,',
  },
  'notify-delivery-body': {
    anchor: 'record.resultSummary ?? (state === "completed" ? "Completed." : "Failed."),\n        `</${tag}>`,\n        "</task>"',
    replacement: 'presentDelivery(record.resultSummary ?? (state === "completed" ? "Completed." : "Failed."), bcpMetadata),\n        `</${tag}>`,\n        "</task>",\n        deliverySuffix(bcpMetadata)',
  },
  'revive-render-signature': {
    anchor: 'function renderReviveOutput(idParam, record, admissionUnknown = false) {',
    replacement: 'async function renderReviveOutput(idParam, record, admissionUnknown = false, directory, board) {',
  },
  'revive-render-delivery': {
    replacement: pick(PATCHES_3_0_1.find(patch => patch.id === 'revive-render-delivery').replacement, 'index'),
  },
  'native-pin-instance-call': {
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP, '          applyAgentToDraft(draft, name, cfg, registry.nativePolicies[name]?.rules);'),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP, '          applyAgentToDraft(draft, name, cfg, registry.nativePolicies[name]?.rules, nativeAgentWrites);'),
  },
  'readonly-result-delivery': {
    anchor: readonlyResultBody('record'),
    replacement: readonlyDeliveryBody('record'),
  },
};

// 3.0.4-specific patches that have no 3.0.3 ancestor:
// - notify-suppressed-catch: the notification catch block gains an explicit
//   suppression branch for the freshness sentinel thrown by
//   notify-delivery-metadata, so a known-stale notification is dropped
//   instead of being retried against an execution that already moved on.
// - notify-currentness-activity: notification currentness includes the board
//   activity revision. This closes the transport-wrapper deferral window: the
//   wrapper schedules the send operation in a later microtask, so a change
//   that lands after the post-await comparison is caught at the send boundary.
//   Because upstream re-uses isCurrentNotification in the send-boundary check,
//   the acceptance callback and the retry guard, this single addition also
//   keeps a raced acceptance from marking a stale delivery as sent and keeps
//   the catch-path retry guard from re-arming a stale notification.
const PATCHES_3_0_4_ADDITIONS = [
  {
    id: 'notify-suppressed-catch',
    purpose: 'A failed post-await freshness comparison suppresses the terminal notification before presentation and transport without scheduling stale retries; lease release and pending-flag cleanup stay in the upstream finally block.',
    anchor: '    } catch (error) {\n      log("[revived-run-tracker] notification failed", {\n        taskID: run.taskID,\n        generation: run.generation,\n        parentSessionID: run.parentSessionID,\n        attempt,\n        timedOut: error instanceof NotificationTransportTimeoutError,\n        error: stringifyError(error)\n      });\n      scheduleNotificationRetry(run, record, notification);\n    } finally {',
    replacement: '    } catch (error) {\n      if (error?.bcpNotificationSuperseded) {\n        log("[revived-run-tracker] notification suppressed: execution changed during metadata inspection", {\n          taskID: run.taskID,\n          generation: run.generation,\n          parentSessionID: run.parentSessionID,\n          attempt\n        });\n      } else {\n        log("[revived-run-tracker] notification failed", {\n          taskID: run.taskID,\n          generation: run.generation,\n          parentSessionID: run.parentSessionID,\n          attempt,\n          timedOut: error instanceof NotificationTransportTimeoutError,\n          error: stringifyError(error)\n        });\n        scheduleNotificationRetry(run, record, notification);\n      }\n    } finally {',
  },
  {
    id: 'notify-currentness-activity',
    purpose: 'Notification currentness includes the board activity revision, so an activity-only change invalidates the send-boundary check, the acceptance callback and the retry guard — no stale output is delivered, marked sent, or re-armed for retry.',
    anchor: 'return !disposed && runs.get(run.taskID) === run && run.notification === notification && run.generation === record.generation && run.terminalRevision === record.terminalRevision && current?.generation === record.generation && current.terminalRevision === record.terminalRevision && run.terminalState === record.state && terminalOutcome(current) === record.state;',
    replacement: 'return !disposed && runs.get(run.taskID) === run && run.notification === notification && run.generation === record.generation && run.terminalRevision === record.terminalRevision && current?.generation === record.generation && current.terminalRevision === record.terminalRevision && current?.activityRevision === record.activityRevision && run.terminalState === record.state && terminalOutcome(current) === record.state;',
  },
];

export const PATCHES_3_0_4 = [
  ...PATCHES_3_0_3.map(patch => ({ ...patch, ...PATCH_OVERRIDES_3_0_4[patch.id] })),
  ...PATCHES_3_0_4_ADDITIONS,
];

// 3.0.5 keeps the full 3.0.4 patch set: 35 patches carry over verbatim (their
// anchors still match both 3.0.5 entries byte-for-byte) and 8 ids are re-anchored
// below. No patch was retired: upstream 3.0.5 extends the affected regions
// (commit gains a hostOutcomeRead corroboration parameter and its callers pass
// the host outcome; the task_result tool folds into task_status's
// result:true path as standalone readTaskResult; AGENT_ALIASES gains the
// librarian alias) without absorbing any BCP fix. Each re-anchor preserves the
// original purpose exactly; only anchor/replacement text tracks the 3.0.5
// bundle shape (indentation, renamed locals, upstream's new parameters).
const PATCH_OVERRIDES_3_0_5 = {
  'commit-signature': {
    // 3.0.5 adds its own 6th parameter (hostOutcomeRead corroboration); bcpOrigin
    // becomes the 7th parameter so existing callers leave it undefined.
    anchor: 'function commit(token, state, text, lease, attribution = "event", hostOutcomeRead) {',
    replacement: 'function commit(token, state, text, lease, attribution = "event", hostOutcomeRead, bcpOrigin) {',
  },
  'commit-transcript-origin': {
    // The inspect-path transcript commit now passes upstream's terminalOutcome
    // as the 6th argument; bcpOrigin threads through as the 7th.
    anchor: '\n      return commit(token, evidence.verdict, evidence.text, undefined, "transcript", terminalOutcome);',
    replacement: '\n      return commit(token, evidence.verdict, evidence.text, undefined, "transcript", terminalOutcome, evidence.bcpOrigin);',
  },
  'commit-queued-transcript-origin': {
    // The queued-continuation caller keeps upstream's five leading arguments,
    // so its origin must skip the new hostOutcomeRead slot (explicit undefined)
    // and land in the 7th parameter. The inherited 3.0.4 call would pass
    // evidence.bcpOrigin as hostOutcomeRead: the stored origin becomes
    // undefined and upstream's outcome corroboration reads a foreign object.
    anchor: PATCHES_3_0_4.find(patch => patch.id === 'commit-queued-transcript-origin').anchor,
    replacement: '\n    return commit(token, evidence.verdict, evidence.text, undefined, "transcript", undefined, evidence.bcpOrigin);',
  },
  'task-result-delivery': {
    // readTaskResult is now a standalone function (task_result folded into
    // task_status's result:true path), so the delivery block sits at the
    // function's top level: 4/2-space indentation instead of the 3.0.4
    // tool-closure nesting. The post-metadata check mirrors upstream's own
    // await-window discipline: capture a gate token before the deliveryMetadata
    // await, recapture after it, and compare activity/attempt/episode (gate
    // capture-token dimensions — NOT board record fields). An episode can
    // advance without moving the board triple, so only the token comparison
    // catches that race; a missing recapture fails closed. The 3.0.4 board
    // generation/terminalRevision/activityRevision CAS is retained, as are
    // presentDelivery and the delivery suffix.
    anchor: '    return current.resultSummary;\n  }\n  const read = await readUntrackedEvidence({ input: options2.input, readTimeoutMs: options2.readTimeoutMs }, taskID);',
    replacement: `    const preMetadata = gate.capture(current);
    const metadata = await deliveryMetadata(options2.input.directory, current);
    const afterDelivery = board.get(taskID);
    const postMetadata = gate.capture(current);
    if (afterDelivery?.generation !== current.generation || afterDelivery.terminalRevision !== current.terminalRevision || afterDelivery.activityRevision !== current.activityRevision || postMetadata?.activityRevision !== preMetadata?.activityRevision || postMetadata?.attemptRevision !== preMetadata?.attemptRevision || postMetadata?.episode !== preMetadata?.episode)
      throw new Error("Task changed while delivery metadata was inspected; retrieve its current result.");
    return presentDelivery(current.resultSummary, metadata) + deliverySuffix(metadata);
  }
  const read = await readUntrackedEvidence({ input: options2.input, readTimeoutMs: options2.readTimeoutMs }, taskID);`,
  },
  'task-result-evidence-delivery': {
    // Same standalone-function reshape: the transcript-evidence fallback tail
    // now closes readTaskResult directly before reportUntrackedTaskStatus.
    anchor: '  return completedText;\n}\nasync function reportUntrackedTaskStatus(options2, ref) {',
    replacement: `  const metadata = await deliveryMetadata(options2.input.directory, { taskID, parentSessionID, state: "completed", bcpOrigin: evidence.bcpOrigin });
  return completedText + deliverySuffix(metadata);
}
async function reportUntrackedTaskStatus(options2, ref) {`,
  },
};

// Index entry only: the alias-guard anchors self-replace on the v1 entry and
// 3.0.5 renamed that table's content (librarian alias added). The server-entry
// halves of these three patches still match 3.0.5 byte-for-byte and are
// inherited from the effective 3.0.4 patches.
const withIndexAliasGuard3_0_5 = id => {
  const base = PATCHES_3_0_4.find(patch => patch.id === id);
  return {
    anchor: V(OMO_ALIAS_GUARD_INDEX_NOOP_3_0_5, pick(base.anchor, 'server')),
    replacement: V(OMO_ALIAS_GUARD_INDEX_NOOP_3_0_5, pick(base.replacement, 'server')),
  };
};
PATCH_OVERRIDES_3_0_5['native-explicit-pin-retain'] = withIndexAliasGuard3_0_5('native-explicit-pin-retain');
PATCH_OVERRIDES_3_0_5['native-pin-instance-state'] = withIndexAliasGuard3_0_5('native-pin-instance-state');
PATCH_OVERRIDES_3_0_5['native-pin-instance-call'] = withIndexAliasGuard3_0_5('native-pin-instance-call');

export const PATCHES_3_0_5 = [
  ...PATCHES_3_0_4.map(patch => ({ ...patch, ...PATCH_OVERRIDES_3_0_5[patch.id] })),
];

// 3.0.5 → 3.0.6: upstream #1652/#1649 replaced the injected-terminal-result
// lifecycle (injections now reconcile through the terminal gate at injection
// time; v2 retires task_revive) and #1637/#1657 reworked task-result
// attribution (readUntrackedEvidence gains a hostInfo argument). Five anchors
// moved; two patches retire; one addition covers a shim return that split in
// two. 43 → 42 patches. Fail-closed digest and uniqueness matching unchanged.
const PATCH_OVERRIDES_3_0_6 = {
  // Keep only the plugin-directory wiring: the injected-resume acknowledgment
  // this site also fed is retired below (its target state no longer exists),
  // and wiring it would reference an undefined function.
  'hook-deps-wiring': {
    purpose: 'Pass the plugin directory into the task-session-manager hook.',
    anchor: '"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      shouldManageSession:',
    replacement: '"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {\n      directory: _ctx.directory,\n      shouldManageSession:',
  },
  // 3.0.6 splits the context shim's transcript return into a paginated history
  // rebuild and a tail slice; both must bind through toV1Transcript. The
  // history site is overridden here, the tail site is a new addition below.
  'shim-context-transcript-identity': {
    anchor: '              data: history.reverse().map(toV1Message),',
    replacement: '              data: toV1Transcript(history.reverse()),',
  },
  // 3.0.6 passes upstream's new third argument (hostInfo) to
  // readUntrackedEvidence. The 3.0.5 gate.capture pre/post + board CAS body
  // carries over unchanged: gate/board are still in readTaskResult scope.
  'task-result-delivery': {
    anchor: '    return current.resultSummary;\n  }\n  const read = await readUntrackedEvidence({ input: options2.input, readTimeoutMs: options2.readTimeoutMs }, taskID, hostInfo);',
    replacement: `    const preMetadata = gate.capture(current);
    const metadata = await deliveryMetadata(options2.input.directory, current);
    const afterDelivery = board.get(taskID);
    const postMetadata = gate.capture(current);
    if (afterDelivery?.generation !== current.generation || afterDelivery.terminalRevision !== current.terminalRevision || afterDelivery.activityRevision !== current.activityRevision || postMetadata?.activityRevision !== preMetadata?.activityRevision || postMetadata?.attemptRevision !== preMetadata?.attemptRevision || postMetadata?.episode !== preMetadata?.episode)
      throw new Error("Task changed while delivery metadata was inspected; retrieve its current result.");
    return presentDelivery(current.resultSummary, metadata) + deliverySuffix(metadata);
  }
  const read = await readUntrackedEvidence({ input: options2.input, readTimeoutMs: options2.readTimeoutMs }, taskID, hostInfo);`,
  },
  // 3.0.6 moves reportUntrackedTaskStatus below the new DIAGNOSTIC_TERMINALS
  // table, so the readTaskResult fallback tail now closes directly before it.
  'task-result-evidence-delivery': {
    anchor: '  return completedText;\n}\nvar DIAGNOSTIC_TERMINALS = new Set(["error", "cancelled", "stopped"]);',
    replacement: `  const metadata = await deliveryMetadata(options2.input.directory, { taskID, parentSessionID, state: "completed", bcpOrigin: evidence.bcpOrigin });
  return completedText + deliverySuffix(metadata);
}
var DIAGNOSTIC_TERMINALS = new Set(["error", "cancelled", "stopped"]);`,
  },
  // 3.0.6 reconciles injections through the terminal gate at injection time,
  // dropping the terminalUnreconciled early-return branch; the annotation now
  // sits directly after the stale guard, before upstream's
  // processed-completion log. Same current-record fence as 3.0.5.
  'synthetic-updated-annotate': {
    anchor: '  const updated = result.kind === "stale" ? undefined : result.record;\n  if (!updated)\n    return;\n  log("[task-session-manager] processed injected background completion", {',
    replacement: `  const updated = result.kind === "stale" ? undefined : result.record;
  if (!updated)
    return;
  await annotateDeliveryPart(state.bcpDirectory, part, updated, message.info?.sessionID, () => {
    const latest = state.backgroundJobBoard.get(updated.taskID);
    return latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision;
  });
  log("[task-session-manager] processed injected background completion", {`,
  },
};

// New in 3.0.6: the context shim's tail-path transcript return (the history
// rebuild path is handled by the overridden shim-context-transcript-identity).
const PATCHES_3_0_6_ADDITIONS = [
  {
    id: 'shim-context-tail-transcript-identity',
    purpose: 'Bind each tail-sliced transcript message to its real run input through the ordered host context (3.0.6 split the context shim return).',
    anchor: '            data: tail.map(toV1Message),',
    replacement: '            data: toV1Transcript(tail),',
  },
];

// Retired for 3.0.6: the injected-resume acknowledgment (definition and call
// site). Upstream #1652/#1649 now reconciles injected completions through the
// terminal gate at injection time (updateFromInjectedCompletion →
// terminalGate.reconcile), so consumed results are no longer left
// terminalUnreconciled and the terminalJobsInjectedByParent ledger this patch
// matched against is gone. Resume-time consumption of genuinely unreconciled
// results is handled upstream (v2 acks inline in handleToolExecuteBefore via
// markReconciled with a generation/terminalRevision settle check; v1 refuses
// with explicit task_revive guidance). The patch's safety contract —
// acknowledge exactly that owned execution — cannot be honored without the
// removed ledger, so no broader replacement is attempted (fail-closed).
const PATCHES_3_0_6_RETIRED = new Set(['ack-injected-resume-def', 'ack-injected-resume-call']);

export const PATCHES_3_0_6 = [
  ...PATCHES_3_0_5
    .filter(patch => !PATCHES_3_0_6_RETIRED.has(patch.id))
    .map(patch => ({ ...patch, ...PATCH_OVERRIDES_3_0_6[patch.id] })),
  ...PATCHES_3_0_6_ADDITIONS,
];

// ---------------------------------------------------------------------------
// 3.0.7 module patcher. Upstream 3.0.7 switched the dist to a multi-module
// layout: each entry (dist/index.js, dist/server/index.js) plus the literal
// import/re-export/dynamic-import closure of chunks it reaches. Patching is
// per-module: OMO_307_MODULES pins every module of each entry's closure by
// SHA-256, patchOmo307() verifies the complete module set and every digest
// before replacing anything, applies each patch exactly once per target
// module, and preserves the package layout (no rebundling). Only the two
// entry modules get the delivery helper import; the patched chunks use only
// in-module symbols (toV1Transcript etc.).
export const OMO_307_MODULES = {
  index: {
    'dist/index.js': '47ec8c7070c648c8860ab4becfb2391257cf833957c4b56ccf3cbaad5e6f5052',
    'dist/chunks/marketplace-pc5v8kr0.js': '9e4ad1f7271ce225456bb40851ca6776e637425b8cc4fa4db5a69159ca2f30e0',
    'dist/chunks/index-z19vm7mg.js': 'e19df353f80bffda3b11049a3fa8b8a5317a97448fdbc5496686336be923697a',
    'dist/chunks/index-01tcrt5t.js': '46e7722c2507912857855b473d4af759f30398a1ef04490e2a7462dc28e1277b',
    'dist/chunks/registry-runtime-pvx2nmh7.js': 'acc01380832d8e3926ee22a0c783b6764a479f7e39fe1052b35b9739e7d659ed',
    'dist/chunks/index-nhpdw4tk.js': '912a02d0d9728d758ec4a37e889de93e27076eb37dc967a71c89c5b52d7fcad0',
    'dist/chunks/service-c1qavjgs.js': '919277f1df13a851ee35ea580e1fe53a5b9a1e47f17b14519629061f0e8b1648',
    'dist/chunks/updater-0f9am5gt.js': '9b9a4468c08ac60cb373a397d7a4db7d808f98358469114202e2b2e9c81b67da',
    'dist/chunks/zip-extractor-yrks8cnt.js': '4cc4d827570b3675b9245bcde38813eacd9bd7e4f478c9c8c23676e4c2a0e9ed',
    'dist/chunks/manager-14m7y84a.js': '6722ed0e141c6ae8303038016dc776be2b2dd025a646e4f6e84007d2729f8425',
    'dist/chunks/index-g9w3d3y2.js': '946832e3ade7b2b86918beaf06fbd365fd0f360bd3ea9eb239e5bcc76e22660f',
    'dist/chunks/index-t61zvtdb.js': 'e73975b3bfaef94feddf3c3c929a834abb4093f4b622f2362ce105d211c4cc24',
    'dist/chunks/index-223r0y2b.js': '959aede99ef0276527701a868903c95e23a59203ccbaa6843283e086b1db248b',
    'dist/chunks/history-mxtgc72x.js': '778067ea01456f96ca565c12f268f664441520d024fca3e9125c1d335f87b051',
    'dist/chunks/interview-bridge-cx8r78bw.js': '856b23baa347112a168ab60f4a1aec31ccfc32113ddc443359cb4b04a29a0e46',
  },
  server: {
    'dist/server/index.js': '485f34ad29e4f9ffa0b2fd9c52dad3d8db401ff68394f40b6f6f93866cbf9237',
    'dist/server/chunks/marketplace-mr0hk4js.js': '5111503e0efab4528f119ff45a990b2ffe14c87d2ff5f6f1614e5a7d22ea56bd',
    'dist/server/chunks/index-wsvbb4qp.js': 'c298c8e828eee887fa779f6482f649f26842b1bbe3b074ad2b4f5df94af34092',
    'dist/server/chunks/registry-runtime-7p5pv2dy.js': '1b8b71ab286401e4689f4c04bb835b8fc6c8be4dfc4a1c7bd851dc39c0e17ddc',
    'dist/server/chunks/index-0pcpsb56.js': 'ff6b92f01c80598f325f5ffe569904f7c8be7a6661f9d7e3ef960472504a934c',
    'dist/server/chunks/service-2d0v189r.js': '5b93086bbd250e563f8d26ef04886cbba0d54c07648a8f0ee701362024bc5f00',
    'dist/server/chunks/updater-znh7wsf2.js': 'f1da517de20c1676977d97b6ec217beed9cf9229f2a73cb8c06391035440a484',
    'dist/server/chunks/zip-extractor-pab1707s.js': '9e98db20af7ec12906aa903b03dcf759f872ae3562f9a66d016c3735d9119e3e',
    'dist/server/chunks/manager-8cgd7zv1.js': '9f07730e49575f3a890698b1cf6eb176f1f9e5f38b7f1a6ba2bdcb90b51a7024',
    'dist/server/chunks/index-3g6fcd3f.js': '8990d5e5cba9b429f5a738c16d30fab8b6d21507425a692a696f5ba038fb0757',
    'dist/server/chunks/index-8kttp83n.js': '08219e703edd27c350fb83950c20025669167fc637a559b4efd40d914ae8e08d',
    'dist/server/chunks/index-s0vbebwq.js': '76e42fe50a52ec9067150f8ebb1a33e4b4ea8234e154fba8192926ed7c439c41',
    'dist/server/chunks/history-bxfwpnw9.js': 'ca64715b024344e4c925f0aa52950d48076a569db3f64252a77beb066bec6cd8',
    'dist/server/chunks/index-athscynt.js': '38ee08773ff1c122f7d7ce5f92d9b237a369ad7151915a1efd73bb072cd3782f',
    'dist/server/chunks/interview-bridge-c2m8w0c6.js': 'ddb2f18ba6b99f6f9d424db488cd1f2487d3687054462784d65be1f1967045f7',
  },
};

const IDX_307 = 'dist/index.js';
const SRV_307 = 'dist/server/index.js';
const ZCHUNK_307 = 'dist/chunks/index-z19vm7mg.js';
const WCHUNK_307 = 'dist/server/chunks/index-wsvbb4qp.js';

// 3.0.7 migrates the 42 effective 3.0.6 patches: 37 carried (some with
// re-variations for the de-shadowed options/record scope or re-anchored onto
// rewritten upstream sites), 5 retired with upstream paths that no longer
// exist (readonly-result-delivery/tracked-call/current-call with the
// readonlyTerminalResult fallback upstream removed — disposed plugins now
// throw pluginDisposedMessage(); read-settlement-contrast/blocked per Oracle
// ruling, because 3.0.7 natively attaches and consumes the read settlement
// retryAfter), and native-terminal-reconcile was re-anchored plus split into
// site A (foreground) and site B (structured launch registration, which the
// v2 wrapper bypasses site A to reach) — each an equal head+tail pair under
// the Oracle narrow stale-only re-observation strategy. Applications are
// exact unique anchors per module — no fuzzy matching, no fallbacks, and no
// no-op filler applications: every listed application transforms real bytes.
const PATCHES_3_0_7 = [
  // --- entry modules: dist/index.js + dist/server/index.js (de-shadowed in
  // 3.0.7: both use plain options/record, so one unified text serves both).
  {
    id: 'hook-deps-wiring',
    purpose: 'Pass the plugin directory into the task-session-manager hook.',
    modules: [IDX_307, SRV_307],
    anchor: `"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {
      shouldManageSession:`,
    replacement: `"tool.execute.before": (input, output) => handleToolExecuteBefore(input, output, {
      directory: _ctx.directory,
      shouldManageSession:`,
  },
  {
    id: 'native-dispatch-now',
    purpose: 'Record the dispatch time of a native foreground task call; its terminal observation window must start at dispatch, not after the already-completed assistant.',
    modules: [IDX_307, SRV_307],
    anchor: `lifecycleEpoch: deps.getLifecycleEpoch?.() ?? 0,
    releaseLease:`,
    replacement: `lifecycleEpoch: deps.getLifecycleEpoch?.() ?? 0,
    nativeCallStartedAt: Date.now(),
    releaseLease:`,
  },
  {
    id: 'register-launch-now',
    purpose: 'Register the native launch with the dispatch-time clock so the terminal classifier attributes the new result to this run.',
    modules: [IDX_307, SRV_307],
    anchor: `return deps.backgroundJobBoard.registerLaunch({
      taskID,
      parentSessionID: pending.parentSessionId,`,
    replacement: `return deps.backgroundJobBoard.registerLaunch({
      taskID,
      now: pending.nativeCallStartedAt,
      parentSessionID: pending.parentSessionId,`,
  },
  {
    id: 'native-terminal-reconcile',
    purpose: 'Site A (foreground handleToolExecuteBefore) pair head: bind the native output signal so the paired loop can re-observe a superseded activity token through the SAME terminal gate (bounded ≤2), narrowed per Oracle ruling to stale from same-round activity/episode drift; deferred stays entirely with the gate. Re-anchored for 3.0.7 through callID: pending.callId to disambiguate the structured-launch reconcile call.',
    modules: [IDX_307, SRV_307],
    anchor: `await deps.terminalGate.reconcile(record, {
        kind: "output",
        status,
        origin: {
          kind: "native",
          run: record,
          callID: pending.callId,`,
    replacement: `const nativeSignal = {
        kind: "output",
        status,
        origin: {
          kind: "native",
          run: record,
          callID: pending.callId,`,
  },
  {
    id: 'native-terminal-reconcile-loop',
    purpose: 'Site A pair tail: freeze the pre-reconcile observation via the original gate (deps.terminalGate.capture) and replay at most twice on stale only — each replay explicitly refuses when deps.terminalGate.hasGivenUp(observed) is set, then re-captures through the same gate and requires task, generation, baselineMessageID, promptMessageID, attemptRevision, attemptStartedAt and terminalRevision to equal the frozen baseline; activity/episode drift is allowed and deferred is left to the gate. A missing capture snapshot stops the replay, never substitutes defaults.',
    modules: [IDX_307, SRV_307],
    anchor: `callIDConfirmed: exactCallConfirmed
        }
      });
      const current = deps.backgroundJobBoard.get(status.taskID);`,
    replacement: `callIDConfirmed: exactCallConfirmed
        }
      };
      const nativeBaseline = deps.terminalGate.capture(record);
      let reconciliation = await deps.terminalGate.reconcile(record, nativeSignal);
      for (let attempt = 0; nativeBaseline && reconciliation?.kind === "stale" && attempt < 2; attempt++) {
        const observed = deps.backgroundJobBoard.get(record.taskID);
        if (!exactCallConfirmed || observed?.generation !== record.generation || observed.state !== "running" || observed.cancellationRequested || deps.terminalGate.hasGivenUp(observed)) break;
        const observation = deps.terminalGate.capture(observed);
        if (!observation || observation.taskID !== nativeBaseline.taskID || observation.generation !== nativeBaseline.generation || observation.baselineMessageID !== nativeBaseline.baselineMessageID || observation.promptMessageID !== nativeBaseline.promptMessageID || observation.attemptRevision !== nativeBaseline.attemptRevision || observation.attemptStartedAt !== nativeBaseline.attemptStartedAt || observation.terminalRevision !== nativeBaseline.terminalRevision) break;
        reconciliation = await deps.terminalGate.reconcile(observed, nativeSignal);
      }
      const current = deps.backgroundJobBoard.get(status.taskID);`,
  },
  {
    id: 'native-terminal-reconcile-structured',
    purpose: 'Site B (registerDelegatedLaunchFromStructured late-terminal registration) pair head: bind the structured launch output signal for the same stale-only re-observation; the v2 wrapper bypasses site A, so site B carries the identical strategy per Oracle ruling.',
    modules: [IDX_307, SRV_307],
    anchor: `    if (input.state !== "running") {
      await deps.terminalGate.reconcile(record, {
        kind: "output",
        status: {
          taskID: input.childTaskID,`,
    replacement: `    if (input.state !== "running") {
      const structuredSignal = {
        kind: "output",
        status: {
          taskID: input.childTaskID,`,
  },
  {
    id: 'native-terminal-reconcile-structured-loop',
    purpose: 'Site B pair tail: freeze the pre-reconcile observation via the original gate (deps.terminalGate.capture) and replay at most twice on stale only — each replay explicitly refuses when deps.terminalGate.hasGivenUp(observed) is set (input.exactCallConfirmed gates entry), then re-captures through the same gate and requires task, generation, baselineMessageID, promptMessageID, attemptRevision, attemptStartedAt and terminalRevision to equal the frozen baseline; activity/episode drift is allowed and deferred is left to the gate. A missing capture snapshot stops the replay, never substitutes defaults.',
    modules: [IDX_307, SRV_307],
    anchor: `          callID: input.callID,
          callIDConfirmed: input.exactCallConfirmed
        }
      });
    }
    return record;`,
    replacement: `          callID: input.callID,
          callIDConfirmed: input.exactCallConfirmed
        }
      };
      const structuredBaseline = deps.terminalGate.capture(record);
      let structuredReconciliation = await deps.terminalGate.reconcile(record, structuredSignal);
      for (let attempt = 0; structuredBaseline && structuredReconciliation?.kind === "stale" && attempt < 2; attempt++) {
        const observed = deps.backgroundJobBoard.get(record.taskID);
        if (!input.exactCallConfirmed || observed?.generation !== record.generation || observed.state !== "running" || observed.cancellationRequested || deps.terminalGate.hasGivenUp(observed)) break;
        const observation = deps.terminalGate.capture(observed);
        if (!observation || observation.taskID !== structuredBaseline.taskID || observation.generation !== structuredBaseline.generation || observation.baselineMessageID !== structuredBaseline.baselineMessageID || observation.promptMessageID !== structuredBaseline.promptMessageID || observation.attemptRevision !== structuredBaseline.attemptRevision || observation.attemptStartedAt !== structuredBaseline.attemptStartedAt || observation.terminalRevision !== structuredBaseline.terminalRevision) break;
        structuredReconciliation = await deps.terminalGate.reconcile(observed, structuredSignal);
      }
    }
    return record;`,
  },
  {
    id: 'foreground-delivery',
    purpose: 'After OMO validates native call ownership and reconciles the terminal generation, attach verified delivery metadata and the reference receipt with a generation/terminal/activity CAS.',
    modules: [IDX_307, SRV_307],
    anchor: `const updated = current?.generation === record.generation ? current : undefined;
      log("[task-session-manager] foreground task status registered",`,
    replacement: `const updated = current?.generation === record.generation ? current : undefined;
      log("[bcp-native-delivery] terminal observation", { taskID: record.taskID, generation: record.generation, verdict: reconciliation?.kind, diagnostic: updated?.lastStatusError });
      if (updated) {
        const metadata = await deliveryMetadata(deps.directory, updated);
        const latest = deps.backgroundJobBoard.get(updated.taskID);
        if (latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision) {
          output.metadata = { ...output.metadata, bcp_delivery: metadata };
          output.output = presentRetainedChildDelivery(output.output, metadata, updated.parentSessionID);
        }
      }
      log("[task-session-manager] foreground task status registered",`,
  },
  {
    id: 'task-result-delivery',
    purpose: 'Read-only result retrieval returns the verified receipt after existing ownership/terminal guards, with a full post-await freshness fence reusing the upstream final-guard primitives: dispose check, both gate.capture tokens present, samePublication(afterDelivery, current), sameObservationEpoch(pre, post), terminalRevision stability and gate.isRetainedObservationBlocked(afterDelivery) — so a relaunch lease acquired during the metadata await refuses via the upstream runningResultRefusal(idParam, taskID, true) path instead of delivering stale completed output; undefined tokens never pass. Re-anchored for 3.0.7 onto the readTaskResult tracked→untracked boundary (plain options scope).',
    modules: [IDX_307, SRV_307],
    anchor: `    return current.resultSummary;
  }
  const read = await readUntrackedEvidence({ input: options.input, readTimeoutMs: options.readTimeoutMs }, taskID, hostInfo);`,
    replacement: `    const preMetadata = gate.capture(current);
    const metadata = await deliveryMetadata(options.input.directory, current);
    const afterDelivery = board.get(taskID);
    const postMetadata = gate.capture(current);
    if (options.isDisposed?.() || !preMetadata || !postMetadata || !afterDelivery || !samePublication(afterDelivery, current) || !sameObservationEpoch(preMetadata, postMetadata) || postMetadata.terminalRevision !== preMetadata.terminalRevision || gate.isRetainedObservationBlocked(afterDelivery))
      return runningResultRefusal(idParam, taskID, true);
    return presentDelivery(current.resultSummary, metadata) + deliverySuffix(metadata);
  }
  const read = await readUntrackedEvidence({ input: options.input, readTimeoutMs: options.readTimeoutMs }, taskID, hostInfo);`,
  },
  {
    id: 'task-result-evidence-delivery',
    purpose: 'Transcript-evidence fallback of task_result keeps the author text and appends the delivery metadata suffix.',
    modules: [IDX_307, SRV_307],
    anchor: `  return completedText;
}
var DIAGNOSTIC_TERMINALS = new Set(["error", "cancelled", "stopped"]);`,
    replacement: `  const metadata = await deliveryMetadata(options.input.directory, { taskID, parentSessionID, state: "completed", bcpOrigin: evidence.bcpOrigin });
  return completedText + deliverySuffix(metadata);
}
var DIAGNOSTIC_TERMINALS = new Set(["error", "cancelled", "stopped"]);`,
  },
  {
    id: 'notify-delivery-metadata',
    purpose: 'Background terminal notifications carry verified delivery metadata; a failed post-await freshness comparison suppresses the notification before presentation and transport.',
    modules: [IDX_307, SRV_307],
    anchor: `const text = [
        \`<task id="\${run.taskID}" state="\${state}">\`,`,
    replacement: `const bcpMetadata = await deliveryMetadata(options.input.directory, record);
      {
        const latest = options.backgroundJobBoard.get(record.taskID);
        if (!latest || latest.generation !== record.generation || latest.terminalRevision !== record.terminalRevision || latest.activityRevision !== record.activityRevision) {
          const superseded = new Error("Execution changed while the terminal notification was inspected; its captured output is stale.");
          superseded.bcpNotificationSuperseded = true;
          throw superseded;
        }
      }
      const text = [
        \`<task id="\${run.taskID}" state="\${state}">\`,`,
  },
  {
    id: 'notify-delivery-body',
    purpose: 'Present the receipt in place of the author body and append the metadata suffix outside the task_result wrapper. Re-anchored for 3.0.7: upstream now falls back to TERMINAL_NOTIFICATIONS fallbackText.',
    modules: [IDX_307, SRV_307],
    anchor: `record.resultSummary ?? fallbackText,
        \`</\${tag}>\`,
        "</task>"`,
    replacement: `presentDelivery(record.resultSummary ?? fallbackText, bcpMetadata),
        \`</\${tag}>\`,
        "</task>",
        deliverySuffix(bcpMetadata)`,
  },
  {
    id: 'injection-state-directory',
    purpose: 'Give the synthetic injection lane the plugin directory for delivery annotation.',
    modules: [IDX_307, SRV_307],
    anchor: `const injectionState = {
    backgroundJobBoard,`,
    replacement: `const injectionState = {
    bcpDirectory: _ctx.directory,
    backgroundJobBoard,`,
  },
  {
    id: 'synthetic-processed-annotate',
    purpose: 'Annotate already-processed injected completions with delivery metadata behind the generation/observation-epoch/deletion fences.',
    modules: [IDX_307, SRV_307],
    anchor: `if (origin?.phase === "processed")
    return;`,
    replacement: `if (origin?.phase === "processed") {
    if (existing && origin.generationAtObservation === existing.generation && (deletionEpoch === undefined || origin.lifecycleEpochAtObservation >= deletionEpoch))
      await annotateDeliveryPart(state.bcpDirectory, part, existing, message.info?.sessionID, () => {
        const latest = state.backgroundJobBoard.get(existing.taskID);
        return latest?.generation === existing.generation && latest.terminalRevision === existing.terminalRevision && latest.activityRevision === existing.activityRevision;
      });
    return;
  }`,
  },
  {
    id: 'synthetic-remembered-annotate',
    purpose: 'Annotate remembered injected completions with delivery metadata behind the same fences.',
    modules: [IDX_307, SRV_307],
    anchor: `if (hasRememberedInjectedCompletion(state, status.taskID, occurrenceId, provenanceKind, existing?.generation)) {
    return;
  }`,
    replacement: `if (hasRememberedInjectedCompletion(state, status.taskID, occurrenceId, provenanceKind, existing?.generation)) {
    const fence = state.injectedCompletionFences?.get(injectedCompletionKey(status.taskID, occurrenceId, provenanceKind));
    if (existing && fence?.generation === existing.generation && (deletionEpoch === undefined || fence.lifecycleEpoch >= deletionEpoch))
      await annotateDeliveryPart(state.bcpDirectory, part, existing, message.info?.sessionID, () => {
        const latest = state.backgroundJobBoard.get(existing.taskID);
        return latest?.generation === existing.generation && latest.terminalRevision === existing.terminalRevision && latest.activityRevision === existing.activityRevision;
      });
    return;
  }`,
  },
  {
    id: 'synthetic-updated-annotate',
    purpose: 'Annotate freshly reconciled injected completions with delivery metadata and a current-record fence.',
    modules: [IDX_307, SRV_307],
    anchor: `  const updated = result.kind === "stale" ? undefined : result.record;
  if (!updated)
    return;
  log("[task-session-manager] processed injected background completion", {`,
    replacement: `  const updated = result.kind === "stale" ? undefined : result.record;
  if (!updated)
    return;
  await annotateDeliveryPart(state.bcpDirectory, part, updated, message.info?.sessionID, () => {
    const latest = state.backgroundJobBoard.get(updated.taskID);
    return latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision;
  });
  log("[task-session-manager] processed injected background completion", {`,
  },
  {
    id: 'revive-unknown-delivery',
    purpose: 'Revive admission-unknown output is annotated with delivery metadata for inspection.',
    modules: [IDX_307, SRV_307],
    anchor: `return renderReviveOutput(idParam, queueContinuation ? launched ?? current : current, true);`,
    replacement: `return renderReviveOutput(idParam, queueContinuation ? launched ?? current : current, true, options.input.directory, options.backgroundJobBoard);`,
  },
  {
    id: 'revive-latest-delivery',
    purpose: 'Revive terminal output is annotated with delivery metadata for inspection.',
    modules: [IDX_307, SRV_307],
    anchor: `return renderReviveOutput(idParam, latest);`,
    replacement: `return renderReviveOutput(idParam, latest, false, options.input.directory, options.backgroundJobBoard);`,
  },
  {
    id: 'revive-render-signature',
    purpose: 'renderReviveOutput accepts the plugin directory and board for verified inspection.',
    modules: [IDX_307, SRV_307],
    anchor: `function renderReviveOutput(idParam, record, admissionUnknown = false) {`,
    replacement: `async function renderReviveOutput(idParam, record, admissionUnknown = false, directory, board) {`,
  },
  {
    id: 'revive-render-delivery',
    purpose: 'Revive output carries the verified receipt; a changed execution degrades to an explicit execution_changed suffix instead of stale text.',
    modules: [IDX_307, SRV_307],
    anchor: `return lines.join(\`
\`);
}
function getCurrentReviveJob`,
    replacement: `const metadata = await deliveryMetadata(directory, admissionUnknown ? { ...record, bcpOrigin: undefined } : record);
  const latest = board?.get(record.taskID);
  if (latest?.generation !== record.generation || latest.terminalRevision !== record.terminalRevision || latest.activityRevision !== record.activityRevision)
    return lines.join("\\n") + deliverySuffix({ ...metadata, association: "unconfirmed", candidates: [], reason: "execution_changed" });
  return presentDelivery(lines.join("\\n"), metadata) + deliverySuffix(metadata);
}
function getCurrentReviveJob`,
  },
  {
    id: 'native-retained-child-delivery',
    purpose: 'Validate the new retained-child suffix against the current owner and execution, compact only exact verified body bytes, and keep the upstream recovery marker authoritative at the tail.',
    modules: [IDX_307, SRV_307],
    anchor: `function formatChildRef(ref) {`,
    replacement: `function presentRetainedChildDelivery(text, metadata, parentSessionID) {
  const ref = readAuthoritativeChildRef(text);
  if (!ref) return presentDelivery(text, metadata) + deliverySuffix(metadata);
  const marker = "\\n" + formatChildRef(ref);
  if (ref.parentSessionID !== parentSessionID || ref.sessionID !== metadata?.execution?.task_id ||
      ref.agent !== metadata?.result_reference?.writer?.agent || !text.endsWith(marker)) return text;
  const original = text.slice(0, -marker.length);
  const close = original.endsWith("</task>") ? "</task>" : original.endsWith("</subagent>") ? "</subagent>" : undefined;
  if (!close) return text;
  const delivered = presentDelivery(original, metadata);
  return delivered.slice(0, -close.length) + deliverySuffix(metadata) + "\\n" + close + marker;
}
function formatChildRef(ref) {`,
  },
  {
    id: 'notify-suppressed-catch',
    purpose: 'A failed post-await freshness comparison suppresses the terminal notification before presentation and transport without scheduling stale retries; lease release and pending-flag cleanup stay in the upstream finally block.',
    modules: [IDX_307, SRV_307],
    anchor: `    } catch (error) {
      log("[revived-run-tracker] notification failed", {
        taskID: run.taskID,
        generation: run.generation,
        parentSessionID: run.parentSessionID,
        attempt,
        timedOut: error instanceof NotificationTransportTimeoutError,
        error: stringifyError(error)
      });
      scheduleNotificationRetry(run, record, notification);
    } finally {`,
    replacement: `    } catch (error) {
      if (error?.bcpNotificationSuperseded) {
        log("[revived-run-tracker] notification suppressed: execution changed during metadata inspection", {
          taskID: run.taskID,
          generation: run.generation,
          parentSessionID: run.parentSessionID,
          attempt
        });
      } else {
        log("[revived-run-tracker] notification failed", {
          taskID: run.taskID,
          generation: run.generation,
          parentSessionID: run.parentSessionID,
          attempt,
          timedOut: error instanceof NotificationTransportTimeoutError,
          error: stringifyError(error)
        });
        scheduleNotificationRetry(run, record, notification);
      }
    } finally {`,
  },
  {
    id: 'notify-currentness-activity',
    purpose: 'Notification currentness includes the board activity revision, so an activity-only change invalidates the send-boundary check, the acceptance callback and the retry guard — no stale output is delivered, marked sent, or re-armed for retry.',
    modules: [IDX_307, SRV_307],
    anchor: `return !disposed && runs.get(run.taskID) === run && run.notification === notification && run.generation === record.generation && run.terminalRevision === record.terminalRevision && current?.generation === record.generation && current.terminalRevision === record.terminalRevision && run.terminalState === record.state && terminalOutcome(current) === record.state;`,
    replacement: `return !disposed && runs.get(run.taskID) === run && run.notification === notification && run.generation === record.generation && run.terminalRevision === record.terminalRevision && current?.generation === record.generation && current.terminalRevision === record.terminalRevision && current?.activityRevision === record.activityRevision && run.terminalState === record.state && terminalOutcome(current) === record.state;`,
  },
  // --- transcript chunks: dist/chunks/index-z19vm7mg.js +
  // dist/server/chunks/index-wsvbb4qp.js (3.0.7 moved the terminal-gate /
  // transcript / shim machinery out of the flat entries into these chunks).
  // Oracle ruling (bb://…/98b8f45b…/e000002): the read-settlement pair
  // (read-settlement-contrast, read-settlement-blocked) is retired for 3.0.7
  // — upstream now attaches the evidence-read settlement natively
  // ({ kind: "blocked", retryAfter: entry.settled }, pendingRuntimeContrast
  // threading + self-scheduled reconcile, entry-side snapshot.retryAfter
  // consumer), and the narrowed reconcile loop below no longer consumes
  // retryAfter. Old-version definitions stay untouched.
  {
    id: 'verdict-origin',
    purpose: 'Carry the terminal classifier’s input/terminal message identity (bcpOrigin) through the completed verdict.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `return { verdict: "completed", text: evidence.text };`,
    replacement: `return { verdict: "completed", text: evidence.text, bcpOrigin: evidence.bcpOrigin };`,
  },
  {
    id: 'classifier-origin',
    purpose: 'Record inputMessageID/terminalMessageID from the terminal assistant message so later receipts can be verified against host identity.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `return text.length > 0 ? { kind: "ready", text } : { kind: "textless" };`,
    replacement: `return text.length > 0 ? { kind: "ready", text, bcpOrigin: { inputMessageID: last.info.parentID, terminalMessageID: last.info.id } } : { kind: "textless" };`,
  },
  {
    id: 'shim-user-text-and-parentid',
    purpose: 'Keep upstream 3.0.3 message mapping intact and bind an assistant without parentID to the preceding real user, without inventing an ID when the input is unavailable.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `var warnedListUnavailable = false;`,
    replacement: `function toV1Transcript(messages2) {
  const mapped = [];
  let inputID;
  for (const entry of messages2) {
    const message = toV1Message(entry);
    if (message.info.role === "user")
      inputID = message.info.id;
    else if (message.info.role === "assistant" && message.info.parentID === undefined && typeof inputID === "string")
      message.info.parentID = inputID;
    mapped.push(message);
  }
  return mapped;
}
var warnedListUnavailable = false;`,
  },
  {
    id: 'shim-context-transcript-identity',
    purpose: 'Bind each transcript message to its real run input through the ordered host context — the exact path fetchChildTranscript reads on real v2 hosts (client.session.messages is always shim-provided there, so a client.message.list fallback can never run).',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `              data: history.reverse().map(toV1Message),`,
    replacement: `              data: toV1Transcript(history.reverse()),`,
  },
  {
    id: 'shim-paged-transcript-identity',
    purpose: 'Apply the same input binding to the paginated transcript path after the desc page is rebuilt ascending. Re-anchored for 3.0.7: upstream uses plain isRecord here.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `              data: page.data.slice().reverse().map((message) => toV1Message(isRecord(message) ? message : { type: "unknown" }))`,
    replacement: `              data: toV1Transcript(page.data.slice().reverse().map((message) => isRecord(message) ? message : { type: "unknown" }))`,
  },
  {
    id: 'commit-signature',
    purpose: 'Thread bcpOrigin through the terminal-gate commit.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `function commit(token, state, text, lease, attribution = "event", hostOutcomeRead) {`,
    replacement: `function commit(token, state, text, lease, attribution = "event", hostOutcomeRead, bcpOrigin) {`,
  },
  {
    id: 'commit-store-origin',
    purpose: 'Store bcpOrigin on the board record at commit time.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `resultSummary: text,
      cancellationLease: lease,`,
    replacement: `resultSummary: text,
      bcpOrigin,
      cancellationLease: lease,`,
  },
  {
    id: 'commit-transcript-origin',
    purpose: 'Commit transcript-attributed evidence with its message identity. Re-anchored for 3.0.7: the inspect commit now destructures transcriptOutcome(evidence) into state/text.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `      return commit(token, state, text, undefined, "transcript", terminalOutcome);`,
    replacement: `      return commit(token, state, text, undefined, "transcript", terminalOutcome, evidence.bcpOrigin);`,
  },
  {
    id: 'clear-origin-reconciled',
    purpose: 'Drop stale bcpOrigin when a reconciled record is cleared.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `resultSummary: undefined,
        lastStatusError: undefined,`,
    replacement: `resultSummary: undefined,
        bcpOrigin: undefined,
        lastStatusError: undefined,`,
  },
  {
    id: 'clear-origin-failed',
    purpose: 'Drop stale bcpOrigin when a failed record is cleared.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `resultSummary: undefined,
      lastStatusError:`,
    replacement: `resultSummary: undefined,
      bcpOrigin: undefined,
      lastStatusError:`,
  },
  {
    id: 'update-origin-merge',
    purpose: 'Merge bcpOrigin on record updates so identity survives activity revisions.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `resultSummary: input.resultSummary ?? existing.resultSummary,
      lastStatusError:`,
    replacement: `resultSummary: input.resultSummary ?? existing.resultSummary,
      bcpOrigin: input.bcpOrigin ?? existing.bcpOrigin,
      lastStatusError:`,
  },
  {
    id: 'commit-queued-transcript-origin',
    purpose: 'Carry the exact queued prompt/terminal identity through the inspectQueuedAnswer commit, independently of the ordinary completion path. Re-anchored for 3.0.7: the queued commit now uses the destructured state/text.',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `    return commit(token, state, text, undefined, "transcript");`,
    replacement: `    return commit(token, state, text, undefined, "transcript", undefined, evidence.bcpOrigin);`,
  },
  {
    id: 'shim-context-tail-transcript-identity',
    purpose: 'Bind each tail-sliced transcript message to its real run input through the ordered host context (3.0.6 split the context shim return).',
    modules: [ZCHUNK_307, WCHUNK_307],
    anchor: `            data: tail.map(toV1Message),`,
    replacement: `            data: toV1Transcript(tail),`,
  },
  // --- agent pin trio: real patches in the server entry only (the setup
  // instances and registry projection live there; the index closure needs no
  // change, so these patches list no index application).
  {
    id: 'native-explicit-pin-retain',
    purpose: 'Retain live nonempty native system/mode after the setup instance first writes its projection, without caching field values; cleared fields fall back to that projection. OMO model/variant/permissions and v1 bytes remain unchanged. Server entry only.',
    modules: [SRV_307],
    anchor: `function applyAgentToDraft(draft, name, v1, compiledPermissions) {
  const model = parseModelRef(v1.model);
  draft.update(name, (agent) => {
    agent.id = name;
    agent.name = name;
    agent.mode = v1.mode ?? (name === "orchestrator" ? "primary" : "subagent");
    agent.hidden = v1.hidden === true;
    if (typeof v1.description === "string")
      agent.description = v1.description;
    if (typeof v1.color === "string")
      agent.color = v1.color;
    if (typeof v1.prompt === "string")
      agent.system = v1.prompt;`,
    replacement: `function applyAgentToDraft(draft, name, v1, compiledPermissions, nativeAgentWrites) {
  const model = parseModelRef(v1.model);
  draft.update(name, (agent) => {
    const projectedSystem = typeof v1.prompt === "string" ? v1.prompt : undefined;
    const projectedMode = v1.mode ?? (name === "orchestrator" ? "primary" : "subagent");
    const written = nativeAgentWrites.has(name);
    const nativeSystem = written && typeof agent.system === "string" && agent.system.length > 0 ? agent.system : undefined;
    const nativeMode = written && typeof agent.mode === "string" && agent.mode.length > 0 ? agent.mode : undefined;
    agent.id = name;
    agent.name = name;
    agent.mode = nativeMode ?? projectedMode;
    agent.hidden = v1.hidden === true;
    if (typeof v1.description === "string")
      agent.description = v1.description;
    if (typeof v1.color === "string")
      agent.color = v1.color;
    const explicitSystem = nativeSystem ?? projectedSystem;
    if (explicitSystem !== undefined)
      agent.system = explicitSystem;
    nativeAgentWrites.add(name);`,
  },
  {
    id: 'native-pin-instance-state',
    purpose: 'Own first-write tracking inside each v2 setup instance; no module-global pin cache or cross-project state. Server entry only.',
    modules: [SRV_307],
    anchor: `      let finalizedRegistry;`,
    replacement: `      const nativeAgentWrites = new Set();
      let finalizedRegistry;`,
  },
  {
    id: 'native-pin-instance-call',
    purpose: 'Pass the setup-local first-write set to each registry projection write. Server entry only.',
    modules: [SRV_307],
    anchor: `          applyAgentToDraft(draft, name, cfg, registry.nativePolicies[name]?.rules);`,
    replacement: `          applyAgentToDraft(draft, name, cfg, registry.nativePolicies[name]?.rules, nativeAgentWrites);`,
  },
];

const OMO_307_ENTRY_MODULES = { index: IDX_307, server: SRV_307 };

// Modules whose patched bodies reference the delivery helper. Only the two
// entry modules do; the patched chunks use only in-module symbols.
const OMO_307_HELPER_IMPORT_MODULES = new Set([IDX_307, SRV_307]);

function omo307Applications(patch) {
  return patch.applications ?? patch.modules.map(path => ({ path, anchor: patch.anchor, replacement: patch.replacement }));
}

/**
 * Patch the OMO 3.0.7 multi-module dist. `modules` maps every module of the
 * selected entry's reachable closure (package-relative POSIX paths) to its
 * exact upstream source; keys must equal OMO_307_MODULES[entry]'s key set and
 * every digest must match before any replacement happens. Returns the patched
 * Map and the flat patch report [{id, path, purpose}].
 */
export function patchOmo307(modules, entry) {
  const expected = OMO_307_MODULES[entry];
  if (!expected) {
    throw new Error('Unsupported OMO 3.0.7 entry: ' + entry + ' (expected index or server)');
  }
  if (!(modules instanceof Map)) {
    throw new Error('patchOmo307 expects modules as a Map<packageRelativePath, source>, got ' + (modules === null ? 'null' : typeof modules));
  }
  const expectedKeys = Object.keys(expected);
  const actualKeys = [...modules.keys()];
  const missing = expectedKeys.filter(key => !modules.has(key));
  const extra = actualKeys.filter(key => !expected[key]);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error('OMO 3.0.7 ' + entry + ' module set mismatch; missing: [' + missing.join(', ') + '] unexpected: [' + extra.join(', ') + ']' +
      ' — pass exactly the entry\'s reachable module closure as keyed by OMO_307_MODULES.' + entry);
  }
  // Phase 1: verify every digest before touching anything.
  for (const key of expectedKeys) {
    const source = modules.get(key);
    assert.equal(typeof source, 'string', 'OMO 3.0.7 module ' + key + ' source must be a string');
    const digest = createHash('sha256').update(source).digest('hex');
    assert.equal(digest, expected[key], 'OMO 3.0.7 ' + entry + ' upstream digest mismatch for ' + key);
  }
  // Phase 2: compute all patched sources (anchor assertions happen here,
  // before any writeback).
  const patched = new Map();
  const report = [];
  for (const key of expectedKeys) {
    patched.set(key, modules.get(key));
  }
  for (const key of expectedKeys) {
    let source = patched.get(key);
    function once(before, after) {
      assert.equal(source.split(before).length, 2, 'OMO patch anchor is not unique in ' + key + ': ' + before.slice(0, 90));
      source = source.replace(before, after);
    }
    for (const patch of PATCHES_3_0_7) {
      for (const application of omo307Applications(patch)) {
        if (application.path !== key) continue;
        once(application.anchor, application.replacement);
        report.push({ id: patch.id, path: key, purpose: patch.purpose });
      }
    }
    if (OMO_307_HELPER_IMPORT_MODULES.has(key)) {
      const depth = key.split('/').length - 1;
      source = 'import { deliveryMetadata, deliverySuffix, annotateDeliveryPart, presentDelivery } from "' + '../'.repeat(depth) + 'omo-delivery.mjs";\n' + source;
    }
    patched.set(key, source);
  }
  // Phase 3: writeback.
  for (const [key, source] of patched) {
    modules.set(key, source);
  }
  return { modules, patches: report };
}

export function describeOmoPatches(version) {
  if (version === '3.0.1') return PATCHES_3_0_1.map(({id, purpose}) => ({id, purpose}));
  if (version === '3.0.3') return PATCHES_3_0_3.map(({id, purpose}) => ({id, purpose}));
  if (version === '3.0.4') return PATCHES_3_0_4.map(({id, purpose}) => ({id, purpose}));
  if (version === '3.0.5') return PATCHES_3_0_5.map(({id, purpose}) => ({id, purpose}));
  if (version === '3.0.6') return PATCHES_3_0_6.map(({id, purpose}) => ({id, purpose}));
  if (version === '3.0.7') return PATCHES_3_0_7.map(patch => ({
    id: patch.id,
    purpose: patch.purpose,
    modules: [...new Set(omo307Applications(patch).map(application => application.path))],
  }));
  if (version === '2.2.25') return [{id: 'legacy-2.2.25', purpose: 'Full 2.2.25 patch set (rollback-compatible legacy path).'}];
  throw new Error('Unsupported OMO version: ' + version);
}

function patchOmo3(original, version, entry) {
  const expected = OMO_TARGETS[version].entries[entry];
  assert.equal(createHash('sha256').update(original).digest('hex'), expected, 'OMO ' + version + ' ' + entry + ' upstream digest mismatch');
  let source = original;
  function once(before, after) {
    assert.equal(source.split(before).length, 2, 'OMO patch anchor is not unique: ' + before.slice(0, 90));
    source = source.replace(before, after);
  }
  // Upstream Council procedure text (steps 1–5) is intentionally left untouched:
  // 3.0.1 keeps upstream Council byte-identical, no private agenda is spliced in.
  for (const patch of version === '3.0.6' ? PATCHES_3_0_6 : version === '3.0.5' ? PATCHES_3_0_5 : version === '3.0.4' ? PATCHES_3_0_4 : version === '3.0.3' ? PATCHES_3_0_3 : PATCHES_3_0_1) {
    once(pick(patch.anchor, entry), pick(patch.replacement, entry));
  }
  return DELIVERY_IMPORT + source;
}

/**
 * Patch any supported OMO upstream source. Auto-detects version+entry from the
 * exact SHA-256; pass {version, entry} to assert a specific target. Unknown
 * content always throws — never patch fuzzily.
 */
export function patchOmo(original, options = {}) {
  const digest = createHash('sha256').update(original).digest('hex');
  const detected = omoTargetFor(digest);
  if (detected?.version === '3.0.7') {
    throw new Error('OMO 3.0.7 moved to a multi-module dist layout and cannot be patched from a single bundle. ' +
      'Build a Map of {packageRelativePath: source} holding exactly the reachable module closure of the ' + detected.entry +
      ' entry (keys per OMO_307_MODULES.' + detected.entry + ') and call patchOmo307(modules, \'' + detected.entry + '\').');
  }
  if (!detected) {
    throw new Error('Unsupported oh-my-opencode-slim source (sha256 ' + digest + '); supported: ' +
      Object.entries(OMO_TARGETS).map(([v, t]) => v + '(' + Object.keys(t.entries).join('/') + ')').join(', '));
  }
  if (options.version && options.version !== detected.version) {
    throw new Error('OMO source is ' + detected.version + ' but ' + options.version + ' was requested');
  }
  if (options.entry && options.entry !== detected.entry) {
    throw new Error('OMO ' + detected.version + ' source is the ' + detected.entry + ' entry but ' + options.entry + ' was requested');
  }
  if (detected.version === '2.2.25') return patchOmo2_2_25(original);
  return patchOmo3(original, detected.version, detected.entry);
}
