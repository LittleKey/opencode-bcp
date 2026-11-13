// 原生后台子代理交付回执(DESIGN §11.9 冻结契约 + §16.7 生命周期接线)。
//
// 范围(冻结):首期仅处理 BCP v2 后台 context 中可回查的宿主 subagent 完成通知
// (宿主 tag v2.1.4,commit 68bc26b):通知 = 父会话 synthetic 消息
// {id:notificationID,metadata:{source:"subagent",childID,agent,state},text:
// `<subagent sessionID="${child}" state="${state}" description="${desc}">\n${text}\n</subagent>`}
// (subagent-completion.ts:8-19/31-45 裸插值模板;state/description 无转义)。
// context hook 收到的 draft 通知 content 是宿主 canonical ContentPart[]:
// to-llm-message.ts:274-275 以 Message.make({id,role:"user",content:message.text})
// 构造,messages.ts:239 content=Schema.Array(ContentPart)、:252/260-265 把 string
// 归一为 [{type:"text",text}]。本模块兼容旧 string 形态与该 canonical 数组形态;
// 多 part/非 text 等复杂形态静默跳过(合成消息本为单 text part)。
// 宿主来源选取(subagent-job.ts:53-60):子会话 messages(desc,limit:20) 中 find
// (type==="assistant" && time.completed!==undefined && error===undefined)——不限终稿。
// 交付证明(R8.3):session.inbox.delivered{sessionID,inboxID}
// (schema/session-event.ts:208-218;inbox.ts promote 逐行发布,inboxID==synthetic
// inputID==通知消息 id)。仅 context 看见通知不构成账本已追平的证明。
//
// R8 域定义:有界来源域 = 有完整起点和已确认观察终点的来源前缀。起点 = 现场
// session.created(parentID)；随后由 subagent 工具的新建结果确认派发归属。
// 不等工具返回才观察首输入；fork/恢复/导入/起点未知
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
  `\n\nRetained: ${id}\nCheck this original and its evidence, version and limits before relying on it. If the exact host-bound original and all needed information remain in context with no change or conflict signal, inspect them directly; otherwise use board_get. Forward the full board ID, not a retelling. Retention is not acceptance.`

// ---- 有界证据。超限释放整个来源域，不剪掉旧证据后继续制造唯一性。 ----
export const CHILDREN_CAP = 32
export const DESCRIPTIONS_CAP = 8
export const INPUT_IDS_CAP = 16
export const ASSISTANTS_CAP = 256
export const TEXT_PARTS_CAP = 512
export const CHILD_EVIDENCE_BYTES_CAP = 256 * 1024
export const SEEN_CHILDREN_CAP = 4096 // 有界墓碑；耗尽后本实例回执关闭，不重新开放旧来源域
const ID_BYTES_CAP = 512
const DELIVERED_PARENTS_CAP = 64 // delivered 账本父会话数
const DELIVERED_PER_PARENT_CAP = 128 // 每父会话 inboxID 上限
const DELIVERY_WAITERS_CAP = 128
const DELIVERY_WAIT_MS = 100

export type ChildObservation = {
  parentID: string
  childID: string
  created: boolean
  dispatched: boolean
  revision: number
  bytes: number
  parts: number
  descriptions: string[]
  inputIDs: string[]
  assistants: Map<string, { ordinals: Map<number, string>; finish?: string }>
  invalid?: string
}

/**
 * Created 只建立临时观察域，不授予来源关联/发布权限。工具结果必须另行确认
 * 同一父子的新建派发。二者任一缺失均不可关联；context 不补建观察起点。
 */
export class SubagentReceiptLedger {
  private children = new Map<string, ChildObservation>()
  private delivered = new Map<string, Map<string, number>>()
  private seenChildren = new Set<string>()
  private serial = 0
  private closed = false
  private waiters = new Set<{ parentID: string; childID: string; inboxID: string; finish: (delivered: boolean) => void }>()

  private validID(id: string): boolean {
    return Boolean(id) && Buffer.byteLength(id) <= ID_BYTES_CAP
  }

  private slot(parentID: string, childID: string): ChildObservation | null {
    if (this.closed || !this.validID(parentID) || !this.validID(childID)) return null
    const old = this.children.get(childID)
    if (old) {
      if (old.parentID !== parentID) this.invalidate(childID, "parentage_changed")
      return old.invalid ? null : old
    }
    // 淘汰、删除或异常后的相同 childID，不能由迟到派发/重复 Created 恢复。
    if (this.seenChildren.has(childID)) return null
    if (this.seenChildren.size >= SEEN_CHILDREN_CAP) {
      this.resetAll()
      return null
    }
    this.seenChildren.add(childID)
    const entry: ChildObservation = {
      parentID, childID, created: false, dispatched: false,
      revision: ++this.serial, bytes: Buffer.byteLength(parentID) + Buffer.byteLength(childID), parts: 0,
      descriptions: [], inputIDs: [], assistants: new Map(),
    }
    this.children.set(childID, entry)
    this.evictChildren()
    return entry
  }

  observeCreated(parentID: string, childID: string): void {
    const entry = this.slot(parentID, childID)
    if (!entry || entry.created) return
    entry.created = true
    entry.revision = ++this.serial
  }

  private reserve(entry: ChildObservation, bytes: number): boolean {
    if (entry.bytes + bytes > CHILD_EVIDENCE_BYTES_CAP) {
      this.invalidate(entry.childID, "evidence_bytes_limit")
      return false
    }
    entry.bytes += bytes
    entry.revision = ++this.serial
    return true
  }

  private description(entry: ChildObservation, description: string): void {
    if (entry.descriptions.includes(description)) return
    if (entry.descriptions.length >= DESCRIPTIONS_CAP) {
      this.invalidate(entry.childID, "descriptions_limit")
      return
    }
    if (this.reserve(entry, Buffer.byteLength(description))) entry.descriptions.push(description)
  }

  /** 派发观察(tool execute.after,subagent 且 input.sessionID 缺失 → 新建子会话)。 */
  observeDispatch(parentID: string, childID: string, description: string): void {
    if (!description) return
    const entry = this.slot(parentID, childID)
    if (!entry) return
    if (!entry.dispatched) {
      entry.dispatched = true
      entry.revision = ++this.serial
    }
    this.description(entry, description)
  }

  /** 续跑观察(tool execute.after,input.sessionID 指向已追踪子会话 → 新描述代次)。 */
  observeContinuation(parentID: string, childID: string, description: string): void {
    if (!parentID || !childID || !description) return
    const entry = this.children.get(childID)
    if (!entry || entry.invalid || !entry.dispatched || entry.parentID !== parentID) return
    this.description(entry, description)
  }

  /** 子会话输入观察(session.inbox.enqueued;steer 等不经 prompt hook 的输入由此覆盖)。 */
  observeChildInput(sessionID: string, inboxID: string): void {
    if (!sessionID || !inboxID) return
    const entry = this.children.get(sessionID)
    if (!entry || !entry.created || entry.invalid) return
    if (!entry.inputIDs.includes(inboxID)) {
      if (entry.inputIDs.length >= INPUT_IDS_CAP || !this.validID(inboxID)) {
        this.invalidate(sessionID, "input_ids_limit")
        return
      }
      if (this.reserve(entry, Buffer.byteLength(inboxID))) entry.inputIDs.push(inboxID)
    }
  }

  /** 交付观察(session.inbox.delivered;父会话维度,按 inboxID==notificationID 关联)。 */
  observeDelivered(parentID: string, inboxID: string): void {
    if (this.closed || !this.validID(parentID) || !this.validID(inboxID)) return
    let set = this.delivered.get(parentID)
    if (!set) {
      set = new Map()
      this.delivered.set(parentID, set)
      this.evictDelivered()
    }
    if (!set.has(inboxID)) {
      if (set.size >= DELIVERED_PER_PARENT_CAP) {
        const oldest = set.keys().next().value
        if (oldest !== undefined) set.delete(oldest)
      }
      set.set(inboxID, ++this.serial)
    }
    for (const waiter of this.waiters) {
      if (waiter.parentID === parentID && waiter.inboxID === inboxID) waiter.finish(true)
    }
  }

  /** 仅等待事件消费，不将等待或 wire 视为交付证明。 */
  waitForDelivery(parentID: string, childID: string, inboxID: string): Promise<boolean> {
    if (this.deliveryVersion(parentID, inboxID) !== undefined) return Promise.resolve(true)
    if (!this.eligibleChild(parentID, childID) || !this.validID(inboxID) || this.waiters.size >= DELIVERY_WAITERS_CAP) return Promise.resolve(false)
    return new Promise((resolve) => {
      const waiter = { parentID, childID, inboxID, finish: (delivered: boolean) => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(delivered)
      } }
      const timer = setTimeout(() => waiter.finish(false), DELIVERY_WAIT_MS)
      this.waiters.add(waiter)
    })
  }

  deliveryVersion(parentID: string, inboxID: string): number | undefined {
    return this.delivered.get(parentID)?.get(inboxID)
  }

  /** started/ended 均建立空正文 assistant；纯工具步骤也是完整来源域的一部分。 */
  observeChildStart(sessionID: string, messageID: string): void {
    const entry = this.children.get(sessionID)
    if (!entry || !entry.created || entry.invalid || entry.assistants.has(messageID)) return
    if (!this.validID(messageID) || entry.assistants.size >= ASSISTANTS_CAP) {
      this.invalidate(sessionID, "assistants_limit")
      return
    }
    if (this.reserve(entry, Buffer.byteLength(messageID))) entry.assistants.set(messageID, { ordinals: new Map() })
  }

  /** 子会话文本段观察(session.text.ended;ordinal 冲突 → 原文不稳定,整体失效)。 */
  observeChildText(sessionID: string, messageID: string, ordinal: number, text: string): void {
    if (!sessionID || !messageID) return
    const entry = this.children.get(sessionID)
    if (!entry || !entry.created || entry.invalid) return
    if (!Number.isInteger(ordinal) || ordinal < 0 || typeof text !== "string") {
      this.invalidate(sessionID, "malformed_event")
      return
    }
    this.observeChildStart(sessionID, messageID)
    const obs = entry.assistants.get(messageID)
    if (!obs || entry.invalid) return
    const prev = obs.ordinals.get(ordinal)
    if (prev !== undefined && prev !== text) {
      this.invalidate(sessionID, "text_rewind")
      return
    }
    if (prev !== undefined) return
    if (entry.parts >= TEXT_PARTS_CAP) {
      this.invalidate(sessionID, "text_parts_limit")
      return
    }
    if (!this.reserve(entry, Buffer.byteLength(text))) return
    entry.parts++
    obs.ordinals.set(ordinal, text)
  }

  /** 子会话步进完成观察(session.step.ended;finish 冲突 → 原文不稳定,整体失效)。 */
  observeChildFinish(sessionID: string, messageID: string, finish: string): void {
    if (!sessionID || !messageID || !finish) return
    const entry = this.children.get(sessionID)
    if (!entry || !entry.created || entry.invalid) return
    this.observeChildStart(sessionID, messageID)
    const obs = entry.assistants.get(messageID)
    if (!obs || entry.invalid) return
    if (obs.finish !== undefined && obs.finish !== finish) {
      this.invalidate(sessionID, "finish_rewind")
      return
    }
    if (obs.finish === undefined && this.reserve(entry, Buffer.byteLength(finish))) obs.finish = finish
  }

  /** 资格失效(compaction/revert/forked/覆盖缺口;不删已留存记录,仅禁止新关联)。 */
  invalidate(sessionID: string, reason: string): void {
    for (const waiter of this.waiters) {
      if (waiter.parentID === sessionID || waiter.childID === sessionID) waiter.finish(false)
    }
    const entry = this.children.get(sessionID)
    if (entry && !entry.invalid) {
      entry.invalid = reason
      entry.revision = ++this.serial
      entry.descriptions = []
      entry.inputIDs = []
      entry.assistants.clear()
      entry.bytes = 0
      entry.parts = 0
    }
    // 父会话变更只撤销其交付证明，不失效其他子会话的完整来源前缀。
    this.delivered.delete(sessionID)
  }

  /** 会话删除(session.deleted):删该会话账目 + 其名下派发与其 delivered 集。 */
  forgetSession(sessionID: string): void {
    this.invalidate(sessionID, "deleted")
    this.children.delete(sessionID)
    this.delivered.delete(sessionID)
    for (const [id, entry] of this.children) {
      if (entry.parentID === sessionID) {
        this.invalidate(id, "parent_deleted")
        this.children.delete(id)
      }
    }
  }

  /** 订阅/处理异常(R8:不以「没观察到事件」证明没变化 → 全部失效)。 */
  resetAll(): void {
    for (const waiter of this.waiters) waiter.finish(false)
    for (const id of this.children.keys()) this.invalidate(id, "reset")
    this.children.clear()
    this.delivered.clear()
    this.seenChildren.clear()
    this.closed = true
    ++this.serial
  }

  hasDelivered(parentID: string, inboxID: string): boolean {
    return this.delivered.get(parentID)?.has(inboxID) ?? false
  }

  eligibleChild(parentID: string, childID: string): ChildObservation | null {
    const entry = this.children.get(childID)
    if (this.closed || !entry || !entry.created || !entry.dispatched || entry.invalid || entry.parentID !== parentID) return null
    return entry
  }

  observedInputIDs(childID: string): string[] {
    return this.children.get(childID)?.inputIDs ?? []
  }

  private evictChildren(): void {
    while (this.children.size > CHILDREN_CAP) {
      const oldest = this.children.keys().next().value
      if (oldest === undefined) break
      this.invalidate(oldest, "capacity")
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

/**
 * 从 context hook 的 draft 通知 content 提取正文:旧 string 形态原样返回;
 * 宿主 canonical 形态(messages.ts:260-265 string → [{type:"text",text}])
 * 仅接受恰好一个 part 且 type==="text"、text 为 string;其余形态(多 part、
 * 非 text part、text 非字符串、非 string 非 array)返回 null,静默跳过。
 */
export const noticeBodyText = (content: unknown): string | null => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    if (content.length !== 1) return null
    const part = content[0] as { type?: unknown; text?: unknown } | undefined
    if (!part || part.type !== "text" || typeof part.text !== "string") return null
    return part.text
  }
  return null
}

/**
 * 候选筛选时的 content 快照(R*.8 写回栅栏的起点):ref = content 本体
 * (string 值或数组引用);数组形态逐 part 留引用;body = 提取正文。
 */
type ContentSnapshot = { ref: unknown; parts: unknown[] | null; body: string }

const snapshotContent = (content: unknown, body: string): ContentSnapshot =>
  Array.isArray(content) ? { ref: content, parts: content.slice(), body } : { ref: content, parts: null, body }

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
  /**
   * context hook 的 draft 消息(LLM 形;synthetic 通知 content = 旧 string 或
   * 宿主 canonical 单 text part 数组,见 noticeBodyText)。
   */
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

type Candidate = { idx: number; id: string; delivery: number; msg: Record<string, unknown>; snap: ContentSnapshot }

export const attachSubagentReceipts = async (deps: ReceiptDeps): Promise<void> => {
  const { msgs, ledger, parentSessionID } = deps
  // fast path:无任何 await 前完成候选筛选与 content 快照(绝大多数请求零开销)。
  const candidates: Candidate[] = []
  const pending: Array<Promise<void>> = []
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    if (!msg || msg.role !== "user") continue
    const body = noticeBodyText(msg.content)
    if (body === null || !body.startsWith('<subagent sessionID="')) continue
    const id = msg.id
    if (typeof id !== "string" || !id) continue
    const delivery = ledger.deliveryVersion(parentSessionID, id)
    if (delivery === undefined) {
      const prefix = '<subagent sessionID="'
      const marker = '" state="completed" description="'
      const end = body.indexOf(marker, prefix.length)
      const childID = end > prefix.length && body.endsWith("\n</subagent>") && body.indexOf('\">\n', end + marker.length) >= 0
        ? body.slice(prefix.length, end) : null
      const entry = childID ? ledger.eligibleChild(parentSessionID, childID) : null
      if (!childID || !entry) continue
      const revision = entry.revision
      const snap = snapshotContent(msg.content, body)
      pending.push(ledger.waitForDelivery(parentSessionID, childID, id).then((observed) => {
        const version = ledger.deliveryVersion(parentSessionID, id)
        if (observed && version !== undefined && ledger.eligibleChild(parentSessionID, childID) === entry && entry.revision === revision) {
          candidates.push({ idx: i, id, delivery: version, msg, snap })
        } else {
          deps.log({ ev: "subagent_receipt_skip", session: parentSessionID, notice_id: id, reason: "delivery_not_observed" })
        }
      }))
      continue
    }
    candidates.push({ idx: i, id, delivery, msg, snap: snapshotContent(msg.content, body) })
  }
  if (pending.length) await Promise.all(pending)
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
  // 比对口径 = 提取正文(数组形态取 text part 文本),与持久 wire 逐字节全等。
  const notices = parentWires.filter((m) => m?.id === candidate.id)
  const notice = notices[0]
  if (notices.length !== 1 || !notice || notice.type !== "synthetic" || notice.text !== candidate.snap.body) {
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
  const revision = entry.revision
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
  // await 期间可能收到 revert/reset/淘汰或新来源事件，旧引用不再是有效证据。
  const stillObserved = (): boolean =>
    ledger.eligibleChild(parentSessionID, childID) === entry && entry.revision === revision &&
    ledger.deliveryVersion(parentSessionID, candidate.id) === candidate.delivery
  if (!stillObserved()) return skip(deps, candidate, "observation_changed")
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
      if (subagentNotificationText(childID, "completed", description, body) === candidate.snap.body) {
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
  // 重新核验持久通知的原文/metadata，不能用旧ID为另一份draft正文背书。
  const latestParent = await deps.parentWire()
  const latestNotices = latestParent?.filter((m) => m?.id === candidate.id)
  const latest = latestNotices?.[0]
  const latestMeta = (latest as { metadata?: typeof meta } | undefined)?.metadata
  if (latestNotices?.length !== 1 || latest?.type !== "synthetic" || latest.text !== candidate.snap.body ||
      latestMeta?.source !== "subagent" || latestMeta.state !== "completed" || latestMeta.childID !== childID) {
    return skip(deps, candidate, "notice_changed")
  }
  // R*.8:所有 await 后复核同一观察代次、交付证明与目标槽位,再同步写回。
  if (!stillObserved()) return skip(deps, candidate, "observation_changed")
  if (!targetIntact(deps, candidate)) return skip(deps, candidate, "target_moved")
  // 写回保持原 representation:string 仍 string,数组仍数组;不改动任何原
  // 消息/数组/part——正文 part 浅拷贝改 text(保留其余字段如 metadata/cache),
  // 其余 part 原引用复用,消息层浅拷贝替换槽位。
  const tailed = candidate.snap.body + receiptTail(bbId)
  const original = candidate.msg.content
  // noticeBodyText 已保证数组形态恰为单 text part;写回即该 part 的浅拷贝。
  const nextContent: unknown = typeof original === "string"
    ? tailed
    : [{ ...(original as Array<Record<string, unknown>>)[0]!, text: tailed }]
  const replacement = { ...candidate.msg, content: nextContent }
  try {
    deps.msgs[candidate.idx] = replacement
  } catch (err) {
    return skip(deps, candidate, `write_failed:${err instanceof Error ? err.message : String(err)}`)
  }
  deps.log({ ev: "subagent_receipt_attached", session: parentSessionID, notice_id: candidate.msg.id, child: childID, message_id: messageID, record: bbId })
}

/**
 * R*.8 写回栅栏(开始时快照+最终复核):只比较数组对象引用不够——同一数组/
 * 同一 part 被 await 期间原地改写也必须拒绝。依次核验:
 * - 槽位仍是原消息对象,且 id/role 未变;
 * - content 本体未换(string 值或数组引用逐 === 比对;换数组即拒绝);
 * - 数组形态:长度未变、每个 part 引用逐一相等(增删/替换 part 即拒绝),
 *   并复提正文与快照逐字节相等(同一 part 内 text 原地改写即拒绝)。
 */
const targetIntact = (deps: ReceiptDeps, candidate: Candidate): boolean => {
  const current = deps.msgs[candidate.idx]
  const snap = candidate.snap
  if (current !== candidate.msg) return false
  if (current.id !== candidate.id || current.role !== "user") return false
  if (current.content !== snap.ref) return false
  if (snap.parts) {
    const content = current.content
    if (!Array.isArray(content) || content.length !== snap.parts.length) return false
    for (let i = 0; i < snap.parts.length; i++) {
      if (content[i] !== snap.parts[i]) return false
    }
    if (noticeBodyText(content) !== snap.body) return false
  }
  return true
}
