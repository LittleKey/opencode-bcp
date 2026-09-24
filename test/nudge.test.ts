import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  newLedger,
  rollLedgerForNewRound,
  decideNudge,
  decideAndPersist,
  roundKnownFor,
  type NudgeLedger,
} from "../src/nudge"
import { openScopeForRoot, type Scope } from "../src/storage"
import { listIndex } from "../src/indexing"
import { aggregateCandidates, candidateSetIdOf } from "../src/aggregate"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let n = 0
function req(): string {
  n++
  return `req-${n}`
}
const noEntry = { messageId: null, s1: false, s2: false }
const entry = (id: string, s1: boolean, s2: boolean) => ({ messageId: id, s1, s2 })
const run = (ledger: NudgeLedger, requestId: string, o?: { roundKnown?: boolean; candidateSetId?: string | null; entry?: { messageId: string | null; s1: boolean; s2: boolean } }) =>
  decideNudge(ledger, {
    requestId,
    roundKnown: o?.roundKnown ?? true,
    candidateSetId: o?.candidateSetId ?? null,
    entry: o?.entry ?? noEntry,
  })

describe("nudge", () => {
  // nudge-1（§10.4① 迁移）：入口信号① 首次命中 → entry_signal_1 注入一次，事件去重置位
  test("入口信号① 首请求 → entry_signal_1，一次预算，entry_prompted_message_ids 置位", () => {
    const { decision, ledger } = run(newLedger(), "r1", { entry: entry("adm1", true, false) })
    expect(decision).toEqual({ inject: true, reason: "entry_signal_1" })
    expect(ledger.round_used).toBe(1)
    expect(ledger.entry_prompted_message_ids).toEqual(["adm1"])
    expect(ledger.seen_requests).toContain("r1")
  })

  // nudge-2（M0-7 迁移 + §10.3 I2）：同 admitted 消息（新请求）→ entry_already_prompted 不重注入、不消耗
  test("同 admitted id 新请求 → entry_already_prompted 不重注入", () => {
    const l1 = run(newLedger(), "r1", { entry: entry("adm1", true, false) }).ledger
    const { decision, ledger } = run(l1, "r2", { entry: entry("adm1", true, true) })
    expect(decision).toEqual({ inject: false, reason: "entry_already_prompted" })
    expect(ledger.round_used).toBe(1)
  })

  // nudge-3
  test("同 requestId 二次 → duplicate_hook，ledger 深比较不变", () => {
    const l1 = run(newLedger(), "r1", { entry: entry("adm1", true, false) }).ledger
    const { decision, ledger } = run(l1, "r1", { entry: entry("adm1", true, false) })
    expect(decision).toEqual({ inject: false, reason: "duplicate_hook" })
    expect(ledger).toEqual(l1)
  })

  // nudge-4
  test("roundKnown=false → identity_unrecoverable，不注入，requestId 入 seen_requests", () => {
    const { decision, ledger } = run(newLedger(), "r1", { roundKnown: false, entry: entry("adm1", true, false) })
    expect(decision).toEqual({ inject: false, reason: "identity_unrecoverable" })
    expect(ledger.round_used).toBe(0)
    expect(ledger.entry_prompted_message_ids).toEqual([])
    expect(ledger.seen_requests).toContain("r1")
  })

  // nudge-5（C3-①）：已用额度保持，无兜底
  test("round_used=2 后身份丢失 → 新 requestId 仍 identity_unrecoverable", () => {
    const base: NudgeLedger = { ...newLedger(), round_id: "msg1", round_known: true, round_used: 2 }
    const { decision, ledger } = run(base, "r9", { roundKnown: false })
    expect(decision).toEqual({ inject: false, reason: "identity_unrecoverable" })
    expect(ledger.round_used).toBe(2) // 额度不因身份丢失而回收或重置
  })

  // nudge-6（父级 P1 最小反例）：连续 3 个未知身份请求 → 注入 0 次
  test("连续 3 个未知身份请求 → 0 次注入", () => {
    let ledger = newLedger()
    let injected = 0
    for (let i = 0; i < 3; i++) {
      const r = run(ledger, req(), { roundKnown: false })
      if (r.decision.inject) injected++
      ledger = r.ledger
    }
    expect(injected).toBe(0)
  })

  // nudge-7（§10.4 迁移）：三类信号均不成立 → no_signal 零注入、零预算消耗（无每轮下限）
  test("无信号 → no_signal，round_used 不变", () => {
    const base: NudgeLedger = { ...newLedger(), round_id: "msg1", round_known: true }
    const { decision, ledger } = run(base, "r1")
    expect(decision).toEqual({ inject: false, reason: "no_signal" })
    expect(ledger.round_used).toBe(0)
  })

  // nudge-8（fix-4 迁移）：完整轨迹——入口(adm1) → 压力 S1 → roll（两路去重状态保留）→
  // 入口(adm2) 新事件成立 → 同轮 S1 → set_already_prompted（先于预算判定，R3-2）
  test("入口优先注入；同轮压力；roll 后入口新事件再次注入；已提示集合持续抑制", () => {
    const a = run(newLedger(), "r1", { candidateSetId: "S1", entry: entry("adm1", true, false) })
    expect(a.decision).toEqual({ inject: true, reason: "entry_signal_1" })
    expect(a.ledger.round_used).toBe(1)
    expect(a.ledger.entry_prompted_message_ids).toEqual(["adm1"])
    const b = run(a.ledger, "r2", { candidateSetId: "S1" })
    expect(b.decision).toEqual({ inject: true, reason: "pressure_reminder" })
    expect(b.ledger.round_used).toBe(2)
    expect(b.ledger.prompted_set_hashes).toEqual(["S1"])
    const rolled = rollLedgerForNewRound(b.ledger, "adm2")
    const c = run(rolled, "r3", { candidateSetId: "S1", entry: entry("adm2", false, true) })
    expect(c.decision).toEqual({ inject: true, reason: "entry_signal_2" }) // 新 admitted id = 新入口事件
    expect(c.ledger.entry_prompted_message_ids).toEqual(["adm1", "adm2"]) // 跨轮持久
    const d = run(c.ledger, "r4", { candidateSetId: "S1" })
    expect(d.decision).toEqual({ inject: false, reason: "set_already_prompted" })
  })

  // nudge-9（P13 共享预算序列迁移）：入口一次 → 压力 S1 一次 → 新集合 S2 → no_budget
  test("入口+压力共享预算用尽 → no_budget", () => {
    let ledger = newLedger()
    const a = run(ledger, "r1", { entry: entry("adm1", true, false) })
    expect(a.decision.reason).toBe("entry_signal_1")
    ledger = a.ledger
    expect(ledger.round_used).toBe(1)
    const b = run(ledger, "r2", { candidateSetId: "S1" })
    expect(b.decision.reason).toBe("pressure_reminder")
    ledger = b.ledger
    expect(ledger.round_used).toBe(2)
    const c = run(ledger, "r3", { candidateSetId: "S2", entry: entry("adm2", true, false) })
    expect(c.decision).toEqual({ inject: false, reason: "no_budget" }) // 入口同样受 ≤2/轮 上限
  })

  // nudge-10（§10.4 合并语义）：①②同时命中 → entry_signal_merged 一条注入、一次预算
  test("①②同时命中 → entry_signal_merged 一次预算", () => {
    const { decision, ledger } = run(newLedger(), "r1", { entry: entry("adm1", true, true) })
    expect(decision).toEqual({ inject: true, reason: "entry_signal_merged" })
    expect(ledger.round_used).toBe(1)
  })

  // nudge-11（§10.4 入口优先，I3）：同请求入口+压力并存 → 仅入口注入，不落压力
  test("同请求入口+压力并存 → 仅入口（候选集未被提示）", () => {
    const a = run(newLedger(), "r1", { candidateSetId: "S1", entry: entry("adm1", true, false) })
    expect(a.decision.reason).toBe("entry_signal_1")
    expect(a.ledger.prompted_set_hashes).toEqual([]) // 压力机会未被消耗，留给后续请求
    const b = run(a.ledger, "r2", { candidateSetId: "S1" })
    expect(b.decision.reason).toBe("pressure_reminder") // 后续请求符合条件且有剩余额度
  })

  // nudge-12
  test("rollLedgerForNewRound：重置轮内字段，prompted_set_hashes/entry_prompted_message_ids 保留，round_id 更新", () => {
    const l1 = run(newLedger(), "r1", { entry: entry("adm1", true, false), candidateSetId: "S0" }).ledger
    // 压力消耗一次以造 prompted_set_hashes
    const l2 = run(l1, "r2", { candidateSetId: "S1" }).ledger
    const rolled = rollLedgerForNewRound(l2, "msg2")
    expect(rolled.round_id).toBe("msg2")
    expect(rolled.round_used).toBe(0)
    expect(rolled.seen_requests).toEqual([])
    expect(rolled.round_known).toBe(true)
    expect(rolled.prompted_set_hashes).toEqual(l2.prompted_set_hashes) // 无截断淘汰
    expect(rolled.entry_prompted_message_ids).toEqual(l2.entry_prompted_message_ids) // 跨轮持久
  })

  // nudge-13（M0-7）：板操作不触碰 budget——账本仅经 decideNudge/rollLedgerForNewRound 变化
  test("put/index 后 budget 深比较不变", () => {
    const scope: Scope = openScopeForRoot({ rootSessionId: "n13", dataDir: mkdtempSync(join(tmpdir(), "bb-nudge-")) })
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

  // n-red-1（Task C 偏差① G8）：失效侧分支（duplicate_hook）必须落盘——
  // R1：budget.round_known 与 rounds.round_known 双字段同一次 writeMeta 置 false。
  test("n-red-1 duplicate_hook 分支的失效侧必须落盘（含 rounds 联动）", () => {
    const scope: Scope = openScopeForRoot({ rootSessionId: "nred1", dataDir: mkdtempSync(join(tmpdir(), "bb-nudge-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 1, round_known: true, last_admitted_message_id: "adm0" },
      budget: { ...newLedger(), round_id: "adm0", round_known: true, round_used: 1, seen_requests: ["rid"] },
    })
    const d = decideAndPersist(scope, streamId, {
      sessionId: "s",
      requestId: "rid", // 已在 seen_requests → duplicate_hook
      requestVerified: false, // 身份失效（admitted 输入不在本次上下文）
      s1: false,
      s2: false,
      candidateSetId: null,
    })
    expect(d.inject).toBe(false)
    expect(d.reason).toBe("duplicate_hook")
    const after = scope.readMeta(streamId)
    expect(after.budget.round_known).toBe(false) // 修复后：失效侧持久化
    expect(after.rounds.round_known).toBe(false) // R1 双字段同一次落盘
  })

  // n-red-2（Task C Step 2 回归，计划 GC#13）：已提示集 + 身份失效 → roundKnownFor 先判短路，
  // 实际命中 identity_unrecoverable（非 set_already_prompted），两处 round_known 失效落盘。
  test("n-red-2 已提示集 + 身份失效 → identity_unrecoverable 且两处 round_known 落盘 false", () => {
    const scope: Scope = openScopeForRoot({ rootSessionId: "nred2", dataDir: mkdtempSync(join(tmpdir(), "bb-nudge-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 1, round_known: true, last_admitted_message_id: "adm0" },
      budget: { ...newLedger(), round_id: "adm0", round_known: true, round_used: 2, prompted_set_hashes: ["S1"] },
    })
    const d = decideAndPersist(scope, streamId, {
      sessionId: "s",
      requestId: "r9",
      requestVerified: false,
      s1: false,
      s2: false,
      candidateSetId: "S1", // 已提示集合——但身份判定短路置前
    })
    expect(d.inject).toBe(false)
    expect(d.reason).toBe("identity_unrecoverable")
    const after = scope.readMeta(streamId)
    expect(after.budget.round_known).toBe(false)
    expect(after.rounds.round_known).toBe(false)
    expect(after.budget.round_used).toBe(2) // 额度不因身份丢失而重置
    expect(after.budget.prompted_set_hashes).toEqual(["S1"]) // 抑制状态保留
  })

  // n-old-1（§10.3 账本迁移容忍）：旧账本字段残留（快照形态）→ 归一化可读不崩，
  // 且写回即完成字段集迁移（无 snapshot_version/initial_fulfilled/last_shown_seq 残留）。
  test("n-old-1 旧账本字段残留可读不崩，写回迁移为新形状", () => {
    const scope: Scope = openScopeForRoot({ rootSessionId: "nold1", dataDir: mkdtempSync(join(tmpdir(), "bb-nudge-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 1, round_known: false, last_admitted_message_id: "adm0" }, // 身份曾失效 → 走 fix-5 恢复路径
      budget: {
        ...newLedger(),
        round_id: "adm0",
        round_known: true,
        round_used: 1,
        // 旧字段残留（JSON 层面无法经类型表达，运行时容忍）
        ...( { snapshot_version: "v9", initial_fulfilled: true, last_shown_seq: 7 } as Record<string, unknown> ),
        entry_prompted_message_ids: undefined, // 新字段缺失（旧数据）
      } as unknown as NudgeLedger,
    })
    const d = decideAndPersist(scope, streamId, {
      sessionId: "s",
      requestId: "r1",
      requestVerified: true,
      admittedMessageId: "adm0", // 同 admitted id → 身份恢复路径（fix-5）
      s1: true,
      s2: false,
      candidateSetId: null,
    })
    expect(d.identityRestored).toBe(true)
    expect(d.reason).toBe("entry_signal_1") // 缺失的 entry_prompted_message_ids 归一化为 [] → 新入口事件成立
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(2)
    expect(after.budget.entry_prompted_message_ids).toEqual(["adm0"])
    const rawBudget = scope.readMeta(streamId).budget as unknown as Record<string, unknown>
    expect(rawBudget.snapshot_version).toBeUndefined() // 写回完成字段集迁移
    expect(rawBudget.initial_fulfilled).toBeUndefined()
    expect(rawBudget.last_shown_seq).toBeUndefined()
  })

  // n-agg-1（Task B Step 4）：candidateSetIdOf 成员顺序不敏感；空流候选为 null
  test("n-agg-1: candidateSetIdOf 乱序输入同 hash；空流 aggregateCandidates → null", () => {
    const M = (s: string) => ({ id: `bb://sc/st/${s}`, hash: `h${s}` })
    expect(candidateSetIdOf("st", [M("a"), M("b")])).toBe(candidateSetIdOf("st", [M("b"), M("a")]))
    const scope: Scope = openScopeForRoot({ rootSessionId: "nagg1", dataDir: mkdtempSync(join(tmpdir(), "bb-nudge-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    expect(aggregateCandidates(scope, streamId, { sessionId: "s", agent: "build" }, null)).toBeNull()
  })
})

describe("i2 admitted 见识集合（历史 admitted 重放不构成新 admission）", () => {
  const mkScope = (root: string) => {
    const scope: Scope = openScopeForRoot({ rootSessionId: root, dataDir: mkdtempSync(join(tmpdir(), "bb-nudge-")) })
    dirs.push(scope.dir)
    scope.registerSession(root, "build")
    const { streamId } = scope.resolveSession(root)
    scope.writeMeta(streamId, {
      ...scope.readMeta(streamId),
      rounds: { current_round: 1, round_known: true, last_admitted_message_id: "seed" },
      budget: { ...newLedger(), round_id: "seed", round_known: true, round_used: 0 },
    })
    return { scope, streamId }
  }
  const tx = (
    scope: Scope,
    streamId: string,
    requestId: string,
    admittedMessageId: string | null,
    s1: boolean,
    candidateSetId: string | null,
  ) =>
    decideAndPersist(scope, streamId, {
      sessionId: "i2",
      requestId,
      requestVerified: true,
      admittedMessageId,
      s1,
      s2: false,
      candidateSetId,
    })

  // oracle I2 复现轨迹：M1→M2→重放 M1——旧实现 roll 重置预算 + 再次压力注入（M1 共 4 次动态提醒）
  test("i2-replay: M1→M2→replay M1 — zero new injections, budget and round unchanged", () => {
    const { scope, streamId } = mkScope("i2replay")
    const r1 = tx(scope, streamId, "r1", "msg1", true, null)
    expect(r1).toMatchObject({ inject: true, reason: "entry_signal_1", advanced: true })
    const r2 = tx(scope, streamId, "r2", "msg2", true, null)
    expect(r2.inject).toBe(true)
    expect(scope.readMeta(streamId).budget.round_used).toBe(1)
    // 重放 M1（带入口信号与压力候选）→ 非新 admission：零新注入、预算/轮次不变
    const r3 = tx(scope, streamId, "r3", "msg1", true, "S9")
    expect(r3).toEqual({ inject: false, reason: "entry_already_prompted", advanced: false, identityRestored: false })
    const meta = scope.readMeta(streamId)
    expect(meta.budget.round_used).toBe(1)
    expect(meta.budget.round_id).toBe("msg2")
    expect(meta.budget.admitted_seen).toEqual(["seed", "msg1", "msg2"]) // "seed" 来自旧夹具 round_id 证据播种（T6-R3/I1）
    expect(meta.rounds.current_round).toBe(3)
    expect(meta.rounds.last_admitted_message_id).toBe("msg2")
    // 重放 M1（无信号）→ no_signal，同样不消耗
    const r4 = tx(scope, streamId, "r4", "msg1", false, "S9")
    expect(r4).toEqual({ inject: false, reason: "no_signal", advanced: false, identityRestored: false })
    expect(scope.readMeta(streamId).budget.round_used).toBe(1)
  })

  test("i2-ring: evicted-position replay is not treated as new admission (I2-R)", () => {
    const { scope, streamId } = mkScope("i2ring")
    // M1→M10 依次处理——旧环形实现下 m1/m2 已被挤出 admitted_seen
    for (let i = 1; i <= 10; i++) tx(scope, streamId, `r${i}`, `m${i}`, false, null)
    const meta = scope.readMeta(streamId)
    expect(meta.budget.admitted_seen).toEqual(["seed", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]) // 无界：不淘汰；"seed" 为证据播种
    expect(meta.budget.round_used).toBe(0)
    expect(meta.rounds.current_round).toBe(11)
    // 淘汰位次的旧 ID（环形旧实现下 m1 已不在集合中）重放 + 新压力集合：
    // 不得当新 admission——不 advanced、不重置预算、不注入（否则 ring 淘汰即伪造新颖性）
    const replay = tx(scope, streamId, "r11", "m1", false, "S9")
    expect(replay).toEqual({ inject: false, reason: "no_signal", advanced: false, identityRestored: false })
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(0)
    expect(after.rounds.current_round).toBe(11)
    expect(after.budget.admitted_seen).toEqual(["seed", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"])
  })

  test("i2-legacy: ledger without admitted_seen — evidenced replay is not a new admission (T6-R3/I1)", () => {
    const { scope, streamId } = mkScope("i2legacy")
    // 旧账本（v1.4.5 前形状）：M1 已耗尽两次提醒、入口已提示，无 admitted_seen 字段
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 1, round_known: true, last_admitted_message_id: "M1" },
      budget: {
        ...newLedger(),
        round_id: "M1",
        round_known: true,
        round_used: 2,
        entry_prompted_message_ids: ["M1"],
        admitted_seen: [],
      },
    })
    const r2 = tx(scope, streamId, "r2", "M2", false, null) // 新输入 M2：正常新 admission
    expect(r2.advanced).toBe(true)
    // oracle 场景：重放 M1（带新压力集合 S2）——播种历史应识别为已处理：
    // 不 advanced、不重置预算、不注入、round 不虚增
    const replay = tx(scope, streamId, "r3", "M1", true, "S2")
    expect(replay).toEqual({ inject: false, reason: "entry_already_prompted", advanced: false, identityRestored: false }) // 入口去重先行；压力侧亦被见识集合抑制
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(0) // 不重置预算（M2 的合法重置后保持 0）
    expect(after.rounds.current_round).toBe(2) // M2 推进一次，重放不虚增
    expect(after.budget.admitted_seen).toEqual(["M1", "M2"]) // 播种自 round_id/entry 证据
  })

  test("i2-legacy2: non-empty but incomplete admitted_seen — merge recovers lost evidence (T6-R4/I1-A)", () => {
    const { scope, streamId } = mkScope("i2legacy2")
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 1, round_known: true, last_admitted_message_id: "M2" },
      budget: {
        ...newLedger(),
        round_id: "M2",
        round_known: true,
        round_used: 1,
        admitted_seen: ["M2"], // 非空但不完整：M1 的证据只剩 entry_prompted 承载
        entry_prompted_message_ids: ["M1"],
      },
    })
    // 重放 M1——无条件合并前：M1 ∉ seen → 误判新 admission（roll + 预算重置）
    const replay = tx(scope, streamId, "r1", "M1", true, "S2")
    expect(replay).toEqual({ inject: false, reason: "entry_already_prompted", advanced: false, identityRestored: false })
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(1) // 不重置
    expect(after.rounds.current_round).toBe(1) // 不虚增
    // 合并即时生效于判定（M1 被识别为已处理）；重放不写盘——合并后的见识集合
    // 随下次账本变更写自然持久化，存储仍为夹具原值
    expect(after.budget.admitted_seen).toEqual(["M2"])
  })

  test("i2-replay-entry: replay without recoverable entry history must not spend current round's entry budget (T6-R4/I1-B)", () => {
    const { scope, streamId } = mkScope("i2replayentry")
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 1, round_known: true, last_admitted_message_id: "M1" },
      budget: {
        ...newLedger(),
        round_id: "M1",
        round_known: true,
        admitted_seen: ["M1"], // 入口历史缺失（entry_prompted 无 M1）——oracle 场景
      },
    })
    const r2 = tx(scope, streamId, "r2", "M2", false, null) // 新输入 M2：正常新 admission
    expect(r2.advanced).toBe(true)
    const replay = tx(scope, streamId, "r3", "M1", true, null) // 重放 M1 且带入口信号 s1
    expect(replay.inject).toBe(false) // 入口与压力一并保守抑制
    expect(replay.advanced).toBe(false)
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(0) // 不偷现轮入口额度（DESIGN:317 预算依附业务输入）
    expect(after.rounds.current_round).toBe(2) // M2 推进一次，重放不虚增
  })
})
