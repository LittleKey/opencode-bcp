import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openScopeForRoot } from "../src/storage"
import { captureFinal, NO_STORE, STORE } from "../src/capture"
import { beginEditObservation, editEvidence, invalidateEditEvidence, observeEdits } from "../src/edit-evidence"
import { sourceHandoff } from "../src/handoff"
import { messageStore, type StoreHost } from "../src/message-store"
import type { HostMessage } from "../src/delivery"

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bcp-store-")); dirs.push(dir)
  let scope = openScopeForRoot({ rootSessionId: "parent", dataDir: dir })
  scope.registerSession("parent", "orchestrator")
  const author = scope.registerSession("author", "fixer")
  scope.registerSession("peer", "oracle")
  scope.registerSession("hidden", "councillor-test")
  const messages = new Map<string, HostMessage>()
  const input: HostMessage = { info: { id: "u1", sessionID: "author", role: "user" }, parts: [{ type: "text", text: "Update the file." }] }
  const reply: HostMessage = { info: { id: "a1", sessionID: "author", role: "assistant", agent: "fixer", parentID: "u1", finish: "stop", time: { completed: 20 } },
    parts: [{ type: "text", text: "Completed without a publication marker." }, { type: "reasoning", text: "private reasoning" }] }
  messages.set("author:u1", input); messages.set("author:a1", reply)
  const access = { directory: dir, ask: async () => {} }
  let reads = 0, allowed = true, sourceAllowed = true
  const host: StoreHost = {
    resolve: async id => {
      const s = scope.config.session_index[id]
      return s ? { scope, streamId: s.stream_id, agent: s.agent } : null
    }, message: async (s, id) => { reads++; return messages.get(`${s}:${id}`) ?? null },
    messages: async (s, limit) => [...messages.values()].filter(m => m.info.sessionID === s).slice(-limit),
    current: () => false, authorizeCaller: async () => allowed,
    authorize: async () => sourceAllowed ? access : null,
    evidence: async (_session, parent, completed, ctx) => editEvidence(scope, author.streamId, parent, completed, ctx),
  }
  const ctx = { sessionID: "parent", agent: "orchestrator", messageID: "parent-call" }
  const invoke = (args: object, context = ctx) => messageStore(host).execute(context, args).then(JSON.parse)
  const request = { action: "store", session_id: "author", message_id: "a1", description: "Original result", kind: "change" }
  return { dir, author, input, reply, host, access, messages, ctx, invoke, request, get scope() { return scope },
    reads: () => reads, denyCaller: () => { allowed = false }, denySource: () => { sourceAllowed = false },
    restart: () => { scope = openScopeForRoot({ rootSessionId: "parent", dataDir: dir }) } }
}
test("non-author retains exact completed public text with actual author and separate requester; both paths replay", async () => {
  const f = setup()
  const stored = await f.invoke(f.request)
  expect(stored.status).toBe("stored")
  const found = f.scope.getById(stored.id); if (found.status !== "found") throw Error("missing")
  expect(found.record.writer).toEqual({ agent: "fixer", session_id: "author", message_id: "a1" })
  expect(found.record.origin!.requested_by).toEqual({ agent: "orchestrator", session_id: "parent", message_id: "parent-call" })
  expect(found.record.content).toBe("Completed without a publication marker.")
  expect(found.record.kind).toBe("change")
  f.restart()
  expect((await f.invoke({ ...f.request, description: "Do not overwrite metadata" })).status).toBe("replay")
  expect((await captureFinal("author", "a1", f.host)).status).toBe("replay")
  expect(f.scope.readMeta(f.author.streamId).high_water).toBe(1)
})
test("message discovery is bounded and exposes exact IDs and real author without reasoning", async () => {
  const f = setup()
  const listing = await f.invoke({ action: "list", session_id: "author", limit: 1 })
  expect(listing.replies).toHaveLength(1)
  expect(listing.replies[0].message_id).toBe("a1")
  expect(listing.replies[0].author).toBe("fixer")
  expect(JSON.stringify(listing)).not.toContain("private reasoning")
  expect(listing.other_sessions.some((s: { session_id: string }) => s.session_id === "hidden")).toBe(false)
  expect((await f.invoke({ action: "list", session_id: "hidden" })).status).toBe("not_found")
})
test("foreign/hidden sources are rejected before message reads; same-scope peer may store", async () => {
  const f = setup()
  for (const session_id of ["foreign", "hidden"]) expect((await f.invoke({ ...f.request, session_id })).status).toBe("not_found")
  expect(f.reads()).toBe(0)
  const saved = await f.invoke(f.request, { sessionID: "peer", agent: "oracle", messageID: "peer-call" })
  expect(saved.status).toBe("stored")
  expect(saved.writer.agent).toBe("fixer")
})
test("caller/source authorization and original input/final restrictions cannot be bypassed", async () => {
  for (const mode of ["caller", "source", "input", "reply"] as const) {
    const f = setup()
    if (mode === "caller") f.denyCaller()
    else if (mode === "source") f.denySource()
    else f[mode].parts![0]!.text += NO_STORE
    expect((await f.invoke(f.request)).id).toBeUndefined()
    expect(f.scope.readMeta(f.author.streamId).high_water).toBe(0)
  }
})
test("non-final, missing original agent, aborted and missing messages cannot be published", async () => {
  for (const mode of ["pending", "agent", "aborted", "missing"] as const) {
    const f = setup()
    if (mode === "pending") f.reply.info.finish = "tool-calls"
    if (mode === "agent") delete f.reply.info.agent
    if (mode === "aborted") f.reply.info.error = { name: "aborted" }
    if (mode === "missing") f.messages.delete("author:a1")
    expect((await f.invoke(f.request)).id).toBeUndefined()
  }
})
test("automatic first capture and explicit repair share identity without changing original metadata", async () => {
  const f = setup()
  f.reply.parts![0]!.text = `Outcome.\n${STORE}`
  const saved = await captureFinal("author", "a1", { ...f.host, current: () => true })
  expect((await f.invoke(f.request)).id).toBe(saved.id)
  const found = f.scope.getById(saved.id!); if (found.status !== "found") throw Error("missing")
  expect(found.record.origin!.requested_by).toBeUndefined()
})
test("durable per-input snapshots survive later edits, session reuse and restart in both capture paths", async () => {
  const f = setup(), path = join(f.dir, "result.md")
  writeFileSync(path, "version one")
  await observeEdits(f.scope, f.author.streamId, "u1", "call1", [path], f.access, () => true, () => 10)
  writeFileSync(path, "version two")
  await observeEdits(f.scope, f.author.streamId, "u1", "call2", [path], f.access, () => true, () => 30)
  await observeEdits(f.scope, f.author.streamId, "u2", "call3", [path], f.access, () => true, () => 35)
  f.restart()
  const first = await f.invoke(f.request)
  expect(readFileSync(new URL(first.source_refs[0].split("#")[0]), "utf8")).toBe("version one")
  f.reply.info.id = "a2"; f.reply.info.time!.completed = 40; f.reply.parts![0]!.text = `Result.\n${STORE}`
  f.messages.set("author:a2", f.reply)
  const second = await captureFinal("author", "a2", { ...f.host, current: () => true })
  const found = f.scope.getById(second.id!); if (found.status !== "found") throw Error("missing")
  expect(readFileSync(new URL(found.record.source_refs![0]!.split("#")[0]), "utf8")).toBe("version two")
})
test("different authors modifying the same path retain independent evidence", async () => {
  const f = setup(), path = join(f.dir, "shared.md"), peer = f.scope.config.session_index.peer!
  writeFileSync(path, "author bytes")
  await observeEdits(f.scope, f.author.streamId, "u1", "c1", [path], f.access, () => true, () => 10)
  writeFileSync(path, "peer bytes")
  await observeEdits(f.scope, peer.stream_id, "u1", "c1", [path], f.access, () => true, () => 11)
  for (const [stream, expected] of [[f.author.streamId, "author bytes"], [peer.stream_id, "peer bytes"]]) {
    const e = await editEvidence(f.scope, stream!, "u1", 20, f.access)
    expect(readFileSync(new URL(e.bindings[0]!.ref.split("#")[0]), "utf8")).toBe(expected!)
  }
})
test("unfinished, stale, late-completing or corrupt observations cannot substitute earlier bytes", async () => {
  const f = setup(), path = join(f.dir, "result.md")
  writeFileSync(path, "old")
  await observeEdits(f.scope, f.author.streamId, "u1", "c1", [path], f.access, () => true, () => 10)
  beginEditObservation(f.scope, f.author.streamId, "u1", "c2", () => 15)
  expect((await editEvidence(f.scope, f.author.streamId, "u1", 20, f.access)).bindings).toEqual([])
  writeFileSync(path, "new")
  await observeEdits(f.scope, f.author.streamId, "u1", "c2", [path], f.access, () => false, () => 25)
  expect((await editEvidence(f.scope, f.author.streamId, "u1", 30, f.access)).bindings).toEqual([])
  await observeEdits(f.scope, f.author.streamId, "u1", "c2", [path], f.access, () => true, () => 25)
  expect((await editEvidence(f.scope, f.author.streamId, "u1", 20, f.access)).bindings).toEqual([])
  const evidence = await editEvidence(f.scope, f.author.streamId, "u1", 30, f.access)
  writeFileSync(new URL(evidence.bindings[0]!.ref.split("#")[0]), "tampered")
  expect((await editEvidence(f.scope, f.author.streamId, "u1", 30, f.access)).bindings).toEqual([])
})
test("historical message-only repair never reads an unversioned current file", async () => {
  const f = setup(), path = join(f.dir, "changed.md")
  writeFileSync(path, "not the original bytes")
  f.reply.parts![0]!.text = `Original result file://${path}`
  const saved = await f.invoke(f.request)
  expect(saved.status).toBe("stored")
  expect(saved.source_errors.some((s: string) => s.startsWith("historical_source_version_unavailable"))).toBe(true)
  const found = f.scope.getById(saved.id); if (found.status !== "found") throw Error("missing")
  expect(found.record.origin!.file_bindings).toBeUndefined()
})
test("failed/deleted paths, denied reads and quota exhaustion retain explicit gaps", async () => {
  const f = setup(), path = join(f.dir, "deleted.md")
  await observeEdits(f.scope, f.author.streamId, "u1", "c1", [path], f.access, () => true, () => 10)
  expect((await editEvidence(f.scope, f.author.streamId, "u1", 20, f.access)).errors.length).toBeGreaterThan(0)
  writeFileSync(path, "bytes")
  await observeEdits(f.scope, f.author.streamId, "u1", "c2", [path], f.access, () => true, () => 11)
  expect((await editEvidence(f.scope, f.author.streamId, "u1", 20, { ...f.access, ask: async () => { throw Error("denied") } })).bindings).toEqual([])
  writeFileSync(join(f.scope.dir, "scope.json"), JSON.stringify({ ...f.scope.config, quota_bytes: 1 }))
  expect(() => beginEditObservation(f.scope, f.author.streamId, "u2", "c3")).toThrow("quota")
  invalidateEditEvidence(f.scope, f.author.streamId, "u1")
  expect((await editEvidence(f.scope, f.author.streamId, "u1", 20, f.access)).bindings).toEqual([])
})
test("late repair of an old message cannot become the newest author version in handoff", async () => {
  const f = setup(), path = join(f.dir, "version.md")
  writeFileSync(path, "old")
  await observeEdits(f.scope, f.author.streamId, "u1", "one", [path], f.access, () => true, () => 10)
  writeFileSync(path, "new")
  await observeEdits(f.scope, f.author.streamId, "u1", "two", [path], f.access, () => true, () => 30)
  const newer: HostMessage = { info: { ...f.reply.info, id: "a2", time: { completed: 40 } }, parts: [{ type: "text", text: "Newer version" }] }
  f.messages.set("author:a2", newer)
  const current = await f.invoke({ ...f.request, message_id: "a2" })
  const older = await f.invoke(f.request)
  const routed = sourceHandoff(f.scope, "parent", `Review ${path}`, [current.id, older.id])
  expect(routed.references).toEqual([current.id])
})

test("screenshot placeholders get discovery guidance without a fallback publication or source read", async () => {
  const f = setup()
  const badSession = await f.invoke({ ...f.request, session_id: "ses_main", message_id: "msg_未定" })
  expect(badSession.status).toBe("not_found")
  expect(badSession.next_call).toEqual({ action: "list" })
  expect(f.reads()).toBe(0)
  const badMessage = await f.invoke({ ...f.request, message_id: "msg_未定" })
  expect(badMessage.reason).toBe("message_not_found")
  expect(badMessage.next_call).toEqual({ action: "list", session_id: "author" })
  expect(f.scope.readMeta(f.author.streamId).high_water).toBe(0)
  const listed = await f.invoke(badMessage.next_call)
  const saved = await f.invoke({ ...f.request, message_id: listed.replies[0].message_id })
  expect(saved.writer.message_id).toBe("a1")
  expect(saved.status).toBe("stored")
})

test("reasoning and tool arguments cannot stand in for an unwritten public report", async () => {
  const f = setup()
  f.reply.parts = [{ type: "reasoning", text: "Full private findings" },
    { type: "tool", tool: "read", state: { status: "completed" } },
    { type: "text", text: "synthetic report", synthetic: true }]
  const listed = await f.invoke({ action: "list", session_id: "author" })
  expect(listed.replies).toEqual([])
  expect(listed.hint).toContain("user-readable reply")
  expect(JSON.stringify(listed)).not.toContain("Full private findings")
  const rejected = await f.invoke(f.request)
  expect(rejected.reason).toBe("not_completed_author_reply")
  expect(rejected.hint).toContain("Complete that reply normally")
  expect((await f.invoke({ ...f.request, content: "injected unwritten report" })).id).toBeUndefined()
  expect(f.scope.readMeta(f.author.streamId).high_water).toBe(0)
})

test("a progress notice cannot be expanded into the report named by its title", async () => {
  const f = setup()
  f.reply.parts![0]!.text = "分析完毕，接下来给出完整解释。"
  const saved = await f.invoke({ ...f.request, description: "Complete technical review" })
  const record = f.scope.getById(saved.id)
  if (record.status !== "found") throw Error("missing")
  expect(record.record.content).toBe("分析完毕，接下来给出完整解释。")
  expect(record.record.content).not.toContain("Complete technical review")
  expect(record.record.content).not.toContain("private reasoning")
})

test("an invisible retention marker alone is neither a public result nor eligible for either capture mode", async () => {
  const f = setup()
  f.reply.parts![0]!.text = `\n${STORE}\n`
  expect((await f.invoke({ action: "list", session_id: "author" })).replies).toEqual([])
  expect((await f.invoke(f.request)).id).toBeUndefined()
  expect((await captureFinal("author", "a1", { ...f.host, current: () => true })).id).toBeUndefined()
  expect(f.scope.readMeta(f.author.streamId).high_water).toBe(0)
})
