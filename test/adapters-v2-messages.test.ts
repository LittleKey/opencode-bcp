// v2 请求边界归一化单测（DESIGN v1.7.1 §16.3-3/4 语义，纯逻辑）。
import { describe, expect, test } from "bun:test"
import {
  UNKNOWN_REQUEST_KEY,
  candidateInSnapshot,
  invalidationInput,
  observePrompt,
  resolveRequestBoundary,
  verifiedInput,
  type SnapshotMessage,
} from "../src/adapters/v2/messages"

const msg = (id: string, role = "user"): SnapshotMessage => ({ id, role })

describe("observePrompt（§16.3-1 仅观测的候选登记）", () => {
  test("真实用户输入 → admitted 候选", () => {
    expect(observePrompt("msg_1", "帮我查一下")).toEqual({ inputMessageId: "msg_1", admissible: true })
  })
  test("无 ID → null，不造随机 ID", () => {
    const obs = observePrompt(null, "帮我查一下")
    expect(obs.inputMessageId).toBeNull()
    expect(obs.admissible).toBe(false)
  })
  test("空串 ID 视同无 ID", () => {
    expect(observePrompt("", "x").inputMessageId).toBeNull()
  })
  test("已知合成特征 → 不可作 admission 候选（I1）", () => {
    expect(observePrompt("msg_2", "<system-reminder>continued</system-reminder>").admissible).toBe(false)
    expect(observePrompt("msg_3", "msg_dcp_summary_" + "a".repeat(40)).admissible).toBe(false)
  })
})

describe("candidateInSnapshot（§16.3-2 快照关联验证）", () => {
  test("候选 ID 在本次快照 → verified", () => {
    expect(candidateInSnapshot("m1", [msg("m1"), msg("m2", "assistant")])).toBe(true)
  })
  test("候选被 compaction 移出快照 → 不验证", () => {
    expect(candidateInSnapshot("m1", [msg("m2", "assistant")])).toBe(false)
  })
  test("无候选 → 不验证", () => {
    expect(candidateInSnapshot(null, [msg("m1")])).toBe(false)
  })
})

describe("resolveRequestBoundary（§16.3-4 两级身份/请求边界键）", () => {
  test("同一边界重试复用同一请求键（reused）", () => {
    const first = resolveRequestBoundary("ses_a", [msg("u1"), msg("a1", "assistant")], {})
    expect(first.boundary).toEqual({ provable: true, reused: false, key: "ses_a:a1" })
    const retry = resolveRequestBoundary("ses_a", [msg("u1"), msg("a1", "assistant")], first.memo)
    expect(retry.boundary).toEqual({ provable: true, reused: true, key: "ses_a:a1" })
  })
  test("持久历史推进后 → 新边界新键（不得被旧键吞掉）", () => {
    const first = resolveRequestBoundary("ses_a", [msg("u1")], {})
    const afterToolLoop = resolveRequestBoundary("ses_a", [msg("u1"), msg("a1", "assistant")], first.memo)
    expect(afterToolLoop.boundary.provable).toBe(true)
    expect(afterToolLoop.boundary.reused).toBe(false)
    expect((afterToolLoop.boundary as { key: string }).key).not.toBe((first.boundary as { key: string }).key)
    // 新键进入 memo 后再次重试同样复用
    const retry = resolveRequestBoundary("ses_a", [msg("u1"), msg("a1", "assistant")], afterToolLoop.memo)
    expect(retry.boundary).toEqual({ provable: true, reused: true, key: "ses_a:a1" })
  })
  test("I3 真实工具循环形状：无 id tool-result 尾部挂靠前一带 id assistant → 边界=assistant id", () => {
    // 宿主形状（to-llm-message.ts:213-229）：assistant 带 id，后跟 role:"tool" 无 id 的结果
    const first = resolveRequestBoundary("ses_a", [msg("u1")], {})
    const afterTool = resolveRequestBoundary(
      "ses_a",
      [msg("u1"), msg("a1", "assistant"), { role: "tool", content: [{ type: "tool-result", toolCallId: "c1" }] }],
      first.memo,
    )
    expect(afterTool.boundary).toEqual({ provable: true, reused: false, key: "ses_a:a1" })
    // 同边界重试复用；下一工具步（a2 + tool）再得新键
    const retry = resolveRequestBoundary(
      "ses_a",
      [msg("u1"), msg("a1", "assistant"), { role: "tool" }],
      afterTool.memo,
    )
    expect(retry.boundary).toEqual({ provable: true, reused: true, key: "ses_a:a1" })
    const next = resolveRequestBoundary(
      "ses_a",
      [msg("u1"), msg("a1", "assistant"), { role: "tool" }, msg("a2", "assistant"), { role: "tool" }],
      retry.memo,
    )
    expect(next.boundary).toEqual({ provable: true, reused: false, key: "ses_a:a2" })
  })
  test("I3 连续无 id tool 尾部后接无 id 非 tool → unknown（不丢弃任意无 ID 尾部）", () => {
    const prev = resolveRequestBoundary("ses_a", [msg("u1")], {})
    const unknown = resolveRequestBoundary(
      "ses_a",
      [msg("u1"), msg("a1", "assistant"), { role: "tool" }, { role: "user" }], // synthetic continuation 形状
      prev.memo,
    )
    expect(unknown.boundary).toEqual({ provable: false, reused: false, key: null })
    expect(unknown.memo).toBe(prev.memo)
  })
  test("新业务输入 → 新键（不同 session 互不串扰）", () => {
    const a = resolveRequestBoundary("ses_a", [msg("u1")], {})
    const b = resolveRequestBoundary("ses_b", [msg("u1")], a.memo)
    expect(b.boundary).toEqual({ provable: true, reused: false, key: "ses_b:u1" })
  })
  test("无 ID 末消息 → unknown：不证明、不造随机 ID、不推进 memo", () => {
    const prev = resolveRequestBoundary("ses_a", [msg("u1")], {})
    const unknown = resolveRequestBoundary(
      "ses_a",
      [msg("u1"), { role: "user" }], // tool-result 转 role:"user" 无 ID 在尾部
      prev.memo,
    )
    expect(unknown.boundary).toEqual({ provable: false, reused: false, key: null })
    expect(unknown.memo).toBe(prev.memo) // memo 不变
  })
  test("空消息列表 → unknown", () => {
    expect(resolveRequestBoundary("ses_a", [], {}).boundary.provable).toBe(false)
  })
})

describe("unknown → 保守失效事务入口（§16.3-3 双失效落盘义务）", () => {
  test("invalidationInput：requestVerified=false + 无 admitted + 无候选集 + 固定非随机键", () => {
    const inv = invalidationInput("ses_a")
    expect(inv.requestVerified).toBe(false)
    expect(inv.admittedMessageId).toBeNull()
    expect(inv.candidateSetId).toBeNull()
    expect(inv.requestId).toBe(`ses_a:${UNKNOWN_REQUEST_KEY}`)
    expect(inv.requestId).not.toContain("rnd") // 确定性常量，非随机补齐
  })
  test("verifiedInput 携带边界键与 admitted 身份", () => {
    const b = resolveRequestBoundary("ses_a", [msg("u1")], {}).boundary
    if (!b.provable) throw new Error("expected provable")
    expect(verifiedInput("ses_a", b, "u1", "hash1")).toEqual({
      requestId: "ses_a:u1",
      requestVerified: true,
      admittedMessageId: "u1",
      candidateSetId: "hash1",
    })
  })
})
