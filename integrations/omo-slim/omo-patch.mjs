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
      if (updated) {
        const metadata = await deliveryMetadata(deps.directory, updated);
        const latest = deps.backgroundJobBoard.get(updated.taskID);
        if (latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision) {
          output.metadata = { ...output.metadata, bcp_delivery: metadata };
          output.output += deliverySuffix(metadata);
        }
      }
      log("[task-session-manager] foreground task status registered",`);
  // Read-only result retrieval, after existing ownership / terminal guards, with a fresh CAS after inspection.
  once('return current.resultSummary;\n        }\n        snapshot = await getRuntimeSessionStatusSnapshot(options.input);',
    `const metadata = await deliveryMetadata(options.input.directory, current);
          const afterDelivery = board.get(taskID);
          if (afterDelivery?.generation !== current.generation || afterDelivery.terminalRevision !== current.terminalRevision || afterDelivery.activityRevision !== current.activityRevision)
            throw new Error("Task changed while delivery metadata was inspected; retrieve its current result.");
          return current.resultSummary + deliverySuffix(metadata);
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
    'record.resultSummary ?? (state === "completed" ? "Completed." : "Failed."),\n        `</${tag}>`,\n        "</task>",\n        deliverySuffix(bcpMetadata)');
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
  return lines.join("\\n") + deliverySuffix(metadata);
}
function getCurrentReviveJob`);
  return 'import { deliveryMetadata, deliverySuffix, annotateDeliveryPart } from "../omo-delivery.mjs";\n' + source;
}
