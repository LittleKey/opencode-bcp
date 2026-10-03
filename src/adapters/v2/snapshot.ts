// v2 host 快照（§16 适配层补充）：@opencode/plugin 2.0.20 的插件 ctx 没有全量 client 的
// session.message.get / message.list——消息原文只能来自
//   (a) ctx 回调/事件（宿主现场投递：session.hook("prompt"/"context")、tool.hook、
//       session.text.ended / session.step.ended / session.deleted）；
//   (b) ctx.session.context（宿主装配的会话上下文，SessionMessageInfo[] wire 形状）。
// 本模块把两路来源合并为有界缓存，并按共享核 HostMessage 契约（src/delivery.ts）映射。
// 来源缺失即 null → 上层一律 fail closed，不伪造原文/完成时间/父子关系。
// wire 形状按 2.0.20 生成类型（@opencode/client dist/promise/generated/types.d.ts
// SessionMessageInfo；/@opencode/cli bin 反汇编一致）：user/synthetic/assistant 均
// 无 parentID——父子关系由适配层建立（context 快照位置推导 + 运行输入关联）。
import type { HostMessage } from "../../delivery"

/** 2.0.20 wire 形状（结构子集；未知形状安全跳过）。 */
export type WireMessage = {
  id?: unknown
  type?: unknown
  text?: unknown
  agent?: unknown
  model?: { id?: unknown; providerID?: unknown }
  content?: unknown
  finish?: unknown
  error?: unknown
  time?: { created?: unknown; completed?: unknown }
}

type ToolObs = { callID: string; tool?: string; status?: string; start?: number; end?: number }
type TextObs = { ordinal: number; text: string }
type Obs = {
  id: string
  role: "user" | "assistant"
  synthetic?: boolean
  text?: string // user/synthetic 正文
  texts: TextObs[] // assistant 文本段（按 ordinal）
  agent?: string
  modelID?: string
  providerID?: string
  finish?: string
  created?: number
  completed?: number
  error?: unknown
  parentID?: string // 适配层建立的输入关联（wire 无此字段）
  tools: ToolObs[]
}

const SESSION_CAP = 64
const MESSAGE_CAP = 32

const isWireAssistantContent = (part: unknown): part is { type: string; text?: unknown; id?: unknown; name?: unknown; state?: { status?: unknown } } =>
  Boolean(part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string")

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)

/** 有界、按会话隔离的宿主消息观测缓存。 */
export class HostSnapshot {
  private sessions = new Map<string, Map<string, Obs>>()
  private order: string[] = []

  private slot(session: string): Map<string, Obs> {
    let map = this.sessions.get(session)
    if (!map) {
      map = new Map()
      this.sessions.set(session, map)
      this.order.push(session)
      while (this.order.length > SESSION_CAP) {
        const oldest = this.order.shift()
        if (oldest !== undefined && oldest !== session) {
          this.sessions.delete(oldest)
        }
      }
    }
    return map
  }

  private upsert(session: string, id: string, role: Obs["role"], synthetic = false): Obs {
    const map = this.slot(session)
    let obs = map.get(id)
    if (!obs || obs.role !== role) {
      obs = { id, role, synthetic, texts: [], tools: [] }
      map.set(id, obs)
      if (map.size > MESSAGE_CAP) {
        const oldest = map.keys().next().value
        if (oldest !== undefined && oldest !== id) map.delete(oldest)
      }
    } else if (synthetic) {
      obs.synthetic = true
    }
    return obs
  }

  /** prompt hook：宿主现场投递的 user 输入（ID + 正文）。 */
  observeUser(session: string, id: string, text?: string, created?: number): void {
    if (!id) return
    const obs = this.upsert(session, id, "user")
    if (text !== undefined) obs.text = text
    if (created !== undefined) obs.created = created
  }

  /** session.text.ended：assistant 正文段（ordinal 保序）。 */
  observeAssistantText(session: string, id: string, ordinal: number, text: string): void {
    if (!id) return
    const obs = this.upsert(session, id, "assistant")
    const existing = obs.texts.find((part) => part.ordinal === ordinal)
    if (existing) existing.text = text
    else obs.texts.push({ ordinal, text })
    obs.texts.sort((a, b) => a.ordinal - b.ordinal)
  }

  /** tool.execute.after：assistant 名下的工具调用痕迹（callID 幂等）。 */
  observeAssistantTool(session: string, messageID: string, part: { callID: string; tool?: string; status?: string; start?: number; end?: number }, agent?: string): void {
    if (!messageID || !part.callID) return
    const obs = this.upsert(session, messageID, "assistant")
    if (agent) obs.agent = agent
    const existing = obs.tools.find((tool) => tool.callID === part.callID)
    if (existing) Object.assign(existing, part)
    else obs.tools.push(part)
  }

  /** session.step.ended / wire 快照：assistant 元数据合并。 */
  observeAssistantMeta(session: string, id: string, patch: { agent?: string; finish?: string; completed?: number; created?: number; modelID?: string; providerID?: string; error?: unknown }): void {
    if (!id) return
    const obs = this.upsert(session, id, "assistant")
    if (patch.agent) obs.agent = patch.agent
    if (patch.finish !== undefined) obs.finish = patch.finish
    if (patch.completed !== undefined) obs.completed = patch.completed
    if (patch.created !== undefined) obs.created = patch.created
    if (patch.modelID) obs.modelID = patch.modelID
    if (patch.providerID) obs.providerID = patch.providerID
    if (patch.error !== undefined) obs.error = patch.error
  }

  /** 运行输入关联（context hook 确认的当前输入 → 其后 assistant 消息）。仅在未建立时不覆盖。 */
  linkParent(session: string, assistantID: string, inputID: string | undefined): void {
    if (!assistantID || !inputID) return
    const obs = this.slot(session).get(assistantID)
    if (obs && obs.role === "assistant" && obs.parentID === undefined) obs.parentID = inputID
  }

  /**
   * ctx.session.context 全量重建：宿主装配的有序 wire 列表是权威视图。
   * assistant 的 parentID 优先取位置推导（最近前驱 user/synthetic）；窗口缺失时保留既有关联。
   */
  refresh(session: string, list: readonly WireMessage[]): void {
    if (!Array.isArray(list)) return
    const derived = new Map<string, string | undefined>()
    let lastUser: string | undefined
    for (const wire of list) {
      const id = str(wire?.id)
      if (!id) continue
      if (wire.type === "user" || wire.type === "synthetic") lastUser = id
      else if (wire.type === "assistant") derived.set(id, lastUser)
    }
    for (const wire of list) {
      const id = str(wire?.id)
      if (!id) continue
      const created = num(wire.time?.created)
      if (wire.type === "user" || wire.type === "synthetic") {
        const obs = this.upsert(session, id, "user", wire.type === "synthetic")
        if (typeof wire.text === "string") obs.text = wire.text
        if (created !== undefined) obs.created = created
      } else if (wire.type === "assistant") {
        const obs = this.upsert(session, id, "assistant")
        if (typeof wire.agent === "string") obs.agent = wire.agent
        if (typeof wire.finish === "string") obs.finish = wire.finish
        if (created !== undefined) obs.created = created
        const completed = num(wire.time?.completed)
        if (completed !== undefined) obs.completed = completed
        if (wire.error !== undefined && wire.error !== null) obs.error = wire.error
        if (wire.model && typeof wire.model === "object") {
          const modelID = str((wire.model as { id?: unknown }).id)
          const providerID = str((wire.model as { providerID?: unknown }).providerID)
          if (modelID) obs.modelID = modelID
          if (providerID) obs.providerID = providerID
        }
        if (Array.isArray(wire.content)) {
          let ordinal = 0
          for (const part of wire.content) {
            if (!isWireAssistantContent(part)) continue
            if (part.type === "text" && typeof part.text === "string") {
              const existing = obs.texts.find((candidate) => candidate.ordinal === ordinal)
              if (existing) existing.text = part.text
              else obs.texts.push({ ordinal, text: part.text })
              ordinal += 1
            } else if (part.type === "tool" && typeof part.id === "string") {
              const status = isWireAssistantContent(part.state) && typeof part.state.status === "string" ? part.state.status : undefined
              const state = (part as { state?: { time?: { ran?: unknown; completed?: unknown } } }).state
              const existing = obs.tools.find((tool) => tool.callID === part.id)
              const mapped: ToolObs = {
                callID: part.id,
                ...(typeof part.name === "string" ? { tool: part.name } : {}),
                ...(status ? { status } : {}),
                ...(num(state?.time?.ran) !== undefined ? { start: num(state?.time?.ran) } : {}),
                ...(num(state?.time?.completed) !== undefined ? { end: num(state?.time?.completed) } : {}),
              }
              if (existing) Object.assign(existing, mapped)
              else obs.tools.push(mapped)
            }
          }
          obs.texts.sort((a, b) => a.ordinal - b.ordinal)
        }
        const parentID = derived.get(id)
        if (parentID !== undefined) obs.parentID = parentID
      }
    }
  }

  read(session: string, id: string): Obs | undefined {
    return this.sessions.get(session)?.get(id)
  }

  forget(session: string): void {
    if (this.sessions.delete(session)) {
      this.order = this.order.filter((entry) => entry !== session)
    }
  }
}

const stringtime = (value: number | undefined) => (value === undefined ? undefined : { created: value })

/** 观测 → 共享核 HostMessage（src/delivery.ts 契约）。不虚构缺失字段：stages 因 v2 text part 无 id/time 而自然 fail closed。 */
export function toHostMessage(session: string, obs: Obs): HostMessage | null {
  if (obs.role === "user") {
    return {
      info: { id: obs.id, sessionID: session, role: "user", ...(obs.created !== undefined ? { time: stringtime(obs.created) } : {}) },
      parts: [{ type: "text", ...(obs.synthetic ? { synthetic: true } : {}), text: obs.text ?? "" }],
    }
  }
  const parts: NonNullable<HostMessage["parts"]> = [
    ...obs.texts.map((part) => ({ type: "text", text: part.text })),
    ...obs.tools.map((tool) => ({
      type: "tool",
      callID: tool.callID,
      ...(tool.tool ? { tool: tool.tool } : {}),
      state: { status: tool.status, time: { ...(tool.start !== undefined ? { start: tool.start } : {}), ...(tool.end !== undefined ? { end: tool.end } : {}) } },
    })),
  ]
  return {
    info: {
      id: obs.id,
      sessionID: session,
      role: "assistant",
      ...(obs.parentID ? { parentID: obs.parentID } : {}),
      ...(obs.agent ? { agent: obs.agent } : {}),
      ...(obs.finish ? { finish: obs.finish } : {}),
      ...(obs.created !== undefined || obs.completed !== undefined
        ? { time: { ...(obs.created !== undefined ? { created: obs.created } : {}), ...(obs.completed !== undefined ? { completed: obs.completed } : {}) } }
        : {}),
      ...(obs.error !== undefined ? { error: obs.error } : {}),
      // Council 需要实际模型身份；缺失时 inspectCouncilSource 显式标注，不虚构。
      ...(obs.modelID || obs.providerID ? { modelID: obs.modelID, providerID: obs.providerID } : {}),
    } as HostMessage["info"],
    parts,
  }
}
