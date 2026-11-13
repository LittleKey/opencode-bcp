// 纯归属解析：从宿主新鲜 wire（context 有序消息）证明一次编辑工具调用属于哪个
// 已确认输入。只读、无 IO、无状态；拒绝理由全部可审计。宿主事实（v2.2.0 已核）：
// context 按 seq 有序且包含未完成 assistant（store/history 语义），wire 行无
// parentID，父子关系只能按位置推导（与 src/adapters/v2/snapshot.ts refresh 一致）。
import type { WireMessage } from "./snapshot"

export type EditInputResolved = { ok: true; inputID: string; userText: string; agent: string }
export type EditInputRejected = { ok: false; reason: string }
export type EditInputResolution = EditInputResolved | EditInputRejected

const row = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object")

/**
 * 解析 assistantID 行的输入归属：
 * - wire 中必须存在恰好一行 id===assistantID 且 type==="assistant"（缺失/重复/类型
 *   不符均拒绝——重复 id 无法确定是哪一次 assistant message）；
 * - 从该行向列表前方跳过其他 assistant 行（同一输入的多 step assistant 都挂在同一
 *   user 输入下），首个非 assistant 行必须是真实 user 输入且 id===expectedInput；
 *   synthetic/system/compaction 屏障、其他类型或 id 不匹配都拒绝（不猜归属）；
 * - userText 取该 user 行原文（no-store 核验与审计需要原文，缺失即拒绝）；
 * - agent 取 assistant 行的 agent 身份；缺失即保守拒绝（wire 缺身份无法与 context
 *   登记身份交叉复核，不得回落登记值冒充已证身份）。
 */
export function resolveEditInput(wire: readonly WireMessage[] | null, assistantID: string, expectedInput: string): EditInputResolution {
  if (!Array.isArray(wire)) return { ok: false, reason: "context_unavailable" }
  if (typeof assistantID !== "string" || !assistantID) return { ok: false, reason: "missing_assistant_id" }
  if (typeof expectedInput !== "string" || !expectedInput) return { ok: false, reason: "missing_input_id" }
  const at: number[] = []
  for (let i = 0; i < wire.length; i++) {
    const entry = wire[i]
    if (!row(entry) || entry.id !== assistantID) continue
    if (entry.type !== "assistant") return { ok: false, reason: "id_is_not_assistant" }
    at.push(i)
  }
  if (at.length === 0) return { ok: false, reason: "assistant_not_in_context" }
  if (at.length > 1) return { ok: false, reason: "ambiguous_assistant_id" }
  const source = wire[at[0]!]!
  const agent = typeof source.agent === "string" && source.agent ? source.agent : undefined
  if (!agent) return { ok: false, reason: "assistant_agent_missing" }
  for (let i = at[0]! - 1; i >= 0; i--) {
    const entry = wire[i]
    if (!row(entry)) continue
    if (entry.type === "assistant") continue
    // synthetic/compaction/未知类型都是输入边界：跨边界即不可证，不假定 wire 有 parentID。
    if (entry.type !== "user") return { ok: false, reason: "non_user_boundary" }
    if (entry.id !== expectedInput) return { ok: false, reason: "input_mismatch" }
    if (typeof entry.text !== "string" || !entry.text) return { ok: false, reason: "input_text_unavailable" }
    return { ok: true, inputID: expectedInput, userText: entry.text, agent }
  }
  return { ok: false, reason: "no_user_predecessor" }
}
