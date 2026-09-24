// Task 5：插件入口装配——会话/scope 归因、注入事务、降级。
// 依据 harness/live-protocol.md A-C1/A-C2/A-C5/A-C6 与 DESIGN §3/§10.2/§11.1/§13.2。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Hooks, Plugin, ToolDefinition, ToolContext } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"
import { openScopeById, openScopeForRoot, AGG_TRIGGER_VISIBLE, AGG_TRIGGER_SUM_DESC_BYTES, type Scope } from "./storage"
import { isIsolatedAgent } from "./permissions"
import { classifyInput, isKnownSyntheticText } from "./rounds"
import { aggregateCandidates } from "./aggregate"
import { decideAndPersist } from "./nudge"
import { detectSignals } from "./signals"
import { defineBoardTools, type BoardToolDef } from "./tools"
import { ENTRY_REMINDER_TEMPLATE, PRESSURE_REMINDER_TEMPLATE, TASK_DESC_APPEND, TOOL_DESCRIPTIONS } from "./constants"

type Resolved = { scope: Scope; streamId: string; isolated: boolean; agent: string | null } // I1：未知身份为 null（不再以空串冒充）

type SessionInfo = { id: string; parentID: string | null; agent: string }

// 每插件实例一份（生产 = 每进程一份）；测试隔离用独立实例。
function createBlackboardState(dataDir: string | undefined) {
  const rootDir = dataDir ?? join(homedir(), ".cache/opencode/blackboard/v1")
  const logPath = dataDir ? join(dataDir, "log/blackboard.log") : join(homedir(), ".cache/opencode/blackboard/log/blackboard.log")
  const skipAgents = (process.env.BLACKBOARD_SKIP_AGENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const scopes = new Map<string, Resolved>() // sessionId → 解析结果（含根会话自己）
  const admitted = new Map<string, string>() // sessionId → 最近一次已验证的 admitted messageId
  const skipTainted = new Set<string>() // I1-R：观察到被 skip 身份的会话——空 agent 身份回退失效，直至显式有效身份重新登记
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

  const degrade = (err: unknown): void => {
    if (degraded) return
    degraded = true
    console.error("[blackboard] degraded:", err instanceof Error ? err.message : String(err))
  }

  return { rootDir, skipAgents, scopes, admitted, skipTainted, log, degrade, isDegraded: () => degraded, hasParentWarned: () => parentWarned, warnParent: (id: string) => { if (!parentWarned) { parentWarned = true; console.error(`[blackboard] session-parent-unresolved: ${id}`) } } }
}

export const BlackboardPlugin: Plugin = async (input, options) => {
  const dataDir = typeof options?.dataDir === "string" ? options.dataDir : undefined
  const st = createBlackboardState(dataDir)

  // A-C5：SDK 会话查询，parentID 向上回溯到根。查询失败 → null（宁隔离不串流）。
  const sessionInfo = async (sessionId: string): Promise<SessionInfo | null> => {
    try {
      const res = (await input.client.session.get({ path: { id: sessionId } })) as {
        data?: { id?: string; parentID?: string | null; agent?: string }
      }
      const info = (res?.data ?? res) as { id?: string; parentID?: string | null; agent?: string }
      if (!info?.id) return null
      return { id: info.id, parentID: info.parentID ?? null, agent: info.agent ?? "" }
    } catch {
      return null
    }
  }

  const findRoot = async (sessionId: string): Promise<string | null> => {
    let cur = sessionId
    for (let i = 0; i < 32; i++) {
      const info = await sessionInfo(cur)
      if (!info) return null
      if (!info.parentID) return cur
      cur = info.parentID
    }
    return null
  }

  // I1：身份刷新——注册路径的显式 agent（hookInput.agent）到达且与缓存不同 → 更新缓存与
  // session_index 注册；刷新同样受 skipAgents 约束（不得绕过），isolated 随新身份重算。
  // 空/相同 agent → 维持缓存（身份未知保持 null，不回退空串）。
  const refreshIdentity = (sessionId: string, cached: Resolved, agent: string): Resolved | null => {
    if (!agent) return cached
    // T6-R4/I2-B②：显式合法身份必须走清除 taint 的登记路径——即使与缓存同名
    //（同名提前返回会绕过持久 skip_tainted 清除，造成"盘上标记与放行并存"）
    if (agent !== cached.agent || st.skipTainted.has(sessionId) || cached.scope.isSessionSkipTainted(sessionId)) {
      cached.scope.refreshSessionAgent(sessionId, agent)
      cached.agent = agent
      cached.isolated = isIsolatedAgent(agent)
      st.skipTainted.delete(sessionId) // I1-R：显式有效身份刷新 → 解除保守标记
    }
    return cached
  }

  // T6-R4/I2-C：taint 落地统一顺序——先本实例保守失效（admitted/缓存/内存标记），
  // 再尝试持久化；持久化失败只丢跨重启保护（记日志降级），绝不回滚本实例阻断。
  const taintAndInvalidate = (sessionId: string, scope: Scope | null): void => {
    st.admitted.delete(sessionId)
    st.scopes.delete(sessionId)
    st.skipTainted.add(sessionId)
    if (scope) {
      try {
        scope.markSessionSkipTainted(sessionId)
      } catch (err) {
        st.log({ ev: "skip_taint_persist_failed", session: sessionId, error: String(err) }) // 降级：本实例已阻断
      }
    }
  }

  // T6-R4/I2-A：只查不建地探测既有 Scope（不注册、不缓存）；任何失败 → null。
  // 供显式 skip 身份冷到达时落持久标记（I2-A：冷入口不查既有 Scope 的缺口）。
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

  // T6-R5/漏口2：skip 到达的冷路径——先完成本实例失效（零 IO、零可失败点），再做可失败
  // 的探测/持久化；探测或持久化失败只丢跨重启标记（本实例已阻断），不再吞掉本地失效
  const coldSkipReject = async (sessionId: string): Promise<null> => {
    taintAndInvalidate(sessionId, null)
    const probed = await probeExistingScope(sessionId)
    if (probed) {
      try {
        probed.markSessionSkipTainted(sessionId) // 幂等；失败按降级：本实例已阻断
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
        // T6-R3/I2：显式 skip 身份或缓存身份已是 skip 对象 → 失效缓存 + 持久标记（跨重启）+ taint
        if ((agent && st.skipAgents.includes(agent)) || (cached.agent && st.skipAgents.includes(cached.agent))) {
          taintAndInvalidate(sessionId, cached.scope)
          return null
        }
        // T6-R5/漏口1：持久 taint 检查与 agent 是否为空无关——工具路径只查不刷新，
        // 非空 ctx.agent 不得绕过他实例已落盘的 skip 标记；合法恢复仅经注册路径
        // （chat.message 显式 agent → refreshIdentity → refreshSessionAgent 清除）。
        // IO：每次调用重读整份 scope.json，正确性优先取舍（不缓存，保持他实例写盘一致性）
        if (st.skipTainted.has(sessionId) || cached.scope.isSessionSkipTainted(sessionId)) {
          taintAndInvalidate(sessionId, null) // 标记已在盘上，本实例失效即可
          return null
        }
        return cached // 工具路径只查不建：不刷新注册（刷新在注册路径）
      }
      if (st.skipAgents.includes(agent)) {
        // T6-R4/I2-A：显式 skip 身份冷到达——先本实例失效，再只查不建地探测既有 Scope：
        // 存在则落持久标记；确实无 Scope 才纯内存拒绝不落盘
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
      // I1：工具路径身份 = 注册路径验证值；两者皆未知 → null（保守，不回退空串）
      // I1-R：被 skip 事件标记的会话——空 agent 请求直接阻断（保守路径），不借回退身份放行；
      // skip 判定施加于最终解析身份。
      // T6-R3：内存 taint 为快路径，持久标记为权威源（重启后仍生效）；空 agent 直接阻断
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

  // 注册路径：仅在会话事件 hook（chat.message / session.created）中调用。
  const registerScopeContext = async (sessionId: string, agent: string): Promise<Resolved | null> => {
    try {
      const cached = st.scopes.get(sessionId)
      if (cached) {
        // T6-R3/I2：显式 skip 身份到达 → 失效既有缓存 + 持久标记（跨重启）+ 内存 taint
        if (agent && st.skipAgents.includes(agent)) {
          taintAndInvalidate(sessionId, cached.scope)
          return null
        }
        // T6-R4/I2-B①：空 agent 命中缓存——他实例可能已落盘 skip 标记（P/Q 并存），
        // 定向读持久标记（重读整份 scope.json）；命中即阻断 + 失效本实例缓存
        if (!agent && (st.skipTainted.has(sessionId) || cached.scope.isSessionSkipTainted(sessionId))) {
          taintAndInvalidate(sessionId, null)
          return null
        }
        return refreshIdentity(sessionId, cached, agent) // I1：缓存命中亦刷新身份
      }
      if (st.skipAgents.includes(agent)) {
        // T6-R4/I2-A：显式 skip 身份冷到达——先本实例失效，再只查不建地探测既有 Scope
        // （存在则落持久标记）；确实无 Scope 才纯内存拒绝不落盘
        return await coldSkipReject(sessionId)
      }
      const root = await findRoot(sessionId)
      if (!root) {
        st.warnParent(sessionId)
        return null
      }
      const scope = openScopeForRoot({ rootSessionId: root, dataDir: st.rootDir })
      const reg = scope.registerSession(sessionId, agent)
      // I1 微修（T5 live 残余）：hook agent 非空优先，否则回退该会话已注册验证身份，再否则 null——
      // 无 agent 信息的 CLI 续接（agent=""）不得遮蔽委派注册的身份。isolated 按最终身份计算。
      const registered = scope.config.session_index[sessionId]
      const tainted = st.skipTainted.has(sessionId) || registered?.skip_tainted === true // T6-R3：内存为快路径，持久标记为权威源
      const identity = agent || registered?.agent || null // 两者皆未知 → null（保守，不回退空串）
      if (identity && st.skipAgents.includes(identity)) {
        // T6-R3/I2：skip 判定施加于最终解析身份（含回退出的持久注册身份）→ 失效缓存、持久标记、不登记 admission
        taintAndInvalidate(sessionId, scope)
        return null
      }
      if (agent) st.skipTainted.delete(sessionId) // 显式有效身份重新登记 → 解除保守标记（持久标记由 registerSession 清除）
      else if (tainted) return null // 空 agent + 被标记会话（内存或持久）→ 不缓存、不登记 admission
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
  const toToolDef = (t: BoardToolDef, description: string): ToolDefinition => ({
    description,
    args: (t.args as unknown as { shape: unknown }).shape as ToolDefinition["args"],
    execute: (args: unknown, ctx: ToolContext) => t.execute(ctx, args),
  })

  const hooks: Hooks = {
    tool: {
      board_put: toToolDef(boardTools.board_put, TOOL_DESCRIPTIONS.board_put),
      board_get: toToolDef(boardTools.board_get, TOOL_DESCRIPTIONS.board_get),
      board_index: toToolDef(boardTools.board_index, TOOL_DESCRIPTIONS.board_index),
      board_aggregate: toToolDef(boardTools.board_aggregate, TOOL_DESCRIPTIONS.board_aggregate),
    },

    // §11.7 task 工具定义注入（V15/VP-1）：hook 对全部 toolID 触发，仅在 task 上追加；
    // hook 无 session/agent 上下文 → 文案为 "When delegating…" 通用式（TASK_DESC_APPEND）。
    "tool.definition": async (hookInput, output) => {
      if (hookInput.toolID !== "task") return
      // M3：宿主描述不以空白结尾时补段落分隔，防追加文案与宿主末句粘连
      if (output.description && !/\s$/.test(output.description)) output.description += "\n\n"
      output.description += TASK_DESC_APPEND
    },

    // 准入信号（P0）：messageID 存在即已验证 admission。G7（计划 Task C 偏差②）：
    // 接收侧只登记 st.admitted 与观察日志——轮次推进/预算滚动/身份恢复统一由
    // transform 关联验证事务（decideAndPersist added 段）落地。
    "chat.message": async (hookInput, output) => {
      try {
        // A-C2 口径：CLI 首条 admission 的 inp.messageID 为 null，取值以 output.message.id（== transform lastMsgId）为准
        const msgId = (output.message as { id?: string }).id ?? hookInput.messageID ?? ""
        const signal = msgId
          ? { kind: "admitted" as const, inputMessageId: msgId }
          : { kind: "unverified" as const }
        const text =
          output.parts
            .map((p) => (p.type === "text" ? p.text : ""))
            .join("\n") + msgId
        const cls = classifyInput(signal, { isUser: true, matchesKnownSynthetic: isKnownSyntheticText(text) })
        const resolved = await registerScopeContext(hookInput.sessionID, hookInput.agent ?? "")
        if (!resolved) return
        const admitted = cls === "admitted_input"
        if (admitted) {
          st.admitted.set(hookInput.sessionID, signal.kind === "admitted" ? signal.inputMessageId : "")
        } else {
          // internal/unverified：不推进轮次、不写 meta（失效由 transform 侧 roundKnownFor 判定并落盘）
          st.admitted.delete(hookInput.sessionID)
        }
        st.log({
          ev: "round_observed",
          session: hookInput.sessionID,
          stream: resolved.streamId,
          message_id: signal.kind === "admitted" ? signal.inputMessageId : null,
          admitted,
        })
      } catch (err) {
        st.degrade(err)
      }
    },

    // 注入事务（A-C1 追加段形态；持久化失败绝不注入 C3；降级 GC#1）。
    "experimental.chat.messages.transform": async (_hookInput, output) => {
      try {
        const msgs = output.messages
        const sessionId = msgs[0]?.info?.sessionID
        if (!sessionId || !sessionId.startsWith("ses_")) return
        const resolved = await lookupScopeContext(sessionId, "")
        if (!resolved) return
        const lastMsgId = String(msgs[msgs.length - 1]?.info?.id ?? "")
        if (!lastMsgId) return
        let lastUserIdx = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          if ((msgs[i]!.info as { role?: string }).role === "user") {
            lastUserIdx = i
            break
          }
        }
        if (lastUserIdx < 0) return
        // I2（Task B Step 3）：transform 读段以单一外层流锁包裹——meta0/入口信号/
        // 候选集在同一把锁内读取，消除 read-modify 竞态。
        // decideAndPersist 在锁外调用（自身持锁；组合读不依赖它的结果）。
        const { meta0, requestVerified, candidateSetId, entry } = resolved.scope.withLock(() => {
          const meta0 = resolved.scope.readMeta(resolved.streamId)
          // P0→请求关联：已验证的 admitted 输入出现在本次请求的上下文中才算已验证。
          const admittedId = st.admitted.get(sessionId)
          const requestVerified = admittedId !== undefined && msgs.some((m) => m.info.id === admittedId)
          // §10.4 ①②：对 admitted 消息的原始文本 parts 跑词法信号判定
          // （排除本插件 part_bb_* 注入 part，防自触发）；admitted 消息不在本次
          // msgs 中 → 本次跳过入口信号（保守，宁可少提醒）。
          let entry: { messageId: string | null; s1: boolean; s2: boolean } = { messageId: null, s1: false, s2: false }
          if (requestVerified && admittedId !== undefined) {
            const admittedMsg = msgs.find((m) => m.info.id === admittedId)
            if (admittedMsg) {
              const prompt = admittedMsg.parts
                .filter((p) => p.type === "text" && !(p as { id?: string }).id?.startsWith("part_bb_"))
                .map((p) => (p as { text: string }).text)
                .join("\n")
              entry = { messageId: admittedId, ...detectSignals(prompt) }
            }
          }
          // I1：resolved.agent 即注册路径验证身份（缓存与注册经 refreshIdentity 保持一致）；
          // null = 未知 → 交由 eligibility 保守路径（不参与原作者匹配），不回退空串原值。
          const agent = resolved.agent ?? ""
          // Task B：候选集接线。聚合门槛（§8.1）：可见数 > AGG_TRIGGER_VISIBLE 或
          // 可见 description 字节 > AGG_TRIGGER_SUM_DESC_BYTES 才产生候选集；否则 null（无压力）。
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
          return { meta0, requestVerified, candidateSetId, entry }
        })
        let decision
        let admittedMessageId: string | null = null
        try {
          // G7：关联验证事务——admitted 登记与验证在同一请求上下文中核对后推进/恢复
          admittedMessageId = requestVerified ? (st.admitted.get(sessionId) ?? null) : null
          decision = decideAndPersist(resolved.scope, resolved.streamId, {
            sessionId,
            requestId: `${sessionId}:${lastMsgId}`,
            requestVerified,
            admittedMessageId,
            s1: entry.s1,
            s2: entry.s2,
            candidateSetId,
          })
        } catch (err) {
          st.degrade(err) // 持久化失败 → 不注入（C3）
          return
        }
        // M2：日志记录 decideAndPersist 持久化后的预算/轮次（此前非注入分支用决策前
        // meta0——roll 与「不注入」并存时 round_id/round_used 显示旧值）
        const afterMeta = resolved.scope.readMeta(resolved.streamId)
        if (decision.advanced || decision.identityRestored) {
          // I10：ev:"round" 两类触发——advanced（推进）与 identityRestored（恢复，轮次不变）
          st.log({
            ev: "round",
            session: sessionId,
            stream: resolved.streamId,
            message_id: admittedMessageId,
            current_round: afterMeta.rounds.current_round,
            round_known: true,
          })
        }
        if (!decision.inject) {
          // 非注入决策同样留痕（L4 断言 teeth：reason 分布可观测）；bytes=0 表示未注入
          st.log({
            ev: "decision",
            session: sessionId,
            stream: resolved.streamId,
            request_id: `${sessionId}:${lastMsgId}`,
            round_id: afterMeta.budget.round_id,
            round_used: afterMeta.budget.round_used,
            reason: decision.reason,
            bytes: 0,
          })
          return
        }
        // 退出锁后取常量模板（§10.2：提醒为固定模板、不含板数据；入口①②合并不拆分）
        // + 原地追加到最后一条 user 消息的 parts（A-C1 append-part）。
        const text = decision.reason.startsWith("entry_signal") ? ENTRY_REMINDER_TEMPLATE : PRESSURE_REMINDER_TEMPLATE
        const userMsgInfo = msgs[lastUserIdx]!.info
        const part: TextPart = {
          type: "text",
          id: `part_bb_${lastMsgId}`,
          sessionID: sessionId,
          messageID: userMsgInfo.id,
          text,
        }
        ;(msgs[lastUserIdx]!.parts as Part[]).push(part)
        st.log({
          ev: "decision",
          session: sessionId,
          stream: resolved.streamId,
          request_id: `${sessionId}:${lastMsgId}`,
          round_id: afterMeta.budget.round_id,
          round_used: afterMeta.budget.round_used,
          reason: decision.reason,
          bytes: new TextEncoder().encode(text).length,
        })
      } catch (err) {
        st.degrade(err)
      }
    },

    // session.created 事件作为注册兜底（无 agent 信息则不注册，避免空 agent 流）。
    event: async ({ event }) => {
      try {
        const e = event as { type?: string; properties?: { info?: { id?: string } } }
        if (e.type !== "session.created") return
        const id = e.properties?.info?.id
        if (!id) return
        const info = await sessionInfo(id)
        if (!info || !info.agent) return
        await registerScopeContext(id, info.agent)
      } catch (err) {
        st.degrade(err)
      }
    },
  }
  return hooks
}

export default BlackboardPlugin
