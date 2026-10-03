// v2 适配层（DESIGN v1.7.1 §16 + §16 适配层补充）：@opencode/plugin v2 promise API 接线。
// - 四工具经 ctx.tool.transform/editor.add（options.codemode:false，结果包 {content:text}）；
//   auto 模式（options.autoCapture !== false）不注册 board_put，改注册 board_store（精确消息留存）
// - subagent 描述：auto 用 normalizeTaskDescription + AUTO_TASK_DESC_APPEND；manual 幂等追加
// - prompt hook 仅观测（§16.3-1）；context hook 承担全部事务与注入（§16.3-2）
// - 请求边界归一化见 ./messages（§16.3-3/4）；注入失败三段语义（§16.3-5）
// - scope/父链经 ctx.session.get 按需补查（§16.4-4：fork 源≠委派父）
// - 消息原文：插件 ctx 无全量 client 的 message.get/list → ./snapshot 合并
//   （prompt/context/tool.hook 事件 + ctx.session.context wire 快照），缺失即 fail closed
// - 自动留存：session.text.ended/step.ended(finish=stop) → captureFinal（宿主鉴权/来源/证据）
// - 交付/Council 桥：DELIVERY_BRIDGE / COUNCIL_BRIDGE 按 ctx.location.directory 注册，
//   请求/响应 schema 与 v1 桥完全一致（共享核 inspectDelivery / inspectCouncilSource）
// - 工具拦截：ctx.tool.hook("execute.before"/"execute.after")——edit/write/patch 编辑证据，
//   subagent/task 派发 sourceHandoff + malformedSha256 告警
// 存储零迁移（§16.5）：dataDir 与账本格式与 v1 完全一致。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { openScopeById, openScopeForRoot, AGG_TRIGGER_VISIBLE, AGG_TRIGGER_SUM_DESC_BYTES, type Scope } from "../../storage"
import { isIsolatedAgent, refPolicy, resolveAuthz } from "../../permissions"
import { parseBbId } from "../../ids"
import { aggregateCandidates } from "../../aggregate"
import { decideAndPersist } from "../../nudge"
import { defineBoardTools, type BoardToolDef } from "../../tools"
import {
  AUTO_CAPTURE_INSTRUCTION,
  AUTO_TASK_DESC_APPEND,
  AUTO_TOOL_DESCRIPTIONS,
  PRESSURE_REMINDER_TEMPLATE,
  TASK_DESC_APPEND,
  TOOL_DESCRIPTIONS,
} from "../../constants"
import { malformedSha256 } from "../../artifacts"
import { normalizeTaskDescription, sourceHandoff } from "../../handoff"
import { DELIVERY_BRIDGE, inspectDelivery, type DeliveryRequest, type HostMessage } from "../../delivery"
import {
  captureFinal,
  NO_STORE,
  permissionAction,
  publicationAllowed,
  type CaptureHost,
  type CaptureResult,
  type PermissionRule,
} from "../../capture"
import { beginEditObservation, invalidateEditEvidence, observeEdits, editEvidence } from "../../edit-evidence"
import { messageStore, STORE_DESCRIPTION } from "../../message-store"
import { COUNCIL_BRIDGE, inspectCouncilSource, type CouncilMessage, type CouncilRequest } from "../../council"
import { ReceiptCheck } from "../../receipt-check"
import {
  invalidationInput,
  observePrompt,
  resolveRequestBoundary,
  verifiedInput,
  type BoundaryMemo,
} from "./messages"
import { HostSnapshot, toHostMessage, type WireMessage } from "./snapshot"

type Resolved = { scope: Scope; streamId: string; isolated: boolean; agent: string | null } // I1：未知身份为 null（不回退空串）

type SessionInfo = {
  id: string
  parentID: string | null
  agent: string
  permissions?: unknown
  location?: { directory?: string; project?: { directory?: string; canonical?: string } }
}

type CaptureState = ReturnType<ReceiptCheck["capture"]>

type ToolHookInput = {
  tool?: string
  sessionID?: string
  agent?: string
  messageID?: string
  id?: string
  input?: unknown
  status?: "completed" | "error"
  result?: unknown
  error?: unknown
}

// v2 内建词汇（hosts/v2 实机 @opencode/cli-linux-x64 2.0.20 注册面）：edit/write/glob/grep/
// read/shell/subagent/patch/question/skill；"apply_patch"/"task" 为 v1 名（保留兼容旧引用）。
// patch 工具 options.permission 亦为 "edit"（同一权限动作）。
const EDIT_TOOLS = ["edit", "write", "patch", "apply_patch"]
const DELEGATE_TOOLS = ["subagent", "task"]
const RECIPIENT_EXCLUDED = ["council", "councillor-"] // Council 原文走独立桥，不参与派发引用重写

function createBlackboardState(dataDir: string | undefined) {
  // §16.5：dataDir 不变——v1/v2 共存同一存储布局
  const rootDir = dataDir ?? join(homedir(), ".cache/opencode/blackboard/v1")
  const logPath = dataDir ? join(dataDir, "log/blackboard.log") : join(homedir(), ".cache/opencode/blackboard/log/blackboard.log")
  const skipAgents = (process.env.BLACKBOARD_SKIP_AGENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const scopes = new Map<string, Resolved>()
  // I2（§16.3-1/2）：每会话保留观测过的 admitted 候选集合（观测序、上限 32 FIFO）。
  // prompt 仅登记；确认在 context 按当前快照进行——快照中不存在的候选（queued/steered/
  // 已取消）留在集合内，不得抹掉其他有效输入，也不得顶替快照中更晚的有效输入。
  const candidates = new Map<string, string[]>()
  const confirmed = new Map<string, string>() // R2：每会话至多一个已确认（活跃）候选
  const skipTainted = new Set<string>()
  const forked = new Set<string>() // §16.4-4：session.forked 观测——fork 会话自成一 scope 根
  // 运行输入关联：context 确认的当前业务输入 → 其后 assistant 消息（wire 无 parentID）。
  const runInput = new Map<string, string>()
  let degraded = false
  let parentWarned = false

  const log = (line: Record<string, unknown>): void => {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n")
    } catch {
      /* 日志失败不影响注入路径 */
    }
  }

  // R2/N1：已确认候选与有界待确认队列分离。confirmed 每 session 至多一个（活跃业务输入
  // 身份），不参与淘汰；pending 队列上限 32、FIFO 淘汰最旧未确认观测。淘汰候选若日后
  // 才真正进入快照，其 admission 证据已丢失 → 确认前提不成立 → 保守失效（见下）。
  const rememberCandidate = (sessionId: string, id: string): void => {
    const arr = candidates.get(sessionId) ?? []
    const next = arr.filter((x) => x !== id)
    next.push(id)
    if (next.length > 32) next.splice(0, next.length - 32) // ponytail: FIFO32 只作用于未确认队列
    candidates.set(sessionId, next)
  }
  // 确认规则（N1 前提）：候选必须可关联快照**当前输入**——匹配者必须是快照最后一个
  // role:"user" 消息（本次请求的业务输入锚点），且在候选池（待确认队列 ∪ 已确认）中。
  // ①仅存在于历史中更早位置的旧候选不得证明其后的输入（淘汰候选 q0 再现时，历史 u1
  // 不再充当证据 → 验证不过 → unknown 保守失效）；②无 id 的尾部 user（synthetic
  // continuation 等）无关联资格；③命中队列成员则提升为已确认并移出队列。多候选同在
  // 快照时，尾 user 即最晚者，与原按快照顺序取最晚的语义一致。
  const confirmedCandidate = (sessionId: string, msgs: readonly { id?: string | null; role?: string }[]): string | null => {
    let tailUserId: string | null = null
    let hasTailUser = false
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === "user") {
        const id = msgs[i]!.id
        tailUserId = typeof id === "string" && id.length > 0 ? id : null
        hasTailUser = true
        break
      }
    }
    if (!hasTailUser || tailUserId === null) return null // 无 user 尾 / 无 id 尾：不可关联 → 失效
    const arr = candidates.get(sessionId) ?? []
    const conf = confirmed.get(sessionId)
    const pool = conf === undefined || arr.includes(conf) ? arr : [...arr, conf]
    if (!pool.includes(tailUserId)) return null
    if (tailUserId !== conf) {
      confirmed.set(sessionId, tailUserId)
      candidates.set(sessionId, (candidates.get(sessionId) ?? []).filter((x) => x !== tailUserId))
    }
    return tailUserId
  }

  const degrade = (err: unknown): void => {
    if (degraded) return
    degraded = true
    console.error("[blackboard] degraded:", err instanceof Error ? err.message : String(err))
  }

  return { rootDir, skipAgents, scopes, candidates, confirmed, runInput, rememberCandidate, confirmedCandidate, skipTainted, forked, log, degrade, warnParent: (id: string) => { if (!parentWarned) { parentWarned = true; console.error(`[blackboard] session-parent-unresolved: ${id}`) } } }
}

export const BlackboardV2Plugin: Plugin.Plugin = {
  id: "opencode-bcp",
  setup: async (ctx) => {
    const options = ctx.options as { dataDir?: string; autoCapture?: boolean } | undefined
    const dataDir = typeof options?.dataDir === "string" ? options.dataDir : undefined
    // v1 同口径：autoCapture 默认开启（v1.13 起的自动留存宿主），false 回退手动 board_put 契约。
    const autoCapture = options?.autoCapture !== false
    const descriptions = autoCapture ? AUTO_TOOL_DESCRIPTIONS : TOOL_DESCRIPTIONS
    const taskAppend = autoCapture ? AUTO_TASK_DESC_APPEND : TASK_DESC_APPEND
    const st = createBlackboardState(dataDir)

    // 桥/工具的项目根：v1 用 input.directory；v2 插件 ctx 的位置是插件实例位置，
    // 仅作桥注册键与相对路径解析基准（会话权威身份仍以 context 登记为准，§16.4-4）。
    const projectDir =
      typeof (ctx as { location?: { directory?: unknown } }).location?.directory === "string"
        ? ((ctx as { location: { directory: string } }).location.directory)
        : ""

    // 消息快照 + 交付证据账本 + 已留存记录（父会话可见性）。
    const snapshots = new HostSnapshot()
    const receipts = new ReceiptCheck()
    const editTokens = new Map<string, CaptureState>()
    const recentSources = new Map<string, string[]>()
    const remember = (session: string, id?: string): void => {
      if (!id) return
      recentSources.set(session, [...(recentSources.get(session) ?? []).filter((old) => old !== id), id].slice(-8))
    }

    // §16.4-4：父链经 ctx.session.get 按需补查（created 热流无 replay，不得依赖）。
    const sessionInfo = async (sessionId: string): Promise<SessionInfo | null> => {
      try {
        const info = (await ctx.session.get({ sessionID: sessionId })) as (Omit<SessionInfo, "parentID" | "agent"> & { parentID?: string | null; agent?: string }) | null
        if (!info?.id) return null
        return {
          id: info.id,
          parentID: info.parentID ?? null,
          agent: info.agent ?? "",
          permissions: (info as { permissions?: unknown }).permissions,
          location: (info as { location?: SessionInfo["location"] }).location,
        }
      } catch {
        return null
      }
    }

    // v2 权限来源（2.0.20）：{action,resource,effect} → 共享核 PermissionRule。
    // agent profile 由 ctx.agent.list 异步 RPC 给出（按 AgentInfo.id 匹配）；
    // 会话级 overrides 在 SessionInfo.permissions（拼接在 profile 规则之后，
    // 共享核 findLast 语义 → 会话覆盖优先生效；缺数组即 fail closed，不当作无限制）。
    const toPermissionRules = (rules: unknown): PermissionRule[] =>
      Array.isArray(rules)
        ? rules.flatMap((rule) => {
            if (!rule || typeof rule !== "object") return []
            const { action, resource, effect } = rule as { action?: unknown; resource?: unknown; effect?: unknown }
            if (typeof action !== "string" || typeof resource !== "string") return []
            if (effect !== "allow" && effect !== "deny" && effect !== "ask") return []
            return [{ permission: action, pattern: resource, action: effect }]
          })
        : []

    // 任一失败 → 抛出（调用方按不可用 fail closed），不返回空表冒充“无限制”。
    // 2.0.20 真实面：ctx.agent.list() 是异步 RPC，输出包 {location, data: AgentInfo[]}；
    // AgentInfo = {id, name, permissions}（@opencode/schema/agent；原生 Build → id:"build"、
    // name:"Build"）。授权一律按 AgentInfo.id 匹配（Agent.ID），不按显示名。
    const agentProfiles = async (): Promise<{ id: string; name: string; permission: PermissionRule[] }[]> => {
      const listFn = (ctx as { agent?: { list?: () => unknown } }).agent?.list
      if (typeof listFn !== "function") throw Error("agent_permissions_unavailable")
      const result: unknown = await (listFn as () => Promise<unknown>).call(ctx.agent)
      const wrapped = result as { data?: unknown } | null
      const list = Array.isArray(result) ? result : Array.isArray(wrapped?.data) ? wrapped!.data : null
      if (!Array.isArray(list)) throw Error("agent_permissions_unavailable")
      return list.flatMap((entry) => {
        const raw = entry as { id?: unknown; name?: unknown; permissions?: unknown }
        if (!raw || typeof raw.id !== "string" || !raw.id) return [] // 无 id 的 profile 无授权主体
        if (!Array.isArray(raw.permissions)) return [] // 无权限数组的 profile 视为不可用（不当作无限制）
        return [{ id: raw.id, name: typeof raw.name === "string" ? raw.name : raw.id, permission: toPermissionRules(raw.permissions) }]
      })
    }

    // ---- 消息原文访问（./snapshot；ctx 无 message.get/list，只有 context 装配视图）----
    const wireOf = (result: unknown): WireMessage[] | null => {
      const data = (result as { data?: unknown } | null | undefined)?.data
      const list = Array.isArray(result) ? result : Array.isArray(data) ? data : null
      return list ? (list as WireMessage[]) : null
    }
    const contextMessages = async (session: string): Promise<WireMessage[] | null> => {
      try {
        const contextOf = (ctx.session as unknown as { context?: (input: { sessionID: string }) => Promise<unknown> }).context
        if (typeof contextOf !== "function") return null
        return wireOf(await contextOf.call(ctx.session, { sessionID: session }))
      } catch {
        return null
      }
    }
    const readMessage = async (session: string, id: string): Promise<HostMessage | null> => {
      const read = (): HostMessage | null => {
        const obs = snapshots.read(session, id)
        return obs ? toHostMessage(session, obs) : null
      }
      const cached = snapshots.read(session, id)
      if (!cached) {
        const list = await contextMessages(session)
        if (!list) return null
        snapshots.refresh(session, list)
        return read()
      }
      // 新鲜度（§16 适配层）：text.ended/step.ended 事件装配的 assistant 观测缺宿主终态
      // 事实（time.completed/agent——仅 context wire 快照补齐）。交付/Council 桥先于
      // capture 读终态：立即返回陈旧观测会让 inspectDelivery 用正确的留存记录对照
      // 不完整消息 → 引用被丢（实机 probe：agentMatches/contentMatches/textHashMatches
      // 全 false，canReadResult 未触达）。与 waitCompleted 同一 4×50ms 有界供给；
      // 不伪造：仍缺则返回现有观测（fail closed / 既有原文回退不变），不无限轮询。
      if (cached.role === "assistant" && cached.completed === undefined) {
        for (let attempt = 0; attempt < 4; attempt++) {
          await new Promise((r) => setTimeout(r, 50))
          const list = await contextMessages(session)
          if (list) snapshots.refresh(session, list)
          const obs = snapshots.read(session, id)
          if (obs?.role === "assistant" && obs.completed !== undefined) break
        }
      }
      return read()
    }
    const waitCompleted = async (session: string, id: string): Promise<void> => {
      // 完成时间由宿主写入消息；step.ended 可能先于 context 装配可见该消息——有界重试，
      // 读不到就让 captureFinal 以其自身 reason fail closed，绝不伪造完成时间。
      for (let attempt = 0; attempt < 4; attempt++) {
        const obs = snapshots.read(session, id)
        if (obs?.role === "assistant" && obs.completed !== undefined) return
        await new Promise((r) => setTimeout(r, 50))
        await contextMessages(session).then((list) => { if (list) snapshots.refresh(session, list) })
      }
    }

    const findRoot = async (sessionId: string): Promise<string | null> => {
      let cur = sessionId
      for (let i = 0; i < 32; i++) {
        // fork 会话不并入 fork 源 scope：自成为根（§16.4-4）。
        if (st.forked.has(cur)) return cur
        const info = await sessionInfo(cur)
        if (!info) return null
        if (!info.parentID) return cur
        cur = info.parentID
      }
      return null
    }

    const refreshIdentity = (sessionId: string, cached: Resolved, agent: string): Resolved | null => {
      if (!agent) return cached
      if (agent !== cached.agent || st.skipTainted.has(sessionId) || cached.scope.isSessionSkipTainted(sessionId)) {
        cached.scope.refreshSessionAgent(sessionId, agent)
        cached.agent = agent
        cached.isolated = isIsolatedAgent(agent)
        st.skipTainted.delete(sessionId)
      }
      return cached
    }

  const taintAndInvalidate = (sessionId: string, scope: Scope | null): void => {
    st.candidates.delete(sessionId)
    st.confirmed.delete(sessionId)
    st.scopes.delete(sessionId)
    st.runInput.delete(sessionId)
      st.skipTainted.add(sessionId)
      if (scope) {
        try {
          scope.markSessionSkipTainted(sessionId)
        } catch (err) {
          st.log({ ev: "skip_taint_persist_failed", session: sessionId, error: String(err) })
        }
      }
    }

    const probeExistingScope = async (sessionId: string): Promise<Scope | null> => {
      const root = await findRoot(sessionId)
      if (!root) return null
      const indexPath = join(st.rootDir, "scope-index.json")
      if (!existsSync(indexPath)) return null
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as { scopes?: Record<string, string> }
      const scopeId = index.scopes?.[root]
      if (!scopeId) return null
      try {
        const scope = openScopeById(scopeId, { dataDir: st.rootDir })
        scope.resolveSession(sessionId)
        return scope
      } catch {
        return null
      }
    }

    const coldSkipReject = async (sessionId: string): Promise<null> => {
      taintAndInvalidate(sessionId, null)
      const probed = await probeExistingScope(sessionId)
      if (probed) {
        try {
          probed.markSessionSkipTainted(sessionId)
        } catch (err) {
          st.log({ ev: "skip_taint_persist_failed", session: sessionId, error: String(err) })
        }
      }
      return null
    }

    // 工具路径：只查不建（C2-①）；任何失败 → null。
    const lookupScopeContext = async (sessionId: string, agent: string): Promise<Resolved | null> => {
      try {
        const cached = st.scopes.get(sessionId)
        if (cached) {
          if ((agent && st.skipAgents.includes(agent)) || (cached.agent && st.skipAgents.includes(cached.agent))) {
            taintAndInvalidate(sessionId, cached.scope)
            return null
          }
          if (st.skipTainted.has(sessionId) || cached.scope.isSessionSkipTainted(sessionId)) {
            taintAndInvalidate(sessionId, null)
            return null
          }
          return cached
        }
        if (st.skipAgents.includes(agent)) {
          return await coldSkipReject(sessionId)
        }
        const root = await findRoot(sessionId)
        if (!root) return null
        const indexPath = join(st.rootDir, "scope-index.json")
        if (!existsSync(indexPath)) return null
        const index = JSON.parse(readFileSync(indexPath, "utf8")) as { scopes?: Record<string, string> }
        const scopeId = index.scopes?.[root]
        if (!scopeId) return null
        const scope = openScopeById(scopeId, { dataDir: st.rootDir })
        let streamId: string
        let isolated: boolean
        try {
          const s = scope.resolveSession(sessionId)
          streamId = s.streamId
          isolated = s.isolated
        } catch {
          return null // unknown_session → 未注册不自动加入
        }
        if (st.skipTainted.has(sessionId) || scope.config.session_index[sessionId]?.skip_tainted === true) return null
        const identity = scope.config.session_index[sessionId]?.agent || null
        if (identity && st.skipAgents.includes(identity)) {
          taintAndInvalidate(sessionId, scope)
          return null
        }
        const resolved: Resolved = { scope, streamId, isolated, agent: identity }
        st.scopes.set(sessionId, resolved)
        return resolved
      } catch (err) {
        st.degrade(err)
        return null
      }
    }

    // 注册路径：唯一入口是 context hook（实际选中 agent，§16.3-3；R1 后 created 不写身份）。
    const registerScopeContext = async (sessionId: string, agent: string): Promise<Resolved | null> => {
      try {
        const cached = st.scopes.get(sessionId)
        if (cached) {
          if (agent && st.skipAgents.includes(agent)) {
            taintAndInvalidate(sessionId, cached.scope)
            return null
          }
          if (!agent && (st.skipTainted.has(sessionId) || cached.scope.isSessionSkipTainted(sessionId))) {
            taintAndInvalidate(sessionId, null)
            return null
          }
          return refreshIdentity(sessionId, cached, agent)
        }
        if (st.skipAgents.includes(agent)) {
          return await coldSkipReject(sessionId)
        }
        const root = await findRoot(sessionId)
        if (!root) {
          st.warnParent(sessionId)
          return null
        }
        const scope = openScopeForRoot({ rootSessionId: root, dataDir: st.rootDir })
        const reg = scope.registerSession(sessionId, agent)
        const registered = scope.config.session_index[sessionId]
        const tainted = st.skipTainted.has(sessionId) || registered?.skip_tainted === true
        const identity = agent || registered?.agent || null
        if (identity && st.skipAgents.includes(identity)) {
          taintAndInvalidate(sessionId, scope)
          return null
        }
        if (agent) st.skipTainted.delete(sessionId)
        else if (tainted) return null
        const resolved: Resolved = { scope, streamId: reg.streamId, isolated: identity ? isIsolatedAgent(identity) : false, agent: identity }
        st.scopes.set(sessionId, resolved)
        return resolved
      } catch (err) {
        st.degrade(err)
        return null
      }
    }

    // ---- 留存宿主（captureFinal 的 v2 实现；与 v1 captureHost 同一共享核契约）----
    const requestedNoStore = (authorInput: HostMessage | null): boolean =>
      Boolean(authorInput?.parts?.some((p) => p.type === "text" && typeof p.text === "string" && p.text.includes(NO_STORE)))

    const captureHost: CaptureHost = {
      resolve: (id) => lookupScopeContext(id, "").then((r) => (r ? { scope: r.scope, streamId: r.streamId, agent: r.agent } : null)),
      message: readMessage,
      current: (id, parent) => st.confirmed.get(id) === parent,
      edits: (id, parent) => receipts.edits(id, parent),
      evidence: async (id, parent, completed, access, stage) => {
        const resolved = await lookupScopeContext(id, "")
        if (!resolved) return { paths: [], bindings: [], errors: ["edit_evidence_author_unavailable"] }
        try {
          return await editEvidence(resolved.scope, resolved.streamId, parent, completed, access, stage)
        } catch (error) {
          return { paths: receipts.edits(id, parent)?.paths ?? [], bindings: [], errors: [error instanceof Error ? error.message : String(error)] }
        }
      },
      // 来源/授权事实全部来自宿主面：agent profile（ctx.agent.list）+ 会话级规则
      // （ctx.session.get）。规则不可得 → null（publication_not_authorized fail closed）。
      // 授权身份是 context 登记的 Agent.ID：profile 按 AgentInfo.id 匹配（原生
      // Build id="build" ≠ 显示名 "Build"；按显示名匹配会让合法作者 fail closed）。
      authorize: async (id, agent, authorInput) => {
        const profiles = await agentProfiles() // 可能抛出 → captureFinal 捕获为可见 reason
        const profile = profiles.find((p) => p.id === agent)
        const current = await sessionInfo(id)
        if (!profile || current?.id !== id || (current.permissions !== undefined && !Array.isArray(current.permissions))) return null
        // v2 user wire 消息无 per-message 工具开关（无 tools 字段）：按规则集裁决。
        const rules = [...profile.permission, ...toPermissionRules(current.permissions ?? [])]
        if (!publicationAllowed(rules, authorInput.info.tools ?? {}, autoCapture)) return null
        const directory = current.location?.project?.canonical ?? current.location?.directory ?? projectDir
        return {
          directory,
          ask: async ({ permission, patterns }) => {
            if (patterns.some((pattern) => permissionAction(rules, permission, pattern) !== "allow"))
              throw Error("capture_source_permission_not_granted")
          },
        }
      },
    }

    // 已留存记录 → 作者/父会话的 recentSources（交付引用与 sourceHandoff 的基础）。
    const retained = async (session: string, id?: string): Promise<void> => {
      if (!id) return
      const resolved = await lookupScopeContext(session, "")
      if (!resolved || refPolicy(resolveAuthz(resolved.scope, { sessionId: session, agent: "" }), parseBbId(id)) !== "ok") return
      const found = resolved.scope.getById(id)
      if (found.status !== "found") return
      remember(session, id)
      if (found.record.writer.session_id === session && found.record.origin) {
        receipts.sourced(session, found.record.origin.input_message_id, id)
      }
    }

    // 自动/桥共用的留存入口：等待宿主完成时间可见 → captureFinal → retained → 父链可见性。
    const capture = async (session: string, message: string): Promise<CaptureResult> => {
      await waitCompleted(session, message)
      const result = await captureFinal(session, message, captureHost)
      await retained(session, result.id)
      // 父会话交付可见性不得依赖集成侧终结回调顺序（v1 同构：parent 记入 recentSources）。
      const parent = result.id && (await sessionInfo(session))?.parentID
      const resolved = parent && (await lookupScopeContext(parent, ""))
      if (result.id && parent && resolved && refPolicy(resolveAuthz(resolved.scope, { sessionId: parent, agent: "" }), parseBbId(result.id)) === "ok") {
        remember(parent, result.id)
      }
      return result
    }

    // 接收方读取能力（交付 result_reference / 派发 source 手递门槛）。
    // BCP 作用域可读不等于宿主允许调用 board_get。有效工具权限不可见时保留原文，
    // 不能把“没有规则”解释为 allow，或以以后可能成功的工具调用代替当前权限证据。
    const canReadResult = async (session: string): Promise<boolean> => {
      const resolved = await lookupScopeContext(session, "")
      const currentInput = st.confirmed.get(session)
      if (!resolved?.agent || resolved.isolated || !currentInput) return false
      const authorInput = await readMessage(session, currentInput)
      if (!authorInput || authorInput.info.role !== "user" || authorInput.info.sessionID !== session || authorInput.info.id !== currentInput) return false
      let profiles: { id: string; name: string; permission: PermissionRule[] }[]
      let current: SessionInfo | null
      try {
        profiles = await agentProfiles()
        current = await sessionInfo(session)
      } catch {
        return false
      }
      const profile = profiles.find((p) => p.id === resolved.agent)
      if (!profile || current?.id !== session || (current.permissions !== undefined && !Array.isArray(current.permissions))) return false
      const rules = [...profile.permission, ...toPermissionRules(current.permissions ?? [])]
      return st.confirmed.get(session) === currentInput && permissionAction(rules, "board_get", "*") === "allow"
    }

    // ---- 交付 / Council 桥（请求/响应 schema 与 v1 完全一致；键=项目目录）----
    // 消费方契约（integrations/omo-slim）：globalThis[BRIDGE]?.get?.(directory) → handler(request)。
    const deliveryHost = {
      scopeFor: (id: string) => lookupScopeContext(id, "").then((r) => (r ? r.scope : null)),
      parentFor: (id: string) => sessionInfo(id).then((r) => r?.parentID ?? null),
      message: readMessage,
      capture: (session: string, message: string) => capture(session, message),
      canReadResult,
      currentResult: (id: string, parent: string) => st.confirmed.get(id) === parent,
    }
    const councilHost = {
      parentFor: deliveryHost.parentFor,
      message: (session: string, id: string) => readMessage(session, id) as Promise<CouncilMessage | null>,
      current: deliveryHost.currentResult,
      isSeat: async (agent: string) => {
        try {
          // 席位身份按 AgentInfo.id 匹配（授权与 Council 同一主体口径）。
          return agent.startsWith("councillor-") && (await agentProfiles()).some((p) => p.id === agent)
        } catch {
          return false
        }
      },
    }
    // ---- 交付 / Council 桥（请求/响应 schema 与 v1 完全一致；键=项目目录）----
    // 共享契约与 v1 同一 Symbol：注册表是 Map<projectDir, handler>（v1 生产方
    // bridges.set(input.directory, handler)），消费方契约（integrations/omo-slim）
    // 为 globalThis[BRIDGE]?.get?.(directory) → handler(request)，Map.get 即满足。
    // 已存在的 Map 必须复用（v1/v2 混部、多项目注册共存）；缺失则新建；非 Map 的
    // 外来值不覆盖、不注册（契约冲突按不可用 fail closed，结构化日志可见）。
    const bridgeRegistrations: Array<() => void> = []
    const registerBridge = <Req,>(symbol: PropertyKey, handler: (request: Req) => Promise<unknown>): void => {
      const globals = globalThis as Record<PropertyKey, unknown>
      const existing = globals[symbol]
      if (existing !== undefined && !(existing instanceof Map)) {
        st.log({ ev: "bridge_registry_conflict", bridge: String(symbol), reason: "non_map_registry" })
        return
      }
      if (existing === undefined) globals[symbol] = new Map<string, (request: Req) => Promise<unknown>>()
      const map = globals[symbol] as Map<string, (request: Req) => Promise<unknown>>
      map.set(projectDir, handler)
      // 身份安全清理：仅当目录键仍指向本实例注册的 handler 时才移除——reload 后
      // 迟到的旧实例清理不得移除已替换该键的新实例注册。
      bridgeRegistrations.push(() => {
        if (map.get(projectDir) === handler) map.delete(projectDir)
      })
    }
    registerBridge<DeliveryRequest>(DELIVERY_BRIDGE, (request) => inspectDelivery(request, deliveryHost))
    registerBridge<CouncilRequest>(COUNCIL_BRIDGE, (request) => inspectCouncilSource(request, councilHost))

    const boardTools = defineBoardTools({
      resolveScope: lookupScopeContext,
      log: (line) => st.log(line),
      // 留存观察：put 落盘即记入 receipts + recentSources（交付覆盖与 sourceHandoff 基础，v1 同构）。
      observePublication: (session, message) => {
        const started = receipts.capture(session, message)
        return (id, bindings, status) => {
          remember(session, id)
          receipts.published(session, started, id, bindings.map((b) => b.path), status)
          st.log({ ev: "handoff_observed", session, id, status, retained_artifacts: bindings.length })
        }
      },
    })

    // board_store（精确消息留存）：宿主决定作者/正文/授权，模型只能点名消息。
    const storeTool = messageStore({
      ...captureHost,
      messages: async (session, limit) => {
        const list = await contextMessages(session)
        if (!list) throw Error("messages_unavailable")
        snapshots.refresh(session, list)
        const mapped: HostMessage[] = []
        for (const wire of list) {
          const id = typeof wire?.id === "string" ? wire.id : ""
          if (!id) continue
          const obs = snapshots.read(session, id)
          if (!obs) continue
          const message = toHostMessage(session, obs)
          if (message) mapped.push(message)
        }
        return mapped.slice(-limit)
      },
      authorizeCaller: async (tctx) => {
        const resolved = await lookupScopeContext(tctx.sessionID, "")
        const parent = st.confirmed.get(tctx.sessionID)
        const authorInput = parent && (await readMessage(tctx.sessionID, parent))
        if (!resolved?.agent || !authorInput || requestedNoStore(authorInput)) return false
        return Boolean(await captureHost.authorize(tctx.sessionID, resolved.agent, authorInput))
      },
      stored: retained,
    })

    // 工具注册：options.codemode:false（§16.4-2）；结果包 {content:text}（§16.5）。
    // auto 模式：board_put 退役（自动留存 + board_store），不注册、不出现在工具面。
    const addBoardTool = (editor: ToolEditor, name: string, description: string, def: BoardToolDef): void => {
      editor.add({
        name,
        description,
        input: def.args, // Zod4 实现 StandardSchema（§16.5）
        options: { codemode: false },
        execute: async (rawArgs: unknown, tctx: ToolContext) => ({
          // writer.message_id = 工具执行身份（§16.3-4），不与提醒去重键合并
          content: await def.execute({ sessionID: tctx.sessionID, agent: tctx.agent, messageID: tctx.messageID }, rawArgs),
        }),
      })
    }

    await ctx.tool.transform((editor) => {
      if (!autoCapture) addBoardTool(editor, "board_put", TOOL_DESCRIPTIONS.board_put, boardTools.board_put)
      addBoardTool(editor, "board_get", descriptions.board_get ?? TOOL_DESCRIPTIONS.board_get, boardTools.board_get)
      addBoardTool(editor, "board_index", descriptions.board_index ?? TOOL_DESCRIPTIONS.board_index, boardTools.board_index)
      addBoardTool(editor, "board_aggregate", descriptions.board_aggregate ?? TOOL_DESCRIPTIONS.board_aggregate, boardTools.board_aggregate)
      addBoardTool(editor, "board_store", STORE_DESCRIPTION, storeTool)
      // §16.4-1：幂等追加 description（保留 executor/schema/options；重复 transform 后恰好一份）。
      // auto 模式：清除 v1 手动契约文案（TASK_DESC_APPEND 与任务工具散文）后换 auto 契约。
      editor.update("subagent", (tool) => {
        const desc = typeof tool.description === "string" ? tool.description : ""
        if (autoCapture) {
          if (desc.includes(AUTO_TASK_DESC_APPEND)) return
          const cleaned = normalizeTaskDescription(desc.split(TASK_DESC_APPEND).join(""))
          const sep = cleaned && !/\s$/.test(cleaned) ? "\n\n" : ""
          tool.description = cleaned + sep + AUTO_TASK_DESC_APPEND
          return
        }
        if (desc.includes(TASK_DESC_APPEND)) return
        const sep = desc && !/\s$/.test(desc) ? "\n\n" : ""
        tool.description = desc + sep + TASK_DESC_APPEND
      })
    })

    // §16.3-1：prompt 仅观测——登记候选（I2：集合非单槽），不推进轮次/预算，不注册
    // （此处无 agent 上下文）。不可 admissible 的观测（internal/synthetic）不清集合：
    // queued/steered 的有效输入不得被无关观测抹掉。
    await ctx.session.hook("prompt", async (input) => {
      try {
        const text = typeof input.prompt?.text === "string" ? input.prompt.text : ""
        const obs = observePrompt(input.messageID, text)
        if (obs.admissible && obs.inputMessageId) {
          st.rememberCandidate(input.sessionID, obs.inputMessageId)
          // 宿主现场投递的 user 原文（ID + 正文）——board_store 列表/NO_STORE 检查的基础。
          snapshots.observeUser(input.sessionID, obs.inputMessageId, text)
        }
        st.log({ ev: "round_observed", session: input.sessionID, message_id: obs.inputMessageId, admitted: obs.admissible })
      } catch (err) {
        st.degrade(err) // 观测故障降级，绝不阻塞（§16.3-5）
      }
    })

    let boundaryMemo: BoundaryMemo = {}

    // I4（§16.3-5a）：可确定性预检全部前置——定位目标 user、查重、构造不可变 replacement。
    // 预检失败 → 零扣减（不进入 decideAndPersist），也不影响 unknown 失效事务（调用方分流）。
    const precheckInject = (msgs: Array<{ role?: string; content?: unknown; [k: string]: unknown }>): { ok: false } | { ok: true; idx: number; message: Record<string, unknown> } => {
      if (Object.isFrozen(msgs)) return { ok: false } // 只读快照：提前可检，不得先扣预算
      let idx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === "user") {
          idx = i
          break
        }
      }
      if (idx < 0) return { ok: false }
      const target = msgs[idx]!
      const content = Array.isArray(target.content) ? (target.content as Array<{ type?: string; text?: string }>) : []
      if (content.some((p) => p?.type === "text" && p.text === PRESSURE_REMINDER_TEMPLATE)) return { ok: false } // 已有模板：查重前置
      const message = { ...target, content: [...content, { type: "text", text: PRESSURE_REMINDER_TEMPLATE }] }
      return { ok: true, idx, message }
    }

    // §16.3-2：context hook 承担全部事务与注入；禁改 prompt.text（本 hook 不触 prompt）。
    // 宿主 await 本回调返回的 Promise 后才消费 messages（Hooks callback: Promise<void> | void）。
    await ctx.session.hook("context", (input) => {
      return (async () => {
        try {
          const sessionId = input.sessionID
          if (!sessionId) return
          const msgs = input.messages
          // I1：每次 context 都以实际选中 agent 走权威登记/刷新路径（缓存命中亦刷新，
          // 含 skip 恢复）；实际身份不得被旧缓存或迟到 created 压过。工具执行仍只查不建。
          const resolved = await registerScopeContext(sessionId, input.agent ?? "")
          if (!resolved) return
          // §16.3-3/4：请求边界归一化（unknown 不造随机 ID；同边界重试复用键）。
          const norm = resolveRequestBoundary(sessionId, msgs, boundaryMemo)
          boundaryMemo = norm.memo
          const boundary = norm.boundary
          const requestId = boundary.provable ? boundary.key : `${sessionId}:unknown`
          // I2：按当前快照确认候选（快照外 queued/取消候选不参与，也不触发无关失效）。
          const confirmed = st.confirmedCandidate(sessionId, msgs)
          const requestVerified = confirmed !== null
          // 运行输入关联 + 留存证据账本：确认的当前输入是其后 assistant 交付的 parent。
          if (confirmed !== null) {
            st.runInput.set(sessionId, confirmed)
            receipts.begin(sessionId, confirmed)
          } else {
            st.runInput.delete(sessionId)
          }
          // auto 模式：把终结回复格式契约推入 system（v1 experimental.chat.system.transform 同构；
          // 只在确认的业务输入请求上注入，system 数组不可用时静默跳过）。
          if (autoCapture && confirmed !== null) {
            const system = (input as { system?: Array<{ type?: string; text?: string }> }).system
            if (Array.isArray(system) && !system.some((part) => part?.text === AUTO_CAPTURE_INSTRUCTION)) {
              system.push({ type: "text", text: AUTO_CAPTURE_INSTRUCTION })
            }
          }
          // I2：读段单一外层流锁（v1 同构）。
          const { candidateSetId } = resolved.scope.withLock(() => {
            const meta0 = resolved.scope.readMeta(resolved.streamId)
            const agent = resolved.agent ?? ""
            const candidates = aggregateCandidates(
              resolved.scope,
              resolved.streamId,
              { sessionId, agent },
              meta0.rounds.round_known ? meta0.rounds.current_round : null,
            )
            const candidateSetId =
              candidates !== null &&
              (candidates.visibleItems > AGG_TRIGGER_VISIBLE || candidates.sumDescriptionBytes > AGG_TRIGGER_SUM_DESC_BYTES)
                ? candidates.setHash
                : null
            return { candidateSetId }
          })
          // I4：verified 注入路径先预检；unknown/验证不过的失效事务不受预检影响。
          const willVerify = boundary.provable && requestVerified
          let replacement: { idx: number; message: Record<string, unknown> } | null = null
          if (willVerify) {
            const pre = precheckInject(msgs as Array<{ role?: string; content?: unknown }>)
            if (!pre.ok) {
              st.log({ ev: "decision", session: sessionId, stream: resolved.streamId, request_id: requestId, reason: "precheck_failed", bytes: 0 })
              return // 预检失败 → 零扣减（不推进、不扣预算、不注入）
            }
            replacement = pre
          }
          let decision
          try {
            const txInput = willVerify
              ? verifiedInput(sessionId, boundary, confirmed!, candidateSetId)
              : invalidationInput(sessionId) // §16.3-3：unknown/验证不过 → 保守失效落盘（双 round_known=false）
            decision = decideAndPersist(resolved.scope, resolved.streamId, { sessionId, ...txInput })
          } catch (err) {
            st.degrade(err) // (b) 持久化失败 → 不注入（§16.3-5）
            return
          }
          const afterMeta = resolved.scope.readMeta(resolved.streamId)
          if (decision.advanced || decision.identityRestored) {
            st.log({
              ev: "round",
              session: sessionId,
              stream: resolved.streamId,
              message_id: confirmed,
              current_round: afterMeta.rounds.current_round,
              round_known: true,
            })
          }
          if (!decision.inject || !willVerify) {
            st.log({ ev: "decision", session: sessionId, stream: resolved.streamId, request_id: requestId, round_id: afterMeta.budget.round_id, round_used: afterMeta.budget.round_used, reason: decision.reason, bytes: 0 })
            return
          }
          // (c) 先持久化后赋值：replacement 已预检构造；此处赋值失败 = 真正提交后失败
          // → 保守损失一次注入机会，不伪称送达、不盲退预算（§16.3-5）。
          try {
            ;(msgs as Array<unknown>)[replacement!.idx] = replacement!.message
          } catch (err) {
            st.degrade(err)
            return
          }
          st.log({ ev: "decision", session: sessionId, stream: resolved.streamId, request_id: requestId, round_id: afterMeta.budget.round_id, round_used: afterMeta.budget.round_used, reason: decision.reason, bytes: new TextEncoder().encode(PRESSURE_REMINDER_TEMPLATE).length })
        } catch (err) {
          st.degrade(err)
        }
      })()
    })

    // ---- 工具拦截（v1 tool.execute.before/after 的 v2 原生面）----
    const toAbsolute = (raw: string): string => (isAbsolute(raw) ? resolve(raw) : projectDir ? resolve(projectDir, raw) : "")

    await ctx.tool.hook("execute.before", async (hook) => {
      const input = hook as ToolHookInput
      try {
        const sessionID = input.sessionID
        if (!sessionID) return
        if (input.tool && EDIT_TOOLS.includes(input.tool)) {
          // 编辑观察只跟随宿主确认的当前输入；authorInput 不可得/受限 → 不观察。
          const started = receipts.capture(sessionID, input.messageID)
          if (input.id && started) editTokens.set(`${sessionID}:${input.id}`, started)
          if (editTokens.size > 128) {
            const oldest = editTokens.keys().next().value
            if (oldest !== undefined) editTokens.delete(oldest)
          }
          if (!started) return
          const resolved = await lookupScopeContext(sessionID, "")
          if (!resolved?.agent) return
          const authorInput = await readMessage(sessionID, started.state.input)
          if (!authorInput || requestedNoStore(authorInput)) return
          if (!(await captureHost.authorize(sessionID, resolved.agent, authorInput))) return
          beginEditObservation(resolved.scope, resolved.streamId, started.state.input, input.id ?? "")
        } else if (input.tool && DELEGATE_TOOLS.includes(input.tool)) {
          const args = input.input as { prompt?: unknown; task_id?: unknown; subagent_type?: unknown; agent?: unknown } | null
          if (!args || typeof args.prompt !== "string" || !args.prompt) return
          const kind = typeof args.subagent_type === "string" ? args.subagent_type : typeof args.agent === "string" ? args.agent : ""
          // Council 原文走独立桥，接收方不读板；不参与派发引用重写。
          if (RECIPIENT_EXCLUDED.some((prefix) => kind === prefix || kind.startsWith(prefix))) return
          let prompt: string = args.prompt
          if (autoCapture) {
            const resolved = await lookupScopeContext(sessionID, "")
            if (resolved) {
              // 接收方身份：task_id 必须真实指向本会话子任务；否则按工具名查 agent profile。
              const requested = typeof args.task_id === "string" && args.task_id ? args.task_id : undefined
              const recipient = requested && (await sessionInfo(requested))?.parentID === sessionID ? requested : undefined
              let readable = false
              try {
                if (recipient) readable = await canReadResult(recipient)
                else {
                  // subagent_type/task agent 均为 Agent.ID → 按 AgentInfo.id 查 profile。
                  const profile = (await agentProfiles()).find((p) => p.id === kind)
                  readable = Boolean(profile) && permissionAction(profile!.permission, "board_get", "*") === "allow"
                }
              } catch {
                readable = false // 接收方读取能力未知 → 保留原文（引用重写不掩盖不可证的能力）
              }
              if (readable) {
                const routed = sourceHandoff(
                  resolved.scope,
                  sessionID,
                  prompt,
                  recentSources.get(sessionID) ?? [],
                  receipts.sources(sessionID, st.confirmed.get(sessionID) ?? ""),
                  recipient,
                )
                prompt = routed.prompt
                if (routed.references.length) {
                  st.log({ ev: "source_handoff", session: sessionID, call: input.id, recipient: recipient ?? kind, references: routed.references, removed_bytes: routed.removedBytes })
                }
              }
            }
          }
          if (!malformedSha256(prompt)) {
            args.prompt = prompt
            return
          }
          // 篡改/非法的 SHA-256 声明在发送前可见；本身可能是分析对象，不阻断派发（v1 同文案）。
          const warning = "BCP version warning: an explicit SHA-256 declaration in this input is not 64 hex digits. Treat that version claim as unverified and check the original source before acceptance."
          if (!prompt.includes(warning)) prompt += "\n\n" + warning
          args.prompt = prompt
          st.log({ ev: "invalid_sha256", session: sessionID, call: input.id })
        }
      } catch (err) {
        st.degrade(err)
      }
    })

    await ctx.tool.hook("execute.after", async (hook) => {
      const input = hook as ToolHookInput
      try {
        const sessionID = input.sessionID
        if (!sessionID || !input.messageID) return
        const isEdit = Boolean(input.tool && EDIT_TOOLS.includes(input.tool))
        // 每个工具调用都补全 assistant 名下的调用痕迹（capture 的 publicReply 完整性依据）。
        snapshots.observeAssistantTool(
          sessionID,
          input.messageID,
          {
            callID: input.id ?? "",
            ...(input.tool ? { tool: input.tool } : {}),
            status: input.status === "completed" ? "completed" : "error",
            end: Date.now(),
          },
          input.agent,
        )
        snapshots.linkParent(sessionID, input.messageID, st.runInput.get(sessionID))
        receipts.assistant(sessionID, input.messageID, st.runInput.get(sessionID))
        if (!isEdit) return
        const started = input.id ? editTokens.get(`${sessionID}:${input.id}`) : undefined
        if (input.id) editTokens.delete(`${sessionID}:${input.id}`)
        if (autoCapture && !started) return
        const resolved = await lookupScopeContext(sessionID, "")
        if (!resolved) return
        // 路径事实：v2 edit/write 输入字段是 path（v1 语义 filePath）；patch 的输入只有
        // patchText，路径在 result.metadata.files[]（v2 patch 条目带 filePath，v2 edit 的
        // FileDiff.Info 条目带 file——两者都收，取不到即 unknownPath 走保守失效）。
        let rawPaths: (string | null)[] = []
        if (input.tool === "apply_patch" || input.tool === "patch") {
          const files = (input.result as { metadata?: { files?: Array<{ filePath?: unknown; file?: unknown }> } } | undefined)?.metadata?.files
          rawPaths = Array.isArray(files)
            ? files.map((f) => {
                const fp = typeof f?.filePath === "string" && f.filePath ? f.filePath : typeof f?.file === "string" && f.file ? f.file : null
                return fp
              })
            : []
        } else {
          const arg = input.input as { filePath?: unknown; path?: unknown } | null | undefined
          const raw = typeof arg?.filePath === "string" && arg.filePath ? arg.filePath : typeof arg?.path === "string" && arg.path ? arg.path : null
          rawPaths = [raw]
        }
        const unknownPath = rawPaths.some((p) => p === null)
        const paths: string[] = []
        for (const raw of rawPaths) {
          if (!raw) continue
          const abs = toAbsolute(raw)
          for (const p of new Set([raw, ...(abs ? [abs] : [])])) paths.push(p)
        }
        receipts.changed(sessionID, unknownPath ? [] : paths, started)
        if (!started || !resolved?.agent) return
        if (receipts.capture(sessionID, started.state.input)?.state !== started.state) return
        const parent = started.state.input
        const authorInput = await readMessage(sessionID, parent)
        if (!authorInput || requestedNoStore(authorInput)) return
        const access = await captureHost.authorize(sessionID, resolved.agent, authorInput)
        if (!access) return
        await observeEdits(
          resolved.scope,
          resolved.streamId,
          parent,
          input.id ?? "",
          paths,
          access,
          () => {
            const current = receipts.capture(sessionID, parent)
            return !started || (current?.state === started.state)
          },
          Date.now,
          unknownPath,
        )
      } catch (err) {
        // 证据通道任何异常：显式失效待定观察（不留半份证据），事件循环继续。
        try {
          const resolved = await lookupScopeContext(input.sessionID ?? "", "")
          const started = input.id ? editTokens.get(`${input.sessionID}:${input.id}`) : undefined
          if (resolved) invalidateEditEvidence(resolved.scope, resolved.streamId, started?.state.input ?? st.confirmed.get(input.sessionID ?? "") ?? "")
        } catch {
          /* 已在降级路径 */
        }
        st.degrade(err)
      }
    })

    // §16.4-4：订阅事件（forked 记录 fork 根；deleted 清理；text/step 驱动留存），
    // setup 返回 cleanup。R1：session.created 不再承担身份写入——context 是唯一权威
    // 登记路径（每次以实际选中 agent 刷新）。created.agent 是创建时值，且宿主对事件
    // 消费与 context 无顺序屏障，迟到 created 若写身份会回滚已确认的实际身份/隔离属性
    // 并解除 taint。冷启动注册兜底由 context 首个模型请求承担。
    const ac = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
          try {
            const event = ev as { type?: string; data?: Record<string, unknown> }
            if (event.type === "session.created") {
              // R1：只观测，不写身份（唯一权威路径是 context 的 registerScopeContext）。
            } else if (event.type === "session.forked") {
              const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
              if (sessionID) st.forked.add(sessionID)
            } else if (event.type === "session.deleted") {
              const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
              if (!sessionID) continue
              receipts.forget(sessionID)
              recentSources.delete(sessionID)
              st.runInput.delete(sessionID)
              snapshots.forget(sessionID)
              for (const key of [...editTokens.keys()]) {
                if (key.startsWith(`${sessionID}:`)) editTokens.delete(key)
              }
            } else if (event.type === "session.text.ended") {
              const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
              const assistantID = typeof event.data?.assistantMessageID === "string" ? event.data.assistantMessageID : ""
              const ordinal = typeof event.data?.ordinal === "number" ? event.data.ordinal : -1
              const text = typeof event.data?.text === "string" ? event.data.text : ""
              if (!sessionID || !assistantID || ordinal < 0) continue
              snapshots.observeAssistantText(sessionID, assistantID, ordinal, text)
              snapshots.linkParent(sessionID, assistantID, st.runInput.get(sessionID))
              receipts.assistant(sessionID, assistantID, st.runInput.get(sessionID))
            } else if (event.type === "session.step.failed") {
              const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
              const assistantID = typeof event.data?.assistantMessageID === "string" ? event.data.assistantMessageID : ""
              if (sessionID && assistantID) {
                st.log({ ev: "step_failed", session: sessionID, message_id: assistantID, error: event.data?.error })
              }
            } else if (event.type === "session.step.ended") {
              const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
              const assistantID = typeof event.data?.assistantMessageID === "string" ? event.data.assistantMessageID : ""
              const finish = typeof event.data?.finish === "string" ? event.data.finish : ""
              if (!sessionID || !assistantID || !finish) continue
              snapshots.observeAssistantMeta(sessionID, assistantID, { finish })
              snapshots.linkParent(sessionID, assistantID, st.runInput.get(sessionID))
              receipts.assistant(sessionID, assistantID, st.runInput.get(sessionID))
              if (finish !== "stop") continue
              if (autoCapture) {
                // 自动留存：终结回复由宿主核验（作者/授权/来源/编辑证据），不依赖模型自觉。
                const result = await capture(sessionID, assistantID)
                st.log({ ev: "final_capture", session: sessionID, message_id: assistantID, ...result })
                if (result.status === "unconfirmed") {
                  st.log({ ev: "final_capture_unconfirmed", session: sessionID, message_id: assistantID, reason: result.reason, notice: TOAST_UNSUPPORTED_NOTE })
                }
                continue
              }
              // 手动模式：终结观察（交付覆盖事实，缺交付即可见）。
              const observation = receipts.finish(sessionID, assistantID, st.runInput.get(sessionID))
              if (!observation) continue
              st.log({ ev: "delivery_observation", session: sessionID, message_id: assistantID, ...observation })
              if (observation.status === "missing_handoff" || observation.status === "manual_version_check") {
                st.log({ ev: "delivery_gap", session: sessionID, message_id: assistantID, ...observation, notice: TOAST_UNSUPPORTED_NOTE })
              }
            }
          } catch (err) {
            st.degrade(err)
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) st.degrade(err)
      }
    })()

    return () => {
      ac.abort()
      // 桥注销：身份安全（见 registerBridge）——只移除仍指向本实例的目录键。
      for (const unregister of bridgeRegistrations) unregister()
    }
  },
}

// 可见缺失事实：2.0.20 插件 ctx 没有 emit TUI toast 的受支持原语（tui.toast.show 是
// TUI 消费的事件类型，插件事件域只有 subscribe）——以结构化日志承载 unconfirmed/delivery_gap。
const TOAST_UNSUPPORTED_NOTE =
  "tui_toast_unavailable: no supported plugin primitive in @opencode/plugin 2.0.20 emits TUI toasts; missing-evidence facts are visible in this structured log only"

export default BlackboardV2Plugin
