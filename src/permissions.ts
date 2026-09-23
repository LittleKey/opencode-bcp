// 权限矩阵（计划 Task 3 Step 1；Global Constraints #6；DESIGN §11.3）。
// 权限来源仅三项：scope 成员资格（持久化 session_index）、隔离名单（env）、pins（受信元数据）。

import type { Scope, ScopeConfig } from "./storage"

export function isolationAgents(): string[] {
  return (process.env.BLACKBOARD_ISOLATED_AGENTS ?? "councillor")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 完全相等或前缀匹配（从 storage.ts 收敛至此的唯一实现） */
export function isIsolatedAgent(agent: string): boolean {
  return isolationAgents().some((e) => agent === e || agent.startsWith(e))
}

export type Authz = {
  scopeId: string
  callerSessionId: string
  registered: boolean
  ownStreamId: string | null
  isolated: boolean
  listableStreams: { streamId: string; agent: string; isolated: boolean }[]
  canWrite: (streamId: string) => boolean
  canRead: (streamId: string) => boolean
}

export function resolveAuthz(scope: Scope, caller: { sessionId: string; agent: string }): Authz {
  const cfg = scope.config
  const own = cfg.session_index[caller.sessionId]
  if (!own) {
    return {
      scopeId: cfg.scope_id,
      callerSessionId: caller.sessionId,
      registered: false,
      ownStreamId: null,
      isolated: isIsolatedAgent(caller.agent),
      listableStreams: [],
      canWrite: () => false,
      canRead: () => false,
    }
  }
  const all = Object.entries(cfg.session_index).map(([sid, e]) => ({ sessionId: sid, ...e }))
  const visible = all.filter((e) => (e.isolated ? e.sessionId === caller.sessionId : true))
  return {
    scopeId: cfg.scope_id,
    callerSessionId: caller.sessionId,
    registered: true,
    ownStreamId: own.stream_id,
    isolated: own.isolated,
    listableStreams: visible.map((e) => ({ streamId: e.stream_id, agent: e.agent, isolated: e.isolated })),
    canWrite: (sid) => own.stream_id === sid,
    canRead: (sid) => visible.some((e) => e.stream_id === sid),
  }
}

export type RefPolicy = "ok" | "forbidden" | "hidden"

/** 存在性判断由调用方查 getById；hidden 与 not_found 同文案输出（C2-③） */
export function refPolicy(authz: Authz, target: { scopeId: string; streamId: string }): RefPolicy {
  if (target.scopeId !== authz.scopeId) return "forbidden"
  return authz.canRead(target.streamId) ? "ok" : "hidden"
}

/** pin 为受信外部元数据（scope.json pins，评审编排直接写入；工具面无写 API） */
export function isPinned(cfg: ScopeConfig, bbId: string): boolean {
  return cfg.pins.includes(bbId)
}
