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
export const helperImportsFor = version =>
  version === '2.2.25' ? ['../omo-delivery.mjs', '../omo-council.mjs'] : ['../omo-delivery.mjs'];

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

export function describeOmoPatches(version) {
  if (version === '3.0.1') return PATCHES_3_0_1.map(({id, purpose}) => ({id, purpose}));
  if (version === '3.0.3') return PATCHES_3_0_3.map(({id, purpose}) => ({id, purpose}));
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
  for (const patch of version === '3.0.3' ? PATCHES_3_0_3 : PATCHES_3_0_1) {
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
