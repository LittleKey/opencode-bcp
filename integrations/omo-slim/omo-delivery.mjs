// Bounded host bridge; BCP may retain a verified final reply. Never wakes a model or changes task state.
import { createHash } from 'node:crypto';
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
export const REFERENCE_MIN_BYTES = 8192;
// Elide only exact whole bytes, or one exact body in the native task_result wrapper.
// A record candidate, title, inferred verdict or partial result is not a replacement proof.
export function presentDelivery(text, metadata) {
  const ref = metadata?.result_reference, execution = metadata?.execution;
  if (typeof text !== 'string' || metadata?.association !== 'host_message_identity' || execution?.state !== 'completed' ||
      !ref || ref.bytes < REFERENCE_MIN_BYTES || typeof ref.description !== 'string' ||
      !/^bb:\/\/[0-9a-f-]+\/[0-9a-f-]+\/e\d+$/i.test(ref.id ?? '') ||
      !/^[0-9a-f]{64}$/.test(ref.text_sha256 ?? '') || ref.writer?.session_id !== execution.task_id ||
      ref.writer?.message_id !== execution.terminal_message_id || ref.input_message_id !== execution.input_message_id) return text;
  let body = text, start = 0;
  const open = '<task_result>\n', close = '\n</task_result>';
  if (Buffer.byteLength(body) !== ref.bytes || createHash('sha256').update(body).digest('hex') !== ref.text_sha256) {
    start = text.indexOf(open);
    if (start < 0 || text.indexOf(open, start + open.length) >= 0) return text;
    start += open.length;
    const end = text.indexOf(close, start);
    if (end < 0 || text.indexOf(close, end + close.length) >= 0) return text;
    const prefix = text.slice(0, start - open.length), suffix = text.slice(end + close.length);
    const task = /^<task\b[^>]*\bid="([A-Za-z0-9_-]+)"[^>]*>\n/.exec(prefix);
    const native = /^task_id: (ses_[A-Za-z0-9_-]+) \(for resuming to continue this task if needed\)\n\n$/.exec(prefix);
    if (!(task?.[1] === execution.task_id && suffix === '\n</task>') &&
        !(native?.[1] === execution.task_id && suffix === '')) return text;
    body = text.slice(start, end);
    if (Buffer.byteLength(body) !== ref.bytes || createHash('sha256').update(body).digest('hex') !== ref.text_sha256) return text;
  }
  const receipt = '<bcp_result_reference>\n' + JSON.stringify({ ...ref,
    required_action: 'Read the original with board_get before depending on its conclusions, versions or limits. This is a retrieval receipt, not acceptance.'
  }).replaceAll('<', '\\u003c') + '\n</bcp_result_reference>';
  if (Buffer.byteLength(receipt) >= ref.bytes) return text;
  return text.slice(0, start) + receipt + text.slice(start + body.length);
}
export async function annotateDeliveryPart(directory, part, record, parentSessionID, isCurrent) {
  if (record.parentSessionID !== parentSessionID || typeof part.text !== 'string') return;
  const metadata = await deliveryMetadata(directory, record);
  if (!isCurrent()) return;
  const suffix = deliverySuffix(metadata);
  if (!part.text.endsWith(suffix)) part.text = presentDelivery(part.text, metadata) + suffix;
}
