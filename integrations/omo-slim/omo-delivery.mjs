// Bounded, read-only host bridge. Errors never trigger model requests or change task state.
const BRIDGE = Symbol.for('opencode.bcp.delivery.v1');
export async function deliveryMetadata(directory, record) {
  const request = {callerSessionID: record.parentSessionID, taskID: record.taskID,
    generation: record.generation, terminalRevision: record.terminalRevision,
    state: record.state === 'reconciled' ? record.terminalState : record.state,
    inputMessageID: record.bcpOrigin?.inputMessageID, terminalMessageID: record.bcpOrigin?.terminalMessageID};
  const unknown = reason => ({schema_version: 1, execution: {task_id: request.taskID, generation: request.generation ?? null,
    terminal_revision: request.terminalRevision ?? null, state: request.state}, association: 'unconfirmed', reason,
    candidates: [], coverage: 'not_evaluated', applicability: 'not_evaluated'});
  const bridge = globalThis[BRIDGE]?.get(directory);
  if (!bridge) return unknown('bcp_unavailable');
  let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(() => bridge(request)),
      new Promise(resolve => { timer = setTimeout(() => resolve(unknown('inspection_timeout')), 2000); timer.unref?.(); })]);
    return JSON.stringify(result).length <= 65536 ? result : unknown('metadata_size_limit');
  } catch { return unknown('inspection_unavailable'); }
  finally { clearTimeout(timer); }
}
export function deliverySuffix(metadata) {
  return '\n\n<bcp_delivery_metadata>\n' + JSON.stringify(metadata).replaceAll('<', '\\u003c') + '\n</bcp_delivery_metadata>';
}
export async function annotateDeliveryPart(directory, part, record, parentSessionID, isCurrent) {
  if (record.parentSessionID !== parentSessionID || typeof part.text !== 'string') return;
  const metadata = await deliveryMetadata(directory, record);
  if (!isCurrent()) return;
  const suffix = deliverySuffix(metadata);
  if (!part.text.endsWith(suffix)) part.text += suffix;
}
