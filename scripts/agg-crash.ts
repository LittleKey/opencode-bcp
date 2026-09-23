// SIGKILL 崩溃子场景（聚合计划 Task D Interfaces 619–622 行）。
// 用法：bun run scripts/agg-crash.ts <sessionId> [dataDir]
// 定位同 agg-seed（scope-index.json → openScopeById + resolveSession）；扫描本流 eligible 成员
// （排除 covered/recent6/tombstoned/pinned，复用 classifyEligibility，作者=该 session）取前 8 →
// faultHook.current = () => process.kill(process.pid, "SIGKILL")（首个故障点命中即杀：agg_after_reserve）
// → scope.aggregate(...)。
// 期望：进程被 SIGKILL 终止（shell rc=137 或 Killed）；若 aggregate 正常返回 → 打印
// `agg-crash FAIL: fault injection did not fire` 且 exit 1。

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { bbV1Root, faultHook, openScopeById, type Scope } from "../src/storage"
import { classifyEligibility } from "../src/eligibility"
import { recentKnowledgeIds, entrySeqs } from "../src/indexing"

function findScopeBySession(dataDir: string | undefined, sessionId: string): { scope: Scope; streamId: string; agent: string } {
  const root = dataDir ?? bbV1Root()
  const indexPath = join(root, "scope-index.json")
  if (!existsSync(indexPath)) throw new Error(`scope-index not found: ${indexPath}`)
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { scopes: Record<string, string> }
  for (const scopeId of Object.values(index.scopes)) {
    const scope = openScopeById(scopeId, { dataDir: root })
    const entry = scope.config.session_index[sessionId]
    if (entry) return { scope, streamId: entry.stream_id, agent: entry.agent }
  }
  throw new Error(`unknown_session: ${sessionId}`)
}

async function main(): Promise<void> {
  const [sessionId, dataDir] = process.argv.slice(2)
  if (!sessionId) {
    console.error("usage: bun run scripts/agg-crash.ts <sessionId> [dataDir]")
    process.exit(1)
  }
  const { scope, streamId, agent } = findScopeBySession(dataDir, sessionId)
  const eligible: string[] = []
  scope.withLock(() => {
    const meta = scope.readMeta(streamId)
    const currentRound = meta.rounds.round_known ? meta.rounds.current_round : null
    const recentIds = recentKnowledgeIds(scope, streamId)
    for (const seq of entrySeqs(scope, streamId)) {
      const rec = scope.readEntry(streamId, seq)
      if (!rec) continue
      const cls = classifyEligibility(rec, {
        cfg: scope.config,
        meta,
        currentRound,
        recentIds,
        callerSessionId: sessionId,
        callerAgent: agent,
      })
      if (cls.status === "eligible") eligible.push(rec.id)
    }
  })
  const memberIds = eligible.slice(0, 8)
  if (memberIds.length < 8) {
    console.error(`agg-crash FAIL: only ${memberIds.length} eligible members (need 8)`)
    process.exit(1)
  }
  faultHook.current = () => {
    process.kill(process.pid, "SIGKILL")
  }
  const result = scope.aggregate(streamId, {
    writer: { agent, session_id: sessionId, message_id: "agg-crash" },
    memberIds,
    description: "agg-crash 崩溃子场景摘要",
    navigationBody: "导航：成员关系见 members。",
  })
  // 走到这里说明故障注入未生效（faultHook 未在任何 FaultPoint 命中）
  console.log(`agg-crash FAIL: fault injection did not fire (${JSON.stringify(result).slice(0, 120)})`)
  process.exit(1)
}

await main()
