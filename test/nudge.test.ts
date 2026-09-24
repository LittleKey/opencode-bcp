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
const run = (ledger: NudgeLedger, requestId: string, o?: { roundKnown?: boolean; candidateSetId?: string | null }) =>
  decideNudge(ledger, {
    requestId,
    roundKnown: o?.roundKnown ?? true,
    candidateSetId: o?.candidateSetId ?? null,
  })

describe("nudge", () => {
  // nudge-3
  test("同 requestId 二次 → duplicate_hook，ledger 深比较不变", () => {
    const l1 = run(newLedger(), "r1").ledger
    const { decision, ledger } = run(l1, "r1")
    expect(decision).toEqual({ inject: false, reason: "duplicate_hook" })
    expect(ledger).toEqual(l1)
  })

  // nudge-4
  test("roundKnown=false → identity_unrecoverable，不注入，requestId 入 seen_requests", () => {
    const { decision, ledger } = run(newLedger(), "r1", { roundKnown: false })
    expect(decision).toEqual({ inject: false, reason: "identity_unrecoverable" })
    expect(ledger.round_used).toBe(0)
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

  // nudge-7（§10.7 无下限；v1.6.0 起 no_signal = 无压力可注入）
  test("无压力候选 → no_signal，round_used 不变", () => {
    const base: NudgeLedger = { ...newLedger(), round_id: "msg1", round_known: true }
    const { decision, ledger } = run(base, "r1")
    expect(decision).toEqual({ inject: false, reason: "no_signal" })
    expect(ledger.round_used).toBe(0)
  })

  // nudge-8（v1.6.0 压力轨迹迁移）：S1 注入 → 同轮同集合抑制 → roll 后抑制跨轮持续 → 新集合符合条件且有剩余额度再注入
  test("压力注入；同集合持续抑制（跨轮）；新集合再注入", () => {
    const a = run(newLedger(), "r1", { candidateSetId: "S1" })
    expect(a.decision).toEqual({ inject: true, reason: "pressure_reminder" })
    expect(a.ledger.round_used).toBe(1)
    expect(a.ledger.prompted_set_hashes).toEqual(["S1"])
    const b = run(a.ledger, "r2", { candidateSetId: "S1" })
    expect(b.decision).toEqual({ inject: false, reason: "set_already_prompted" })
    const rolled = rollLedgerForNewRound(b.ledger, "adm2")
    const c = run(rolled, "r3", { candidateSetId: "S1" })
    expect(c.decision).toEqual({ inject: false, reason: "set_already_prompted" }) // 跨轮持续抑制（§10.3）
    expect(c.ledger.round_used).toBe(0)
    const d = run(c.ledger, "r4", { candidateSetId: "S2" })
    expect(d.decision).toEqual({ inject: true, reason: "pressure_reminder" }) // 新集合 + 剩余额度
  })

  // nudge-9（P13 预算序列迁移）：两个新集合各一次 → 额度 2/2 → 第三个集合 no_budget
  test("连续压力注入耗尽预算 → no_budget", () => {
    let ledger = newLedger()
    const a = run(ledger, "r1", { candidateSetId: "S1" })
    expect(a.decision.reason).toBe("pressure_reminder")
    ledger = a.ledger
    expect(ledger.round_used).toBe(1)
    const b = run(ledger, "r2", { candidateSetId: "S2" })
    expect(b.decision.reason).toBe("pressure_reminder")
    ledger = b.ledger
    expect(ledger.round_used).toBe(2)
    const c = run(ledger, "r3", { candidateSetId: "S3" })
    expect(c.decision).toEqual({ inject: false, reason: "no_budget" })
  })

  // nudge-12
  test("rollLedgerForNewRound：重置轮内字段，prompted_set_hashes/entry_prompted_message_ids 保留，round_id 更新", () => {
    const l1 = run(newLedger(), "r1", { candidateSetId: "S0" }).ledger
    // 压力消耗一次以造 prompted_set_hashes
    const l2 = run(l1, "r2", { candidateSetId: "S1" }).ledger
    const rolled = rollLedgerForNewRound(l2, "msg2")
    expect(rolled.round_id).toBe("msg2")
    expect(rolled.round_used).toBe(0)
    expect(rolled.seen_requests).toEqual([])
    expect(rolled.round_known).toBe(true)
    expect(rolled.prompted_set_hashes).toEqual(l2.prompted_set_hashes) // 无截断淘汰
    expect(rolled.entry_prompted_message_ids).toEqual(l2.entry_prompted_message_ids) // §10.7 旧账本历史证据跨轮持久
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
      candidateSetId: null,
    })
    expect(d.identityRestored).toBe(true)
    expect(d.reason).toBe("no_signal") // 无压力候选 → 零注入（v1.6.0 起入口注入已退役）
    expect(d.inject).toBe(false)
    expect(d.advanced).toBe(false)
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(1) // 恢复路径不消耗额度
    expect(after.budget.entry_prompted_message_ids).toEqual([]) // 缺失字段归一化为 []
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
    candidateSetId: string | null,
  ) =>
    decideAndPersist(scope, streamId, {
      sessionId: "i2",
      requestId,
      requestVerified: true,
      admittedMessageId,
      candidateSetId,
    })

  // oracle I2 复现轨迹（v1.6.0 迁移）：M1→M2→重放 M1——零新注入、预算/轮次不变
  test("i2-replay: M1→M2→replay M1 — zero new injections, budget and round unchanged", () => {
    const { scope, streamId } = mkScope("i2replay")
    const r1 = tx(scope, streamId, "r1", "msg1", null)
    expect(r1).toEqual({ inject: false, reason: "no_signal", advanced: true, identityRestored: false })
    const r2 = tx(scope, streamId, "r2", "msg2", null)
    expect(r2.advanced).toBe(true)
    expect(scope.readMeta(streamId).budget.round_used).toBe(0)
    // 重放 M1（带压力候选）→ 非新 admission：零新注入、预算/轮次不变（候选集被见识集合抑制）
    const r3 = tx(scope, streamId, "r3", "msg1", "S9")
    expect(r3).toEqual({ inject: false, reason: "no_signal", advanced: false, identityRestored: false })
    const meta = scope.readMeta(streamId)
    expect(meta.budget.round_used).toBe(0)
    expect(meta.budget.round_id).toBe("msg2")
    expect(meta.budget.admitted_seen).toEqual(["seed", "msg1", "msg2"]) // "seed" 来自旧夹具 round_id 证据播种（T6-R3/I1）
    expect(meta.rounds.current_round).toBe(3)
    expect(meta.rounds.last_admitted_message_id).toBe("msg2")
    // 再次重放 M1 → no_signal，同样不消耗
    const r4 = tx(scope, streamId, "r4", "msg1", "S9")
    expect(r4).toEqual({ inject: false, reason: "no_signal", advanced: false, identityRestored: false })
    expect(scope.readMeta(streamId).budget.round_used).toBe(0)
  })

  test("i2-ring: evicted-position replay is not treated as new admission (I2-R)", () => {
    const { scope, streamId } = mkScope("i2ring")
    // M1→M10 依次处理——旧环形实现下 m1/m2 已被挤出 admitted_seen
    for (let i = 1; i <= 10; i++) tx(scope, streamId, `r${i}`, `m${i}`, null)
    const meta = scope.readMeta(streamId)
    expect(meta.budget.admitted_seen).toEqual(["seed", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]) // 无界：不淘汰；"seed" 为证据播种
    expect(meta.budget.round_used).toBe(0)
    expect(meta.rounds.current_round).toBe(11)
    // 淘汰位次的旧 ID（环形旧实现下 m1 已不在集合中）重放 + 新压力集合：
    // 不得当新 admission——不 advanced、不重置预算、不注入（否则 ring 淘汰即伪造新颖性）
    const replay = tx(scope, streamId, "r11", "m1", "S9")
    expect(replay).toEqual({ inject: false, reason: "no_signal", advanced: false, identityRestored: false })
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(0)
    expect(after.rounds.current_round).toBe(11)
    expect(after.budget.admitted_seen).toEqual(["seed", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"])
  })

  // oracle 回归③（DESIGN §14.4 :754，§10.7 迁移约束行为化）：历史 ID 仅存旧入口字段
  // （entry_prompted_message_ids、admitted_seen 字段真实缺失）→ 重放不增轮、不重置额度、
  // 不取得新提醒额度。夹具无旁路：round_id/last 均为 M2（不再播种 M1），M1 唯一证据
  // 载体是 entry_prompted_message_ids 合并；预算 2/2 保留（不先执行合法 admission 归零）。
  test("v16-3: legacy entry-only ledger — evidenced replay neither advances nor re-earns reminder quota", () => {
    const { scope, streamId } = mkScope("v16legacy")
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 7, round_known: true, last_admitted_message_id: "M2" },
      budget: {
        round_id: "M2",
        round_known: true,
        round_used: 2,
        seen_requests: [],
        prompted_set_hashes: ["S1"],
        entry_prompted_message_ids: ["M1"],
        // admitted_seen 真实省略（旧数据缺字段，非空数组）
      } as unknown as NudgeLedger,
    })
    // 用新 request ID + 新候选集直接重放 M1：若 entry 合并被删，M1 无证据 → 误判新
    // admission（advanced + roll 归零 + 消耗新集合）；合并在位 → no_signal、状态保持。
    const replay = tx(scope, streamId, "r-replay", "M1", "S2")
    expect(replay).toEqual({ inject: false, reason: "no_signal", advanced: false, identityRestored: false })
    const after = scope.readMeta(streamId)
    expect(after.rounds.current_round).toBe(7) // 不推进轮次
    expect(after.rounds.last_admitted_message_id).toBe("M2") // 轮次身份不变
    expect(after.budget.round_id).toBe("M2")
    expect(after.budget.round_used).toBe(2) // 预算仍为 2（不重置、不消耗）
    expect(after.budget.prompted_set_hashes).toEqual(["S1"]) // 既有候选集抑制保留
    expect(after.budget.admitted_seen).toContain("M1") // M1 历史证据被恢复（合并后随本次账本写持久化）
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
    const replay = tx(scope, streamId, "r1", "M1", "S2")
    expect(replay).toEqual({ inject: false, reason: "no_signal", advanced: false, identityRestored: false })
    // 合并即时生效于判定（M1 被识别为已处理）；重放不增轮、不重置额度、不注入。
    // requestId 登记与合并后的见识集合（["M2","M1"]）随该次账本变更写持久化——证据恢复落盘，无副作用。
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(1) // 不重置
    expect(after.rounds.current_round).toBe(1) // 不虚增
    expect(after.budget.admitted_seen).toEqual(["M2", "M1"]) // 合并恢复的证据已持久化
  })
})
