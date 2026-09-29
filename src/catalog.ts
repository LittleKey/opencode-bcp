// On-demand title discovery over authorized published records; no body injection or title synthesis.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Scope } from "./storage"
import type { BbRecord, RecordKind } from "./schema"
import { formatBbId, parseBbId, parseEntryFileName } from "./ids"
import { refPolicy, resolveAuthz } from "./permissions"
import { SEARCH_LIMITS } from "./search"

export const CATALOG_LIMITS = { ...SEARCH_LIMITS, pageBytes: 8192 }
type Options = { caller: { sessionId: string; agent: string }; stream?: string; keyword?: string; kind?: RecordKind;
  view?: "compact" | "all"; sinceSeq?: number; limit?: number; cursor?: string }
type Item = { id: string; description: string; writer_agent: string; kind?: RecordKind; source_time?: number;
  superseded_by?: string; covered_by?: string; tombstoned?: true }
const hash = (s: string) => createHash("sha256").update(s).digest("hex")

export function authorizedCatalog(scope: Scope, opts: Options, budget = CATALOG_LIMITS) {
  return scope.withLock(() => {
    const auth = resolveAuthz(scope, opts.caller)
    if (!auth.registered || !auth.ownStreamId) throw Error("unregistered_session")
    if (opts.stream && refPolicy(auth, { scopeId: auth.scopeId, streamId: opts.stream }) !== "ok") throw Error("stream_not_found")
    if (opts.sinceSeq !== undefined && !opts.stream) throw Error("since_seq_requires_single_stream")
    const streams = opts.stream ? [opts.stream] : [...new Set(auth.listableStreams.map(s => s.streamId))].sort()
    const limit = Math.min(opts.limit ?? 50, 200)
    const binding = hash(JSON.stringify({ caller: auth.callerSessionId, scope: auth.scopeId, streams, view: opts.view ?? "compact",
      keyword: opts.keyword, kind: opts.kind, since: opts.sinceSeq, limit, budget }))
    let cursor: { binding: string; snapshot: string; offset: number; v: number } | undefined
    if (opts.cursor) {
      try {
        if (opts.cursor.length > 2048) throw Error()
        cursor = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8"))
        if (cursor?.v !== 1 || cursor.binding !== binding || typeof cursor.snapshot !== "string" ||
            !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw Error()
      } catch { throw Error("catalog_cursor_mismatch") }
    }
    const fingerprint = createHash("sha256").update(binding), reasons = new Set<string>(), rows: Item[] = []
    let examined = 0, bytes = 0, stopped = false
    const edge = (id?: string) => {
      try { return id && refPolicy(auth, parseBbId(id)) === "ok" ? id : undefined } catch { return undefined }
    }
    for (const stream of streams) {
      let meta: ReturnType<Scope["readMeta"]>, names: string[]
      try {
        scope.recover(stream); meta = scope.readMeta(stream)
        names = readdirSync(join(scope.dir, "streams", stream, "entries")).filter(n => parseEntryFileName(n) !== null)
          .sort((a, b) => parseEntryFileName(a)! - parseEntryFileName(b)!)
      } catch { reasons.add("stream_unavailable"); fingerprint.update(stream + ":unavailable"); continue }
      fingerprint.update(JSON.stringify([stream, names]))
      if (stopped) continue
      for (const name of names) {
        const seq = parseEntryFileName(name)!
        if (opts.sinceSeq !== undefined && seq <= opts.sinceSeq) continue
        if (examined >= budget.records) { reasons.add("record_budget"); stopped = true; break }
        examined++
        const path = join(scope.dir, "streams", stream, "entries", name)
        let rec: BbRecord
        try {
          const size = statSync(path).size
          if (size > budget.recordBytes) { reasons.add("oversized_record"); fingerprint.update(name + ":oversized:" + size); continue }
          if (bytes + size > budget.bytes) { reasons.add("byte_budget"); stopped = true; break }
          const raw = readFileSync(path, "utf8"); bytes += Buffer.byteLength(raw); fingerprint.update(hash(raw)); rec = JSON.parse(raw)
          if (rec.id !== formatBbId(auth.scopeId, stream, seq) || rec.scope_id !== auth.scopeId || rec.stream_id !== stream ||
              rec.sequence !== seq || typeof rec.description !== "string" || typeof rec.content !== "string" || typeof rec.writer?.agent !== "string") throw Error()
        } catch { reasons.add("record_unavailable"); fingerprint.update(name + ":unavailable"); continue }
        const superseded = edge(meta.nav[rec.id]?.superseded_by), covered = edge(meta.nav[rec.id]?.covered_by)
        const tombstoned = meta.tombstoned[rec.id] !== undefined
        fingerprint.update(JSON.stringify([rec.id, superseded, covered, tombstoned]))
        if (((opts.view ?? "compact") === "compact" && tombstoned) || (opts.kind && rec.kind !== opts.kind) ||
            (opts.keyword && !rec.description.toLowerCase().includes(opts.keyword.toLowerCase()))) continue
        rows.push({ id: rec.id, description: rec.description, writer_agent: rec.writer.agent,
          ...(rec.kind ? { kind: rec.kind } : {}), ...(rec.origin?.message_completed_at ? { source_time: rec.origin.message_completed_at } : {}),
          ...(superseded ? { superseded_by: superseded } : {}), ...(covered ? { covered_by: covered } : {}), ...(tombstoned ? { tombstoned: true as const } : {}) })
      }
    }
    const snapshot = fingerprint.digest("hex")
    if (cursor && cursor.snapshot !== snapshot) throw Error("catalog_cursor_stale")
    rows.sort((a, b) => a.id.localeCompare(b.id))
    const offset = cursor?.offset ?? 0
    if (offset > rows.length) throw Error("catalog_cursor_mismatch")
    const items: Item[] = []; let itemBytes = 2, next = offset
    while (next < rows.length && items.length < limit) {
      const item = rows[next]!, size = Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0)
      if (itemBytes + size > budget.pageBytes) {
        if (!items.length) { reasons.add("oversized_catalog_item"); next++; continue }
        break
      }
      items.push(item); itemBytes += size; next++
    }
    const nextCursor = next < rows.length ? Buffer.from(JSON.stringify({ v: 1, binding, snapshot, offset: next })).toString("base64url") : null
    return { range: "authorized" as const, items, nextCursor, total_items: rows.length, item_bytes: itemBytes,
      coverage: reasons.size ? "incomplete" : "complete", reasons: [...reasons], all_visible_listed: !reasons.size && offset === 0 && !nextCursor,
      examined_entries: examined, scanned_bytes: bytes, snapshot,
      note: "Titles are author-provided navigation, not evidence. Read selected originals with board_get; covered and superseded sources remain readable. Follow nextCursor for remaining entries; incomplete coverage is not absence." }
  })
}
