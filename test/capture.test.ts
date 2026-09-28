import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { openScopeForRoot } from "../src/storage"
import { captureFinal, captureRequested, NO_STORE, STORE, permissionAction, type CaptureHost } from "../src/capture"
import { inspectDelivery, type HostMessage } from "../src/delivery"
import { inspectArtifacts } from "../src/artifacts"
import { BlackboardPlugin } from "../src/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import { AUTO_CAPTURE_INSTRUCTION } from "../src/constants"
import { ReceiptCheck } from "../src/receipt-check"
import { sourceHandoff } from "../src/handoff"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bcp-capture-")); dirs.push(dir)
  const scope = openScopeForRoot({ rootSessionId: "parent", dataDir: dir })
  scope.registerSession("parent", "orchestrator")
  const child = scope.registerSession("child", "fixer")
  const input: HostMessage = { info: { id: "u1", sessionID: "child", role: "user" }, parts: [{ type: "text", text: "Inspect this input." }] }
  const final: HostMessage = { info: { id: "a1", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer", finish: "stop", time: { completed: 1 } },
    parts: [{ type: "text", text: STORE + "\nOutcome: unchanged.\nLimits: only the requested scope.\n" }] }
  const messages = new Map([["u1", input], ["a1", final]])
  let active = "u1"
  const host: CaptureHost = { resolve: async () => ({ scope, streamId: child.streamId, agent: "fixer" }),
    message: async (_session, id) => messages.get(id) ?? null, current: (_session, id) => id === active,
    authorize: async () => ({ directory: dir, ask: async () => {} }) }
  return { dir, scope, child, input, final, messages, host, setActive: (id: string) => { active = id } }
}
test("exact author text and identity retained once; replay is durable and never copies mutable sources again", async () => {
  const f = fixture(), file = join(f.dir, "draft.md")
  writeFileSync(file, "version one")
  const text = `${STORE}\n  DONE\n\nBasis: file://${file}\nLimits: not independently reviewed.\n`
  f.final.parts = [{ type: "reasoning", text: "not public" }, { type: "text", text }, { type: "text", text: "host annotation", synthetic: true }]
  const results = await Promise.all([captureFinal("child", "a1", f.host), captureFinal("child", "a1", f.host)])
  expect(results.map(r => r.status).sort()).toEqual(["replay", "stored"])
  expect(results[0]!.id).toBe(results[1]!.id)
  const found = f.scope.getById(results[0]!.id!)
  if (found.status !== "found") throw Error("capture missing")
  expect(found.record.content).toBe(text)
  expect(found.record.writer).toEqual({ agent: "fixer", session_id: "child", message_id: "a1" })
    expect(found.record.origin).toEqual({ kind: "host_final", input_message_id: "u1", text_sha256: createHash("sha256").update(text).digest("hex"), message_completed_at: 1, file_bindings: [{ path: file, ref: found.record.source_refs![0] }] })
  expect(inspectArtifacts(f.scope, f.child.streamId, found.record.source_refs)[0]!.status).toBe("verified")
  writeFileSync(file, "version two")
  const restarted = openScopeForRoot({ rootSessionId: "parent", dataDir: f.dir })
  const replay = await captureFinal("child", "a1", { ...f.host, resolve: async () => ({ scope: restarted, streamId: f.child.streamId, agent: "fixer" }) })
  expect(replay).toEqual({ status: "replay", id: results[0]!.id })
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(1)
  const snapshot = new URL(found.record.source_refs![0]!); snapshot.hash = ""
  expect(readFileSync(snapshot, "utf8")).toBe("version one")
})
test("nonfinal, errored, summary, pending tool, wrong-author and stale work are never captured", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.final.info.finish = "tool-calls" },
    (f: ReturnType<typeof fixture>) => { f.final.info.time = {} },
    (f: ReturnType<typeof fixture>) => { f.final.info.error = { name: "MessageAbortedError" } },
    (f: ReturnType<typeof fixture>) => { f.final.info.summary = true },
    (f: ReturnType<typeof fixture>) => { f.final.info.agent = "other" },
    (f: ReturnType<typeof fixture>) => { f.final.parts!.push({ type: "tool", state: { status: "running" } }) },
    (f: ReturnType<typeof fixture>) => { f.setActive("u2") },
    (f: ReturnType<typeof fixture>) => { f.input.info.role = "assistant" },
  ]) {
    const f = fixture(); mutate(f)
    expect((await captureFinal("child", "a1", f.host)).status).toBe("unconfirmed")
    expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
  }
})
test("Chinese citation annotations delimit URIs; encoded filename punctuation remains readable", async () => {
  const f = fixture(), file = join(f.dir, "工件（审阅）.md")
  writeFileSync(file, "specific version")
  const uri = new URL("file://" + file).href.replaceAll("（", "%EF%BC%88").replaceAll("）", "%EF%BC%89")
  f.final.parts![0]!.text = `${STORE}\nDONE: ${uri}（oracle 已复核），其他内容。`
  const result = await captureFinal("child", "a1", f.host)
  expect(result.status).toBe("stored")
  const found = f.scope.getById(result.id!)
  if (found.status !== "found") throw Error("capture missing")
  expect(found.record.origin!.source_errors).toBeUndefined()
  expect(inspectArtifacts(f.scope, f.child.streamId, found.record.source_refs)[0]!.status).toBe("verified")
})
test("publication marker and denied authorization skip all file access; input changes during capture fail closed", async () => {
  for (const position of ["input", "final", "permission"] as const) {
    const f = fixture(); let fileReads = 0
    f.final.parts![0]!.text += `file://${join(f.dir, "missing")}`
    if (position !== "permission") f[position].parts![0]!.text += NO_STORE
    f.host.authorize = async () => position === "permission" ? null : { directory: f.dir, ask: async () => { fileReads++ } }
    expect((await captureFinal("child", "a1", f.host)).status).toBe("skipped")
    expect(fileReads).toBe(0)
    expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
  }
  const f = fixture()
  f.host.authorize = async () => { f.setActive("u2"); return { directory: f.dir } }
  expect((await captureFinal("child", "a1", f.host)).reason).toBe("input_changed_during_capture")
})
test("unavailable/denied/mismatched artifacts preserve original claims with explicit source errors, not verification", async () => {
  for (const mode of ["missing", "denied", "mismatch"] as const) {
    const f = fixture(), path = join(f.dir, "input.md")
    if (mode !== "missing") writeFileSync(path, "new bytes")
    f.final.parts![0]!.text = `${STORE}\nPASS, source: file://${path}${mode === "mismatch" ? "#sha256=" + "0".repeat(64) : ""}`
    if (mode === "denied") f.host.authorize = async () => ({ directory: f.dir, ask: async () => { throw Error("denied") } })
    const result = await captureFinal("child", "a1", f.host)
    expect(result.status).toBe("stored")
    const found = f.scope.getById(result.id!)
    if (found.status !== "found") throw Error("capture missing")
    expect(found.record.content).toBe(f.final.parts![0]!.text!)
    expect(found.record.origin!.source_errors).toHaveLength(1)
    expect(inspectArtifacts(f.scope, f.child.streamId, found.record.source_refs)[0]!.status).not.toBe("verified")
  }
})
test("oversize and conflicting captures report a gap without truncation or false reuse", async () => {
  const f = fixture(); f.final.parts![0]!.text = STORE + "\n" + "x".repeat(262145)
  expect((await captureFinal("child", "a1", f.host)).reason).toBe("content_too_large")
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
  f.final.parts![0]!.text = STORE + "\nFirst final"
  const first = await captureFinal("child", "a1", f.host)
  f.final.parts![0]!.text = STORE + "\nChanged final"
  expect((await captureFinal("child", "a1", f.host)).reason).toBe("capture_conflict")
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(1)
  const found = f.scope.getById(first.id!); expect(found.status === "found" && found.record.content).toBe(STORE + "\nFirst final")
})
test("missing, quoted, inline or input-only opt-in never authorizes saving", async () => {
  for (const text of ["限制已收到", `Example: ${STORE}`, `\`\`\`html\n${STORE}\n\`\`\``, `${STORE} same line`]) {
    const f = fixture(); f.final.parts![0]!.text = text
    f.input.parts![0]!.text = STORE + "\nA request marker alone is insufficient."
    f.host.authorize = async () => { throw Error("must not authorize") }
    expect(await captureFinal("child", "a1", f.host)).toEqual({ status: "skipped", reason: "capture_not_requested" })
    expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
  }
})
test("standalone markers tolerate prefaces but never code, quotes or inline examples", async () => {
  for (const text of [`${STORE}\nDone`, `Done\n${STORE}`, `\nDone\n\n${STORE}\n\n`, `Intro\n${STORE}\nMore`]) expect(captureRequested(text)).toBe(true)
  for (const text of [`Done ${STORE}`, `> ${STORE}`, `    ${STORE}`,
    `\`\`\`html\n${STORE}`, `~~~html\n${STORE}`, `\`\`\`\n${STORE}\n\`\`\``, `> Quote\n> ${STORE}`,
    `<pre>\n${STORE}\n</pre>`, `<code class="example">\n${STORE}\n</code>`]) expect(captureRequested(text)).toBe(false)
  const f = fixture(), text = `A permitted answer\n${STORE}`
  f.final.parts![0]!.text = text
  const result = await captureFinal("child", "a1", f.host)
  const stored = f.scope.getById(result.id!)
  expect(stored.status === "found" && stored.record.content).toBe(text)
  const g = fixture(); g.final.parts![0]!.text = `Do not retain\n${NO_STORE}\n${STORE}`
  expect((await captureFinal("child", "a1", g.host)).reason).toBe("publication_restricted")
})
test("current native outputs are versioned without file URI; unknown or denied sources remain explicit gaps", async () => {
  const f = fixture(), file = join(f.dir, "output.md"), secret = join(f.dir, "private.md")
  writeFileSync(file, "final output bytes"); writeFileSync(secret, "not authorized")
  f.host.edits = () => ({ revision: 2, paths: [file, secret], unknownPath: true })
  f.host.authorize = async () => ({ directory: f.dir, ask: async ({ patterns }) => { if (patterns.includes(secret)) throw Error("denied") } })
  const result = await captureFinal("child", "a1", f.host)
  const found = f.scope.getById(result.id!); if (found.status !== "found") throw Error("missing")
  expect(found.record.origin!.file_bindings).toEqual([{ path: file, ref: found.record.source_refs![0], native_edit: true }])
  expect(found.record.origin!.source_errors).toHaveLength(2)
  expect(inspectArtifacts(f.scope, f.child.streamId, found.record.source_refs)[0]!.status).toBe("verified")
  writeFileSync(file, "later change")
  expect(await captureFinal("child", "a1", f.host)).toEqual({ status: "replay", id: result.id })
  const uri = new URL(found.record.source_refs![0]!); uri.hash = ""
  expect(readFileSync(uri, "utf8")).toBe("final output bytes")
})
test("old native edit completions cannot contaminate a new input; source races fail closed", async () => {
  const observer = new ReceiptCheck()
  observer.begin("s", "u1"); const old = observer.capture("s")
  observer.begin("s", "u2"); observer.changed("s", ["/old.md"], old)
  expect(observer.edits("s", "u1")).toBeUndefined()
  expect(observer.edits("s", "u2")!.paths).toEqual([])
  observer.changed("s", ["/new.md"], observer.capture("s"))
  expect(observer.edits("s", "u2")!.paths).toEqual(["/new.md"])
  const f = fixture(), file = join(f.dir, "output.md"); writeFileSync(file, "bytes")
  let revision = 1
  f.host.edits = () => ({ revision, paths: [file], unknownPath: false })
  f.host.authorize = async () => ({ directory: f.dir, ask: async () => { revision++ } })
  expect((await captureFinal("child", "a1", f.host)).reason).toBe("edits_changed_during_capture")
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
})
test("handoffs preserve exact author references and replace only identical native artifact copies", async () => {
  const f = fixture(), file = join(f.dir, "output.md"), body = "# Original artifact\n" + "Exact material and constraints.\n".repeat(40)
  writeFileSync(file, body)
  f.host.edits = () => ({ revision: 1, paths: [file], unknownPath: false })
  const result = await captureFinal("child", "a1", f.host)
  const prompt = `Review ${file}\n---\n${body}\n---\nDo not modify the file; verify constraints.`
  const routed = sourceHandoff(f.scope, "parent", prompt, [result.id!])
  expect(routed.references).toEqual([result.id!])
  expect(routed.prompt).not.toContain(body.trimEnd())
  expect(routed.prompt).toContain("Do not modify the file; verify constraints.")
  expect(routed.removedBytes).toBeGreaterThan(0)
  expect(sourceHandoff(f.scope, "parent", routed.prompt, [result.id!]).prompt).toBe(routed.prompt)
  expect(sourceHandoff(f.scope, "parent", "An unrelated task", [result.id!]).references).toEqual([])
  expect(sourceHandoff(f.scope, "unknown", prompt, [result.id!]).references).toEqual([])
  const changed = body.replace("Original", "Different")
  expect(sourceHandoff(f.scope, "parent", `${file}\n${changed}`, [result.id!]).prompt).toContain(changed)
  const found = f.scope.getById(result.id!); if (found.status !== "found") throw Error("missing")
  const uri = new URL(found.record.source_refs![0]!); uri.hash = ""
  writeFileSync(uri, "corrupt")
  expect(sourceHandoff(f.scope, "parent", prompt, [result.id!]).references).toEqual([])
})
test("only explicitly observed current-input decisions are routed without paraphrase", () => {
  const f = fixture(), parent = f.scope.registerSession("parent", "orchestrator")
  const put = (streamId: string, session: string, kind: "decision" | "note") => {
    const r = f.scope.put(streamId, { writer: { agent: "orchestrator", session_id: session, message_id: "stage" },
      createdRound: 1, description: "stage", content: "Original independent decision with limits.", kind })
    if (r.status !== "stored") throw Error("fixture")
    return r.id
  }
  const decision = put(parent.streamId, "parent", "decision"), note = put(parent.streamId, "parent", "note")
  const other = put(f.child.streamId, "child", "decision")
  const hidden = f.scope.registerSession("hidden", "councillor")
  const secret = put(hidden.streamId, "hidden", "decision")
  const prompt = "Implement the selected option; do not add assumptions."
  expect(sourceHandoff(f.scope, "parent", prompt, [decision]).references).toEqual([])
  const routed = sourceHandoff(f.scope, "parent", prompt, [], [decision, note, other, secret])
  expect(routed.references).toEqual([decision])
  expect(routed.prompt).toContain(prompt)
  expect(routed.prompt).not.toContain("Original independent decision with limits.")
  expect(routed.prompt).not.toContain(secret)
  expect(sourceHandoff(f.scope, "parent", routed.prompt, [], [decision]).prompt).toBe(routed.prompt)
})
test("board permission uses last matching rule, ask is not implicit authorization", () => {
  expect(permissionAction([], "board_put")).toBe("ask")
  const rules = [{ permission: "*", pattern: "*", action: "allow" as const }, { permission: "board_*", pattern: "*", action: "deny" as const }]
  expect(permissionAction(rules, "board_put")).toBe("deny")
  expect(permissionAction([...rules, { permission: "board_put", pattern: "*", action: "allow" }], "board_put")).toBe("allow")
  expect(permissionAction([{ permission: "read", pattern: "/tmp/*.md", action: "allow" }], "read", "/tmp/a/b.md")).toBe("allow")
})
test("source routing selects immutable newest author version despite an old replay and adds feedback only for that author", async () => {
  const f = fixture(), file = join(f.dir, "output.md")
  writeFileSync(file, "old authored version")
  f.host.edits = () => ({ revision: 1, paths: [file], unknownPath: false })
  const old = await captureFinal("child", "a1", f.host)
  const review = f.scope.registerSession("reviewer", "oracle")
  f.messages.set("ru1", { info: { id: "ru1", sessionID: "reviewer", role: "user" }, parts: [] })
  f.messages.set("r1", { info: { id: "r1", sessionID: "reviewer", role: "assistant", agent: "oracle", parentID: "ru1", finish: "stop", time: { completed: 2 } }, parts: [{ type: "text", text: `${STORE}\nFinding against file://${file}` }] })
  const reviewed = await captureFinal("reviewer", "r1", { ...f.host, edits: undefined, current: () => true,
    resolve: async () => ({ scope: f.scope, streamId: review.streamId, agent: "oracle" }) })
  writeFileSync(file, "new authored version")
  f.messages.set("a2", { ...f.final, info: { ...f.final.info, id: "a2" } })
  const latest = await captureFinal("child", "a2", f.host)
  const recent = [latest.id!, reviewed.id!, old.id!]
  const initial = sourceHandoff(f.scope, "parent", file, recent)
  expect(initial.references).toEqual([latest.id!])
  const correcting = sourceHandoff(f.scope, "parent", file, recent, [], "child")
  expect(correcting.references).toEqual([latest.id!, reviewed.id!])
  expect(correcting.prompt).toContain("<bcp_author_feedback>")
  expect(sourceHandoff(f.scope, "parent", correcting.prompt, recent, [], "child").prompt).toBe(correcting.prompt)
  expect(sourceHandoff(f.scope, "parent", file, recent, [], "new-independent-reviewer").references).toEqual([latest.id!])
})
test("delivery bridge attaches host-created reference without rewriting author text; stale execution cannot capture", async () => {
  const f = fixture(), text = f.final.parts![0]!.text
  const host = { scopeFor: async () => f.scope, parentFor: async () => "parent", message: f.host.message,
    capture: (session: string, message: string) => captureFinal(session, message, f.host) }
  const request = { callerSessionID: "parent", taskID: "child", state: "completed", inputMessageID: "u1", terminalMessageID: "a1", generation: 2 }
  const result: any = await inspectDelivery(request, host)
  expect(result.capture.status).toBe("stored")
  expect(result.candidates[0].id).toBe(result.capture.id)
  expect(result.candidates[0].origin).toBe("current_input")
  expect(result.coverage).toBe("not_evaluated")
  expect(f.final.parts![0]!.text).toBe(text)
  expect((await inspectDelivery({ ...request, state: "cancelled" }, host)).association).toBe("unconfirmed")
})
test("real adapter gate honors agent/session/input authorization and captures without tool calls", async () => {
  for (const mode of ["allow", "agent-deny", "session-deny", "input-deny"] as const) {
    const f = fixture()
    if (mode === "input-deny") f.input.info.tools = { board_put: false }
    const client = { app: { agents: async () => ({ data: [{ name: "fixer", permission: [
      { permission: "*", pattern: "*", action: "allow" },
      ...(mode === "agent-deny" ? [{ permission: "board_*", pattern: "*", action: "deny" }] : []),
    ] }] }) }, session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: path.id === "child" ? "parent" : null, agent: path.id === "child" ? "fixer" : "orchestrator",
        permission: mode === "session-deny" ? [{ permission: "board_put", pattern: "*", action: "deny" }] : [] } }),
      message: async ({ path }: { path: { messageID: string } }) => ({ data: f.messages.get(path.messageID) }),
    } }
    const plugin = await BlackboardPlugin({ directory: f.dir, client } as unknown as PluginInput, { dataDir: f.dir })
    await plugin["chat.message"]!({ sessionID: "child", agent: "fixer", messageID: "u1" }, { message: f.input.info as never, parts: f.input.parts as never })
    const system = { system: ["original system"] }
    await plugin["experimental.chat.system.transform"]!({ sessionID: "child" } as never, system)
    await plugin["experimental.chat.system.transform"]!({ sessionID: "child" } as never, system)
    expect(system.system).toEqual(["original system", AUTO_CAPTURE_INSTRUCTION])
    await plugin.event!({ event: { type: "message.updated", properties: { info: f.final.info } } as never })
    expect(f.scope.readMeta(f.child.streamId).high_water).toBe(mode === "allow" ? 1 : 0)
    const text = readFileSync(join(f.dir, "log/blackboard.log"), "utf8")
    expect(text).toContain('"ev":"final_capture"')
    expect(text).toContain(mode === "allow" ? '"status":"stored"' : '"status":"skipped"')
  }
})
test("capture system convention is absent for unadmitted input and manual mode", async () => {
  for (const autoCapture of [false, true]) {
    const f = fixture()
    const plugin = await BlackboardPlugin({ directory: f.dir, client: {} } as unknown as PluginInput, { dataDir: f.dir, autoCapture })
    const system = { system: ["unchanged"] }
    await plugin["experimental.chat.system.transform"]!({ sessionID: "unadmitted" } as never, system)
    expect(system.system).toEqual(["unchanged"])
  }
})
test("adapter native edit hooks bind an output even when the author uses only its filename", async () => {
  const f = fixture(), file = join(f.dir, "output.md")
  const client = { app: { agents: async () => ({ data: [{ name: "fixer", permission: [{ permission: "*", pattern: "*", action: "allow" }] }] }) }, session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: path.id === "child" ? "parent" : null, agent: path.id === "child" ? "fixer" : "orchestrator" } }),
    message: async ({ path }: { path: { messageID: string } }) => ({ data: f.messages.get(path.messageID) }),
  } }
  const plugin = await BlackboardPlugin({ directory: f.dir, client } as unknown as PluginInput, { dataDir: f.dir })
  await plugin["chat.message"]!({ sessionID: "child", agent: "fixer", messageID: "u1" }, { message: f.input.info as never, parts: f.input.parts as never })
  await plugin["tool.execute.before"]!({ tool: "write", sessionID: "child", callID: "call1" }, { args: { filePath: file } })
  writeFileSync(file, "created by native writer")
  await plugin["tool.execute.after"]!({ tool: "write", sessionID: "child", callID: "call1", args: { filePath: file } }, { title: "write", output: "ok", metadata: {} })
  f.final.info.time!.completed = Date.now()
  await plugin.event!({ event: { type: "message.updated", properties: { info: f.final.info } } as never })
  const entries = f.scope.readMeta(f.child.streamId).idem
  const id = entries["bcp:final:child:a1"]!.id
  const found = f.scope.getById(id); if (found.status !== "found") throw Error("missing capture")
  expect(found.record.origin!.file_bindings).toEqual([{ path: file, ref: found.record.source_refs![0], native_edit: true }])
})
test("quota failure is explicit and hidden captures cannot leak their auto-created reference", async () => {
  const f = fixture()
  f.scope.updateConfig(cfg => ({ ...cfg, quota_bytes: 1 }))
  expect((await captureFinal("child", "a1", f.host)).reason).toBe("quota_exceeded")
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
  const g = fixture(), hidden = g.scope.registerSession("hidden", "councillor")
  const put = g.scope.put(hidden.streamId, { writer: { agent: "councillor", session_id: "hidden", message_id: "x" }, createdRound: 1, description: "hidden", content: "private" })
  if (put.status !== "stored") throw Error("fixture")
  const result: any = await inspectDelivery({ callerSessionID: "parent", taskID: "child", state: "completed", inputMessageID: "u1", terminalMessageID: "a1" },
    { scopeFor: async () => g.scope, parentFor: async () => "parent", message: g.host.message, capture: async () => ({ status: "stored", id: put.id }) })
  expect(result.capture).toEqual({ status: "unconfirmed", reason: "capture_not_accessible" })
  expect(result.candidates).toEqual([])
})
