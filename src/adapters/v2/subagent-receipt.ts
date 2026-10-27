// 原生后台子代理交付回执(DESIGN §11.9 冻结契约 + §16.7 生命周期接线)。
//
// 范围(冻结):首期仅处理 BCP v2 后台 context 中可回查的宿主 subagent 完成通知
// (宿主 tag v2.1.4,commit 68bc26b):通知 = 父会话 synthetic 消息
// {id:notificationID,metadata:{source:"subagent",childID,agent,state},text:
// `<subagent sessionID="${child}" state="${state}" description="${desc}">\n${text}\n</subagent>`}
// (subagent-completion.ts:8-19/31-45 裸插值模板;state/description 无转义)。
// 宿主来源选取(subagent-job.ts:53-60):子会话 messages(desc,limit:20) 中 find
// (type==="assistant" && time.completed!==undefined && error===undefined)——不限终稿。
// 交付证明(R8.3):session.inbox.delivered{sessionID,inboxID}
// (schema/session-event.ts:208-218;inbox.ts promote 逐行发布,inboxID==synthetic
// inputID==通知消息 id)。仅 context 看见通知不构成账本已追平的证明。
//
// R8 域定义:有界来源域 = 有完整起点和已确认观察终点的来源前缀。起点 = 经 subagent
// 工具调用观察到的「新建」子会话(input.sessionID 缺失);fork/恢复/导入/起点未知
// 永不新关联。compaction/revert/覆盖缺口/容量淘汰 → 该子会话关联资格整体失效,
// 不从剩余窗口自动恢复。订阅/处理异常 → 全部失效(R8 降级表)。
//
// 一切无法证明的情形静默保留原文;本模块只改本次请求的展示副本(input.messages 的
// draft 数组槽位浅拷贝替换),永不修改宿主持久历史,不放宽既有发布/授权保护。
// 回执路径任何错误只记日志,不触发插件全局 degrade。

import { createHash } from "node:crypto"
import type { WireMessage } from "./snapshot"

// 宿主 NO_TEXT 逐字(subagent-completion.ts:9;插件无法 import 宿主内部,本地复刻)。
export const SUBAGENT_NO_TEXT = "Subagent completed without a text response."

// 回执两行(冻结文案,附在通知正文末尾,空行分隔)。
export const receiptTail = (id: string): string =>
  `\n\nRetained: ${id}\nBefore relying on this result, read the original with board_get and check its version and limits; retention is not acceptance.`

const idempotencyProbe = (id: string): string => `Retained: ${id}\nBefore relying on this result`

// ---- 有界容量(R8.4:容量淘汰 = 对应资格整体失效,直接删除,不留残域) ----
export const CHILDREN_CAP = 32 // 追踪子会话数(Map 插入序,超出删最旧)
const DESCRIPTIONS_CAP = 8 // 同一子会话的派发描述代次(续跑新代次)
const INPUT_IDS_CAP = 16 // 子会话观察到的输入消息 ID(session.inbox.enqueued)
const DELIVERED_PARENTS_CAP = 64 // delivered 账本父会话数
const DELIVERED_PER_PARENT_CAP = 128 // 每父会话 inboxID 上限

export type ChildObservation = {
  parentID: string
  childID: string
  descriptions: string[]
  inputIDs: string[]
  assistants: Map<string, { ordinals: Map<number, string>; finish?: string }>
  invalid?: string
}

/**
 * 子会话观察账本(R8 有界来源域)。只登记经 subagent 工具观察到的「新建」子会话;
 * 起点未知的子会话事件一律忽略(账本只更新已存在 entry)。
 */
export class SubagentReceiptLedger {
  private children = new Map<string, ChildObservation>()
  private delivered = new Map<string, Set<string>>()

  /** 派发观察(tool execute.after,subagent 且 input.sessionID 缺失 → 新建子会话)。 */
  observeDispatch(parentID: string, childID: string, description: string): void {
    if (!parentID || !childID || !description) return
    const existing = this.children.get(childID)
    if (existing) {
      // 同 childID 归属到另一父会话 → 按归属不可证降级(删除旧档,按新观察重建)。
      if (existing.parentID !== parentID) {
        this.children.delete(childID)
      } else {
        if (!existing.invalid && !existing.descriptions.includes(description)) {
          existing.descriptions.push(description)
          if (existing.descriptions.length > DESCRIPTIONS_CAP) existing.descriptions.shift()
        }
        return
      }
    }
    this.children.set(childID, {
      parentID,
      childID,
      descriptions: [description],
      inputIDs: [],
      assistants: new Map(),
    })
    this.evictChildren()
  }

  /** 续跑观察(tool execute.after,input.sessionID 指向已追踪子会话 → 新描述代次)。 */
  observeContinuation(parentID: string, childID: string, description: string): void {
    if (!parentID || !childID || !description) return
    const entry = this.children.get(childID)
    if (!entry || entry.invalid || entry.parentID !== parentID) return
    if (!entry.descriptions.includes(description)) {
      entry.descriptions.push(description)
      if (entry.descriptions.length > DESCRIPTIONS_CAP) entry.descriptions.shift()
    }
  }

  /** 子会话输入观察(session.inbox.enqueued;steer 等不经 prompt hook 的输入由此覆盖)。 */
  observeChildInput(sessionID: string, inboxID: string): void {
    if (!sessionID || !inboxID) return
    const entry = this.children.get(sessionID)
    if (!entry || entry.invalid) return
    if (!entry.inputIDs.includes(inboxID)) {
      entry.inputIDs.push(inboxID)
      if (entry.inputIDs.length > INPUT_IDS_CAP) entry.inputIDs.shift()
    }
  }

  /** 交付观察(session.inbox.delivered;父会话维度,按 inboxID==notificationID 关联)。 */
  observeDelivered(parentID: string, inboxID: string): void {
    if (!parentID || !inboxID) return
    let set = this.delivered.get(parentID)
    if (!set) {
      set = new Set()
      this.delivered.set(parentID, set)
      this.evictDelivered()
    }
    if (!set.has(inboxID)) {
      if (set.size >= DELIVERED_PER_PARENT_CAP) {
        const oldest = set.values().next().value
        if (oldest !== undefined) set.delete(oldest)
      }
      set.add(inboxID)
    }
  }

  /** 子会话文本段观察(session.text.ended;ordinal 冲突 → 原文不稳定,整体失效)。 */
  observeChildText(sessionID: string, messageID: string, ordinal: number, text: string): void {
    if (!sessionID || !messageID) return
    const entry = this.children.get(sessionID)
    if (!entry || entry.invalid) return
    if (!Number.isInteger(ordinal) || ordinal < 0 || typeof text !== "string") {
      entry.invalid = "malformed_event"
      return
    }
    let obs = entry.assistants.get(messageID)
    if (!obs) {
      obs = { ordinals: new Map() }
      entry.assistants.set(messageID, obs)
    }
    const prev = obs.ordinals.get(ordinal)
    if (prev !== undefined && prev !== text) {
      entry.invalid = "text_rewind"
      return
    }
    obs.ordinals.set(ordinal, text)
  }

  /** 子会话步进完成观察(session.step.ended;finish 冲突 → 原文不稳定,整体失效)。 */
  observeChildFinish(sessionID: string, messageID: string, finish: string): void {
    if (!sessionID || !messageID || !finish) return
    const entry = this.children.get(sessionID)
    if (!entry || entry.invalid) return
    const obs = entry.assistants.get(messageID)
    if (!obs) return
    if (obs.finish !== undefined && obs.finish !== finish) {
      entry.invalid = "finish_rewind"
      return
    }
    obs.finish = finish
  }

  /** 资格失效(compaction/revert/forked/覆盖缺口;不删已留存记录,仅禁止新关联)。 */
  invalidate(sessionID: string, reason: string): void {
    const entry = this.children.get(sessionID)
    if (entry && !entry.invalid) entry.invalid = reason
  }

  /** 会话删除(session.deleted):删该会话账目 + 其名下派发与其 delivered 集。 */
  forgetSession(sessionID: string): void {
    this.children.delete(sessionID)
    this.delivered.delete(sessionID)
    for (const [id, entry] of this.children) {
      if (entry.parentID === sessionID) this.children.delete(id)
    }
  }

  /** 订阅/处理异常(R8:不以「没观察到事件」证明没变化 → 全部失效)。 */
  resetAll(): void {
    this.children.clear()
    this.delivered.clear()
  }

  hasDelivered(parentID: string, inboxID: string): boolean {
    return this.delivered.get(parentID)?.has(inboxID) ?? false
  }

  eligibleChild(parentID: string, childID: string): ChildObservation | null {
    const entry = this.children.get(childID)
    if (!entry || entry.invalid || entry.parentID !== parentID) return null
    return entry
  }

  observedInputIDs(childID: string): string[] {
    return this.children.get(childID)?.inputIDs ?? []
  }

  private evictChildren(): void {
    while (this.children.size > CHILDREN_CAP) {
      const oldest = this.children.keys().next().value
      if (oldest === undefined) break
      this.children.delete(oldest)
    }
  }

  private evictDelivered(): void {
    while (this.delivered.size > DELIVERED_PARENTS_CAP) {
      const oldest = this.delivered.keys().next().value
      if (oldest === undefined) break
      this.delivered.delete(oldest)
    }
  }
}

// ---- 纯函数(宿主算法逐字复刻;禁止替换成近似匹配) ----

/** 宿主渲染(subagent-completion.ts:10-12):非空 text parts join("\n\n") || NO_TEXT。 */
export const renderSubagentText = (content: unknown): string => {
  if (typeof content === "string") return content || SUBAGENT_NO_TEXT
  if (!Array.isArray(content)) return SUBAGENT_NO_TEXT
  const text = content
    .filter((p): p is { type: "text"; text?: unknown } => Boolean(p) && (p as { type?: unknown }).type === "text")
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter((t) => t.length > 0)
    .join("\n\n")
  return text || SUBAGENT_NO_TEXT
}

/** 通知外层模板逐字节(subagent-completion.ts:36;裸插值,无转义)。 */
export const subagentNotificationText = (childID: string, state: string, description: string, text: string): string =>
  `<subagent sessionID="${childID}" state="${state}" description="${description}">\n${text}\n</subagent>`

/**
 * 宿主来源选取(subagent-job.ts:53-60 逐字):最近 20 条内倒序第一条
 * assistant 且 time.completed 存在且无 error。不限终稿。
 */
export const selectHostSource = (wire: WireMessage[]): WireMessage | undefined => {
  const recent = wire.slice(-20)
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]
    if (!m || m.type !== "assistant") continue
    const time = m.time as { completed?: unknown } | undefined
    if (time?.completed === undefined) continue
    if (m.error !== undefined) continue
    return m
  }
  return undefined
}

/** 留存核验的内容哈希口径(capture.ts publicReply:text parts 的 text 以 "\n" 连接)。 */
export const assistantPublicContent = (m: WireMessage): string => {
  if (!Array.isArray(m.content)) return ""
  return m.content
    .filter((p): p is { type: "text"; text?: unknown } => Boolean(p) && (p as { type?: unknown }).type === "text")
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("\n")
}

export const assistantPublicContentHash = (m: WireMessage): string =>
  createHash("sha256").update(assistantPublicContent(m)).digest("hex")

/**
 * 子会话覆盖核验(R8.2/4/5):wire 是完整前缀且与账本逐项一致才有效。
 * - wire 出现 compaction 消息 → false;
 * - 账本观察到的 assistant 必须全部仍在 wire,反之 wire 的 assistant 必须全部被观察过
 *   (双向相等;任一方向缺失 = 覆盖缺口/原文变化);
 * - 每条消息的 text parts(按出现序)与账本 ordinal 升序文本逐一相等(含空串;
 *   宿主 wire text part 按 ordinal 升序排列,publish-llm-event.ts:96/166);
 * - 每条账本 assistant 的 finish 必须已观察且与 wire 一致(step 未观察到 = 域不完整)。
 */
export const childCoverageValid = (wire: WireMessage[], entry: ChildObservation): boolean => {
  for (const m of wire) {
    if (m?.type === "compaction") return false
  }
  const wireAssistants = wire.filter((m) => m?.type === "assistant")
  const observedIDs = entry.assistants.keys()
  for (const id of observedIDs) {
    if (!wireAssistants.some((m) => m.id === id)) return false
  }
  for (const m of wireAssistants) {
    const id = typeof m.id === "string" ? m.id : ""
    if (!id) return false
    const obs = entry.assistants.get(id)
    if (!obs) return false
    const parts = Array.isArray(m.content)
      ? m.content.filter((p): p is { type: "text"; text?: unknown } => Boolean(p) && (p as { type?: unknown }).type === "text")
      : []
    const ordinals = [...obs.ordinals.keys()].sort((a, b) => a - b)
    if (parts.length !== ordinals.length) return false
    for (let i = 0; i < parts.length; i++) {
      const ordinal = ordinals[i]!
      if (obs.ordinals.get(ordinal) !== (typeof parts[i]!.text === "string" ? parts[i]!.text : "")) return false
    }
    const finish = typeof m.finish === "string" ? m.finish : ""
    if (obs.finish === undefined || obs.finish !== finish) return false
  }
  return true
}

// ---- 关联/回执编排(R*4-8 + R8.6;除 fast path 外全部 try/catch 隔离,只 log) ----

export type ReceiptDeps = {
  parentSessionID: string
  /** context hook 的 draft 消息(LLM 形;synthetic 通知 = {id,role:"user",content:字符串})。 */
  msgs: Array<Record<string, unknown>>
  ledger: SubagentReceiptLedger
  /** 父会话 wire 完整读(核验 synthetic 类型/metadata;失败 → 静默)。 */
  parentWire(): Promise<WireMessage[] | null>
  /** 子会话 wire 完整读(来源域对照;失败 → 静默)。 */
  childWire(sessionID: string): Promise<WireMessage[] | null>
  /** 子会话 parentID 回查(sessionInfo;证明父子关系)。 */
  childParentID(childID: string): Promise<string | null>
  /**
   * 留存记录核验:按来源身份(作者会话+消息ID)查 captureFinal 已存记录,并核验
   * origin.kind==="host_final"、text_sha256、writer 三元组、origin.input_message_id
   * ∈ 账本观察输入。不可证 → null(不补捕、不放宽)。
   */
  retainedRecord(childID: string, messageID: string, contentHash: string, observedInputIDs: string[]): Promise<string | null>
  /** 父会话对该记录的读取权限(refPolicy + board_get)。 */
  parentCanRead(bbId: string): Promise<boolean>
  log(line: Record<string, unknown>): void
}

type Candidate = { idx: number; msg: Record<string, unknown>; content: string }

export const attachSubagentReceipts = async (deps: ReceiptDeps): Promise<void> => {
  const { msgs, ledger, parentSessionID } = deps
  // fast path:无任何 await 前完成候选筛选(绝大多数请求零开销)。
  const candidates: Candidate[] = []
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    if (!msg || msg.role !== "user") continue
    const content = msg.content
    if (typeof content !== "string" || !content.startsWith('<subagent sessionID="')) continue
    const id = msg.id
    if (typeof id !== "string" || !id || !ledger.hasDelivered(parentSessionID, id)) continue
    candidates.push({ idx: i, msg, content })
  }
  if (candidates.length === 0) return
  let parentWires: WireMessage[] | null = null
  try {
    parentWires = await deps.parentWire()
  } catch (err) {
    deps.log({ ev: "subagent_receipt_skip", session: parentSessionID, reason: "parent_wire_error", error: err instanceof Error ? err.message : String(err) })
    return
  }
  if (!parentWires) {
    deps.log({ ev: "subagent_receipt_skip", session: parentSessionID, reason: "parent_wire_unavailable" })
    return
  }
  for (const candidate of candidates) {
    try {
      await attachOne(deps, candidate, parentWires)
    } catch (err) {
      deps.log({ ev: "subagent_receipt_error", session: parentSessionID, notice: err instanceof Error ? err.message : String(err) })
    }
  }
}

const skip = (deps: ReceiptDeps, candidate: Candidate, reason: string): void => {
  deps.log({ ev: "subagent_receipt_skip", session: deps.parentSessionID, notice_id: candidate.msg.id, reason })
}

const attachOne = async (deps: ReceiptDeps, candidate: Candidate, parentWires: WireMessage[]): Promise<void> => {
  const { ledger, parentSessionID } = deps
  // R*.2:以真实父会话 wire 回查通知,核验 synthetic 类型与 metadata(正文 ID 不单独构成证明)。
  const notice = parentWires.find((m) => m?.id === candidate.msg.id)
  if (!notice || notice.type !== "synthetic") {
    return skip(deps, candidate, "notice_not_verified")
  }
  const meta = (notice as { metadata?: unknown }).metadata as { source?: unknown; childID?: unknown; state?: unknown } | undefined
  if (meta?.source !== "subagent" || meta?.state !== "completed") {
    return skip(deps, candidate, "notice_not_verified")
  }
  const childID = typeof meta?.childID === "string" && meta.childID ? meta.childID : null
  if (!childID) return skip(deps, candidate, "child_id_missing")
  // R8.1:起点必须在本插件观察期内(新建派发);起点未知 → 永不新关联。
  const entry = ledger.eligibleChild(parentSessionID, childID)
  if (!entry) return skip(deps, candidate, "child_not_observed")
  // R*.2:父子关系必须证明。
  let childParent: string | null = null
  try {
    childParent = await deps.childParentID(childID)
  } catch {
    childParent = null
  }
  if (childParent !== parentSessionID) return skip(deps, candidate, "parentage_unverified")
  // R8.2/4/5:子会话 wire 全量对照;覆盖缺口/原文变化 → 该子会话资格整体失效。
  let childWires: WireMessage[] | null = null
  try {
    childWires = await deps.childWire(childID)
  } catch {
    childWires = null
  }
  if (!childWires) return skip(deps, candidate, "child_wire_unavailable")
  if (!childCoverageValid(childWires, entry)) {
    ledger.invalidate(childID, "coverage_gap")
    return skip(deps, candidate, "coverage_gap")
  }
  // R8.6:完整前缀内精确渲染比对(R*.4:恰好一个消息精确匹配才认定来源)。
  // 不以「宿主此刻会选谁」收窄候选:续跑会移动宿主选取点,而已证明的历史关联
  // 不因子会话续跑改指新结果(R*.7)。候选域 = wire 全部 assistant 中
  // 满足宿主来源资格(completed 且无 error)的消息;逐条渲染、逐描述代次复算
  // 外层模板,与通知正文逐字节全等;NO_TEXT 占位输出跳过。
  const matches: WireMessage[] = []
  for (const m of childWires) {
    if (!m || m.type !== "assistant") continue
    const time = m.time as { completed?: unknown } | undefined
    if (time?.completed === undefined || m.error !== undefined) continue
    const body = renderSubagentText(m.content)
    if (body === SUBAGENT_NO_TEXT) continue
    for (const description of entry.descriptions) {
      if (subagentNotificationText(childID, "completed", description, body) === candidate.content) {
        matches.push(m)
        break
      }
    }
  }
  if (matches.length === 0) return skip(deps, candidate, "no_match")
  // R*.4:多匹配 → 不确认(不猜测、不设容忍窗口)。
  if (matches.length !== 1) return skip(deps, candidate, "source_not_unique")
  const selected = matches[0]!
  if (typeof selected.id !== "string" || !selected.id) return skip(deps, candidate, "source_not_unique")
  const messageID = selected.id
  // R*.6:来源身份确认后,才查终稿资格与留存记录(作者会话+输入ID+消息ID+内容)。
  let bbId: string | null = null
  try {
    bbId = await deps.retainedRecord(childID, messageID, assistantPublicContentHash(selected), ledger.observedInputIDs(childID))
  } catch (err) {
    deps.log({ ev: "subagent_receipt_skip", session: parentSessionID, notice_id: candidate.msg.id, reason: "retention_lookup_error", error: err instanceof Error ? err.message : String(err) })
    return
  }
  if (!bbId) return skip(deps, candidate, "not_retained")
  let readable = false
  try {
    readable = await deps.parentCanRead(bbId)
  } catch {
    readable = false
  }
  if (!readable) return skip(deps, candidate, "not_readable")
  // 幂等:已带同记录回执 → 不重复。
  if (candidate.content.includes(idempotencyProbe(bbId))) return skip(deps, candidate, "already_attached")
  // R*.8:所有 await 后复核目标消息仍在 draft 且正文未变,再浅拷贝替换槽位。
  const current = deps.msgs[candidate.idx]
  if (current !== candidate.msg || current?.content !== candidate.content) {
    return skip(deps, candidate, "target_moved")
  }
  const replacement = { ...candidate.msg, content: candidate.content + receiptTail(bbId) }
  try {
    deps.msgs[candidate.idx] = replacement
  } catch (err) {
    return skip(deps, candidate, `write_failed:${err instanceof Error ? err.message : String(err)}`)
  }
  deps.log({ ev: "subagent_receipt_attached", session: parentSessionID, notice_id: candidate.msg.id, child: childID, message_id: messageID, record: bbId })
}
