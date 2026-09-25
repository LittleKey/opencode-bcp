// v2 请求边界归一化（DESIGN v1.7.1 §16.3-3/4，纯逻辑、无宿主 import，可单测）。
//
// 两级身份：
//   A. 业务输入轮次身份 = prompt hook 观测的 admitted 候选（inputMessageId）。
//   B. 模型请求边界键 = 本次 context 快照可证明的边界标识，请求预算 ≤1/请求 的去重键。
// context 无显式 requestID；Message.id 可选；tool-result/MAX_STEPS/synthetic 消息可能
// 无 ID 或被宿主转成 role:"user" —— 绝不照搬 messages.at(-1).id 充当 admission 证明，
// 绝不生成随机 ID 补齐；无法证明边界 → unknown → 保守失效事务入口（双 round_known=false）。

import { isKnownSyntheticText } from "../../rounds"

/** context 快照消息的最小切片（LLM Message 的结构子集）。 */
export type SnapshotMessage = {
  readonly id?: string | null
  readonly role?: string
  readonly content?: unknown
}

/** prompt hook 观测结果（§16.3-1：仅登记，不推进轮次/预算）。 */
export type PromptObservation = {
  /** 候选 admitted messageId；宿主未给 ID → null（不造随机 ID）。 */
  readonly inputMessageId: string | null
  /** 真实用户输入（非已知合成特征）→ true；否则不构成 admission 候选。 */
  readonly admissible: boolean
}

export function observePrompt(messageId: string | null | undefined, text: string): PromptObservation {
  const id = typeof messageId === "string" && messageId.length > 0 ? messageId : null
  const synthetic = isKnownSyntheticText(text ?? "")
  return { inputMessageId: id, admissible: id !== null && !synthetic }
}

/** §16.3-2 快照验证：候选 ID 必须确实出现在本次消息快照中（关联验证，G7 同构）。 */
export function candidateInSnapshot(
  admittedId: string | null | undefined,
  messages: readonly SnapshotMessage[],
): boolean {
  if (admittedId == null || admittedId === "") return false
  return messages.some((m) => m.id === admittedId)
}

/**
 * 已证明请求边界，§16.3-4：
 * - provable+reused=false：持久历史推进后的新边界（新请求键）。
 * - provable+reused=true：同一已证明边界内的重复 hook/未改变边界的重试 → 复用同键，
 *   由 nudge seen_requests 去重，不重复消耗请求预算。
 * - provable=false：unknown——不注入/不推进/不生成随机 ID，且必须走保守失效落盘。
 */
export type RequestBoundary =
  | { readonly provable: true; readonly reused: boolean; readonly key: string }
  | { readonly provable: false; readonly reused: false; readonly key: null }

/** 已证明边界缓存：sessionId → 最近一次已证明边界键（由接线层持有，纯函数传入传出）。 */
export type BoundaryMemo = Readonly<Record<string, string>>

/** unknown 路径的固定请求键常量——确定性、非随机、所有 unknown 归并为一（保守）。 */
export const UNKNOWN_REQUEST_KEY = "unknown"

// 边界算法（§16.3-3，宿主证据 P/packages/core/src/session/runner/to-llm-message.ts:213-229、
// P/packages/ai/src/schema/messages.ts:283-284）：常规工具循环的持久历史形状是
// [.., assistant(带 id + toolCalls), tool-result(role:"tool"，无 id)，..]。无 id 尾部
// 仅当 role==="tool"（可证明为 call-result，挂靠其前 assistant）才可跳过；其余无 id
// 消息（synthetic continuation / MAX_STEPS 转出的 user 等）= 真正缺证 → unknown。
// 键只取自 id 齐全的持久消息；不用输入 ID、不用时间/随机数、不丢弃任意无 ID 尾部。
function headIdOf(messages: readonly SnapshotMessage[]): string | null {
  let i = messages.length - 1
  while (i >= 0) {
    const m = messages[i]!
    const id = typeof m.id === "string" && m.id.length > 0 ? m.id : null
    if (id !== null) return id
    if (m.role !== "tool") return null // 无法证明归属的无 ID 尾部 → 缺证
    i-- // call-result 尾部：归属其前最近的带 id 持久消息
  }
  return null
}

export function resolveRequestBoundary(
  sessionId: string,
  messages: readonly SnapshotMessage[],
  memo: BoundaryMemo,
): { boundary: RequestBoundary; memo: BoundaryMemo } {
  const headId = headIdOf(messages)
  if (headId === null) {
    // unknown：不证明、不复用旧键、不造随机 ID；memo 原样（不推进）。
    return { boundary: { provable: false, reused: false, key: null }, memo }
  }
  const key = `${sessionId}:${headId}`
  const reused = memo[sessionId] === key
  const next = reused ? memo : { ...memo, [sessionId]: key }
  return { boundary: { provable: true, reused, key }, memo: next }
}

/** unknown → 保守失效事务输入（decideAndPersist 的实参决策，§16.3-3 双失效落盘入口）。 */
export function invalidationInput(sessionId: string): {
  requestId: string
  requestVerified: false
  admittedMessageId: null
  candidateSetId: null
} {
  return {
    requestId: `${sessionId}:${UNKNOWN_REQUEST_KEY}`,
    requestVerified: false,
    admittedMessageId: null,
    candidateSetId: null,
  }
}

/** 已证明边界 → decideAndPersist 实参决策（验证由接线层先用 candidateInSnapshot 完成）。 */
export function verifiedInput(
  sessionId: string,
  boundary: RequestBoundary & { provable: true },
  admittedMessageId: string,
  candidateSetId: string | null,
): {
  requestId: string
  requestVerified: true
  admittedMessageId: string
  candidateSetId: string | null
} {
  return {
    requestId: boundary.key,
    requestVerified: true,
    admittedMessageId,
    candidateSetId,
  }
}
