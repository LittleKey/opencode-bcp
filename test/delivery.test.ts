import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openScopeForRoot } from "../src/storage"
import { defineBoardTools } from "../src/tools"
import { inspectDelivery, type DeliveryRequest, type HostMessage } from "../src/delivery"

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bcp-delivery-")); dirs.push(dir)
  const scope = openScopeForRoot({ rootSessionId: "parent", dataDir: dir })
  scope.registerSession("parent", "orchestrator")
  const child = scope.registerSession("child", "fixer")
  const hidden = scope.registerSession("hidden", "councillor")
  const messages = new Map<string, HostMessage>([
    ["input", { info: { id: "input", sessionID: "child", role: "user" } }],
    ["author", { info: { id: "author", sessionID: "child", role: "assistant", parentID: "input" } }],
    ["final", { info: { id: "final", sessionID: "child", role: "assistant", parentID: "input" }, parts: [] }],
  ])
  const tools = defineBoardTools({ resolveScope: async () => ({ scope, streamId: child.streamId, isolated: false }), log: () => {} })
  const ctx = { sessionID: "child", agent: "fixer", messageID: "author", directory: dir, ask: async () => {} }
  const file = join(dir, "artifact.txt"); writeFileSync(file, "review input")
  const put = async (refs: string[] = [file]) => {
    const text = await tools.board_put.execute(ctx, { description: "result", content: "Outcome: result. Limits: synthetic", source_refs: refs })
    const id = text.split(" ")[1]!
    messages.get("final")!.parts = [{ type: "text", text: id }]
    return id
  }
  const request: DeliveryRequest = { callerSessionID: "parent", taskID: "child", generation: 1, terminalRevision: 1,
    state: "completed", inputMessageID: "input", terminalMessageID: "final" }
  const host = { scopeFor: async () => scope, parentFor: async () => "parent", message: async (_s: string, id: string) => messages.get(id) ?? null }
  return { scope, hidden, messages, put, request, host, dir, file }
}
test("current author and byte checks reconstructed without publication observer state", async () => {
  const f = await fixture(); await f.put()
  const first: any = await inspectDelivery(f.request, f.host)
  expect(first.association).toBe("host_message_identity")
  expect(first.candidates[0].origin).toBe("current_input")
  expect(first.candidates[0].sources[0].check).toBe("verified")
  expect(first.coverage).toBe("not_evaluated")
  expect(await inspectDelivery(f.request, { ...f.host })).toEqual(first)
  writeFileSync(f.file, "new current bytes")
  expect((await inspectDelivery(f.request, f.host) as any).candidates[0].sources[0].check).toBe("verified")
})
test("reuse keeps old authorship; missing author message stays unconfirmed", async () => {
  const f = await fixture(); await f.put()
  f.messages.get("author")!.info.parentID = "older-input"
  expect((await inspectDelivery(f.request, f.host) as any).candidates[0].origin).toBe("prior_input")
  f.messages.delete("author")
  expect((await inspectDelivery(f.request, f.host) as any).candidates[0].origin).toBe("unconfirmed")
})
test("hidden record indistinguishable from unknown and no source inspection", async () => {
  const f = await fixture()
  const record = f.scope.put(f.hidden.streamId, { writer: { agent: "councillor", session_id: "hidden", message_id: "x" }, createdRound: 1, description: "secret", content: "secret" })
  if (record.status !== "stored") throw Error("fixture")
  f.messages.get("final")!.parts = [{ type: "text", text: record.id }]
  expect((await inspectDelivery(f.request, f.host) as any).candidates).toEqual([{ id: record.id, readability: "not_found" }])
})
test("wrong owner, missing terminal, running and invalid parent do not invent association", async () => {
  const f = await fixture(); await f.put()
  for (const request of [{ ...f.request, callerSessionID: "other" }, { ...f.request, terminalMessageID: undefined }, { ...f.request, state: "running" }, { ...f.request, inputMessageID: "wrong" }])
    expect((await inspectDelivery(request, f.host)).association).toBe("unconfirmed")
})
test("empty and external-only records are not artifact-verified; text without IDs not delivery proof", async () => {
  const f = await fixture(); await f.put(["src/relative.ts", "https://example.invalid/docs"])
  expect((await inspectDelivery(f.request, f.host) as any).candidates[0].sources.map((s: any) => s.check)).toEqual(["external_unchecked", "external_unchecked"])
  f.messages.get("final")!.parts = [{ type: "text", text: "Done" }]
  expect((await inspectDelivery(f.request, f.host)).candidates).toEqual([])
})
test("cross-scope candidates are forbidden and candidate/source limits stay explicit", async () => {
  const f = await fixture()
  const refs = Array.from({ length: 17 }, (_, i) => `https://example.invalid/${i}`)
  const ids: string[] = []
  for (let i = 0; i < 9; i++) ids.push(await f.put(refs))
  f.messages.get("final")!.parts = [{ type: "text", text: ids.join("\n") }]
  const result: any = await inspectDelivery(f.request, f.host)
  expect(result.candidates).toHaveLength(8)
  expect(result.truncated).toBe(true)
  expect(result.candidates[0].sources).toHaveLength(16)
  expect(result.candidates[0].sources_truncated).toBe(true)
  const cross = ids[0]!.replace(f.scope.scopeId, "00000000-0000-0000-0000-000000000000")
  f.messages.get("final")!.parts = [{ type: "text", text: cross }]
  expect((await inspectDelivery(f.request, f.host)).candidates).toEqual([{ id: cross, readability: "forbidden" }])
})
