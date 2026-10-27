// Rounds 9-12：acp_run 工具结果默认留存、回执、同轮去重、标题与授权路径。
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { openScopeForRoot, type Scope } from "../src/storage"
import {
  captureToolResult, formatToolResultReceipt, parseTaskTitle, toolResultKey, toolResultTitle,
  NO_STORE, STORE, type CaptureHost, type ToolResultSource,
} from "../src/capture"
import { stripTopLevelStoreMarkers } from "../src/markers"
import { DELIVERY_BRIDGE, type DeliveryRequest, type HostMessage } from "../src/delivery"
import { BlackboardPlugin } from "../src/plugin"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
function recordOf(scope: Scope, id: string) {
  const found = scope.getById(id)
  if (found.status !== "found") throw Error(`record missing: ${id}`)
  return found.record
}

// ---------- 单元层：captureToolResult + 标题/回执/展示副本 ----------

function fixture(raw = "Answer: 42\nLimits: small sample.") {
  const dir = mkdtempSync(join(tmpdir(), "bcp-acp-")); dirs.push(dir)
  const scope = openScopeForRoot({ rootSessionId: "parent", dataDir: dir })
  scope.registerSession("parent", "orchestrator")
  const child = scope.registerSession("child", "fixer")
  const input: HostMessage = { info: { id: "u1", sessionID: "child", role: "user" }, parts: [{ type: "text", text: "Task: Fix the parser\nPlease proceed." }] }
  const messages = new Map([["u1", input]])
  const host: CaptureHost = {
    resolve: async () => ({ scope, streamId: child.streamId, agent: "fixer" }),
    message: async (_session, id) => messages.get(id) ?? null,
    current: () => true,
    authorize: async () => ({ directory: dir, ask: async () => {} }),
  }
  const source = (over: Partial<ToolResultSource> = {}): ToolResultSource => ({
    session: "child", callID: "call_1", raw, externalAgent: "glm-4.6",
    writerMessageID: "a1", inputMessageID: "u1", input, ...over,
  })
  return { dir, scope, child, input, messages, host, source }
}

test("round10: no-marker result is retained by default with exact hash and full raw including markers", async () => {
  const f = fixture()
  const result = await captureToolResult(f.source(), f.host)
  expect(result.status).toBe("stored")
  const record = recordOf(f.scope, result.id!)
  expect(record.content).toBe("Answer: 42\nLimits: small sample.")
  expect(record.origin).toEqual({
    kind: "host_tool_result", input_message_id: "u1", text_sha256: sha256(record.content),
    tool: "acp_run", call_id: "call_1", external_agent: "glm-4.6",
  })
  // writer = wrapper 会话宿主确认身份 + 真实助理消息 ID；绝不写 orchestrator/callID。
  expect(record.writer).toEqual({ agent: "fixer", session_id: "child", message_id: "a1" })
  const marked = `${STORE}\nAnswer: kept.`
  const second = await captureToolResult(f.source({ callID: "call_2", raw: marked }), f.host)
  expect(second.status).toBe("stored")
  expect(recordOf(f.scope, second.id!).content).toBe(marked) // 记录保留完整原文（含标记行）
})

test("round10: same callID is idempotent — same raw replays, different raw conflicts", async () => {
  const f = fixture()
  const first = await captureToolResult(f.source(), f.host)
  const replay = await captureToolResult(f.source(), f.host)
  expect(replay).toEqual({ status: "replay", id: first.id })
  const conflict = await captureToolResult(f.source({ raw: "Answer: 43" }), f.host)
  expect(conflict).toEqual({ status: "unconfirmed", reason: "capture_conflict" })
  expect(f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", "call_1")]?.id).toBe(first.id!)
})

test("round10: NO_STORE in result or input skips; permission denial skips; empty/oversize fail explicitly", async () => {
  const f = fixture()
  expect(await captureToolResult(f.source({ raw: `Answer\n${NO_STORE}` }), f.host)).toEqual({ status: "skipped", reason: "publication_restricted" })
  expect(await captureToolResult(f.source({ input: { ...f.input, parts: [{ type: "text", text: NO_STORE }] } }), f.host))
    .toEqual({ status: "skipped", reason: "publication_restricted" })
  const denied = { ...f.host, authorize: async () => null }
  expect(await captureToolResult(f.source(), denied)).toEqual({ status: "skipped", reason: "publication_not_authorized" })
  expect(await captureToolResult(f.source({ raw: "   " }), f.host)).toEqual({ status: "unconfirmed", reason: "empty_result" })
  expect(await captureToolResult(f.source({ raw: "x".repeat(262145) }), f.host)).toEqual({ status: "unconfirmed", reason: "content_too_large" })
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
})

test("round10: fail-closed when the associated input cannot be confirmed or the author is unavailable", async () => {
  const f = fixture()
  expect(await captureToolResult(f.source({ input: { ...f.input, info: { ...f.input.info, role: "assistant" } } }), f.host))
    .toEqual({ status: "unconfirmed", reason: "input_unavailable" })
  // 宿主确认的输入与会话不符 → 失败关闭（调用方据实读取，不接受拼接输入）。
  expect(await captureToolResult(f.source({ input: { info: { id: "u1", sessionID: "other-session", role: "user" }, parts: [] } }), f.host))
    .toEqual({ status: "unconfirmed", reason: "input_unavailable" })
  const unresolved = { ...f.host, resolve: async () => null }
  expect(await captureToolResult(f.source(), unresolved)).toEqual({ status: "unconfirmed", reason: "author_unavailable" })
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
})

test("round12: Task titles — template, fallbacks and truncation", () => {
  expect(toolResultTitle("glm-4.6", "Fix the parser")).toBe("ACP result: glm-4.6 | Fix the parser")
  expect(toolResultTitle("glm-4.6")).toBe("ACP result: glm-4.6")
  expect(toolResultTitle("", "task")).toBe("ACP result: unknown | task")
  const long = toolResultTitle("glm-4.6", "a".repeat(160))
  expect([...long].length).toBe(80) // 80 码点截断，无残缺代理对
  expect(toolResultTitle("glm-4.6", "tab\ttitle")).not.toContain("\t") // 控制字符归一
  const user = (text: string): HostMessage => ({ info: { id: "u1", sessionID: "s", role: "user" }, parts: [{ type: "text", text }] })
  expect(parseTaskTitle(user("Task: Fix the parser\nTask: other\nrest"))).toBe("Fix the parser")
  expect(parseTaskTitle(user("Task:  "))).toBeUndefined()
  expect(parseTaskTitle(user("Task: héllo"))).toBeUndefined()
  expect(parseTaskTitle(user(`Task: ${"a".repeat(161)}`))).toBeUndefined()
  expect(parseTaskTitle(user('He said "Task: not a title"'))).toBeUndefined()
  expect(parseTaskTitle(user("Question: not parsed\nTask: later"))).toBeUndefined()
})

test("round11: display copy strips only valid top-level markers; receipts use the fixed formats", () => {
  const raw = `${STORE}\nAnswer: 42\n\`\`\`\n${STORE}\n\`\`\`\nLimits: sample.`
  expect(stripTopLevelStoreMarkers(raw)).toBe("Answer: 42\n\`\`\`\n<!-- bcp:store -->\n\`\`\`\nLimits: sample.")
  const id = "bb://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/e000001"
  // Round 13：回执/状态行后固定追加指引行（stored/replay/skipped/failed 一致）。
  const GUIDE = "Preserve the retention line above in your reply."
  expect(formatToolResultReceipt(raw, { status: "stored", id })).toBe(`Answer: 42\n\`\`\`\n<!-- bcp:store -->\n\`\`\`\nLimits: sample.\n\nRetained: ${id}\n${GUIDE}`)
  expect(formatToolResultReceipt("plain", { status: "replay", id })).toBe(`plain\n\nRetained: ${id}\n${GUIDE}`)
  expect(formatToolResultReceipt(raw, { status: "skipped", reason: "publication_restricted" })).toBe(`Answer: 42\n\`\`\`\n<!-- bcp:store -->\n\`\`\`\nLimits: sample.\n\nRetention skipped: publication_restricted\n${GUIDE}`)
  expect(formatToolResultReceipt(raw, { status: "unconfirmed", reason: "source_message_unavailable" })).toBe(`Answer: 42\n\`\`\`\n<!-- bcp:store -->\n\`\`\`\nLimits: sample.\n\nRetention failed: source_message_unavailable\n${GUIDE}`)
  const html = `<pre>\n${STORE}\n</pre>\n${STORE}`
  expect(stripTopLevelStoreMarkers(html)).toBe(`<pre>\n<!-- bcp:store -->\n</pre>`)
})

// ---------- 适配器层：after 钩子、消息定位、同轮去重、授权路径 ----------

type ClientFixture = ReturnType<typeof adapterFixture>
function adapterFixture(denyBoardStore = false, childAgent = "fixer") {
  const dir = mkdtempSync(join(tmpdir(), "bcp-acp-ad-")); dirs.push(dir)
  const scope = openScopeForRoot({ rootSessionId: "parent", dataDir: dir })
  scope.registerSession("parent", "orchestrator") // 交付桥接以父会话为 caller，需已注册
  const child = scope.registerSession("child", childAgent)
  const input: HostMessage = { info: { id: "u1", sessionID: "child", role: "user" }, parts: [{ type: "text", text: "Task: Fix the parser\nPlease proceed." }] }
  const toolMessage: HostMessage = { info: { id: "a1", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer" },
    parts: [{ type: "tool", tool: "acp_run", callID: "call_1", state: { status: "running" } }] }
  const messages = new Map([["u1", input], ["a1", toolMessage]])
  const client = {
    app: { agents: async () => ({ data: [{ name: childAgent, permission: [
      { permission: "*", pattern: "*", action: "allow" },
      ...(denyBoardStore ? [{ permission: "board_store", pattern: "*", action: "deny" }] : []),
    ] }] }) },
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: path.id === "child" ? "parent" : null,
        agent: path.id === "child" ? childAgent : "orchestrator", permission: [] } }),
      message: async ({ path }: { path: { messageID: string } }) => ({ data: messages.get(path.messageID) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: [...messages.values()].filter(m => m.info.sessionID === path.id) }),
    },
  }
  return { dir, scope, child, childAgent, input, toolMessage, messages, client }
}

type Plugin = Awaited<ReturnType<typeof BlackboardPlugin>>
async function admittedPlugin(f: ClientFixture, options: Record<string, unknown> = {}) {
  const plugin = await BlackboardPlugin({ directory: f.dir, client: f.client } as unknown as PluginInput, { dataDir: f.dir, ...options })
  await plugin["chat.message"]!({ sessionID: "child", agent: f.childAgent, messageID: "u1" }, { message: f.input.info as never, parts: f.input.parts as never })
  return plugin
}

const runAcp = (f: ClientFixture, plugin: Plugin, raw: string, callID = "call_1", agent = "glm-4.6", present = true) => {
  if (present) (f.toolMessage.parts![0] as { callID: string }).callID = callID
  const output = { title: "acp", output: raw, metadata: {} }
  return plugin["tool.execute.after"]!({ tool: "acp_run", sessionID: "child", callID, args: { agent } } as never, output as never).then(() => output.output as string)
}

const finalEvent = (plugin: Plugin, id: string, parentID: string) =>
  plugin.event!({ event: { type: "message.updated", properties: { info: { id, sessionID: "child", role: "assistant", parentID, agent: "fixer", finish: "stop", time: { completed: 2 } } } } as never })

const boardStore = (plugin: Plugin, messageId: string) => {
  const ctx = { sessionID: "child", agent: "fixer", messageID: messageId } as unknown as ToolContext
  const execute = plugin.tool!.board_store.execute as unknown as (args: unknown, ctx: unknown) => Promise<string>
  return execute({ action: "store", message_id: messageId, description: "wrapper paraphrase" }, ctx).then(r => JSON.parse(r) as Record<string, unknown>)
}

// 父 task 交付检查入口（审查 e000002 修复的验收面）：经 DELIVERY_BRIDGE 调真实适配器桥。
const delivery = (f: ClientFixture, terminal: string, input = "u1"): Promise<any> => {
  const map = (globalThis as Record<PropertyKey, unknown>)[DELIVERY_BRIDGE] as Map<string, (r: DeliveryRequest) => Promise<unknown>>
  return map.get(f.dir)!({ callerSessionID: "parent", taskID: "child", state: "completed",
    inputMessageID: input, terminalMessageID: terminal } as DeliveryRequest) as Promise<any>
}

test("round9/11 M1: default deployment retains through the existing permission path; explicit board_store deny still skips", async () => {
  for (const mode of ["allow", "deny"] as const) {
    const f = adapterFixture(mode === "deny")
    const plugin = await admittedPlugin(f)
    const output = await runAcp(f, plugin, "Answer: 42")
    if (mode === "allow") {
      expect(output).toMatch(/\n\nRetained: bb:\/\//)
      expect(f.scope.readMeta(f.child.streamId).high_water).toBe(1)
      const id = f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", "call_1")]!.id!
      expect(recordOf(f.scope, id).description).toBe("ACP result: glm-4.6 | Fix the parser")
      expect(recordOf(f.scope, id).writer).toEqual({ agent: "fixer", session_id: "child", message_id: "a1" })
    } else {
      expect(output).toBe("Answer: 42\n\nRetention skipped: publication_not_authorized\nPreserve the retention line above in your reply.")
      expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
    }
  }
})

test("round9: running tool part is accepted at after-time; window-miss and duplicate matches fail explicitly", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  const ok = await runAcp(f, plugin, "Answer: 42")
  expect(ok).toMatch(/Retained: bb:\/\//)
  // present:false 不回写部件 callID → 查询窗口内无该部件，有界重试后明确失败。
  const miss = await runAcp(f, plugin, "Answer: 42", "call_missing", "glm-4.6", false)
  expect(miss).toBe("Answer: 42\n\nRetention failed: source_message_unavailable\nPreserve the retention line above in your reply.")
  f.messages.set("a2", { info: { id: "a2", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer" },
    parts: [{ type: "tool", tool: "acp_run", callID: "call_dup" }] })
  f.messages.set("a3", { info: { id: "a3", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer" },
    parts: [{ type: "tool", tool: "acp_run", callID: "call_dup" }] })
  const dup = await runAcp(f, plugin, "Answer: 42", "call_dup", "glm-4.6", false) // 两条匹配 → 明确失败
  expect(dup).toBe("Answer: 42\n\nRetention failed: source_ambiguous\nPreserve the retention line above in your reply.")
  const meta = f.scope.readMeta(f.child.streamId)
  expect(meta.idem[toolResultKey("child", "call_missing")]).toBeUndefined()
  expect(meta.idem[toolResultKey("child", "call_dup")]).toBeUndefined()
})

test("round11: multiple calls in one session each get their own record and receipt", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  const first = await runAcp(f, plugin, "First result")
  const second = await runAcp(f, plugin, "Second result", "call_2")
  const r1 = /Retained: (bb:\/\/\S+)/.exec(first)![1]!
  const r2 = /Retained: (bb:\/\/\S+)/.exec(second)![1]!
  expect(r1).not.toBe(r2)
  expect(f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", "call_2")]?.id).toBe(r2)
})

test("round9 §1.4: same-input-round dedup for the event path, board_store and failed retention; next round recovers", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  const output = await runAcp(f, plugin, "Answer: 42")
  const recordId = /Retained: (bb:\/\/\S+)/.exec(output)![1]!
  // 事件路径不得捕获该轮 wrapper 终稿转述。
  f.messages.set("w1", { info: { id: "w1", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer", finish: "stop", time: { completed: 3 } },
    parts: [{ type: "text", text: `${STORE}\nAnswer: 42 (paraphrase)` }] })
  await finalEvent(plugin, "w1", "u1")
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(1) // 无第二条记录
  expect(readFileSync(join(f.dir, "log/blackboard.log"), "utf8")).toContain("acp_tool_result_round")
  // board_store 也不得重复入库该轮 wrapper 消息；引用原始终记录。
  const stored = await boardStore(plugin, "w1")
  expect(stored.status).toBe("skipped")
  expect(stored.reason).toBe("acp_tool_result_round")
  expect(stored.record_ids).toEqual([recordId])
  expect(stored.hint).toEqual(expect.any(String))
  // 下一用户输入轮恢复正常捕获。
  f.messages.set("u2", { info: { id: "u2", sessionID: "child", role: "user" }, parts: [{ type: "text", text: "Next question." }] })
  f.messages.set("w2", { info: { id: "w2", sessionID: "child", role: "assistant", parentID: "u2", agent: "fixer", finish: "stop", time: { completed: 4 } },
    parts: [{ type: "text", text: `${STORE}\nNext answer.` }] })
  await plugin["chat.message"]!({ sessionID: "child", agent: "fixer", messageID: "u2" },
    { message: { id: "u2", sessionID: "child", role: "user" } as never, parts: [{ type: "text", text: "Next question." }] as never })
  await finalEvent(plugin, "w2", "u2")
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(2)
})

test("round9 §1.4: a called-but-failed retention still blocks the round (wrapper marker cannot re-capture)", async () => {
  const f = adapterFixture(true)
  const plugin = await admittedPlugin(f)
  const output = await runAcp(f, plugin, "Answer: 42")
  expect(output).toBe("Answer: 42\n\nRetention skipped: publication_not_authorized\nPreserve the retention line above in your reply.")
  f.messages.set("w1", { info: { id: "w1", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer", finish: "stop", time: { completed: 3 } },
    parts: [{ type: "text", text: `${STORE}\nAnswer: 42 (self-added marker)` }] })
  await finalEvent(plugin, "w1", "u1")
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
  const stored = await boardStore(plugin, "w1")
  expect(stored.note).toContain("no original tool-result record was retained")
})

test("review e000002: delivery bridge cannot re-capture an acp round — a valid wrapper marker yields the original record reference, idempotently", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  const output = await runAcp(f, plugin, "Answer: 42")
  const recordId = /Retained: (bb:\/\/\S+)/.exec(output)![1]!
  f.messages.set("w1", { info: { id: "w1", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer", finish: "stop", time: { completed: 3 } },
    parts: [{ type: "text", text: `${STORE}\nAnswer: 42 (paraphrase)\nRetained: ${recordId}` }] })
  const result = await delivery(f, "w1")
  // 交付检查同轮跳过：不落第二条记录，返回原始终记录引用。
  expect(result.capture).toEqual({ status: "skipped", reason: "acp_tool_result_round", record_ids: [recordId] })
  expect(result.result_reference).toBeUndefined() // 绝不把工具结果冒充为精确覆盖 wrapper 终稿的 host_final 引用
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(1)
  // 原始终记录对该父会话可读且关联到当前输入轮。
  const candidate = result.candidates.find((c: { id: string }) => c.id === recordId)
  expect(candidate.readability).toBe("found")
  expect(candidate.origin).toBe("current_input")
  // 幂等：交付检查重复调用、事件先于/后于交付，结果一致。
  expect(await delivery(f, "w1")).toEqual(result)
  await finalEvent(plugin, "w1", "u1")
  expect(await delivery(f, "w1")).toEqual(result)
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(1)
})

test("review e000002: a round whose ACP retention was denied stays closed through the delivery bridge", async () => {
  const f = adapterFixture(true) // board_store deny → 工具结果留存 skipped，轮次仍登记
  const plugin = await admittedPlugin(f)
  expect(await runAcp(f, plugin, "Answer: 42")).toContain("Retention skipped: publication_not_authorized")
  f.messages.set("w1", { info: { id: "w1", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer", finish: "stop", time: { completed: 3 } },
    parts: [{ type: "text", text: `${STORE}\nAnswer: 42 (self-added marker)` }] })
  const result = await delivery(f, "w1")
  expect(result.capture).toEqual({ status: "skipped", reason: "acp_tool_result_round",
    note: "no original tool-result record was retained for this input round" })
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0) // wrapper 无法补出第二条记录
})

test("review e000003: delivery metadata never carries tool-result IDs invisible to the parent caller", async () => {
  const f = adapterFixture(false, "councillor-fix") // 隔离子流：父调用方对该记录 refPolicy=hidden
  const plugin = await admittedPlugin(f)
  const output = await runAcp(f, plugin, "Answer: 42")
  const recordId = /Retained: (bb:\/\/\S+)/.exec(output)![1]!
  f.messages.set("w1", { info: { id: "w1", sessionID: "child", role: "assistant", parentID: "u1", agent: f.childAgent, finish: "stop", time: { completed: 3 } },
    parts: [{ type: "text", text: `${STORE}\nAnswer: 42 (paraphrase)` }] }) // 终稿不含任何 bb 引用
  const result = await delivery(f, "w1")
  // record_ids 全部不可见 → 中性 capture_not_accessible，不出现“未留存”措辞（区别于真实未留存）。
  expect(result.capture).toEqual({ status: "unconfirmed", reason: "capture_not_accessible" })
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain(recordId) // 不泄漏 ID 与存在性
  expect(serialized).not.toContain("no original tool-result record was retained")
})

test("review e000002: the next independent input round retains normally through the delivery bridge", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  await runAcp(f, plugin, "Answer: 42")
  f.messages.set("w1", { info: { id: "w1", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer", finish: "stop", time: { completed: 3 } },
    parts: [{ type: "text", text: `${STORE}\nAnswer: 42 (paraphrase)` }] })
  expect((await delivery(f, "w1")).capture.status).toBe("skipped")
  f.messages.set("u2", { info: { id: "u2", sessionID: "child", role: "user" }, parts: [{ type: "text", text: "Next question." }] })
  f.messages.set("w2", { info: { id: "w2", sessionID: "child", role: "assistant", parentID: "u2", agent: "fixer", finish: "stop", time: { completed: 4 } },
    parts: [{ type: "text", text: `${STORE}\nNext answer.` }] })
  await plugin["chat.message"]!({ sessionID: "child", agent: "fixer", messageID: "u2" },
    { message: { id: "u2", sessionID: "child", role: "user" } as never, parts: [{ type: "text", text: "Next question." }] as never })
  const next = await delivery(f, "w2", "u2")
  expect(next.capture.status).toBe("stored")
  expect(next.capture.id).toMatch(/^bb:\/\//)
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(2)
})

test("round11 glue: acp_run raw with a valid top-level store marker — record keeps it verbatim, display copy strips it", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  const raw = `${STORE}\nAnswer: 42`
  const output = await runAcp(f, plugin, raw)
  expect(output.startsWith("Answer: 42\n\nRetained: bb://")).toBe(true) // 顶层标记剥除后接回执
  expect(output).not.toContain("bcp:store") // 显示副本不含标记
  const id = f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", "call_1")]!.id!
  expect(recordOf(f.scope, id).content).toBe(raw) // 存储原文逐字保留标记
})

test("round9: plugin restart recovers the round judgment from host messages and records, not caches", async () => {
  const f = adapterFixture()
  await runAcp(f, await admittedPlugin(f), "Answer: 42")
  f.messages.set("w1", { info: { id: "w1", sessionID: "child", role: "assistant", parentID: "u1", agent: "fixer", finish: "stop", time: { completed: 3 } },
    parts: [{ type: "text", text: `${STORE}\nAnswer: 42 (paraphrase)` }] })
  const restarted = await admittedPlugin(f) // 全新插件实例：内存登记不存在
  await finalEvent(restarted, "w1", "u1")
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(1)
  expect(readFileSync(join(f.dir, "log/blackboard.log"), "utf8")).toContain("acp_tool_result_round")
})

test("round11/12: acpCapture:false and autoCapture:false return the original result unchanged and store nothing", async () => {
  for (const options of [{ acpCapture: false }, { autoCapture: false }]) {
    const f = adapterFixture()
    const plugin = await admittedPlugin(f, options)
    const output = await runAcp(f, plugin, "Answer: 42")
    expect(output).toBe("Answer: 42") // 关闭：原样返回、不作任何声明
    expect(f.scope.readMeta(f.child.streamId).high_water).toBe(0)
  }
})

test("round10: short and diagnostic returns are recorded as tool results without claiming advisor success", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  const output = await runAcp(f, plugin, "no text")
  expect(output).toMatch(/\n\nRetained: bb:\/\//)
  const id = f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", "call_1")]!.id!
  const record = recordOf(f.scope, id)
  expect(record.content).toBe("no text")
  expect(record.description).not.toContain("success")
})

test("round12: adapter title selection uses the associated input only; later lines and missing titles never block retention", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  const setDescription = (text: string, callID: string) => {
    f.messages.set("u1", { info: { id: "u1", sessionID: "child", role: "user" }, parts: [{ type: "text", text }] })
    return runAcp(f, plugin, "Answer: 42", callID).then(() => {
      const id = f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", callID)]!.id!
      return recordOf(f.scope, id).description
    })
  }
  // 输入首行非 Task: → 中性回退，留存不受影响。
  expect(await setDescription("普通问题\nTask: later line", "call_9")).toBe("ACP result: glm-4.6")
  // 过长 Task 行 → 回退。
  expect(await setDescription(`Task: ${"a".repeat(161)}`, "call_10")).toBe("ACP result: glm-4.6")
  // 合法 Task 首行 → 模板标题；同 callID 重入复用记录（round 12 测试 9）。
  expect(await setDescription("Task: Fix the parser", "call_11")).toBe("ACP result: glm-4.6 | Fix the parser")
  const before = f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", "call_11")]!.id!
  await runAcp(f, plugin, "Answer: 42", "call_11")
  expect(f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", "call_11")]!.id).toBe(before)
})

test("round11 §2: shared post-retention notify runs on the ACP path and reaches the parent half", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  const output = await runAcp(f, plugin, "Answer: 42")
  expect(output).toMatch(/\n\nRetained: bb:\/\//)
  expect(f.scope.readMeta(f.child.streamId).high_water).toBe(1)
  // 共享通知可观测性：acp_retained_notified 只能由 notifyRetained 产生，
  // parent 字段只能来自父级查找半段（retained() 本身不含该步骤）——
  // 若 ACP 路径漏走共享通知或通知缺父半段，此断言失败。
  const log = readFileSync(join(f.dir, "log/blackboard.log"), "utf8")
  expect(log).toContain('"ev":"acp_retained_notified"')
  expect(log).toContain('"parent":"parent"')
})

test("round12: unconfirmable source message fails closed, distinct from title-unavailable fallback", async () => {
  const f = adapterFixture()
  const plugin = await admittedPlugin(f)
  // 输入可确认但无合法 Task 行 → 正常回退（上一用例）；此处输入不可读 → 失败关闭。
  f.messages.delete("u1")
  const output = await runAcp(f, plugin, "Answer: 42", "call_20")
  expect(output).toBe("Answer: 42\n\nRetention failed: input_unavailable\nPreserve the retention line above in your reply.")
  expect(f.scope.readMeta(f.child.streamId).idem[toolResultKey("child", "call_20")]).toBeUndefined()
})

// R9：acp_run 留存后再派发（真实链路 :453-476 留存 → :556-565 登记 → before 钩子 → sourceHandoff）。
// 留存的工具结果记录不携带任何 kind —— 路由不得依赖 kind 值；标签与文案按 R9 冻结文本。
test("R9: a retained acp_run result routes on the next dispatch as a neutral current-input source", async () => {
  const f = adapterFixture()
  // 派发收件人档案必须在插件首次读取前就绪（agentProfiles 缓存于第一次调用）。
  const allow = [{ permission: "*", pattern: "*", action: "allow" }]
  f.client.app.agents = async () => ({ data: [
    { name: "fixer", permission: allow },
    { name: "auditor", permission: [...allow, { permission: "board_get", pattern: "*", action: "deny" }] },
  ] })
  const plugin = await admittedPlugin(f)
  const output = await runAcp(f, plugin, "Answer: 42")
  const id = /Retained: (bb:\/\/\S+)/.exec(output)![1]!
  expect(recordOf(f.scope, id).kind).toBeUndefined() // 无 kind 记录真实入板（schema 不补 note）
  const dispatch = { args: { subagent_type: "fixer", prompt: "Continue from the delegated result." } }
  await plugin["tool.execute.before"]!({ tool: "task", sessionID: "child", callID: "t1" } as never, dispatch as never)
  const prompt = dispatch.args.prompt as string
  expect(prompt).toContain("<bcp_input_sources>")
  expect(prompt).not.toContain("<bcp_input_decisions>")
  expect(prompt).toContain(id)
  expect(prompt).toContain("These are candidate sources, not inferred dependencies, approved decisions or execution authority.")
  expect(prompt).not.toContain("Answer: 42") // 只给引用，不代写正文
  // 钩子重复执行幂等。
  const again = { args: { subagent_type: "fixer", prompt } }
  await plugin["tool.execute.before"]!({ tool: "task", sessionID: "child", callID: "t2" } as never, again as never)
  expect(again.args.prompt).toBe(prompt)
  // 接收方不可读时保留原 prompt（降级，不报错、不删正文）。
  const blocked = { args: { subagent_type: "auditor", prompt: "Keep this supplied body when sources cannot be dereferenced." } }
  await plugin["tool.execute.before"]!({ tool: "task", sessionID: "child", callID: "t3" } as never, blocked as never)
  expect(blocked.args.prompt).toBe("Keep this supplied body when sources cannot be dereferenced.")
})
