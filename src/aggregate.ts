// 候选选择（DESIGN §8.1/§8.3；计划 Task A Step 3）。
// 候选收集仅产出 nudge 提示用集合身份，不承载提交校验（提交由 Scope.aggregate 全量重验，GC#6）。
// I1：完整扫描（readMeta → 遍历 entry → 分类）在同一 withLock 内、recover 之后整体执行。

import { AGG_BATCH_MAX, AGG_BATCH_MIN, type Scope } from "./storage"
import { recordHash, type AggregateMember } from "./schema"
import { formatBbId, parseBbId } from "./ids"
import { classifyEligibility } from "./eligibility"
import { entrySeqs, recentKnowledgeIds } from "./indexing"

export type AggregateCandidates = {
  members: AggregateMember[]   // 按 sequence 升序、最早 ≤AGG_BATCH_MAX 条 eligible
  visibleItems: number         // compact 折叠后可见目录项数（含摘要）
  sumDescriptionBytes: number  // 可见目录项 description 的 UTF-8 字节合计（§8.1 第二触发条件）
  setHash: string              // = recordHash(UTF8(streamId + 排序后 members 的 id+hash 拼接))，64 hex
}

export function aggregateCandidates(
  scope: Scope,
  streamId: string,
  caller: { sessionId: string; agent: string },
  currentRound: number | null,
): AggregateCandidates | null {
  return scope.withLock(() => {
    scope.recover(streamId)          // I1：候选完整扫描位于同一锁内、恢复之后
    const meta = scope.readMeta(streamId)
    const cfg = scope.config
    const recentIds = recentKnowledgeIds(scope, streamId)
    const members: AggregateMember[] = []
    let visibleItems = 0
    let sumDescriptionBytes = 0
    for (const rec of entrySeqs(scope, streamId).sort((a, b) => a - b)) {
      const item = scope.readEntry(streamId, rec)
      if (!item) continue
      const id = formatBbId(scope.scopeId, streamId, rec)
      if (meta.tombstoned[id] !== undefined) continue
      if (meta.nav[id]?.covered_by !== undefined) continue // 折叠后不占可见目录
      visibleItems += 1
      sumDescriptionBytes += Buffer.byteLength(item.description, "utf8")
      if (members.length < AGG_BATCH_MAX) {
        const g = scope.getById(id)
        if (g.status !== "found") continue
        const cls = classifyEligibility(item, {
          cfg, meta, currentRound, recentIds,
          callerSessionId: caller.sessionId, callerAgent: caller.agent,
        })
        if (cls.status === "eligible") members.push({ id, hash: g.hash })
      }
    }
    if (members.length < AGG_BATCH_MIN) return null
    members.sort((a, b) => parseBbId(a.id).seq - parseBbId(b.id).seq)
    return { members: members.slice(0, AGG_BATCH_MAX), visibleItems, sumDescriptionBytes, setHash: candidateSetIdOf(streamId, members) }
  })
}

export function candidateSetIdOf(streamId: string, members: AggregateMember[]): string {
  const sorted = [...members].sort((a, b) => (a.id < b.id ? -1 : 1))
  return recordHash(new TextEncoder().encode(streamId + JSON.stringify(sorted)))
}
