// 资格公式（DESIGN §8.3/§8.4，机械可验）。判定顺序：命中即返回。
// P7：superseded 记录不因被修正而额外受保护，与其他旧记录同资格；
// 聚合只折叠目录、原文仍可按旧 ID 取回（D:§8.6/§11.4）。
//
// pin 生命周期声明：**采纳、持续保护、授权释放、聚合提交时对全部成员重校验**
// 是第二步启用聚合的硬前置（§12/Global Constraints #8）；M1 第一步仅提供只读
// isPinned 供下述第 5 步与索引标注使用。
import type { BbRecord } from "./schema"
import type { ScopeConfig, StreamMeta } from "./storage"
import { isPinned } from "./permissions"

// 仅服务快照统计与第二步聚合校验，M1 不触发自动聚合（§8.3 fence 定义）。
export const AGG_FENCE_ROUNDS = 2
export const RECENT_K = 6

export type EligibilityCtx = {
  cfg: ScopeConfig
  meta: StreamMeta
  currentRound: number | null
  recentIds: string[]
  callerSessionId: string
  /** I1：注册路径验证的 caller 身份；null/空串 = 未知 → 保守不参与原作者匹配 */
  callerAgent: string | null
}

export function classifyEligibility(
  rec: BbRecord,
  ctx: EligibilityCtx,
): { status: "eligible" | "protected" | "unknown"; reason: string } {
  // §8.4：候选资格限定原作者；writer 身份含 session + agent 双字段，区分同流不同写手（I8）。
  // I1：caller 身份未知（null/空串）一律 not_original_author——空串不得与空串 writer 冒充匹配。
  if (!ctx.callerAgent || ctx.callerSessionId !== rec.writer.session_id || ctx.callerAgent !== rec.writer.agent) {
    return { status: "protected", reason: "not_original_author" }
  }
  // M1-5：年龄已知才可判定；unknown 默认不参与自动聚合（§9）
  if (rec.created_round === null || ctx.currentRound === null) {
    return { status: "unknown", reason: "round_unknown" }
  }
  // 摘要不作为聚合成员（单层互斥，§8.3）
  if (rec.kind === "index_summary") {
    return { status: "protected", reason: "index_summary" }
  }
  // 已被任何已提交摘要覆盖（§8.3 单层互斥）
  if (ctx.meta.nav[rec.id]?.covered_by !== undefined) {
    return { status: "protected", reason: "already_covered" }
  }
  if (isPinned(ctx.cfg, rec.id)) {
    return { status: "protected", reason: "pinned" }
  }
  // 最近 6 条已发布知识消息（recentKnowledgeIds 按 sequence 降序取，非视图截取，I8）
  if (ctx.recentIds.includes(rec.id)) {
    return { status: "protected", reason: "recent" }
  }
  // 年龄保护：current_round − created_round > AGG_FENCE_ROUNDS 不成立 → fence 内
  if (!(ctx.currentRound - rec.created_round > AGG_FENCE_ROUNDS)) {
    return { status: "protected", reason: "fence" }
  }
  // 其余（含 superseded_by 存在的记录，P7）→ eligible
  return { status: "eligible", reason: "formula_pass" }
}
