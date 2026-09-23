import { describe, test, expect } from "bun:test"
import { classifyInput, applyInput, type RoundState } from "../src/rounds"

const admitted = (id: string) => ({ kind: "admitted" as const, inputMessageId: id })
const fresh: RoundState = { current_round: 0, round_known: false, last_admitted_message_id: null }

describe("rounds", () => {
  // rounds-1
  test("admitted+user+非合成 → admitted_input，applyInput 增轮", () => {
    expect(classifyInput(admitted("msg1"), { isUser: true, matchesKnownSynthetic: false })).toBe("admitted_input")
    const s = applyInput(fresh, "admitted_input", "msg1")
    expect(s).toEqual({ current_round: 1, round_known: true, last_admitted_message_id: "msg1" })
  })

  // rounds-2（I1）
  test("unverified 信号且文本像真实输入 → internal（内容不构成 admission）", () => {
    const realLooking = "请帮我修复登录模块的超时问题"
    expect(realLooking.length).toBeGreaterThan(0)
    expect(classifyInput({ kind: "unverified" }, { isUser: true, matchesKnownSynthetic: false })).toBe("internal")
    expect(applyInput(fresh, "internal", "msg-x")).toEqual(fresh)
  })

  // rounds-3
  test("isUser=false → internal", () => {
    expect(classifyInput(admitted("msg1"), { isUser: false, matchesKnownSynthetic: false })).toBe("internal")
  })

  // rounds-4（A-C6，保守优先）
  test("admitted 但 matchesKnownSynthetic=true → internal", () => {
    expect(classifyInput(admitted("msg_dcp_summary_" + "a".repeat(40)), { isUser: true, matchesKnownSynthetic: true })).toBe(
      "internal",
    )
  })

  // rounds-5
  test("连续两次不同 messageId 的 admitted → 递增 2", () => {
    let s = applyInput(fresh, "admitted_input", "msg1")
    s = applyInput(s, "admitted_input", "msg2")
    expect(s).toEqual({ current_round: 2, round_known: true, last_admitted_message_id: "msg2" })
  })

  // rounds-6（P12）：同一 messageId 的 admitted 重复到达 → 幂等（恢复不增轮）
  test("同一 messageId 重复 admitted → 状态与首次处理后深比较不变", () => {
    const first = applyInput(fresh, "admitted_input", "msg1")
    const replay = applyInput(first, "admitted_input", "msg1")
    expect(replay).toEqual(first)
    expect(replay.current_round).toBe(1) // 轮次仍为 +1
  })
})
