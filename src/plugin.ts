// Task 5：插件入口装配——会话/scope 归因、注入事务、降级。
// 依据 harness/live-protocol.md A-C1/A-C2/A-C5/A-C6 与 DESIGN §3/§10.2/§11.1/§13.2。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Hooks, Plugin, ToolDefinition, ToolContext } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"
import { openScopeById, openScopeForRoot, type Scope } from "./storage"
import { isIsolatedAgent } from "./permissions"
import { listIndex, snapshotCounts } from "./indexing"
import { applyInput, classifyInput, isKnownSyntheticText } from "./rounds"
import { decideAndPersist, renderSnapshot, rollLedgerForNewRound, snapshotVersionOf } from "./nudge"
import { defineBoardTools, type BoardToolDef } from "./tools"

type Resolved = { scope: Scope; streamId: string; isolated: boolean }

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

  return { rootDir, skipAgents, scopes, admitted, log, degrade, isDegraded: () => degraded, hasParentWarned: () => parentWarned, warnParent: (id: string) => { if (!parentWarned) { parentWarned = true; console.error(`[blackboard] session-parent-unresolved: ${id}`) } } }
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

  // 工具路径：只查不建（C2-①）；任何失败 → null。
  const lookupScopeContext = async (sessionId: string, agent: string): Promise<Resolved | null> => {
    try {
      if (st.skipAgents.includes(agent)) return null
      const cached = st.scopes.get(sessionId)
      if (cached) return cached
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
      const resolved: Resolved = { scope, streamId, isolated }
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
      if (st.skipAgents.includes(agent)) return null
      const cached = st.scopes.get(sessionId)
      if (cached) return cached
      const root = await findRoot(sessionId)
      if (!root) {
        st.warnParent(sessionId)
        return null
      }
      const scope = openScopeForRoot({ rootSessionId: root, dataDir: st.rootDir })
      const reg = scope.registerSession(sessionId, agent)
      const resolved: Resolved = { scope, streamId: reg.streamId, isolated: isIsolatedAgent(agent) }
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
      board_put: toToolDef(boardTools.board_put, "写入 blackboard 知识记录"),
      board_get: toToolDef(boardTools.board_get, "按 id 批量读取 blackboard 记录原文"),
      board_index: toToolDef(boardTools.board_index, "列出 blackboard 目录（compact/all 视图）"),
    },

    // 准入信号（P0）：messageID 存在即已验证 admission。轮次推进 + 预算滚动 + 身份恢复。
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
        resolved.scope.withLock(() => {
          const meta = resolved.scope.readMeta(resolved.streamId)
          if (cls === "admitted_input") {
            const id = signal.kind === "admitted" ? signal.inputMessageId : ""
            st.admitted.set(hookInput.sessionID, id)
            const rounds0 = applyInput(meta.rounds, cls, id)
            const isNew = rounds0 !== meta.rounds
            // 同一 messageId 幂等恢复（P12/R1）：同一 writeMeta 将两处 round_known 置回 true
            const rounds = isNew ? rounds0 : { ...rounds0, round_known: true }
            const budget = isNew
              ? { ...rollLedgerForNewRound(meta.budget, id) }
              : { ...meta.budget, round_known: true }
            if (isNew || budget.round_known !== meta.budget.round_known) {
              resolved.scope.writeMeta(resolved.streamId, { ...meta, rounds, budget })
            }
            st.log({
              ev: "round",
              session: hookInput.sessionID,
              stream: resolved.streamId,
              message_id: id,
              current_round: rounds.current_round,
              round_known: rounds.round_known,
            })
          } else {
            // internal/unverified：不触碰 current_round/last_admitted；
            // 若 round_known === true → 同一 writeMeta 将两处 round_known 一并置 false（P12/R1）。
            if (meta.budget.round_known) {
              resolved.scope.writeMeta(resolved.streamId, {
                ...meta,
                rounds: { ...meta.rounds, round_known: false },
                budget: { ...meta.budget, round_known: false },
              })
            }
            st.admitted.delete(hookInput.sessionID)
            st.log({
              ev: "round",
              session: hookInput.sessionID,
              stream: resolved.streamId,
              current_round: meta.rounds.current_round,
              round_known: false,
            })
          }
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
        const meta0 = resolved.scope.readMeta(resolved.streamId)
        const agent = resolved.scope.config.session_index[sessionId]?.agent ?? ""
        // P0→请求关联：已验证的 admitted 输入出现在本次请求的上下文中才算已验证。
        const admittedId = st.admitted.get(sessionId)
        const requestVerified = admittedId !== undefined && msgs.some((m) => m.info.id === admittedId)
        const counts = snapshotCounts(
          resolved.scope,
          resolved.streamId,
          { sessionId, agent },
          meta0.rounds.round_known ? meta0.rounds.current_round : null,
        )
        const compact = listIndex(resolved.scope, resolved.streamId, { limit: 1000, caller: { sessionId, agent } })
        const recentDescriptions = compact.items.slice(-4).map((i) => i.description)
        const snapshotVersion = snapshotVersionOf(counts, recentDescriptions)
        let decision
        try {
          decision = decideAndPersist(resolved.scope, resolved.streamId, {
            sessionId,
            requestId: `${sessionId}:${lastMsgId}`,
            requestVerified,
            snapshotVersion,
            candidateSetId: null, // G2：M1 仅目录提示，聚合第二步
            maxSeq: meta0.high_water,
          })
        } catch (err) {
          st.degrade(err) // 持久化失败 → 不注入（C3）
          return
        }
        if (!decision.inject) {
          // 非注入决策同样留痕（L4 断言 teeth：reason 分布可观测）；bytes=0 表示未注入
          st.log({
            ev: "decision",
            session: sessionId,
            stream: resolved.streamId,
            request_id: `${sessionId}:${lastMsgId}`,
            round_id: meta0.budget.round_id,
            round_used: meta0.budget.round_used,
            reason: decision.reason,
            bytes: 0,
            omitted_descriptions: 0,
            omitted_summaries: 0,
          })
          return
        }
        // 退出锁后渲染 + 原地追加到最后一条 user 消息的 parts（A-C1 append-part）。
        const snap = renderSnapshot(counts, recentDescriptions, [], snapshotVersion)
        const text = `[blackboard 目录快照 v${snapshotVersion}]\n` + snap.text
        const userMsgInfo = msgs[lastUserIdx]!.info
        const part: TextPart = {
          type: "text",
          id: `part_bb_${lastMsgId}`,
          sessionID: sessionId,
          messageID: userMsgInfo.id,
          text,
        }
        ;(msgs[lastUserIdx]!.parts as Part[]).push(part)
        const after = resolved.scope.readMeta(resolved.streamId)
        st.log({
          ev: "decision",
          session: sessionId,
          stream: resolved.streamId,
          request_id: `${sessionId}:${lastMsgId}`,
          round_id: after.budget.round_id,
          round_used: after.budget.round_used,
          reason: decision.reason,
          bytes: new TextEncoder().encode(text).length,
          omitted_descriptions: snap.omittedDescriptions,
          omitted_summaries: snap.omittedSummaries,
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
