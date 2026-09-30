import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Narrow changes to pinned OMO 2.2.25. Preserve leases, lifecycle, raw author text and gate decisions.
export function patchOmo(original) {
  assert.equal(createHash('sha256').update(original).digest('hex'), '1a8a7a69db029f1c0fea19c4c8ded674281a8e674bedf72b4c8380e0b6de6e1f');
  let source = original;
  function once(before, after) {
    assert.equal(source.split(before).length, 2, 'OMO patch anchor is not unique: ' + before.slice(0, 90));
    source = source.replace(before, after);
  }
  const councilStart = source.indexOf('1. If the question references an external resource (PR, URL, issue, doc)');
  const councilEnd = source.indexOf('5. Present the council\'s synthesized report.', councilStart);
  assert(councilStart >= 0 && councilEnd > councilStart, 'Council procedure anchors missing');
  source = source.slice(0, councilStart) + `1. Resolve required external material into authorized readable source artifacts first, using the appropriate specialist. Give seats exact source locations and necessary original excerpts, not a rewritten conclusion. Mark unavailable material explicitly.
2. Dispatch the same question and evidence boundary independently to each configured seat in PARALLEL via \${vocab.tool}():
\${dispatchList}
3. Collect the actual ses_* task IDs or standard cou-N aliases and completion states. Respect the task budget; report failed, empty or unfinished seats explicitly. Do not replace a missing opinion or retry just to manufacture agreement.
4. Call \${vocab.tool}(\${vocab.agentParam}='council', description='Synthesize council report') with the original question and the explicit seat task IDs or aliases. Do not copy or paraphrase their responses and do not claim their model identities yourself. The host will attach bounded, verified original replies and actual provenance; unavailable or oversized evidence remains a visible gap.
` + source.slice(councilEnd);
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
  return 'import { deliveryMetadata, deliverySuffix, annotateDeliveryPart, presentDelivery } from "../omo-delivery.mjs";\nimport { prepareCouncilPrompt } from "../omo-council.mjs";\n' + source;
}
