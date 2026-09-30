/**
 * Council 宿主原文核验。
 *
 * 职责边界：
 * - 只通过注入的只读主机视图核验子任务终结消息，不查/写任何 board（尤其不读 isolated 来源）。
 * - 核验 direct parent、真实已完成公开 assistant（publicReply）、实际 agent 与请求席位相符、
 *   对应 user 消息与 ID/会话/输入一致；current（主角色现有 admitted 表）读前读后。
 * - 任何失败只返回 status:"unavailable" + reason，不附正文；绝不偷偷截断原文。
 * - 32 KiB UTF-8 字节上限。
 */
import { createHash } from "node:crypto"
import type { HostMessage } from "./delivery"
import { publicReply } from "./reply"

/** 桥标识：与 integrations/omo-slim/omo-council.mjs 共享同一全局符号。 */
export const COUNCIL_BRIDGE = Symbol.for("opencode.bcp.council.v1")

/** 每席原文上限：32 KiB，按 UTF-8 字节计。 */
export const COUNCIL_TEXT_LIMIT = 32 * 1024

export type CouncilRequest = {
  callerSessionID: string
  taskID: string
  agent: string
  inputMessageID: string
  terminalMessageID: string
}

/** 终结消息可能携带实际模型字段；缺失时结果显式标注 "unknown"，不虚构。 */
export type CouncilMessage = HostMessage & {
  info: HostMessage["info"] & { modelID?: string; providerID?: string }
}

/** 只读主机视图。current 使用主角色现有 admitted 表；未知必须返回 false（未知 → 不可用，别造恢复证据）。 */
export type CouncilHost = {
  parentFor: (id: string) => Promise<string | null>
  message: (session: string, id: string) => Promise<CouncilMessage | null>
  current: (session: string, input: string) => boolean
  isSeat: (agent: string) => Promise<boolean>
}

export type CouncilSource =
  | {
      schema_version: 1
      status: "verified"
      task_id: string
      agent: string
      model: { modelID: string; providerID: string }
      input_message_id: string
      terminal_message_id: string
      text: string
      text_sha256: string
      text_bytes: number
    }
  /** 失败一律不附正文。 */
  | { schema_version: 1; status: "unavailable"; task_id: string; reason: string }

const unavailable = (taskID: string, reason: string): CouncilSource =>
  ({ schema_version: 1, status: "unavailable", task_id: typeof taskID === "string" ? taskID : "", reason })

/** 终结/输入消息与请求的身份一致性：ID、会话、角色、终结对输入的父子关系。 */
const identity = (request: CouncilRequest, terminal: CouncilMessage | null, input: CouncilMessage | null) =>
  Boolean(terminal && input &&
    terminal.info.id === request.terminalMessageID && terminal.info.sessionID === request.taskID &&
    terminal.info.role === "assistant" && terminal.info.parentID === request.inputMessageID &&
    input.info.id === request.inputMessageID && input.info.sessionID === request.taskID &&
    input.info.role === "user")

const read = async (host: CouncilHost, request: CouncilRequest) => {
  const [terminal, input] = await Promise.all([
    host.message(request.taskID, request.terminalMessageID),
    host.message(request.taskID, request.inputMessageID),
  ])
  return { terminal, input }
}

export async function inspectCouncilSource(request: CouncilRequest, host: CouncilHost): Promise<CouncilSource> {
  if (!request || typeof request !== "object" ||
      typeof request.callerSessionID !== "string" || !request.callerSessionID ||
      typeof request.taskID !== "string" || !request.taskID ||
      typeof request.agent !== "string" || !request.agent) return unavailable(request?.taskID, "invalid_request")
  if (typeof request.inputMessageID !== "string" || !request.inputMessageID ||
      typeof request.terminalMessageID !== "string" || !request.terminalMessageID)
    return unavailable(request.taskID, "no_terminal_identity")

  // direct parent：任务必须直接属于请求的调用方会话。
  let parent: string | null = null
  try { parent = await host.parentFor(request.taskID) } catch { parent = null }
  if (parent !== request.callerSessionID) return unavailable(request.taskID, "unverified_owner")

  // current 读前：任务会话必须仍停在产生该终结的同一 admitted 输入上；宿主未知即 false → 不可用。
  if (!host.current(request.taskID, request.inputMessageID)) return unavailable(request.taskID, "not_current_input")

  // 请求席位必须是已配置的 councillor 席位。
  let seat = false
  try { seat = await host.isSeat(request.agent) } catch { seat = false }
  if (!seat) return unavailable(request.taskID, "not_configured_seat")

  let first: { terminal: CouncilMessage | null; input: CouncilMessage | null }
  try { first = await read(host, request) }
  catch { return unavailable(request.taskID, "message_identity_unavailable") }
  if (!first.terminal || !first.input || !identity(request, first.terminal, first.input))
    return unavailable(request.taskID, "message_identity_unavailable")

  // 真实已完成公开 assistant：复用 publicReply（final 仅限 finish==="stop"）。
  const reply = publicReply(first.terminal)
  if (!reply || reply.kind !== "final") return unavailable(request.taskID, "not_public_reply")

  // 实际作者与请求席位相符；消息缺 agent 字段视为不符，不虚构。
  if (first.terminal.info.agent !== request.agent) return unavailable(request.taskID, "seat_mismatch")

  const text = reply.content
  const textBytes = new TextEncoder().encode(text).length
  if (textBytes > COUNCIL_TEXT_LIMIT) return unavailable(request.taskID, "text_size_limit")

  // 读后复查：终结/输入消息身份与公开正文均未变化，且 current 仍成立；期间轮换/改写即不可用。
  let again: { terminal: CouncilMessage | null; input: CouncilMessage | null }
  try { again = await read(host, request) }
  catch { return unavailable(request.taskID, "message_changed_during_read") }
  if (!again.terminal || !again.input || !identity(request, again.terminal, again.input))
    return unavailable(request.taskID, "message_changed_during_read")
  const replyAgain = publicReply(again.terminal)
  if (!replyAgain || replyAgain.kind !== "final" || replyAgain.content !== text ||
      again.terminal.info.agent !== first.terminal.info.agent ||
      again.terminal.info.modelID !== first.terminal.info.modelID || again.terminal.info.providerID !== first.terminal.info.providerID)
    return unavailable(request.taskID, "message_changed_during_read")
  if (!host.current(request.taskID, request.inputMessageID)) return unavailable(request.taskID, "not_current_input")

  return {
    schema_version: 1,
    status: "verified",
    task_id: request.taskID,
    agent: request.agent,
    model: { modelID: again.terminal.info.modelID ?? "unknown", providerID: again.terminal.info.providerID ?? "unknown" },
    input_message_id: request.inputMessageID,
    terminal_message_id: request.terminalMessageID,
    text,
    text_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    text_bytes: textBytes,
  }
}
