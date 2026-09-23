import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  newLedger,
  rollLedgerForNewRound,
  decideNudge,
  roundKnownFor,
  renderSnapshot,
  snapshotVersionOf,
  type NudgeLedger,
} from "../src/nudge"
import { openScopeForRoot, type Scope } from "../src/storage"
import { listIndex } from "../src/indexing"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let n = 0
function req(): string {
  n++
  return `req-${n}`
}
const initial = (requestId: string, roundKnown = true, snapshotVersion = "v1") =>
  decideNudge(newLedger(), { requestId, roundKnown, candidateSetId: null, snapshotVersion })

describe("nudge", () => {
  // nudge-1
  test("首轮 roundKnown=true → initial_reminder，mark_fulfilled，ledger 置位", () => {
    const { decision, ledger } = initial("r1")
    expect(decision).toEqual({ inject: true, reason: "initial_reminder", mark_fulfilled: true })
    expect(ledger.initial_fulfilled).toBe(true)
    expect(ledger.round_used).toBe(1)
    expect(ledger.seen_requests).toContain("r1")
  })

  // nudge-2（P13）：同轮第 2 次初始机会（新快照版本）→ fulfilled_initial，预算与 snapshot_version 不变
  test("同轮第二次初始机会 → fulfilled_initial 不重注入", () => {
    const l1 = initial("r1").ledger
    const { decision, ledger } = decideNudge(l1, { requestId: "r2", roundKnown: true, candidateSetId: null, snapshotVersion: "v2" })
    expect(decision).toEqual({ inject: false, reason: "fulfilled_initial", mark_fulfilled: false })
    expect(ledger.round_used).toBe(1)
    expect(ledger.snapshot_version).toBe("v1")
  })

  // nudge-3
  test("同 requestId 二次 → duplicate_hook，ledger 深比较不变", () => {
    const l1 = initial("r1").ledger
    const { decision, ledger } = decideNudge(l1, { requestId: "r1", roundKnown: true, candidateSetId: null, snapshotVersion: "v2" })
    expect(decision).toEqual({ inject: false, reason: "duplicate_hook", mark_fulfilled: false })
    expect(ledger).toEqual(l1)
  })

  // nudge-4
  test("roundKnown=false → identity_unrecoverable，不注入，requestId 入 seen_requests", () => {
    const { decision, ledger } = initial("r1", false)
    expect(decision).toEqual({ inject: false, reason: "identity_unrecoverable", mark_fulfilled: false })
    expect(ledger.initial_fulfilled).toBe(false)
    expect(ledger.round_used).toBe(0)
    expect(ledger.seen_requests).toContain("r1")
  })

  // nudge-5（C3-①）：已用额度保持，无兜底
  test("round_used=2 后身份丢失 → 新 requestId 仍 identity_unrecoverable", () => {
    const base: NudgeLedger = { ...newLedger(), round_id: "msg1", round_known: true, round_used: 2, initial_fulfilled: true }
    const { decision, ledger } = decideNudge(base, { requestId: "r9", roundKnown: false, candidateSetId: null, snapshotVersion: "v9" })
    expect(decision).toEqual({ inject: false, reason: "identity_unrecoverable", mark_fulfilled: false })
    expect(ledger.round_used).toBe(2) // 额度不因身份丢失而回收或重置
  })

  // nudge-6（父级 P1 最小反例）：连续 3 个未知身份请求 → 注入 0 次
  test("连续 3 个未知身份请求 → 0 次注入", () => {
    let ledger = newLedger()
    let injected = 0
    for (let i = 0; i < 3; i++) {
      const r = decideNudge(ledger, { requestId: req(), roundKnown: false, candidateSetId: null, snapshotVersion: `v${i}` })
      if (r.decision.inject) injected++
      ledger = r.ledger
    }
    expect(injected).toBe(0)
  })

  // nudge-7：初始类快照版本未变 → state_unchanged（不消耗）
  test("快照版本未变 → state_unchanged", () => {
    // 初始未履行，先以 v1 注入过一次？构造：直接注入后把 snapshot_version 还原为 v1 的场景不合法；
    // 按定义：未 fulfilled、有预算、snapshot_version === 输入 → state_unchanged
    const base: NudgeLedger = { ...newLedger(), round_id: "msg1", round_known: true, snapshot_version: "v1" }
    const { decision, ledger } = decideNudge(base, { requestId: "r1", roundKnown: true, candidateSetId: null, snapshotVersion: "v1" })
    expect(decision).toEqual({ inject: false, reason: "state_unchanged", mark_fulfilled: false })
    expect(ledger.round_used).toBe(0)
  })

  // nudge-8：跨轮集合抑制且 prompted_set_hashes 持久化字段保留
  test("轮 A 提示 S1，roll 后轮 B 同集合 → set_already_prompted", () => {
    const l1 = decideNudge(newLedger(), { requestId: "r1", roundKnown: true, candidateSetId: "S1", snapshotVersion: "v1" }).ledger
    expect(l1.prompted_set_hashes).toEqual(["S1"])
    const rolled = rollLedgerForNewRound(l1, "msg2")
    const { decision } = decideNudge(rolled, { requestId: "r2", roundKnown: true, candidateSetId: "S1", snapshotVersion: "v2" })
    expect(decision).toEqual({ inject: false, reason: "set_already_prompted", mark_fulfilled: false })
  })

  // nudge-9（P13 共享预算序列）：初始一次 → 压力 S1 一次 → 新集合 S2 → no_budget
  test("初始+压力共享预算用尽 → no_budget", () => {
    let ledger = newLedger()
    const a = decideNudge(ledger, { requestId: "r1", roundKnown: true, candidateSetId: null, snapshotVersion: "v1" })
    expect(a.decision.reason).toBe("initial_reminder")
    ledger = a.ledger
    expect(ledger.round_used).toBe(1)
    const b = decideNudge(ledger, { requestId: "r2", roundKnown: true, candidateSetId: "S1", snapshotVersion: "v1" })
    expect(b.decision.reason).toBe("pressure_reminder")
    ledger = b.ledger
    expect(ledger.round_used).toBe(2)
    expect(ledger.snapshot_version).toBe("v1") // I2：压力不动 snapshot_version
    const c = decideNudge(ledger, { requestId: "r3", roundKnown: true, candidateSetId: "S2", snapshotVersion: "v1" })
    expect(c.decision).toEqual({ inject: false, reason: "no_budget", mark_fulfilled: false })
  })

  // nudge-10（I2）：集合已提示后初始机会仍可用
  test("roll 后初始机会独立于压力类去重 → initial_reminder", () => {
    const l1 = decideNudge(newLedger(), { requestId: "r1", roundKnown: true, candidateSetId: "S1", snapshotVersion: "v1" }).ledger
    const rolled = rollLedgerForNewRound(l1, "msg2")
    const { decision } = decideNudge(rolled, { requestId: "r2", roundKnown: true, candidateSetId: null, snapshotVersion: "v2" })
    expect(decision.reason).toBe("initial_reminder")
  })

  // nudge-14（I2）：压力已发但初始未发、快照不变：压力注入不动 snapshot_version → 初始机会仍可注入
  test("压力后同快照初始机会 → initial_reminder", () => {
    let ledger = newLedger()
    const a = decideNudge(ledger, { requestId: "r1", roundKnown: true, candidateSetId: "S1", snapshotVersion: "v1" })
    expect(a.decision.reason).toBe("pressure_reminder")
    ledger = a.ledger
    expect(ledger.snapshot_version).toBeNull() // 压力未被写入改动
    const b = decideNudge(ledger, { requestId: "r2", roundKnown: true, candidateSetId: null, snapshotVersion: "v1" })
    expect(b.decision.reason).toBe("initial_reminder") // state_unchanged 只对初始类自身上次注入生效
  })

  // nudge-11
  test("rollLedgerForNewRound：重置轮内字段，prompted_set_hashes 保留，round_id 更新", () => {
    const l1 = initial("r1").ledger
    const rolled = rollLedgerForNewRound(l1, "msg2")
    expect(rolled.round_id).toBe("msg2")
    expect(rolled.round_used).toBe(0)
    expect(rolled.seen_requests).toEqual([])
    expect(rolled.initial_fulfilled).toBe(false)
    expect(rolled.round_known).toBe(true)
    expect(rolled.snapshot_version).toBeNull()
    expect(rolled.prompted_set_hashes).toEqual(l1.prompted_set_hashes) // 无截断淘汰
  })

  // nudge-12（M0-7）：板操作不触碰 budget——账本仅经 decideNudge/rollLedgerForNewRound 变化
  test("put/index 后 budget 深比较不变", () => {
    const scope: Scope = openScopeForRoot({ rootSessionId: "n12", dataDir: mkdtempSync(join(tmpdir(), "bb-nudge-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const before = structuredClone(scope.readMeta(streamId).budget)
    scope.put(streamId, {
      writer: { agent: "build", session_id: "s", message_id: "m1" },
      createdRound: null,
      description: "d",
      content: "c",
    })
    listIndex(scope, streamId, { caller: { sessionId: "s", agent: "build" } })
    expect(scope.readMeta(streamId).budget).toEqual(before)
    // roundKnownFor 判定入口形状校验（P12：requestVerified=false → 立即 false）
    const meta = scope.readMeta(streamId)
    expect(roundKnownFor(meta.budget, meta.rounds, false)).toBe(false)
    expect(roundKnownFor(newLedger(), meta.rounds, true)).toBe(false) // round_id null
  })

  // nudge-13
  test("renderSnapshot ≤2048 字节；30 条 60 字节描述 → 省略行 + 保留整条", () => {
    const counts = {
      knowledge_total: 30,
      visible_items: 30,
      index_summary_count: 0,
      new_since_last_shown: 3,
      eligible: 2,
      protected: 28,
      unknown_round: 0,
    }
    const descs = Array.from({ length: 30 }, (_, i) => `描述${i}`.padEnd(60 - String(i).length, "·"))
    const r = renderSnapshot(counts, descs, [], snapshotVersionOf(counts, descs.slice(0, 4)))
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(2048)
    expect(r.text).toContain("省略描述")
    expect(r.omittedDescriptions).toBe(26)
    for (const line of r.text.split("\n")) {
      if (line.startsWith("- ")) expect(descs).toContain(line.slice(2)) // 保留项均为整条
    }
    const normal = renderSnapshot(counts, ["a", "b"], ["s1"], "abcdef0123456789")
    expect(new TextEncoder().encode(normal.text).length).toBeLessThanOrEqual(2048)
    expect(normal.omittedDescriptions).toBe(0)
    expect(normal.omittedSummaries).toBe(0)
  })
})
