import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openScopeForRoot, type Scope } from "../src/storage"
import { parseBbId } from "../src/ids"
import { classifyEligibility, AGG_FENCE_ROUNDS, RECENT_K, type EligibilityCtx } from "../src/eligibility"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let n = 0
function setup() {
  const scope: Scope = openScopeForRoot({ rootSessionId: `e${++n}`, dataDir: mkdtempSync(join(tmpdir(), "bb-elig-")) })
  dirs.push(scope.dir)
  const { streamId } = scope.registerSession("author-session", "build")
  let m = 0
  const put = (createdRound: number | null, extra: Partial<Parameters<Scope["put"]>[1]> = {}) => {
    const r = scope.put(streamId, {
      writer: { agent: "build", session_id: "author-session", message_id: `m${m++}` },
      createdRound,
      description: `d${m}`,
      content: "c",
      ...extra,
    })
    if (r.status !== "stored") throw new Error("put failed")
    return r
  }
  return { scope, streamId, put }
}

// 便捷：按 stored 结果取整条记录
function recordOf(scope: Scope, streamId: string, id: string) {
  const seq = parseBbId(id).seq
  const rec = scope.readEntry(streamId, seq)
  if (!rec) throw new Error("record missing")
  return rec
}

describe("eligibility", () => {
  // elig-1（M1-5）
  test("created_round=null → unknown（round_unknown）", () => {
    // 常量符合 §8.3 fence 定义
    expect(AGG_FENCE_ROUNDS).toBe(2)
    expect(RECENT_K).toBe(6)
    const { scope, streamId, put } = setup()
    const r = put(null)
    const rec = recordOf(scope, streamId, r.id)
    const ctx: EligibilityCtx = {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 5,
      recentIds: [],
      callerSessionId: "author-session",
      callerAgent: "build",
    }
    expect(classifyEligibility(rec, ctx)).toEqual({ status: "unknown", reason: "round_unknown" })
    // currentRound 未知同样 unknown
    expect(classifyEligibility(rec, { ...ctx, currentRound: null }).status).toBe("unknown")
  })

  // elig-2
  test("距当前轮 1 轮 → protected（fence）", () => {
    const { scope, streamId, put } = setup()
    const r = put(4)
    const rec = recordOf(scope, streamId, r.id)
    const cls = classifyEligibility(rec, {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 5,
      recentIds: [],
      callerSessionId: "author-session",
      callerAgent: "build",
    })
    expect(cls).toEqual({ status: "protected", reason: "fence" })
  })

  // elig-3
  test("距 3 轮、caller=作者（session+agent 均匹配）、无其它保护 → eligible", () => {
    const { scope, streamId, put } = setup()
    const r = put(2)
    const rec = recordOf(scope, streamId, r.id)
    const cls = classifyEligibility(rec, {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 5,
      recentIds: [],
      callerSessionId: "author-session",
      callerAgent: "build",
    })
    expect(cls).toEqual({ status: "eligible", reason: "formula_pass" })
  })

  // elig-4
  test("pinned → protected", () => {
    const { scope, streamId, put } = setup()
    const r = put(1)
    const cfg = scope.config
    cfg.pins.push(r.id)
    const cls = classifyEligibility(recordOf(scope, streamId, r.id), {
      cfg,
      meta: scope.readMeta(streamId),
      currentRound: 5,
      recentIds: [],
      callerSessionId: "author-session",
      callerAgent: "build",
    })
    expect(cls).toEqual({ status: "protected", reason: "pinned" })
  })

  // elig-5
  test("在 recentIds 中 → protected（recent）", () => {
    const { scope, streamId, put } = setup()
    const r = put(1)
    const cls = classifyEligibility(recordOf(scope, streamId, r.id), {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 5,
      recentIds: [r.id],
      callerSessionId: "author-session",
      callerAgent: "build",
    })
    expect(cls).toEqual({ status: "protected", reason: "recent" })
  })

  // elig-6（§9/M1-6）：补写记录按其实际发布时间所在轮次获得近期保护
  test("补写记录 created_round=实际发布轮 → protected（fence）", () => {
    const { scope, streamId, put } = setup()
    // 补写：publication_for 指向原记录；created_round = 本轮（实际发布轮）→ fence 内
    const r = put(5, { publicationFor: "bb://scope/stream/e000001" })
    const cls = classifyEligibility(recordOf(scope, streamId, r.id), {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 5,
      recentIds: [],
      callerSessionId: "author-session",
      callerAgent: "build",
    })
    expect(cls).toEqual({ status: "protected", reason: "fence" })
  })

  // elig-7（I8）：同流换写手 → 非原作者
  test("callerAgent ≠ writer.agent → protected（not_original_author）", () => {
    const { scope, streamId, put } = setup()
    const r = put(1)
    const cls = classifyEligibility(recordOf(scope, streamId, r.id), {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 5,
      recentIds: [],
      callerSessionId: "author-session", // session 匹配
      callerAgent: "review", // agent 不匹配
    })
    expect(cls).toEqual({ status: "protected", reason: "not_original_author" })
  })

  // elig-8（P7）：被修正不额外受保护；covered_by 分列断言
  test("superseded_by 置位 → eligible；covered_by 置位 → protected（already_covered）", () => {
    const { scope, streamId, put } = setup()
    const r = put(1)
    const meta = scope.readMeta(streamId)
    const ctxOf = () => ({
      cfg: scope.config,
      meta: scope.readMeta(streamId), // 每次写 nav 后重读
      currentRound: 5,
      recentIds: [],
      callerSessionId: "author-session",
      callerAgent: "build",
    })
    const rec = recordOf(scope, streamId, r.id)
    // P7：superseded_by 存在但其余条件满足 → eligible（聚合只折叠目录，原文仍可按旧 ID 取回）
    scope.writeMeta(streamId, { ...meta, nav: { ...meta.nav, [r.id]: { superseded_by: "bb://s/t/e000009" } } })
    expect(classifyEligibility(rec, ctxOf())).toEqual({ status: "eligible", reason: "formula_pass" })
    // covered_by → protected
    scope.writeMeta(streamId, { ...meta, nav: { ...meta.nav, [r.id]: { covered_by: "bb://s/t/e000010" } } })
    expect(classifyEligibility(rec, ctxOf())).toEqual({ status: "protected", reason: "already_covered" })
  })
})
