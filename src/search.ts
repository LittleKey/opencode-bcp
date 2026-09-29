// Rebuild-on-query lexical search over published records. No model calls or second authority.
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Scope } from "./storage"
import type { BbRecord, RecordKind } from "./schema"
import { parseEntryFileName, parseBbId, formatBbId } from "./ids"
import { resolveAuthz, refPolicy } from "./permissions"

export const SEARCH_LIMITS = { records: 5000, bytes: 32 * 1024 * 1024, recordBytes: 512 * 1024 }
type Token = { term: string; start: number; end: number }
export function searchTokens(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(/[\p{Script=Han}]+|[\p{Script=Latin}\p{N}_]+/gu)) {
    const word = m[0], start = m.index!
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word]; let offset = start
      for (let i = 0; i < chars.length; i++) {
        if (chars.length === 1 || i < chars.length - 1)
          out.push({ term: chars.slice(i, i + 2).join(""), start: offset, end: offset + chars.slice(i, i + 2).join("").length })
        offset += chars[i].length
      }
    } else {
      out.push({ term: word.toLowerCase(), start, end: start + word.length })
      // Preserve exact identifiers and also recognize HTTP 500 / board store spelling.
      if (!/[_\p{N}]/u.test(word)) continue
      const pieces = [...word.matchAll(/[\p{Script=Latin}]+|\p{N}+/gu)]
      if (pieces.length > 1) for (const piece of pieces)
        out.push({ term: piece[0].toLowerCase(), start: start + piece.index!, end: start + piece.index! + piece[0].length })
    }
  }
  return out
}
type Options = { query: string; range?: "own" | "authorized"; stream?: string; view?: "compact" | "all";
  kind?: RecordKind; sinceSeq?: number; limit?: number; cursor?: string; caller: { sessionId: string; agent: string } }
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
function publishedPaths(rec: BbRecord, scopeDir: string): string[] {
  const paths = (rec.origin?.file_bindings ?? []).map(b => b.path)
  for (const ref of rec.source_refs ?? []) if (ref.startsWith("file://")) {
    try {
      const path = fileURLToPath(new URL(ref))
      // Retained cache addresses are version locators, not business filenames.
      if (!path.startsWith(scopeDir + "/") && !rec.origin?.file_bindings?.some(b => b.ref === ref)) paths.push(path)
    } catch { /* Non-file references are not path evidence. */ }
  }
  return [...new Set(paths)].slice(0, 16)
}
function excerpt(text: string, position: number) {
  // UTF-16 offsets refer to the original string; never synthesize or normalize the excerpt.
  let start = Math.max(0, position - 70)
  if (start && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start--
  let value = "", length = 0
  for (const char of text.slice(start)) { if (length++ === 240) break; value += char }
  return { text: value, start, end: start + value.length }
}

export function searchRecords(scope: Scope, opts: Options, budget = SEARCH_LIMITS) {
  return scope.withLock(() => {
    const auth = resolveAuthz(scope, opts.caller)
    if (!auth.registered || !auth.ownStreamId) throw Error("unregistered_session")
    const query = opts.query.trim()
    if (!query || [...query].length > 200) throw Error("invalid_search_query")
    const clauses = query.split(/\s+/)
    const groups = clauses.map(s => {
      const tokens = searchTokens(s)
      // For compound identifiers, require the components rather than both joined and spaced spellings.
      return [...new Set(tokens.filter(t => !tokens.some(piece => piece.start >= t.start && piece.end <= t.end &&
        piece.end - piece.start < t.end - t.start)).map(t => t.term))]
    })
    const terms = [...new Set(groups.flat())]
    if (!terms.length || groups.some(g => !g.length) || terms.length > 32) throw Error("invalid_search_terms")
    if (opts.stream) {
      const policy = refPolicy(auth, { scopeId: auth.scopeId, streamId: opts.stream })
      if (policy !== "ok") throw Error(policy === "hidden" ? "stream_not_found" : "forbidden_stream")
    }
    const streams = opts.stream ? [opts.stream] : opts.range === "own" ? [auth.ownStreamId]
      : [...new Set(auth.listableStreams.map(s => s.streamId))].sort()
    if (opts.sinceSeq !== undefined && !opts.stream && opts.range !== "own") throw Error("since_seq_requires_single_stream")
    const limit = Math.min(opts.limit ?? 10, 50)
    const binding = hash(JSON.stringify({ caller: auth.callerSessionId, scope: auth.scopeId, query, streams,
      range: opts.range ?? "authorized", view: opts.view ?? "compact", kind: opts.kind, since: opts.sinceSeq, limit }))
    let cursor: { v: number; binding: string; snapshot: string; offset: number } | undefined
    if (opts.cursor) {
      try {
        if (opts.cursor.length > 2048) throw Error()
        cursor = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8"))
        if (cursor?.v !== 1 || cursor.binding !== binding || typeof cursor.snapshot !== "string" ||
            !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw Error()
      } catch { throw Error("search_cursor_mismatch") }
    }
    const fingerprint = createHash("sha256").update(binding)
    const reasons = new Set<string>(), wanted = new Set(terms), df = new Map<string, number>()
    let scanned = 0, examined = 0, bytes = 0, documents = 0, totalLength = 0, stopped = false
    const matches: { rec: BbRecord; stream: string; counts: Map<string, number>; length: number;
      snippet: ReturnType<typeof excerpt> & { field: "content" | "path" }; phrase: boolean; pathPhrase: boolean;
      covered_by: string | null; superseded_by: string | null; tombstoned: boolean }[] = []
    for (const stream of streams) {
      let meta: ReturnType<Scope["readMeta"]>, names: string[]
      try {
        scope.recover(stream); meta = scope.readMeta(stream)
        names = readdirSync(join(scope.dir, "streams", stream, "entries")).filter(n => parseEntryFileName(n) !== null)
          .sort((a, b) => parseEntryFileName(a)! - parseEntryFileName(b)!)
      } catch { reasons.add("stream_unavailable"); fingerprint.update(stream + ":unavailable"); continue }
      fingerprint.update(JSON.stringify([stream, names, meta.nav, meta.tombstoned]))
      if (stopped) continue
      for (const name of names) {
        const seq = parseEntryFileName(name)!
        if (opts.sinceSeq !== undefined && seq <= opts.sinceSeq) continue
        if (examined >= budget.records) { reasons.add("record_budget"); stopped = true; break }
        examined++
        const path = join(scope.dir, "streams", stream, "entries", name)
        let raw: string, rec: BbRecord
        try {
          const size = statSync(path).size
          if (size > budget.recordBytes) { reasons.add("oversized_record"); fingerprint.update(name + ":oversized:" + size); continue }
          if (bytes + size > budget.bytes) { reasons.add("byte_budget"); stopped = true; break }
          raw = readFileSync(path, "utf8"); scanned++; bytes += Buffer.byteLength(raw)
          fingerprint.update(hash(raw))
          rec = JSON.parse(raw)
          if (rec.id !== formatBbId(auth.scopeId, stream, seq) || rec.scope_id !== auth.scopeId || rec.stream_id !== stream ||
              rec.sequence !== seq || typeof rec.content !== "string" || typeof rec.description !== "string" || !rec.writer?.agent) throw Error()
        } catch { reasons.add("record_unavailable"); fingerprint.update(name + ":unavailable"); continue }
        const tombstoned = meta.tombstoned[rec.id] !== undefined
        if (((opts.view ?? "compact") === "compact" && tombstoned) || (opts.kind && rec.kind !== opts.kind)) continue
        const searchable = rec.content.replace(/<!-- bcp:(?:store|no-store) -->/g, marker => " ".repeat(marker.length))
        const body = searchTokens(searchable), paths = publishedPaths(rec, scope.dir)
        const counts = new Map<string, number>(); let first = -1, matchedPath: string | undefined
        for (const t of body) if (wanted.has(t.term)) { counts.set(t.term, (counts.get(t.term) ?? 0) + 1); if (first < 0) first = t.start }
        for (const p of paths) for (const t of searchTokens(p)) if (wanted.has(t.term)) {
          counts.set(t.term, (counts.get(t.term) ?? 0) + 2); matchedPath ??= p
        }
        const length = Math.max(1, body.length)
        documents++; totalLength += length
        for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1)
        // Every whitespace-delimited clause must match; Han clauses tolerate broken bigram boundaries.
        if (!groups.every((g, i) => g.filter(t => counts.has(t)).length >=
            (/\p{Script=Han}/u.test(clauses[i]) ? Math.ceil(g.length * 0.6) : g.length))) continue
        const edge = (id?: string) => {
          if (!id) return null
          try { return refPolicy(auth, parseBbId(id)) === "ok" ? id : null } catch { return null }
        }
        matches.push({ rec, stream, counts, length,
          snippet: first >= 0 ? { field: "content", ...excerpt(rec.content, first) }
            : { field: "path", ...excerpt(matchedPath!, 0) },
          phrase: searchable.toLowerCase().includes(query.toLowerCase()),
          pathPhrase: paths.some(p => p.toLowerCase().includes(query.toLowerCase())),
          covered_by: edge(meta.nav[rec.id]?.covered_by), superseded_by: edge(meta.nav[rec.id]?.superseded_by), tombstoned })
      }
    }
    const snapshot = fingerprint.digest("hex")
    if (cursor && cursor.snapshot !== snapshot) throw Error("search_cursor_stale")
    const average = totalLength / Math.max(1, documents)
    const ranked = matches.map(m => {
      let score = 0
      for (const term of terms) {
        const tf = Math.min(8, m.counts.get(term) ?? 0), n = df.get(term) ?? 0
        if (tf) score += Math.log(1 + (documents - n + 0.5) / (n + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * m.length / average))
      }
      score += (m.phrase ? 3 : 0) + (m.pathPhrase ? 5 : 0)
      return { m, score }
    }).sort((a, b) => b.score - a.score || a.m.rec.id.localeCompare(b.m.rec.id))
    const offset = cursor?.offset ?? 0
    if (offset > ranked.length) throw Error("search_cursor_mismatch")
    const items = ranked.slice(offset, offset + limit).map(({ m, score }) => ({
      id: m.rec.id, stream_id: m.stream, sequence: m.rec.sequence, description: m.rec.description, kind: m.rec.kind,
      writer_agent: m.rec.writer.agent, score: Number(score.toFixed(6)), matched_terms: terms.filter(t => m.counts.has(t)),
      snippet: m.snippet, covered_by: m.covered_by, superseded_by: m.superseded_by, tombstoned: m.tombstoned,
    }))
    const next = offset + items.length
    return { query, range: opts.stream ? "stream" : opts.range ?? "authorized", items,
      nextCursor: next < ranked.length ? Buffer.from(JSON.stringify({ v: 1, binding, snapshot, offset: next })).toString("base64url") : null,
      coverage: reasons.size ? "incomplete" : "complete", reasons: [...reasons], scanned_records: scanned, examined_entries: examined, scanned_bytes: bytes,
      matched_records: ranked.length, snapshot, note: "Published content/path matches only; no title inference or semantic acceptance. Read selected originals with board_get. Incomplete coverage or a miss is not proof of absence." }
  })
}
