import { test, expect } from "bun:test"
import { saveInput, boundedArchiveFetch, FileArchiveV2Plugin } from "../src/adapters/v2/file-archive"
import { readOperatorPolicy } from "../src/adapters/v2/handoff-source"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"
test("strict snapshot arguments reject literal text and previous variants", () => {
  expect(saveInput.safeParse({ sessionId: "child" }).success).toBe(true)
  expect(saveInput.safeParse({ sessionId: "child", messageId: "m" }).success).toBe(true)
  for (const value of [
    { kind: "session", sessionId: "child", text: "x" },
    { kind: "content", text: "x", taskId: "t" }, { text: "x" },
    { kind: "session", sessionId: "child" }, { sessionId: "child", text: "x" },
    { sessionId: "child", messageId: "" }, { sessionId: "" },
    { kind: "session", sessionId: "child", baseUrl: "http://evil" },
  ]) expect(saveInput.safeParse(value).success).toBe(false)
})
test("production transport refuses cross-origin before any network request", async () => {
  const transport = boundedArchiveFetch("http://127.0.0.1:1", new AbortController().signal)
  await expect(transport("http://example.invalid")).rejects.toThrow("denied")
})
test("one static tool registered without policy, executes fail closed", async () => {
  const tools: any[] = []
  await FileArchiveV2Plugin.setup!({
    options: {}, tool: { transform: async (fn: any) => fn({ add: (t: any) => tools.push(t) }) },
  } as any)
  expect(tools.map(t => t.name)).toEqual(["bcp_save"])
  const result = await tools[0].execute({ sessionId: "self" }, {})
  expect(JSON.parse(result.content)).toEqual({ status: "denied", reason: "trusted_configuration_required" })
})
test("JSON operator source exact binding, explicit evidence, expiry and live revocation", () => {
  const dir = mkdtempSync(join(homedir(), ".policy-test-"))
  const path = join(dir, "policy.json")
  const expected = { taskId: "task", taskRoot: "/project/.opencode/work/task",
    callerSessionId: "parent", agent: "orchestrator", sourceSessionId: "child" }
  const grant = { ...expected, authorized: true, noStore: false, sharedReadersApproved: true,
    expiresAt: Date.now() + 60_000 }
  const write = (value: object) => writeFileSync(path,
    JSON.stringify({ schema: "bcp.operator-handoff-policy.v1", grants: [value] }), { mode: 0o600 })
  try {
    expect(readOperatorPolicy(path, expected)).toBe(false)
    write(grant)
    expect(readOperatorPolicy(path, expected)).toBe(true)
    expect(readOperatorPolicy(path, { ...expected, sourceSessionId: "other" })).toBe(false)
    for (const patch of [{ authorized: false }, { noStore: true },
      { sharedReadersApproved: false }, { expiresAt: 0 }]) {
      write({ ...grant, ...patch })
      expect(readOperatorPolicy(path, expected)).toBe(false)
    }
    write(grant)
    chmodSync(path, 0o644)
    expect(readOperatorPolicy(path, expected)).toBe(false)
    chmodSync(path, 0o600)
    writeFileSync(path, " ".repeat(64 * 1024 + 1))
    expect(readOperatorPolicy(path, expected)).toBe(false)
    const fifo = join(dir, "fifo")
    expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0)
    expect(readOperatorPolicy(fifo, expected)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test("production snapshot execution uses exact edit resources, live policy and lock rechecks", async () => {
  const workspace = mkdtempSync(join(homedir(), ".adapter-test-"))
  const project = join(workspace, "project")
  const taskRoot = join(project, ".opencode/work/task")
  mkdirSync(taskRoot, { recursive: true })
  const policyFile = join(workspace, "policy.json")
  writeFileSync(policyFile, JSON.stringify({ schema: "bcp.operator-handoff-policy.v1", grants: [{
    taskId: "task", taskRoot, callerSessionId: "parent", agent: "build", sourceSessionId: "parent",
    authorized: true, noStore: false, sharedReadersApproved: true, expiresAt: Date.now() + 60_000,
  }] }), { mode: 0o600 })
  const local = { id: "parent", projectID: "project", location: { directory: project }, permissions: [] }
  const oldFetch = globalThis.fetch
  const calls: any[] = []
  let deny = false
  let configured = false
  let revokeOnEdit = false
   let sessionMode = true
   let mutate = false
   let active = true
   let exactId = "pinned"
   let exactMode = "valid"
   let latestMode = "valid"
  let gets = 0
  let lists = 0
  const message = { id: "pinned", type: "assistant", agent: "worker", time: { created: 1, completed: 2 },
    finish: "stop", content: [{ type: "text", text: "original" }] }
  const denied = Error("native denial")
  globalThis.fetch = (async (request: Request) => {
    const path = new URL(request.url).pathname
    if (sessionMode) {
      if (path.endsWith("/message/pinned")) {
        gets++
        if (exactMode === "missing") return Response.json({ error: "missing" }, { status: 404 })
        if (exactMode === "pending") return Response.json({ data: { ...message, time: { created: 1 } } })
        if (exactMode === "failed") return Response.json({ data: { ...message, finish: "length" } })
        return Response.json({ data: !mutate || gets === 1 ? { ...message, id: exactId } :
          { ...message, content: [{ type: "text", text: "mutated before publish" }] } })
      }
      if (path.endsWith("/message")) {
        lists++
        expect(new URL(request.url).searchParams.get("limit")).toBe("1")
        return Response.json({ data: latestMode === "missing" ? [] :
          [{ ...message, ...(latestMode === "pending" ? { time: { created: 1 } } : {}) }], cursor: {} })
      }
      if (path.endsWith("/active")) return Response.json({ data: active ? { parent: {} } : {} })
      if (path.endsWith("/child")) return Response.json({ data: { ...local, id: "child", parentID: "parent" } })
    }
    return Response.json(path.includes("session") ? { data: local } : { pid: 123 })
  }) as typeof fetch
  try {
    let tool: any
    const options = { enabled: true, policyFile, connection: { baseUrl: "http://127.0.0.1:1", serverPid: 123 },
      taskScopes: [{ taskId: "task", taskRoot, callerSessionId: "parent", projectId: "project",
        directory: project, allowArchive: true, sharedReadersApproved: true }] }
    await FileArchiveV2Plugin.setup!({
      options: { loadOperatorOptions: async () => configured ? structuredClone(options) : {} },
      location: { directory: project },
      session: { get: async () => local }, agent: { list: async () => [{ id: "build", permissions: [] }] },
      permission: { assert: async (input: any) => {
        calls.push(input)
         if (deny && input.action === "edit") throw denied
         if (revokeOnEdit && input.action === "edit") configured = false
      } },
      tool: { transform: async (fn: any) => fn({ add: (value: any) => { tool = value } }) },
    } as any)
     const ctx = { sessionID: "parent", messageID: "m", id: "call", agent: "build", signal: new AbortController().signal }
     const exact = { sessionId: "parent", messageId: "pinned" }
     expect(JSON.parse((await tool.execute(exact, ctx)).content).reason).toBe("trusted_configuration_required")
     configured = true
     revokeOnEdit = true
     expect(JSON.parse((await tool.execute(exact, ctx)).content).status).toBe("denied")
     expect(calls.some(call => call.action === "edit")).toBe(true)
     expect(readdirSync(taskRoot, { recursive: true }).map(String)
       .some(path => path.endsWith("meta.json"))).toBe(false)
     calls.length = 0
     configured = true
     revokeOnEdit = false
     const result = JSON.parse((await tool.execute({ sessionId: "parent", messageId: "pinned" }, ctx)).content)
     expect(result.status).toBe("saved")
     expect(lists).toBe(0)
    const edits = calls.filter(c => c.action === "edit")
    expect(edits.length).toBe(1)
    expect(edits[0].resources.every((r: string) => r.startsWith(".opencode/work/task/") && !r.includes("*"))).toBe(true)
    expect(calls.filter(c => c.action === "read").length).toBe(1)
    expect(JSON.parse((await tool.execute({ sessionId: "parent" }, ctx)).content).status).toBe("pending")
    expect(lists).toBe(0)
    exactId = "wrong"
    expect(JSON.parse((await tool.execute({ sessionId: "parent", messageId: "pinned" }, ctx)).content).status).toBe("source_changed")
    expect(lists).toBe(0)
    exactId = "pinned"
    for (const [mode, status] of [["missing", "denied"], ["pending", "pending"], ["failed", "partial"]]) {
      exactMode = mode!
      expect(JSON.parse((await tool.execute({ sessionId: "parent", messageId: "pinned" }, ctx)).content).status).toBe(status)
      expect(lists).toBe(0)
    }
    exactMode = "valid"
    active = false
    for (const [mode, status] of [["missing", "no_text"], ["pending", "pending"]]) {
      latestMode = mode!
      expect(JSON.parse((await tool.execute({ sessionId: "parent" }, ctx)).content).status).toBe(status)
    }
    latestMode = "valid"
    lists = 0
    expect(JSON.parse((await tool.execute({ sessionId: "foreign", messageId: "pinned" }, ctx)).content).status).toBe("denied")
    deny = true
    await expect(tool.execute({ sessionId: "parent", messageId: "pinned" }, { ...ctx, id: "denied-call" })).rejects.toBe(denied)
    writeFileSync(policyFile, JSON.stringify({ schema: "bcp.operator-handoff-policy.v1", grants: [] }))
    expect(JSON.parse((await tool.execute({ sessionId: "parent" }, ctx)).content).status).toBe("denied")
    // Exact pin is read at BOTH lock checks. Mutation after the first GET must
    // prevent publication, rather than caching that first successful check.
    deny = false
    sessionMode = true
    mutate = true
    active = false
    gets = 0
    writeFileSync(policyFile, JSON.stringify({ schema: "bcp.operator-handoff-policy.v1", grants: [{
      taskId: "task", taskRoot, callerSessionId: "parent", agent: "build", sourceSessionId: "child",
      authorized: true, noStore: false, sharedReadersApproved: true, expiresAt: Date.now() + 60_000,
    }] }))
    const snapshot = JSON.parse((await tool.execute({ sessionId: "child" }, ctx)).content)
    expect(snapshot.status).toBe("source_changed")
    expect(gets).toBe(2)
    expect(lists).toBe(1)
    const files = readdirSync(join(taskRoot, "archive"), { recursive: true }).map(String)
    const childDirectory = `id-${Buffer.from("child").toString("hex")}`
    expect(files.some(path => path.startsWith(`${childDirectory}/`) && path.endsWith("meta.json"))).toBe(false)
  } finally {
    globalThis.fetch = oldFetch
    rmSync(workspace, { recursive: true, force: true })
  }
})
test("explicit caller scopes share a task root without inheriting source authority", async () => {
  const workspace = mkdtempSync(join(homedir(), ".adapter-shared-task-test-"))
  const project = join(workspace, "project")
  const taskRoot = join(project, ".opencode/work/task")
  mkdirSync(taskRoot, { recursive: true })
  const policyFile = join(workspace, "policy.json")
  const sessions = Object.fromEntries([
    ["parent", undefined], ["child", "parent"], ["sibling", "parent"], ["grandchild", "child"],
  ].map(([id, parentID]) => [id, {
    id, ...(parentID ? { parentID } : {}), projectID: "project",
    location: { directory: project }, permissions: [],
  }]))
  const scope = (callerSessionId: string) => ({
    taskId: "task", taskRoot, callerSessionId, projectId: "project",
    directory: project, allowArchive: true, sharedReadersApproved: true,
  })
  const options = {
    enabled: true, policyFile, connection: { baseUrl: "http://127.0.0.1:1", serverPid: 123 },
    taskScopes: [scope("parent")],
  }
  const grants: object[] = []
  const grant = (callerSessionId: string, sourceSessionId: string) => {
    grants.push({
      taskId: "task", taskRoot, callerSessionId, sourceSessionId, agent: "build",
      authorized: true, noStore: false, sharedReadersApproved: true, expiresAt: Date.now() + 60_000,
    })
    writeFileSync(policyFile, JSON.stringify({ schema: "bcp.operator-handoff-policy.v1", grants }),
      { mode: 0o600 })
  }
  const oldFetch = globalThis.fetch
  const sourceReads: string[] = []
  globalThis.fetch = (async (request: Request) => {
    const path = new URL(request.url).pathname
    const message = path.match(/\/session\/([^/]+)\/message\/pinned$/)
    if (message) {
      const id = decodeURIComponent(message[1]!)
      sourceReads.push(id)
      return Response.json({ data: {
        id: "pinned", type: "assistant", agent: "build", time: { created: 1, completed: 2 },
        finish: "stop", content: [{ type: "text", text: `reply from ${id}` }],
      } })
    }
    const session = path.match(/\/session\/([^/]+)$/)
    if (session) return Response.json({ data: sessions[decodeURIComponent(session[1]!)] })
    return Response.json({ pid: 123 })
  }) as typeof fetch
  try {
    let tool: any
    await FileArchiveV2Plugin.setup!({
      options: { loadOperatorOptions: async () => structuredClone(options) },
      location: { directory: project },
      session: { get: async ({ sessionID }: any) => sessions[sessionID] },
      agent: { list: async () => [{ id: "build", permissions: [] }] },
      permission: { assert: async () => {} },
      tool: { transform: async (fn: any) => fn({ add: (value: any) => { tool = value } }) },
    } as any)
    const save = async (caller: string, source: string) => JSON.parse((await tool.execute({
      sessionId: source, messageId: "pinned",
    }, {
      sessionID: caller, messageID: "m", id: `${caller}-${source}`, agent: "build",
      signal: new AbortController().signal,
    })).content)

    grant("parent", "child")
    const childSnapshot = await save("parent", "child")
    expect(childSnapshot.status).toBe("saved")

    // Neither a parent's grant nor an explicit scope alone grants child self-save.
    expect((await save("child", "child")).status).toBe("denied")
    options.taskScopes.push(scope("child"), scope("sibling"))
    expect((await save("child", "child")).status).toBe("denied")
    grant("child", "child")
    const childSelf = await save("child", "child")
    expect(childSelf.status).toBe("already_saved")
    expect(childSelf.body).toBe(childSnapshot.body)

    // A second source uses its own folder in the same stable task archive.
    grant("parent", "parent")
    const parentSnapshot = await save("parent", "parent")
    expect(parentSnapshot.status).toBe("saved")
    for (const [result, source] of [[childSnapshot, "child"], [parentSnapshot, "parent"]] as const) {
      expect(result.body.startsWith(`.opencode/work/task/archive/id-${Buffer.from(source).toString("hex")}/`)).toBe(true)
      expect(readFileSync(join(project, result.body), "utf8")).toContain(`reply from ${source}`)
    }
    expect(parentSnapshot.body).not.toBe(childSnapshot.body)

    // Even independent policy grants cannot bypass the direct-child relationship.
    grant("sibling", "child")
    grant("parent", "grandchild")
    const readsBefore = sourceReads.length
    expect((await save("sibling", "child")).status).toBe("denied")
    expect((await save("parent", "grandchild")).status).toBe("denied")
    expect(sourceReads.length).toBe(readsBefore)
  } finally {
    globalThis.fetch = oldFetch
    rmSync(workspace, { recursive: true, force: true })
  }
})
