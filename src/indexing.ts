// 目录视图（计划 Task 3 Step 2；DESIGN §11.2/§11.3；I7 cursor 绑定；P15 授权在输出层）。

import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { Scope, StreamMeta } from "./storage"
import type { RecordKind } from "./schema"
import { parseEntryFileName, parseBbId } from "./ids"
import { isPinned, refPolicy, resolveAuthz } from "./permissions"
import { classifyEligibility, RECENT_K, type EligibilityCtx } from "./eligibility"
import type { SnapshotCounts } from "./nudge"

export type IndexView = "compact" | "all"

export type IndexItem = {
  id: string
  sequence: number
  description: string
  kind?: RecordKind
  created_round: number | null
  writer_agent: string
  pinned: boolean
  superseded_by: string | null
  tombstoned: boolean
}

/** base64url JSON 不透明串（I7：绑定 scope/stream/query，不跨作用域漂移） */
export function encodeCursor(c: { scopeId: string; streamId: string; lastSeq: number; queryHash: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url")
}

export function decodeCursor(
  s: string,
  expect: { scopeId: string; streamId: string; queryHash: string },
): { lastSeq: number } {
  let c: { scopeId?: unknown; streamId?: unknown; lastSeq?: unknown; queryHash?: unknown }
  try {
    c = JSON.parse(Buffer.from(s, "base64url").toString("utf8"))
  } catch {
    throw new Error("cursor_mismatch")
  }
  if (
    c.scopeId !== expect.scopeId ||
    c.streamId !== expect.streamId ||
    c.queryHash !== expect.queryHash ||
    typeof c.lastSeq !== "number" ||
    !Number.isInteger(c.lastSeq)
  ) {
    throw new Error("cursor_mismatch")
  }
  return { lastSeq: c.lastSeq }
}

/** view/keyword/kind/sinceSeq 的 sha256 前 16 hex——查询任一参数变化即失配 */
export function queryHashOf(opts: { view?: IndexView; keyword?: string; kind?: RecordKind; sinceSeq?: number }): string {
  const material = JSON.stringify({
    view: opts.view ?? "compact",
    keyword: opts.keyword ?? null,
    kind: opts.kind ?? null,
    sinceSeq: opts.sinceSeq ?? null,
  })
  return new Bun.CryptoHasher("sha256").update(material).digest("hex").slice(0, 16)
}

/** 条目来源 = readdir 按 parseEntryFileName 升序 + readEntry；导航/标注在输出层执行授权（P15） */
export function listIndex(
  scope: Scope,
  streamId: string,
  opts: {
    view?: IndexView
    keyword?: string
    kind?: RecordKind
    sinceSeq?: number
    limit?: number
    cursor?: string
    caller: { sessionId: string; agent: string }
  },
): { items: IndexItem[]; nextCursor: string | null } {
  const authz = resolveAuthz(scope, opts.caller)
  const cfg = scope.config
  const meta = scope.readMeta(streamId)
  const view: IndexView = opts.view ?? "compact"
  const limit = opts.limit ?? 50
  let names: string[] = []
  try {
    names = readdirSync(join(scope.dir, "streams", streamId, "entries"))
  } catch {
    names = []
  }
  const seqs = names
    .map((n) => parseEntryFileName(n))
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b)
  const qh = queryHashOf({ view: opts.view, keyword: opts.keyword, kind: opts.kind, sinceSeq: opts.sinceSeq })
  let minSeq = 1
  if (opts.sinceSeq !== undefined) minSeq = opts.sinceSeq + 1
  if (opts.cursor !== undefined) {
    const c = decodeCursor(opts.cursor, { scopeId: cfg.scope_id, streamId, queryHash: qh })
    minSeq = Math.max(minSeq, c.lastSeq + 1)
  }
  const all: IndexItem[] = []
  for (const seq of seqs) {
    if (seq < minSeq) continue
    const rec = scope.readEntry(streamId, seq)
    if (!rec) continue
    const tombstoned = meta.tombstoned[rec.id] !== undefined
    if (view === "compact" && tombstoned) continue
    if (opts.keyword !== undefined && !rec.description.toLowerCase().includes(opts.keyword.toLowerCase())) continue
    if (opts.kind !== undefined && rec.kind !== opts.kind) continue
    let superseded_by: string | null = meta.nav[rec.id]?.superseded_by ?? null
    if (superseded_by !== null) {
      let t: ReturnType<typeof parseBbId> | null = null
      try {
        t = parseBbId(superseded_by)
      } catch {
        t = null
      }
      if (!t || refPolicy(authz, { scopeId: t.scopeId, streamId: t.streamId }) !== "ok") superseded_by = null
    }
    all.push({
      id: rec.id,
      sequence: rec.sequence,
      description: rec.description,
      kind: rec.kind,
      created_round: rec.created_round,
      writer_agent: rec.writer.agent,
      pinned: isPinned(cfg, rec.id),
      superseded_by,
      tombstoned,
    })
  }
  if (all.length > limit) {
    return {
      items: all.slice(0, limit),
      nextCursor: encodeCursor({ scopeId: cfg.scope_id, streamId, lastSeq: all[limit - 1]!.sequence, queryHash: qh }),
    }
  }
  return { items: all, nextCursor: null }
}

// "最近 6 条已发布知识消息"按发布序取，不从视图截取（I8）：
// 非 tombstoned 且非 index_summary 的记录按 sequence 降序前 RECENT_K 条的 id。
export function recentKnowledgeIds(scope: Scope, streamId: string): string[] {
  const meta = scope.readMeta(streamId)
  const seqs = entrySeqs(scope, streamId)
  const ids: string[] = []
  for (let i = seqs.length - 1; i >= 0 && ids.length < RECENT_K; i--) {
    const rec = scope.readEntry(streamId, seqs[i]!)
    if (!rec) continue
    if (meta.tombstoned[rec.id] !== undefined) continue
    if (rec.kind === "index_summary") continue
    ids.push(rec.id)
  }
  return ids
}

function entrySeqs(scope: Scope, streamId: string): number[] {
  let names: string[] = []
  try {
    names = readdirSync(join(scope.dir, "streams", streamId, "entries"))
  } catch {
    names = []
  }
  return names
    .map((n) => parseEntryFileName(n))
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b)
}

// 快照计数（DESIGN §10.2；Task 4 Step 4）。eligible/protected/unknown_round =
// 全部条目跑 classifyEligibility（caller = own session+agent）的分布。
// new_since_last_shown 按 sequence > last_shown_seq 计数而非 maxSeq 差——序号空洞不失真（I8）。
export function snapshotCounts(
  scope: Scope,
  streamId: string,
  caller: { sessionId: string; agent: string },
  currentRound: number | null,
): SnapshotCounts {
  const cfg = scope.config
  const meta: StreamMeta = scope.readMeta(streamId)
  const ctx: EligibilityCtx = {
    cfg,
    meta,
    currentRound,
    recentIds: recentKnowledgeIds(scope, streamId),
    callerSessionId: caller.sessionId,
    callerAgent: caller.agent,
  }
  const counts: SnapshotCounts = {
    knowledge_total: 0,
    visible_items: 0,
    index_summary_count: 0,
    new_since_last_shown: 0,
    eligible: 0,
    protected: 0,
    unknown_round: 0,
  }
  for (const seq of entrySeqs(scope, streamId)) {
    const rec = scope.readEntry(streamId, seq)
    if (!rec) continue
    if (meta.tombstoned[rec.id] !== undefined) continue
    counts.knowledge_total++
    if (rec.kind === "index_summary") counts.index_summary_count++
    // M1：compact 视图与 knowledge_total 相同；聚合启用后分化
    counts.visible_items++
    if (rec.sequence > meta.budget.last_shown_seq) counts.new_since_last_shown++
    const cls = classifyEligibility(rec, ctx)
    if (cls.status === "eligible") counts.eligible++
    else if (cls.status === "protected") counts.protected++
    else counts.unknown_round++
  }
  return counts
}
