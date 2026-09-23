// 轮次时钟（DESIGN §9，轻量）：一轮 = 一个新的真实用户/外部任务输入实际进入该 agent 处理。
// 工具循环、agent 自己的 nudge、聚合回执、compaction continuation 均不增轮（§9）。
// I1：内容正则永远不能单独作为 admission 判据——仅 admitted 身份信号 + isUser + 非已知合成特征才增轮。

export type RoundClass = "admitted_input" | "internal"

export type AdmissionSignal =
  | { kind: "admitted"; inputMessageId: string }
  | { kind: "unverified" }

export type RoundState = {
  current_round: number
  round_known: boolean
  last_admitted_message_id: string | null
}

// 保守辅助正则 + A-C6 结论（harness/live-protocol.md）：
// compaction continuation 特征 = 合成 id `msg_dcp_summary_<40hex>`（不落盘）+
// transform lastMsgId 后缀 `-background-job-board`（父#2）。
// 运行时保守规则：不匹配也不增轮（欠增轮 → 预算更保守，A-C6）。
// 正则以 `[<]` 字符类书写（语义等价；字面尖括号前缀序列干扰部分读取工具显示层）。
export const SYNTHETIC_RE = /^\[blackboard|^[<]system-reminder|^[<]dcp-|msg_dcp_summary_[0-9a-f]{40}|-background-job-board$/

export function isKnownSyntheticText(text: string): boolean {
  return SYNTHETIC_RE.test(text)
}

export function classifyInput(
  signal: AdmissionSignal,
  flags: { isUser: boolean; matchesKnownSynthetic: boolean },
): RoundClass {
  if (signal.kind !== "admitted") return "internal" // 无已验证身份信号 → 不增轮（I1）
  if (!flags.isUser || flags.matchesKnownSynthetic) return "internal"
  return "admitted_input"
}

// 幂等（P12）：同一 messageId 的 admitted 重复到达（恢复重放）→ 原样返回，
// 不增轮不重置；仅新 messageId 才 +1。
export function applyInput(state: RoundState, cls: RoundClass, inputMessageId: string): RoundState {
  if (cls !== "admitted_input") return state
  if (inputMessageId === state.last_admitted_message_id) return state
  return {
    current_round: state.current_round + 1,
    round_known: true,
    last_admitted_message_id: inputMessageId,
  }
}
