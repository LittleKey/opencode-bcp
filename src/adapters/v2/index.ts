// v2 适配层（DESIGN v1.7.1 §16）：@opencode/plugin v2 promise API 接线。
// - 四工具经 ctx.tool.transform/editor.add（options.codemode:false，结果包 {content:text}）
// - subagent 描述幂等追加（§16.4-1：v2 委派工具是 subagent，不是 task）
// - prompt hook 仅观测（§16.3-1）；context hook 承担全部事务与注入（§16.3-2）
// - 请求边界归一化见 ./messages（§16.3-3/4）；注入失败三段语义（§16.3-5）
// - scope/父链经 ctx.session.get 按需补查（§16.4-4：fork 源≠委派父）
// 存储零迁移（§16.5）：dataDir 与账本格式与 v1 完全一致。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { openScopeById, openScopeForRoot, AGG_TRIGGER_VISIBLE, AGG_TRIGGER_SUM_DESC_BYTES, type Scope } from "../../storage"
import { isIsolatedAgent } from "../../permissions"
import { aggregateCandidates } from "../../aggregate"
import { decideAndPersist } from "../../nudge"
import { defineBoardTools, type BoardToolDef } from "../../tools"
import { PRESSURE_REMINDER_TEMPLATE, TASK_DESC_APPEND, TOOL_DESCRIPTIONS } from "../../constants"
import {
  invalidationInput,
  observePrompt,
  resolveRequestBoundary,
  verifiedInput,
  type BoundaryMemo,
} from "./messages"

type Resolved = { scope: Scope; streamId: string; isolated: boolean; agent: string | null } // I1：未知身份为 null（不回退空串）

type SessionInfo = { id: string; parentID: string | null; agent: string }

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

  return { rootDir, skipAgents, scopes, candidates, confirmed, rememberCandidate, confirmedCandidate, skipTainted, forked, log, degrade, warnParent: (id: string) => { if (!parentWarned) { parentWarned = true; console.error(`[blackboard] session-parent-unresolved: ${id}`) } } }
}

export const BlackboardV2Plugin: Plugin.Plugin = {
  id: "opencode-bcp",
  setup: async (ctx) => {
    const options = ctx.options as { dataDir?: string } | undefined
    const dataDir = typeof options?.dataDir === "string" ? options.dataDir : undefined
    const st = createBlackboardState(dataDir)

    // §16.4-4：父链经 ctx.session.get 按需补查（created 热流无 replay，不得依赖）。
    const sessionInfo = async (sessionId: string): Promise<SessionInfo | null> => {
      try {
        const info = await ctx.session.get({ sessionID: sessionId })
        if (!info?.id) return null
        return { id: info.id, parentID: info.parentID ?? null, agent: info.agent ?? "" }
      } catch {
        return null
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

    const boardTools = defineBoardTools({
      resolveScope: lookupScopeContext,
      log: (line) => st.log(line),
    })

    // 四工具注册：options.codemode:false（§16.4-2）；结果包 {content:text}（§16.5）。
    const addBoardTool = (editor: ToolEditor, name: keyof typeof TOOL_DESCRIPTIONS, def: BoardToolDef): void => {
      editor.add({
        name,
        description: TOOL_DESCRIPTIONS[name],
        input: def.args, // Zod4 实现 StandardSchema（§16.5）
        options: { codemode: false },
        execute: async (rawArgs: unknown, tctx: ToolContext) => ({
          // writer.message_id = 工具执行身份（§16.3-4），不与提醒去重键合并
          content: await def.execute({ sessionID: tctx.sessionID, agent: tctx.agent, messageID: tctx.messageID }, rawArgs),
        }),
      })
    }

    await ctx.tool.transform((editor) => {
      addBoardTool(editor, "board_put", boardTools.board_put)
      addBoardTool(editor, "board_get", boardTools.board_get)
      addBoardTool(editor, "board_index", boardTools.board_index)
      addBoardTool(editor, "board_aggregate", boardTools.board_aggregate)
      // §16.4-1：幂等追加 description（保留 executor/schema/options；重复 transform 后恰好一份）。
      editor.update("subagent", (tool) => {
        const desc = typeof tool.description === "string" ? tool.description : ""
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

    // §16.4-4：订阅事件（forked 记录 fork 根），setup 返回 cleanup。
    // R1：session.created 不再承担身份写入——context 是唯一权威登记路径（每次以实际
    // 选中 agent 刷新）。created.agent 是创建时值（session.ts:260-285），且宿主对事件
    // 消费与 context 无顺序屏障（host.ts:255-264），迟到 created 若写身份会回滚已确认
    // 的实际身份/隔离属性并解除 taint。冷启动注册兜底由 context 首个模型请求承担。
    const ac = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
          try {
            if (ev.type === "session.created") {
              // R1：只观测，不写身份（唯一权威路径是 context 的 registerScopeContext）。
            } else if (ev.type === "session.forked") {
              const data = ev.data as { sessionID?: string }
              if (data?.sessionID) st.forked.add(data.sessionID)
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
    }
  },
}

export default BlackboardV2Plugin
