// Nudge 设计（DESIGN v1.4.7 §10，事件驱动的固定模板提醒，可误中的词法提醒机制）。
// 自动注入只发生在明确可机械判定的信号上（§10.4 ①②入口词法信号 / ③聚合压力），
// 提醒为常量模板、不含板数据；零信号零注入，无"每轮至少一次"下限（§10.7 已废除）。
// 父级 P1：无兜底额度；C3：账本唯一且原子。
import type { BudgetLedger, StreamMeta, Scope } from "./storage"
import { applyInput } from "./rounds"

// 与 StreamMeta.budget 同一形状（storage 落盘类型），单一事实来源，避免双处漂移。
export type NudgeLedger = BudgetLedger

export function newLedger(): NudgeLedger {
  return {
    round_id: null,
    round_known: false,
    round_used: 0,
    seen_requests: [],
    prompted_set_hashes: [],
    entry_prompted_message_ids: [],
    admitted_seen: [],
  }
}

// 仅在正面识别新 admitted input 时调用（唯一的额度重置路径）。
// prompted_set_hashes 与 entry_prompted_message_ids 原样保留——集合抑制与入口事件
// 去重均跨轮持续，无截断淘汰（§10.3）。
export function rollLedgerForNewRound(ledger: NudgeLedger, roundId: string): NudgeLedger {
  return {
    ...ledger,
    round_id: roundId,
    round_used: 0,
    seen_requests: [],
    round_known: true,
  }
}

export type NudgeReason =
  | "entry_signal_1"
  | "entry_signal_2"
  | "entry_signal_merged"
  | "entry_already_prompted"
  | "pressure_reminder"
  | "duplicate_hook"
  | "no_budget"
  | "set_already_prompted"
  | "identity_unrecoverable"
  | "no_signal"

/** 入口机会输入：messageId = 经准入关联验证的 admitted messageId（§10.3 I2 入口事件身份） */
export type EntrySignal = { messageId: string | null; s1: boolean; s2: boolean }

// 纯函数。决策顺序每步命中即返回（fix-4 保留）：
// 入口机会优先于压力机会（§10.4：同一请求同时满足入口与压力条件时入口优先，
// 压力仅在后续符合条件且有剩余额度时提示）——入口注入即 return，本请求不再落压力。
// 入口用 entry_prompted_message_ids 去重（事件去重，重放/工具循环/continuation/重启
// 不产生新入口事件），压力用 prompted_set_hashes 去重（跨轮持续抑制），两类独立。
export function decideNudge(
  ledger: NudgeLedger,
  input: { requestId: string; roundKnown: boolean; candidateSetId: string | null; entry: EntrySignal },
): { decision: { inject: boolean; reason: NudgeReason }; ledger: NudgeLedger } {
  // 1. 同请求重复 hook 不重复消耗
  if (ledger.seen_requests.includes(input.requestId)) {
    return { decision: { inject: false, reason: "duplicate_hook" }, ledger: { ...ledger } }
  }
  // 2. 身份不可恢复：requestId 入 seen_requests（防同请求反复评估）；额度不变、保守抑制
  if (!input.roundKnown) {
    return {
      decision: { inject: false, reason: "identity_unrecoverable" },
      ledger: { ...ledger, seen_requests: [...ledger.seen_requests, input.requestId] },
    }
  }
  // 3. 入口机会：s1||s2 且该 admitted 消息未提示过 → 一条入口提醒、一次预算（①②合并不重复）；
  //    与压力共享轮次预算 ≤2（额度耗尽 → no_budget；去重判定先于预算——已提示过即 entry_already_prompted）
  const entryHit = input.entry.messageId !== null && (input.entry.s1 || input.entry.s2)
  const entryPending =
    input.entry.messageId !== null && entryHit && !ledger.entry_prompted_message_ids.includes(input.entry.messageId)
  if (entryPending && ledger.round_used >= 2) {
    return { decision: { inject: false, reason: "no_budget" }, ledger: { ...ledger } }
  }
  if (entryPending && input.entry.messageId !== null) {
    const reason: NudgeReason =
      input.entry.s1 && input.entry.s2
        ? "entry_signal_merged"
        : input.entry.s1
          ? "entry_signal_1"
          : "entry_signal_2"
    return {
      decision: { inject: true, reason },
      ledger: {
        ...ledger,
        round_used: ledger.round_used + 1,
        entry_prompted_message_ids: [...ledger.entry_prompted_message_ids, input.entry.messageId],
        seen_requests: [...ledger.seen_requests, input.requestId],
      },
    }
  }
  // 4. 无压力候选：入口信号存在但已提示过 → entry_already_prompted；否则零信号 → no_signal
  if (input.candidateSetId === null) {
    return { decision: { inject: false, reason: entryHit ? "entry_already_prompted" : "no_signal" }, ledger: { ...ledger } }
  }
  // 5. 压力机会：同一候选集自动提示一次后持续抑制；先判集合——round_used=2 亦返回 set_already_prompted（R3-2）
  if (ledger.prompted_set_hashes.includes(input.candidateSetId)) {
    return { decision: { inject: false, reason: entryHit ? "entry_already_prompted" : "set_already_prompted" }, ledger: { ...ledger } }
  }
  // 6. 轮次预算 ≤2（入口与压力共享同一剩余额度，压力注入前显式预算检查）
  if (ledger.round_used >= 2) {
    return { decision: { inject: false, reason: "no_budget" }, ledger: { ...ledger } }
  }
  // 7. 注入压力提醒
  return {
    decision: { inject: true, reason: "pressure_reminder" },
    ledger: {
      ...ledger,
      round_used: ledger.round_used + 1,
      prompted_set_hashes: [...ledger.prompted_set_hashes, input.candidateSetId], // 无截断
      seen_requests: [...ledger.seen_requests, input.requestId],
    },
  }
}

// roundKnown 的唯一判定入口（C3-③，父级 P12）。
// requestVerified = 本次请求的身份验证结果；验证失败/不可验证 → 立即 false，
// 即使旧持久字段相等（P12）。
export function roundKnownFor(
  ledger: NudgeLedger,
  rounds: StreamMeta["rounds"],
  requestVerified: boolean,
): boolean {
  return (
    requestVerified &&
    rounds.round_known &&
    rounds.last_admitted_message_id === ledger.round_id &&
    ledger.round_id !== null
  )
}

export type DecideAndPersistInput = {
  sessionId: string
  requestId: string
  requestVerified: boolean
  /** 本次关联验证的 admitted messageId（Task C 偏差②：仅 transform 侧提供；推进/恢复唯一入口） */
  admittedMessageId?: string | null
  /** 入口信号①②（transform 对 admitted 消息文本 detectSignals 的结果） */
  s1: boolean
  s2: boolean
  candidateSetId: string | null
  // 同步测试交错点（父级 F2：无 Promise，Atomics.wait/同步自旋阻塞，与同步签名一致）：
  // 正确实现下持锁暂停 → 他进程 lock_timeout 冲突报告。
  raceProbe?: { afterRead: () => void }
}

export type DecideAndPersistResult = {
  inject: boolean
  reason: NudgeReason
  /** 本次请求使轮次推进（新 admitted id → applyInput + rollLedgerForNewRound） */
  advanced: boolean
  /** 同 admitted id 复验恢复两处 round_known（不增轮、不 roll 额度/去重，fix-5） */
  identityRestored: boolean
}

// 旧账本（v1.4.7 前快照形态）读时归一化：缺字段补默认、多字段忽略（fsck 不校验
// budget 字段集）；归一化后写回即完成字段集迁移，新账本不再含已废除字段。
function normalizeBudget(raw: BudgetLedger): NudgeLedger {
  // T6-R4/I1-A：无条件合并 admission 证据——"非空"不得当作"完整"：旧形态可能只有
  // 部分见识（如 admitted_seen=[M2] 而 entry_prompted=[M1]），缺项会把历史重放误判为
  // 新 admission（无法证明的新颖性不发额度）。新账本中 round_id/entry ids 本就是
  // admitted_seen 子集，合并幂等。顺序：seen → entry → round_id（round_id 为最新 id，
  // 置末使 roll 后的当前 id 不会翻到队首，保持历史顺序稳定）。
  const seen = Array.from(
    new Set(
      [...(raw.admitted_seen ?? []), ...(raw.entry_prompted_message_ids ?? []), raw.round_id].filter(
        (x): x is string => typeof x === "string" && x !== "",
      ),
    ),
  )
  return {
    round_id: raw.round_id ?? null,
    round_known: !!raw.round_known,
    round_used: raw.round_used ?? 0,
    seen_requests: raw.seen_requests ?? [],
    prompted_set_hashes: raw.prompted_set_hashes ?? [],
    entry_prompted_message_ids: raw.entry_prompted_message_ids ?? [],
    admitted_seen: seen,
  }
}

// 锁内事务的完整决策流程——Task 5 ④ 的唯一实现：
// withLock 内重读 meta → raceProbe.afterRead（同步）→ 旧账本归一化 → 关联验证事务
// （G7：轮次推进/身份恢复只在此处落地，接收侧仅登记）→ roundKnownFor → decideNudge
// → 值快照比较（Task C 偏差①）→ writeMeta 条件 = advanced ∨ identityRestored ∨ 账本
// 任一字段变化（R1：unknown 不注入也必须持久化——两处 round_known 的失效/恢复不落盘，
// put 侧就会读到旧状态）。退出锁后由调用方注入；Task 5 transform 与
// scripts/budget-race.ts 子进程都只调用它，保证测试与生产同一代码路径。
export function decideAndPersist(scope: Scope, streamId: string, input: DecideAndPersistInput): DecideAndPersistResult {
  return scope.withLock(() => {
    const meta = scope.readMeta(streamId)
    input.raceProbe?.afterRead()
    // G7（计划 Task C Step 4）：轮次推进/身份恢复在锁内关联验证事务中落地。
    const base = normalizeBudget(meta.budget)
    // I2：历史 admitted 重放（id 已见识但不是最近一个）——非新 admission：
    // 不推进轮次、不重置预算；动态提醒保守抑制（压力候选置 null；入口去重由
    // entry_prompted_message_ids 承载）。DESIGN:315-324 同一业务输入不产生新事件。
    const replayedAdmitted =
      input.admittedMessageId != null &&
      input.admittedMessageId !== meta.rounds.last_admitted_message_id &&
      base.admitted_seen.includes(input.admittedMessageId)
    // T6-R4/I1-B：已判定历史重放且该消息入口历史不可恢复（不在 entry_prompted 中）→
    // 入口提醒与压力提醒一并保守抑制——历史业务输入不得消费现轮入口额度
    // （DESIGN.md:317 预算依附于单个已识别业务输入；:323 同一业务输入不产生新事件）。
    const replayedEntryUnproven =
      replayedAdmitted &&
      input.admittedMessageId != null &&
      !base.entry_prompted_message_ids.includes(input.admittedMessageId)
    let mutable: StreamMeta = { ...meta, budget: base }
    let advanced = false
    let identityRestored = false
    if (input.requestVerified && input.admittedMessageId) {
      if (input.admittedMessageId === meta.rounds.last_admitted_message_id && !meta.rounds.round_known) {
        // 同 admitted id 恢复（fix-5）：不增轮、不 roll 额度/去重，仅恢复两处 round_known
        mutable = {
          ...meta,
          rounds: { ...meta.rounds, round_known: true },
          budget: { ...base, round_known: true },
        }
        identityRestored = true
      } else if (input.admittedMessageId !== meta.rounds.last_admitted_message_id) {
        if (!replayedAdmitted) {
          // 新 admitted id：轮次推进 + 唯一额度重置路径（roll）+ 见识集合登记
          // （I2-R：无界集合——缓存未命中不构成新颖性证明，被淘汰旧 ID 重放同样受抑）
          const rounds = applyInput(meta.rounds, "admitted_input", input.admittedMessageId)
          mutable = {
            ...meta,
            rounds,
            budget: {
              ...rollLedgerForNewRound(base, input.admittedMessageId),
              admitted_seen: [...base.admitted_seen, input.admittedMessageId],
            },
          }
          advanced = true
        }
        // replayedAdmitted：历史 admitted 重放——不推进、不重置（candidateSetId 已在下方抑制）
      }
    }
    const roundKnown = roundKnownFor(mutable.budget, mutable.rounds, input.requestVerified)
    // Task C 偏差①：decideNudge 的输入是全新对象，返回 ledger 一律按值快照比较
    const snapshot: NudgeLedger = { ...mutable.budget, round_known: roundKnown }
    const { decision, ledger } = decideNudge(snapshot, {
      requestId: input.requestId,
      roundKnown,
      candidateSetId: replayedAdmitted ? null : input.candidateSetId,
      entry: {
        messageId: replayedEntryUnproven ? null : (input.admittedMessageId ?? null),
        s1: !replayedEntryUnproven && input.s1,
        s2: !replayedEntryUnproven && input.s2,
      },
    })
    const changed =
      ledger.round_known !== base.round_known ||
      ledger.round_used !== base.round_used ||
      ledger.seen_requests.join("\n") !== base.seen_requests.join("\n") ||
      ledger.prompted_set_hashes.join("\n") !== base.prompted_set_hashes.join("\n") ||
      ledger.entry_prompted_message_ids.join("\n") !== base.entry_prompted_message_ids.join("\n")
    if (advanced || identityRestored || changed) {
      // P12/R1：身份状态变化（失效或恢复）必须同时持久化两处 round_known——
      // budget 侧（nudge）与 rounds 侧（board.put 的 created_round 读取处）。
      scope.writeMeta(streamId, {
        ...mutable,
        rounds: { ...mutable.rounds, round_known: ledger.round_known },
        budget: ledger,
      })
    }
    return { inject: decision.inject, reason: decision.reason, advanced, identityRestored }
  })
}
