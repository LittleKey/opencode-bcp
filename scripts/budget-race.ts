// Task 5 plug-9：真实子进程预算竞争 + F2 冲突报告协议（与生产 transform 同一 decideAndPersist 路径）。
// I4：worker 携带压力候选集（第 4 参，"-"=null）——A/B 用不同候选集、起点 round_used=1，
// A 持锁消费最后额度（注入）而 B 重试 no_budget；同时保留持锁暂停/锁冲突报告机制。
// 用法：bun scripts/budget-race.ts <dataDir> <rootSessionId> <requestId> [candidateSetId] [--pause]
import { existsSync, writeFileSync } from "node:fs"
import { openScopeForRoot } from "../src/storage"
import { decideAndPersist } from "../src/nudge"

function pauseSync(dataDir: string): void {
  writeFileSync(`${dataDir}/pause-A`, "1")
  const deadline = Date.now() + 10000
  const buf = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(`${dataDir}/resume-A`)) {
    if (Date.now() > deadline) process.exit(3)
    Atomics.wait(buf, 0, 0, 5)
  }
}

const [dataDir, rootSessionId, requestId, candidateSetId] = process.argv.slice(2)
const pause = process.argv.includes("--pause")
if (!dataDir || !rootSessionId || !requestId) {
  console.error("usage: bun scripts/budget-race.ts <dataDir> <rootSessionId> <requestId> [candidateSetId] [--pause]")
  process.exit(2)
}

try {
  const scope = openScopeForRoot({ rootSessionId, dataDir })
  const { streamId } = scope.resolveSession(rootSessionId)
  const result = decideAndPersist(scope, streamId, {
    sessionId: rootSessionId,
    requestId: `${rootSessionId}:${requestId}`,
    requestVerified: true,
    s1: false,
    s2: false,
    candidateSetId: candidateSetId && candidateSetId !== "-" ? candidateSetId : null,
    raceProbe: pause ? { afterRead: () => pauseSync(dataDir) } : undefined,
  })
  console.log(JSON.stringify({ injected: result.inject, reason: result.reason }))
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes("lock_timeout")) {
    console.log("lock_contention_observed")
    process.exit(0)
  }
  console.error(String(msg))
  process.exit(1)
}
