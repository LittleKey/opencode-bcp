import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openScopeForRoot, type Scope } from "../src/storage"
import { searchRecords, SEARCH_LIMITS } from "../src/search"
import { defineBoardTools } from "../src/tools"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bcp-search-")); dirs.push(dir)
  const scope = openScopeForRoot({ rootSessionId: "root", dataDir: dir })
  const own = scope.registerSession("root", "orchestrator").streamId
  const peer = scope.registerSession("peer", "fixer").streamId
  const hidden = scope.registerSession("secret", "councillor").streamId
  const caller = { sessionId: "root", agent: "orchestrator" }
  return { scope, own, peer, hidden, caller }
}
let n = 0
function put(scope: Scope, stream: string, content: string, extra: Partial<Parameters<Scope["put"]>[1]> = {}) {
  const sid = Object.entries(scope.config.session_index).find(([, s]) => s.stream_id === stream)![0]
  const r = scope.put(stream, { writer: { agent: scope.config.session_index[sid].agent, session_id: sid, message_id: `m${++n}` },
    createdRound: null, description: "[fixer] <summary>", content, ...extra })
  if (r.status !== "stored") throw Error(JSON.stringify(r))
  return r.id
}
test("body discovery crosses authorized streams, ignores descriptions and returns exact original snippets", () => {
  const { scope, own, peer, caller } = setup()
  put(scope, own, "Nothing relevant here", { description: "cancelled 优先" })
  const content = "背景：" + "一般说明。".repeat(100) + "cancelled 的优先级必须高于 timeout 重试。"
  const id = put(scope, peer, content)
  const result = searchRecords(scope, { query: "CANCELLED 优先", caller })
  expect(result.coverage).toBe("complete"); expect(result.items.map(x => x.id)).toEqual([id])
  const snippet = result.items[0].snippet
  expect(snippet.field).toBe("content"); expect(snippet.text).toBe(content.slice(snippet.start, snippet.end))
  expect(snippet.text).toContain("优先级"); expect([...snippet.text].length).toBeLessThanOrEqual(240)
  expect(searchRecords(scope, { query: "cancelled", range: "own", caller }).items).toEqual([])
})
test("hidden records do not affect candidates, scores, counts, snapshots or streams", () => {
  const { scope, peer, hidden, caller } = setup()
  put(scope, peer, "timeout 优先级")
  const before = searchRecords(scope, { query: "timeout", caller })
  put(scope, hidden, "TOP_SECRET timeout timeout", { description: "secret title" })
  const after = searchRecords(scope, { query: "timeout", caller })
  expect(after).toEqual(before)
  expect(() => searchRecords(scope, { query: "timeout", stream: hidden, caller })).toThrow("stream_not_found")
  expect(() => searchRecords(scope, { query: "timeout", caller: { sessionId: "unknown", agent: "build" } })).toThrow("unregistered_session")
})
test("Han bigrams bridge character boundaries; every whitespace clause is required", () => {
  const { scope, peer, caller } = setup()
  const exact = put(scope, peer, "取消优先级明确高于重试")
  const split = put(scope, peer, "取消请求的处理优先级最高")
  put(scope, peer, "优先级队列调度，无关业务")
  const result = searchRecords(scope, { query: "取消 优先级", caller })
  expect(new Set(result.items.map(x => x.id))).toEqual(new Set([exact, split]))
  expect(searchRecords(scope, { query: "取消优先级", caller }).items[0].id).toBe(exact)
  expect(searchRecords(scope, { query: "timeout cancelled", caller }).items).toEqual([])
})
test("published paths are searchable, but linked file contents are not read", () => {
  const { scope, peer, caller } = setup()
  const file = join(dirs.at(-1)!, "retry.py"); writeFileSync(file, "privateUnpublishedNeedle")
  const id = put(scope, peer, "已完成验证", { sourceRefs: [`file://${file}`] })
  const result = searchRecords(scope, { query: "retry.py", caller })
  expect(result.items[0].id).toBe(id); expect(result.items[0].snippet.field).toBe("path")
  expect(searchRecords(scope, { query: "privateUnpublishedNeedle", caller }).items).toEqual([])
})
test("protocol markers and retained cache addresses do not pollute discovery", () => {
  const { scope, peer, caller } = setup()
  put(scope, peer, "业务结果\n<!-- bcp:store -->", { sourceRefs: [`file://${scope.dir}/streams/${peer}/artifacts/cacheOnlyNeedle.txt`] })
  expect(searchRecords(scope, { query: "store", caller }).items).toEqual([])
  expect(searchRecords(scope, { query: "cacheOnlyNeedle", caller }).items).toEqual([])
  const real = put(scope, peer, "store 的语义已说明\n<!-- bcp:store -->")
  expect(searchRecords(scope, { query: "store", caller }).items.map(x => x.id)).toEqual([real])
})
test("folded original bodies remain searchable; tombstones and explicit kind filters apply", () => {
  const { scope, peer, caller } = setup()
  const a = put(scope, peer, "timeout 原始依据")
  const b = put(scope, peer, "timeout 新评审", { kind: "review" })
  const meta = scope.readMeta(peer); meta.nav[a] = { covered_by: b, superseded_by: b }; scope.writeMeta(peer, meta)
  expect(searchRecords(scope, { query: "timeout", caller }).items).toHaveLength(2)
  expect(searchRecords(scope, { query: "timeout", caller }).items.find(x => x.id === a)?.covered_by).toBe(b)
  expect(searchRecords(scope, { query: "timeout", caller, kind: "review" }).items.map(x => x.id)).toEqual([b])
  scope.markTombstone(peer, a, "withdrawn")
  expect(searchRecords(scope, { query: "timeout", caller }).items.map(x => x.id)).toEqual([b])
  expect(searchRecords(scope, { query: "timeout", caller, view: "all" }).items).toHaveLength(2)
})
test("navigation never leaks hidden references", () => {
  const { scope, peer, hidden, caller } = setup()
  const a = put(scope, peer, "timeout"), b = put(scope, hidden, "private")
  const meta = scope.readMeta(peer); meta.nav[a] = { covered_by: b, superseded_by: b }; scope.writeMeta(peer, meta)
  const row = searchRecords(scope, { query: "timeout", caller }).items[0]
  expect(row.covered_by).toBeNull(); expect(row.superseded_by).toBeNull()
})
test("relevance pages are deterministic and disjoint; changes invalidate rather than mix pages", () => {
  const { scope, peer, caller } = setup()
  for (let i = 0; i < 5; i++) put(scope, peer, `timeout 原因${i}`)
  const opts = { query: "timeout", caller, limit: 2 }
  const first = searchRecords(scope, opts), second = searchRecords(scope, { ...opts, cursor: first.nextCursor! })
  const third = searchRecords(scope, { ...opts, cursor: second.nextCursor! })
  expect(new Set([...first.items, ...second.items, ...third.items].map(x => x.id)).size).toBe(5)
  expect(third.nextCursor).toBeNull()
  expect(() => searchRecords(scope, { ...opts, query: "原因", cursor: first.nextCursor! })).toThrow("search_cursor_mismatch")
  expect(() => searchRecords(scope, { ...opts, caller: { sessionId: "peer", agent: "fixer" }, cursor: first.nextCursor! })).toThrow("search_cursor_mismatch")
  put(scope, peer, "timeout new")
  expect(() => searchRecords(scope, { ...opts, cursor: first.nextCursor! })).toThrow("search_cursor_stale")
})
test("permission, content, and navigation changes invalidate the old search snapshot", () => {
  const { scope, peer, caller } = setup()
  const id = put(scope, peer, "timeout a"); put(scope, peer, "timeout b")
  const opts = { query: "timeout", caller, limit: 1 }
  let cursor = searchRecords(scope, opts).nextCursor!
  const meta = scope.readMeta(peer); meta.nav[id] = { covered_by: id }; scope.writeMeta(peer, meta)
  expect(() => searchRecords(scope, { ...opts, cursor })).toThrow("search_cursor_stale")
  cursor = searchRecords(scope, opts).nextCursor!
  const path = join(scope.dir, "streams", peer, "entries", "e000001.json")
  const rec = JSON.parse(readFileSync(path, "utf8")); rec.content += " changed"; writeFileSync(path, JSON.stringify(rec))
  expect(() => searchRecords(scope, { ...opts, cursor })).toThrow("search_cursor_stale")
  cursor = searchRecords(scope, opts).nextCursor!
  scope.refreshSessionAgent("peer", "councillor")
  expect(() => searchRecords(scope, { ...opts, cursor })).toThrow("search_cursor_mismatch")
})
test("bounded scans and unreadable records report incomplete coverage without fabricated absence", () => {
  const { scope, peer, caller } = setup()
  for (let i = 0; i < 3; i++) put(scope, peer, `timeout ${i}`)
  const result = searchRecords(scope, { query: "missing", stream: peer, caller }, { ...SEARCH_LIMITS, records: 1 })
  expect(result.items).toEqual([]); expect(result.coverage).toBe("incomplete"); expect(result.reasons).toContain("record_budget")
  expect(result.examined_entries).toBe(1)
  expect(searchRecords(scope, { query: "timeout", caller }, { ...SEARCH_LIMITS, bytes: 1 }).reasons).toContain("byte_budget")
  expect(searchRecords(scope, { query: "timeout", caller }, { ...SEARCH_LIMITS, recordBytes: 1 }).reasons).toContain("oversized_record")
  writeFileSync(join(scope.dir, "streams", peer, "entries", "e000001.json"), "broken")
  const broken = searchRecords(scope, { query: "timeout", caller })
  expect(broken.coverage).toBe("incomplete"); expect(broken.reasons).toContain("record_unavailable")
  expect(broken.items).toHaveLength(2)
})
test("tool query works without changing legacy directory/keyword behavior or writing records", async () => {
  const { scope, own, peer } = setup()
  const a = put(scope, own, "bodyOnlyNeedle", { description: "legacy title" })
  const b = put(scope, peer, "bodyOnlyNeedle")
  const before = readFileSync(join(scope.dir, "streams", own, "entries", "e000001.json"), "utf8")
  const tools = defineBoardTools({ resolveScope: async () => ({ scope, streamId: own, isolated: false }), log: () => {} })
  const ctx = { sessionID: "root", agent: "orchestrator", messageID: "query" }
  const call = async (args: unknown) => JSON.parse(await tools.board_index.execute(ctx, args))
  expect((await call({})).stream.items.map((x: { id: string }) => x.id)).toEqual([a])
  expect((await call({ keyword: "bodyOnlyNeedle" })).stream.items).toEqual([])
  expect(new Set((await call({ query: "bodyOnlyNeedle" })).search.items.map((x: { id: string }) => x.id))).toEqual(new Set([a, b]))
  expect(await tools.board_index.execute(ctx, { query: "bodyOnlyNeedle", keyword: "legacy" })).toContain("query_keyword_conflict")
  expect((await call({ keyword: "", range: "own" })).stream.items.map((x: { id: string }) => x.id)).toEqual([a])
  expect(await tools.board_index.execute(ctx, { range: "authorized" })).toContain("query_required_for_authorized_search")
  expect(await tools.board_index.execute(ctx, { query: "bodyOnlyNeedle", since_seq: 0 })).toContain("since_seq_requires_single_stream")
  expect((await call({ query: "bodyOnlyNeedle", stream: peer, since_seq: 0 })).search.items[0].id).toBe(b)
  expect(readFileSync(join(scope.dir, "streams", own, "entries", "e000001.json"), "utf8")).toBe(before)
})
test("invalid queries/cursors and foreign scope stream identifiers fail closed", () => {
  const { scope, caller } = setup()
  for (const query of ["", "  ", "***", "a".repeat(201)]) expect(() => searchRecords(scope, { query, caller })).toThrow()
  expect(() => searchRecords(scope, { query: "timeout", caller, cursor: "garbage" })).toThrow("search_cursor_mismatch")
  expect(() => searchRecords(scope, { query: "timeout", caller, stream: "../../other" })).toThrow("stream_not_found")
})
test("letter-digit and underscore spellings preserve exact identifiers and support spaced queries", () => {
  const { scope, peer, caller } = setup()
  const id = put(scope, peer, "HTTP500 必须停止。board_store 保存原文，取消优先处理。")
  for (const query of ["HTTP 500", "HTTP500", "board store", "board_store", "HTTP 500 停止 取消 优先"]) {
    const row = searchRecords(scope, { query, caller }).items[0]
    expect(row.id).toBe(id); expect(row.snippet.text).toContain("HTTP500")
  }
  expect(searchRecords(scope, { query: "HTTP 404", caller }).items).toEqual([])
  const spaced = put(scope, peer, "HTTP 502 的处置")
  expect(searchRecords(scope, { query: "HTTP502", caller }).items.map(x => x.id)).toEqual([spaced])
})
