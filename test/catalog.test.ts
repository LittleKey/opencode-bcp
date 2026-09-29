import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openScopeForRoot } from "../src/storage"
import { authorizedCatalog, CATALOG_LIMITS } from "../src/catalog"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bcp-catalog-")); dirs.push(dir)
  const scope = openScopeForRoot({ rootSessionId: "root", dataDir: dir })
  const own = scope.registerSession("root", "orchestrator").streamId
  const peer = scope.registerSession("peer", "fixer").streamId
  const hidden = scope.registerSession("secret", "councillor").streamId
  const caller = { sessionId: "root", agent: "orchestrator" }
  let n = 0
  function put(stream = peer, description = "主题：已完成；限制仅静态验证") {
    const sid = Object.entries(scope.config.session_index).find(([, v]) => v.stream_id === stream)![0]
    const result = scope.put(stream, { writer: { agent: scope.config.session_index[sid]!.agent, session_id: sid, message_id: `m${++n}` },
      description, content: "Exact public source body", createdRound: null })
    if (result.status !== "stored") throw Error(JSON.stringify(result))
    return result.id
  }
  return { scope, own, peer, hidden, caller, put }
}
test("authorized catalog exposes compact metadata, covers folded originals and never rewrites records", () => {
  const { scope, own, peer, caller, put } = setup()
  const a = put(own), b = put(peer)
  const path = join(scope.dir, "streams", own, "entries", "e000001.json"), original = readFileSync(path, "utf8")
  const meta = scope.readMeta(own); meta.nav[a] = { covered_by: b, superseded_by: b }; scope.writeMeta(own, meta)
  const result = authorizedCatalog(scope, { caller })
  expect(new Set(result.items.map(r => r.id))).toEqual(new Set([a, b]))
  expect(result.items.find(r => r.id === a)?.covered_by).toBe(b)
  expect(result.items[0]).not.toHaveProperty("content")
  expect(result.all_visible_listed).toBe(true)
  expect(result.item_bytes).toBe(Buffer.byteLength(JSON.stringify(result.items)))
  expect(readFileSync(path, "utf8")).toBe(original)
  scope.markTombstone(peer, b, "withdrawn")
  expect(authorizedCatalog(scope, { caller }).total_items).toBe(1)
  expect(authorizedCatalog(scope, { caller, view: "all" }).items.find(r => r.id === b)?.tombstoned).toBe(true)
})
test("hidden records cannot alter counts, bytes, snapshot or navigational references", () => {
  const { scope, peer, hidden, caller, put } = setup()
  const a = put(peer), before = authorizedCatalog(scope, { caller })
  const b = put(hidden, "SECRET")
  expect(authorizedCatalog(scope, { caller })).toEqual(before)
  const meta = scope.readMeta(peer); meta.nav[a] = { covered_by: b, superseded_by: b }; scope.writeMeta(peer, meta)
  expect(authorizedCatalog(scope, { caller })).toEqual(before)
  expect(() => authorizedCatalog(scope, { caller, stream: hidden })).toThrow("stream_not_found")
  expect(() => authorizedCatalog(scope, { caller, stream: "../foreign" })).toThrow("stream_not_found")
  expect(() => authorizedCatalog(scope, { caller: { sessionId: "absent", agent: "orchestrator" } })).toThrow("unregistered_session")
})
test("byte-limited pages are complete, non-overlapping and stable across authorized streams", () => {
  const { scope, own, peer, caller, put } = setup()
  const all = Array.from({ length: 15 }, (_, i) => put(i % 2 ? own : peer, "标题".repeat(35)))
  const budget = { ...CATALOG_LIMITS, pageBytes: 1000 }
  let cursor: string | undefined, ids: string[] = []
  do {
    const page = authorizedCatalog(scope, { caller, limit: 200, cursor }, budget)
    expect(page.coverage).toBe("complete"); expect(page.item_bytes).toBeLessThanOrEqual(1000)
    expect(page.all_visible_listed).toBe(false)
    ids.push(...page.items.map(r => r.id)); cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(ids.length).toBe(all.length); expect(new Set(ids)).toEqual(new Set(all))
})
test("cursors bind identity, filters, permissions, publication and navigation snapshot", () => {
  const { scope, peer, caller, put } = setup()
  const firstId = put(); put()
  const opts = { caller, limit: 1 }, first = authorizedCatalog(scope, opts)
  expect(() => authorizedCatalog(scope, { ...opts, keyword: "changed", cursor: first.nextCursor! })).toThrow("catalog_cursor_mismatch")
  expect(() => authorizedCatalog(scope, { ...opts, caller: { sessionId: "peer", agent: "fixer" }, cursor: first.nextCursor! })).toThrow("catalog_cursor_mismatch")
  const meta = scope.readMeta(peer); meta.nav[firstId] = { covered_by: firstId }; scope.writeMeta(peer, meta)
  expect(() => authorizedCatalog(scope, { ...opts, cursor: first.nextCursor! })).toThrow("catalog_cursor_stale")
  let cursor = authorizedCatalog(scope, opts).nextCursor!; put()
  expect(() => authorizedCatalog(scope, { ...opts, cursor })).toThrow("catalog_cursor_stale")
  cursor = authorizedCatalog(scope, opts).nextCursor!
  scope.refreshSessionAgent("peer", "councillor")
  expect(() => authorizedCatalog(scope, { ...opts, cursor })).toThrow("catalog_cursor_mismatch")
  expect(() => authorizedCatalog(scope, { caller, cursor: "malformed" })).toThrow("catalog_cursor_mismatch")
})
test("filtering and budget/unreadable gaps are explicit rather than fabricated absence", () => {
  const { scope, peer, caller, put } = setup(); put(peer, "Alpha"); put(peer, "Beta")
  expect(authorizedCatalog(scope, { caller, keyword: "alpha" }).total_items).toBe(1)
  expect(authorizedCatalog(scope, { caller, kind: "review" }).total_items).toBe(0)
  expect(() => authorizedCatalog(scope, { caller, sinceSeq: 0 })).toThrow("since_seq_requires_single_stream")
  expect(authorizedCatalog(scope, { caller, stream: peer, sinceSeq: 1 }).total_items).toBe(1)
  for (const [budget, reason] of [[{ records: 1 }, "record_budget"], [{ bytes: 1 }, "byte_budget"], [{ recordBytes: 1 }, "oversized_record"], [{ pageBytes: 1 }, "oversized_catalog_item"]] as const) {
    const r = authorizedCatalog(scope, { caller }, { ...CATALOG_LIMITS, ...budget })
    expect(r.coverage).toBe("incomplete"); expect(r.reasons).toContain(reason); expect(r.all_visible_listed).toBe(false)
  }
  writeFileSync(join(scope.dir, "streams", peer, "entries", "e000001.json"), "broken")
  const result = authorizedCatalog(scope, { caller })
  expect(result.coverage).toBe("incomplete"); expect(result.reasons).toContain("record_unavailable"); expect(result.total_items).toBe(1)
})
