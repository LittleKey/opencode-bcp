import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { BlackboardPlugin } from "../src/plugin"
import { captureFinal, publicationAllowed, type PermissionRule } from "../src/capture"
import { publicReply } from "../src/reply"
import { messageStore, type StoreHost } from "../src/message-store"
import { beginEditObservation, editEvidence, observeEdits } from "../src/edit-evidence"
import { openScopeForRoot } from "../src/storage"
import { ReceiptCheck } from "../src/receipt-check"
import type { HostMessage } from "../src/delivery"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bcp-stage-")); dirs.push(dir)
  const scope = openScopeForRoot({ rootSessionId: "s", dataDir: dir })
  const { streamId } = scope.registerSession("s", "orchestrator")
  const input: HostMessage = { info: { id: "u", sessionID: "s", role: "user" }, parts: [{ type: "text", text: "Choose and delegate." }] }
  const stage: HostMessage = { info: { id: "a", sessionID: "s", role: "assistant", agent: "orchestrator", parentID: "u", finish: "tool-calls", time: { created: 10, completed: 20 } }, parts: [
    { id: "text1", type: "text", text: "Choose B. Keep the deadline. Pending external validation.", time: { start: 11, end: 19 } },
    { type: "reasoning", text: "private" },
    { id: "tool1", type: "tool", callID: "edit1", tool: "write", state: { status: "completed", time: { start: 15, end: 25 } } },
  ] }
  const access = { directory: dir, ask: async () => {} }
  const messages = new Map([["u", input], ["a", stage]])
  const host: StoreHost = { resolve: async () => ({ scope, streamId, agent: "orchestrator" }),
    message: async (_, id) => messages.get(id) ?? null, messages: async () => [...messages.values()],
    current: () => true, authorize: async () => access, authorizeCaller: async () => true,
    evidence: async (_, id, completed, ctx, boundary) => editEvidence(scope, streamId, id, completed, ctx, boundary) }
  const ctx = { sessionID: "s", agent: "orchestrator", messageID: "store-call" }
  const invoke = (args: object) => messageStore(host).execute(ctx, args).then(JSON.parse)
  const args = { action: "store", message_id: "a", description: "Decision", kind: "decision" }
  return { dir, scope, streamId, stage, input, access, messages, host, invoke, args, ctx }
}
test("stage capture is explicit, public-only, immutable and discoverable with its own identity", async () => {
  const f = fixture()
  expect((await captureFinal("s", "a", f.host)).id).toBeUndefined()
  const list = await f.invoke({ action: "list" })
  expect(list.replies[0].message_type).toBe("stage")
  const result = await f.invoke(f.args)
  const found = f.scope.getById(result.id); if (found.status !== "found") throw Error("missing")
  expect(found.record.content).toBe(f.stage.parts![0]!.text!)
  expect(found.record.origin!.kind).toBe("host_stage")
  expect(found.record.origin!.message_completed_at).toBe(25)
  expect(found.record.kind).toBe("decision")
  expect((await f.invoke({ action: "list" })).replies[0].record_id).toBe(result.id)
  expect((await f.invoke(f.args)).status).toBe("replay")
  expect(f.scope.readMeta(f.streamId).high_water).toBe(1)
  f.stage.parts![2]!.state!.time!.end = 26
  expect((await f.invoke(f.args)).reason).toBe("capture_conflict")
})
test("streaming, running, interrupted, unidentified and empty stages are not listed or saved", async () => {
  for (const mode of ["text-open", "tool-running", "tool-unidentified", "tool-open", "empty", "length", "error", "summary"] as const) {
    const f = fixture()
    if (mode === "text-open") delete f.stage.parts![0]!.time!.end
    if (mode === "tool-running") f.stage.parts![2]!.state!.status = "running"
    if (mode === "tool-unidentified") delete f.stage.parts![2]!.callID
    if (mode === "tool-open") delete f.stage.parts![2]!.state!.time!.end
    if (mode === "empty") f.stage.parts![0]!.text = ""
    if (mode === "length") f.stage.info.finish = "length"
    if (mode === "error") f.stage.info.error = { name: "aborted" }
    if (mode === "summary") f.stage.info.summary = true
    expect((await f.invoke({ action: "list" })).replies).toEqual([])
    expect((await f.invoke(f.args)).id).toBeUndefined()
  }
})
test("stage bytes follow causal native-call snapshots, not premature model completion or later edits", async () => {
  const f = fixture(), path = join(f.dir, "output.txt")
  beginEditObservation(f.scope, f.streamId, "u", "edit1", () => 15)
  writeFileSync(path, "STAGE_V1")
  // Real host ordering: model ends20, tool ends25, snapshot after-hook ends30.
  await observeEdits(f.scope, f.streamId, "u", "edit1", [path], f.access, () => true, () => 30)
  beginEditObservation(f.scope, f.streamId, "u", "edit2", () => 35)
  writeFileSync(path, "LATER_V2")
  await observeEdits(f.scope, f.streamId, "u", "edit2", [path], f.access, () => true, () => 40)
  const result = await f.invoke(f.args)
  expect(result.source_errors).toEqual([])
  expect(readFileSync(new URL(result.source_refs[0].split("#")[0]), "utf8")).toBe("STAGE_V1")
  expect(readFileSync(path, "utf8")).toBe("LATER_V2")
})
test("missing or unfinished stage snapshots never fall back to an earlier snapshot", async () => {
  const f = fixture(), path = join(f.dir, "output.txt")
  writeFileSync(path, "EARLIER")
  await observeEdits(f.scope, f.streamId, "u", "old", [path], f.access, () => true, () => 5)
  const boundary = publicReply(f.stage, true)!.boundary!
  expect((await editEvidence(f.scope, f.streamId, "u", 25, f.access, boundary)).errors).toContain("stage_edit_evidence_missing")
  beginEditObservation(f.scope, f.streamId, "u", "edit1", () => 15)
  expect((await editEvidence(f.scope, f.streamId, "u", 25, f.access, boundary)).bindings).toEqual([])
})
test("a changed source boundary during asynchronous evidence preparation is rejected", async () => {
  const f = fixture()
  f.host.evidence = async () => { f.stage.parts![0]!.text = "changed"; return { paths: [], bindings: [], errors: [] } }
  expect((await f.invoke(f.args)).reason).toBe("message_changed_during_capture")
  expect(f.scope.readMeta(f.streamId).high_water).toBe(0)
})
test("publication policy uses store, preserves legacy explicit bans, and respects rule order", () => {
  const rule = (permission: string, action: PermissionRule["action"]): PermissionRule => ({ permission, pattern: "*", action })
  expect(publicationAllowed([rule("*", "allow")])).toBe(true)
  expect(publicationAllowed([rule("*", "deny"), rule("board_store", "allow")])).toBe(true)
  for (const action of ["deny", "ask"] as const) {
    expect(publicationAllowed([rule("*", "allow"), rule("board_put", action)])).toBe(false)
    expect(publicationAllowed([rule("*", "allow"), rule("board_p*", action)])).toBe(false)
    expect(publicationAllowed([rule("*", "allow"), rule("board_store", action)])).toBe(false)
  }
  expect(publicationAllowed([rule("board_put", "deny"), rule("*", "allow")])).toBe(true)
  expect(publicationAllowed([rule("*", "deny"), rule("board_put", "allow")], {}, false)).toBe(true)
  expect(publicationAllowed([rule("*", "deny"), rule("board_store", "allow")], {}, false)).toBe(false)
  for (const key of ["board_put", "board_store"]) expect(publicationAllowed([rule("*", "allow")], { [key]: false })).toBe(false)
})
test("source registration allows current-input reuse without claiming snapshot freshness", () => {
  const r = new ReceiptCheck(); r.begin("s", "u"); r.changed("s", ["file"])
  r.sourced("s", "old", "old-record"); expect(r.sources("s", "u")).toEqual([])
  r.sourced("s", "u", "record"); r.sourced("s", "u", "record")
  expect(r.sources("s", "u")).toEqual(["record"])
  expect(r.finish("s", "final", "u")?.status).toBe("missing_handoff")
  r.begin("s", "next"); expect(r.sources("s", "next")).toEqual([])
})
test("real adapter removes default put, registers retained decisions before dispatch, and preserves manual put", async () => {
  const f = fixture()
  const client = { app: { agents: async () => ({ data: [{ name: "orchestrator", permission: [{ permission: "*", pattern: "*", action: "allow" }] }] }) }, session: {
    get: async () => ({ data: { id: "s", parentID: null, agent: "orchestrator" } }),
    message: async ({ path }: { path: { messageID: string } }) => ({ data: f.messages.get(path.messageID) }),
    messages: async () => ({ data: [...f.messages.values()] }),
  } }
  const plugin = await BlackboardPlugin({ directory: f.dir, client } as unknown as PluginInput, { dataDir: f.dir })
  expect(Object.keys(plugin.tool!).sort()).toEqual(["board_aggregate", "board_get", "board_index", "board_store"])
  await plugin["chat.message"]!({ sessionID: "s", agent: "orchestrator", messageID: "u" }, { message: f.input.info as never, parts: f.input.parts as never })
  const result = JSON.parse(await plugin.tool!.board_store.execute(f.args, f.ctx as never) as string)
  expect(result.status).toBe("stored")
  const output = { args: { prompt: "Implement from the governing decision." } }
  await plugin["tool.execute.before"]!({ tool: "task", sessionID: "s", callID: "next" }, output)
  expect(output.args.prompt).toContain(result.id)
  expect(output.args.prompt).toContain("<bcp_input_decisions>")
  expect(output.args.prompt).not.toContain(f.stage.parts![0]!.text!)
  const manual = await BlackboardPlugin({ directory: f.dir, client } as unknown as PluginInput, { dataDir: f.dir, autoCapture: false })
  expect(manual.tool!.board_put).toBeDefined()
})
