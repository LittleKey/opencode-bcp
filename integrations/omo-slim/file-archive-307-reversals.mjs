// Exact repo-added presentation patches, copied for explicit inverse application.
// Full original and patched module validation precedes their use. No fuzzy matching.
export const FILE_ARCHIVE_307_REVERSALS = [
  {
    "id": "foreground-delivery",
    "anchor": "const updated = current?.generation === record.generation ? current : undefined;\n      log(\"[task-session-manager] foreground task status registered\",",
    "replacement": "const updated = current?.generation === record.generation ? current : undefined;\n      log(\"[bcp-native-delivery] terminal observation\", { taskID: record.taskID, generation: record.generation, verdict: reconciliation?.kind, diagnostic: updated?.lastStatusError });\n      if (updated) {\n        const metadata = await deliveryMetadata(deps.directory, updated);\n        const latest = deps.backgroundJobBoard.get(updated.taskID);\n        if (latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision) {\n          output.metadata = { ...output.metadata, bcp_delivery: metadata };\n          output.output = presentRetainedChildDelivery(output.output, metadata, updated.parentSessionID);\n        }\n      }\n      log(\"[task-session-manager] foreground task status registered\",",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "task-result-delivery",
    "anchor": "    return current.resultSummary;\n  }\n  const read = await readUntrackedEvidence({ input: options.input, readTimeoutMs: options.readTimeoutMs }, taskID, hostInfo);",
    "replacement": "    const preMetadata = gate.capture(current);\n    const metadata = await deliveryMetadata(options.input.directory, current);\n    const afterDelivery = board.get(taskID);\n    const postMetadata = gate.capture(current);\n    if (options.isDisposed?.() || !preMetadata || !postMetadata || !afterDelivery || !samePublication(afterDelivery, current) || !sameObservationEpoch(preMetadata, postMetadata) || postMetadata.terminalRevision !== preMetadata.terminalRevision || gate.isRetainedObservationBlocked(afterDelivery))\n      return runningResultRefusal(idParam, taskID, true);\n    return presentDelivery(current.resultSummary, metadata) + deliverySuffix(metadata);\n  }\n  const read = await readUntrackedEvidence({ input: options.input, readTimeoutMs: options.readTimeoutMs }, taskID, hostInfo);",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "task-result-evidence-delivery",
    "anchor": "  return completedText;\n}\nvar DIAGNOSTIC_TERMINALS = new Set([\"error\", \"cancelled\", \"stopped\"]);",
    "replacement": "  const metadata = await deliveryMetadata(options.input.directory, { taskID, parentSessionID, state: \"completed\", bcpOrigin: evidence.bcpOrigin });\n  return completedText + deliverySuffix(metadata);\n}\nvar DIAGNOSTIC_TERMINALS = new Set([\"error\", \"cancelled\", \"stopped\"]);",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "notify-delivery-metadata",
    "anchor": "const text = [\n        `<task id=\"${run.taskID}\" state=\"${state}\">`,",
    "replacement": "const bcpMetadata = await deliveryMetadata(options.input.directory, record);\n      {\n        const latest = options.backgroundJobBoard.get(record.taskID);\n        if (!latest || latest.generation !== record.generation || latest.terminalRevision !== record.terminalRevision || latest.activityRevision !== record.activityRevision) {\n          const superseded = new Error(\"Execution changed while the terminal notification was inspected; its captured output is stale.\");\n          superseded.bcpNotificationSuperseded = true;\n          throw superseded;\n        }\n      }\n      const text = [\n        `<task id=\"${run.taskID}\" state=\"${state}\">`,",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "notify-delivery-body",
    "anchor": "record.resultSummary ?? fallbackText,\n        `</${tag}>`,\n        \"</task>\"",
    "replacement": "presentDelivery(record.resultSummary ?? fallbackText, bcpMetadata),\n        `</${tag}>`,\n        \"</task>\",\n        deliverySuffix(bcpMetadata)",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "injection-state-directory",
    "anchor": "const injectionState = {\n    backgroundJobBoard,",
    "replacement": "const injectionState = {\n    bcpDirectory: _ctx.directory,\n    backgroundJobBoard,",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "synthetic-processed-annotate",
    "anchor": "if (origin?.phase === \"processed\")\n    return;",
    "replacement": "if (origin?.phase === \"processed\") {\n    if (existing && origin.generationAtObservation === existing.generation && (deletionEpoch === undefined || origin.lifecycleEpochAtObservation >= deletionEpoch))\n      await annotateDeliveryPart(state.bcpDirectory, part, existing, message.info?.sessionID, () => {\n        const latest = state.backgroundJobBoard.get(existing.taskID);\n        return latest?.generation === existing.generation && latest.terminalRevision === existing.terminalRevision && latest.activityRevision === existing.activityRevision;\n      });\n    return;\n  }",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "synthetic-remembered-annotate",
    "anchor": "if (hasRememberedInjectedCompletion(state, status.taskID, occurrenceId, provenanceKind, existing?.generation)) {\n    return;\n  }",
    "replacement": "if (hasRememberedInjectedCompletion(state, status.taskID, occurrenceId, provenanceKind, existing?.generation)) {\n    const fence = state.injectedCompletionFences?.get(injectedCompletionKey(status.taskID, occurrenceId, provenanceKind));\n    if (existing && fence?.generation === existing.generation && (deletionEpoch === undefined || fence.lifecycleEpoch >= deletionEpoch))\n      await annotateDeliveryPart(state.bcpDirectory, part, existing, message.info?.sessionID, () => {\n        const latest = state.backgroundJobBoard.get(existing.taskID);\n        return latest?.generation === existing.generation && latest.terminalRevision === existing.terminalRevision && latest.activityRevision === existing.activityRevision;\n      });\n    return;\n  }",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "synthetic-updated-annotate",
    "anchor": "  const updated = result.kind === \"stale\" ? undefined : result.record;\n  if (!updated)\n    return;\n  log(\"[task-session-manager] processed injected background completion\", {",
    "replacement": "  const updated = result.kind === \"stale\" ? undefined : result.record;\n  if (!updated)\n    return;\n  await annotateDeliveryPart(state.bcpDirectory, part, updated, message.info?.sessionID, () => {\n    const latest = state.backgroundJobBoard.get(updated.taskID);\n    return latest?.generation === updated.generation && latest.terminalRevision === updated.terminalRevision && latest.activityRevision === updated.activityRevision;\n  });\n  log(\"[task-session-manager] processed injected background completion\", {",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "revive-unknown-delivery",
    "anchor": "return renderReviveOutput(idParam, queueContinuation ? launched ?? current : current, true);",
    "replacement": "return renderReviveOutput(idParam, queueContinuation ? launched ?? current : current, true, options.input.directory, options.backgroundJobBoard);",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "revive-latest-delivery",
    "anchor": "return renderReviveOutput(idParam, latest);",
    "replacement": "return renderReviveOutput(idParam, latest, false, options.input.directory, options.backgroundJobBoard);",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "revive-render-signature",
    "anchor": "function renderReviveOutput(idParam, record, admissionUnknown = false) {",
    "replacement": "async function renderReviveOutput(idParam, record, admissionUnknown = false, directory, board) {",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "revive-render-delivery",
    "anchor": "return lines.join(`\n`);\n}\nfunction getCurrentReviveJob",
    "replacement": "const metadata = await deliveryMetadata(directory, admissionUnknown ? { ...record, bcpOrigin: undefined } : record);\n  const latest = board?.get(record.taskID);\n  if (latest?.generation !== record.generation || latest.terminalRevision !== record.terminalRevision || latest.activityRevision !== record.activityRevision)\n    return lines.join(\"\\n\") + deliverySuffix({ ...metadata, association: \"unconfirmed\", candidates: [], reason: \"execution_changed\" });\n  return presentDelivery(lines.join(\"\\n\"), metadata) + deliverySuffix(metadata);\n}\nfunction getCurrentReviveJob",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "native-retained-child-delivery",
    "anchor": "function formatChildRef(ref) {",
    "replacement": "function presentRetainedChildDelivery(text, metadata, parentSessionID) {\n  const ref = readAuthoritativeChildRef(text);\n  if (!ref) return presentDelivery(text, metadata) + deliverySuffix(metadata);\n  const marker = \"\\n\" + formatChildRef(ref);\n  if (ref.parentSessionID !== parentSessionID || ref.sessionID !== metadata?.execution?.task_id ||\n      ref.agent !== metadata?.result_reference?.writer?.agent || !text.endsWith(marker)) return text;\n  const original = text.slice(0, -marker.length);\n  const close = original.endsWith(\"</task>\") ? \"</task>\" : original.endsWith(\"</subagent>\") ? \"</subagent>\" : undefined;\n  if (!close) return text;\n  const delivered = presentDelivery(original, metadata);\n  return delivered.slice(0, -close.length) + deliverySuffix(metadata) + \"\\n\" + close + marker;\n}\nfunction formatChildRef(ref) {",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  },
  {
    "id": "notify-suppressed-catch",
    "anchor": "    } catch (error) {\n      log(\"[revived-run-tracker] notification failed\", {\n        taskID: run.taskID,\n        generation: run.generation,\n        parentSessionID: run.parentSessionID,\n        attempt,\n        timedOut: error instanceof NotificationTransportTimeoutError,\n        error: stringifyError(error)\n      });\n      scheduleNotificationRetry(run, record, notification);\n    } finally {",
    "replacement": "    } catch (error) {\n      if (error?.bcpNotificationSuperseded) {\n        log(\"[revived-run-tracker] notification suppressed: execution changed during metadata inspection\", {\n          taskID: run.taskID,\n          generation: run.generation,\n          parentSessionID: run.parentSessionID,\n          attempt\n        });\n      } else {\n        log(\"[revived-run-tracker] notification failed\", {\n          taskID: run.taskID,\n          generation: run.generation,\n          parentSessionID: run.parentSessionID,\n          attempt,\n          timedOut: error instanceof NotificationTransportTimeoutError,\n          error: stringifyError(error)\n        });\n        scheduleNotificationRetry(run, record, notification);\n      }\n    } finally {",
    "modules": [
      "dist/index.js",
      "dist/server/index.js"
    ]
  }
];
