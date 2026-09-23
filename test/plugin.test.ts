// Task 5 插件装配测试：直接调用 hooks，伪造 client / ToolContext / messages。
import { describe, test, expect, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { Message } from "@opencode-ai/sdk"
import { BlackboardPlugin } from "../src/plugin"
import { openScopeForRoot, Scope, type StreamMeta } from "../src/storage"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bbplug-"))
  dirs.push(d)
  return d
}

function clientStub(over?: { failSession?: boolean }) {
  return {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        if (over?.failSession) throw new Error("parent query failed")
        return { data: { id: path.id, parentID: null, agent: "" } }
      },
    },
  }
}

function forgeInput(dataDir: string, over?: { failSession?: boolean }): PluginInput {
  return { client: clientStub(over) } as unknown as PluginInput
}

function forgeCtx(sessionId: string): ToolContext {
  return {
    sessionID: sessionId,
    messageID: "msg_tool",
    agent: "build",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as unknown as ToolContext
}

function userMsg(sessionId: string, id: string, text: string): { info: Message; parts: { type: string; text: string }[] } {
  return {
    info: { id, sessionID: sessionId, role: "user" } as unknown as Message,
    parts: [{ type: "text", text }],
  }
}

async function setupSession(dataDir: string, sessionId: string, agent = "build") {
  const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
  scope.registerSession(sessionId, agent)
  return scope
}

const byteLen = (s: string) => new TextEncoder().encode(s).length

describe("plugin", () => {
  // plug-1 注册会话 transform → 原地追加到末条 user 消息 parts，≤2048 字节
  test("plug-1: transform appends snapshot text part in place", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p1"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const m = userMsg(sessionId, "msg_1", "hi")
    const msgs = [m]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
    expect(m.parts.length).toBe(2)
    expect(m.parts[1]!.text.startsWith("[blackboard 目录快照")).toBe(true)
    expect(byteLen(m.parts[1]!.text)).toBeLessThanOrEqual(2048)
    expect(msgs.length).toBe(1) // 无新消息，原地追加
  })

  // plug-2 同 (sessionId,lastMsgId) 二次 transform → 不重复注入
  test("plug-2: duplicate request id not injected twice", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p2"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const m1 = userMsg(sessionId, "msg_1", "hi")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m1] as never })
    expect(m1.parts.length).toBe(2)
    const m2 = userMsg(sessionId, "msg_1", "hi")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m2] as never })
    expect(m2.parts.length).toBe(1) // duplicate_hook
  })

  // plug-3 父查询失败 → lookup null：transform 静默、board.put 拒绝
  test("plug-3: unresolved parent rejects tools and silences transform", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p3"
    const plugin = await BlackboardPlugin(forgeInput(dataDir, { failSession: true }), { dataDir })
    const m = userMsg(sessionId, "msg_1", "hi")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m] as never })
    expect(m.parts.length).toBe(1)
    const tools = plugin.tool!
    const out = await tools.board_put.execute(
      { description: "d", content: "c", idempotency_key: "k" },
      forgeCtx(sessionId),
    )
    expect(out).toBe("rejected: unregistered_session")
  })

  // plug-4 readMeta 抛错 → 降级输出仅一次，transform 不抛出
  test("plug-4: degrade printed exactly once on persisting read failure", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p4"
    await setupSession(dataDir, sessionId)
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    const errLogs: string[] = []
    const realError = console.error
    console.error = (...a: unknown[]) => errLogs.push(a.join(" "))
    const realRead = Scope.prototype.readMeta
    Scope.prototype.readMeta = function (): StreamMeta {
      throw new Error("read boom")
    }
    const m = userMsg(sessionId, "msg_1", "hi")
    const m2 = userMsg(sessionId, "msg_1", "hi")
    try {
      await plugin["experimental.chat.messages.transform"]!({}, { messages: [m] as never })
      await plugin["experimental.chat.messages.transform"]!({}, { messages: [m2] as never })
    } finally {
      Scope.prototype.readMeta = realRead
      console.error = realError
    }
    expect(m.parts.length).toBe(1)
    expect(errLogs.filter((l) => l.startsWith("[blackboard] degraded")).length).toBe(1)
  })

  // plug-5 chat.message admitted → 轮次 +1 持久化，budget.round_id = 新 messageId
  test("plug-5: admitted input rolls round and ledger", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p5"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const meta = scope.readMeta(scope.resolveSession(sessionId).streamId)
    expect(meta.rounds.current_round).toBe(1)
    expect(meta.rounds.round_known).toBe(true)
    expect(meta.budget.round_id).toBe("msg_1")
    expect(meta.budget.round_known).toBe(true)
  })

  // plug-6 一次成功 board.put 后 budget 深等于不变（M0-7）
  test("plug-6: board.put leaves budget unchanged", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p6"
    await setupSession(dataDir, sessionId)
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const streamId = scope.resolveSession(sessionId).streamId
    const before = scope.readMeta(streamId).budget
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    const out = await plugin.tool!.board_put.execute(
      { description: "d", content: "c", idempotency_key: "k1" },
      forgeCtx(sessionId),
    )
    expect(out).toContain("stored")
    expect(scope.readMeta(streamId).budget).toEqual(before)
  })

  // plug-7 (C3) writeMeta 首调抛错 → 不注入、budget 不变
  test("plug-7: persist failure never injects", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p7"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const realWrite = Scope.prototype.writeMeta
    let calls = 0
    Scope.prototype.writeMeta = function (): void {
      calls++
      throw new Error("write boom")
    }
    let m = userMsg(sessionId, "msg_1", "hi")
    try {
      await plugin["experimental.chat.messages.transform"]!({}, { messages: [m] as never })
    } finally {
      Scope.prototype.writeMeta = realWrite
    }
    expect(calls).toBe(1)
    expect(m.parts.length).toBe(1)
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const meta = scope.readMeta(scope.resolveSession(sessionId).streamId)
    expect(meta.budget.round_used).toBe(0)
    expect(meta.budget.snapshot_version).toBe(null)
  })

  // plug-8 (P13) 预算耗尽（round_used=1 且 initial_fulfilled=true）→ 零注入
  test("plug-8: exhausted budget yields zero injections", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p8"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msgSeed" },
      { message: {} as never, parts: [] as never },
    )
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const streamId = scope.resolveSession(sessionId).streamId
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      budget: { ...meta.budget, round_used: 1, initial_fulfilled: true },
    })
    const mA = [userMsg(sessionId, "msgSeed", "hi")]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: mA as never })
    const mB = userMsg(sessionId, "msgSeed", "hi")
    const msgsB = [mB, { info: { id: "asst_1", sessionID: sessionId, role: "assistant" } as unknown as Message, parts: [] }]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: msgsB as never })
    expect(mA[0]!.parts.length).toBe(1)
    expect(mB.parts.length).toBe(1)
    expect(scope.readMeta(streamId).budget.round_used).toBe(1)
  })

  // plug-9 (P11/P13/F2) 真实子进程预算竞争 + 冲突报告协议
  test("plug-9: budget race across real processes reports conflict once", async () => {    const dataDir = tmpDataDir()
    const rootId = "ses_p9"
    const scope = openScopeForRoot({ rootSessionId: rootId, dataDir })
    scope.registerSession(rootId, "build")
    const streamId = scope.resolveSession(rootId).streamId
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 1, round_known: true, last_admitted_message_id: "msgSeed" },
      budget: { ...meta.budget, round_id: "msgSeed", round_known: true, round_used: 1, initial_fulfilled: false },
    })
    const spawn = (req: string, pause: boolean) =>
      Bun.spawn(["bun", "scripts/budget-race.ts", dataDir, rootId, req, ...(pause ? ["--pause"] : [])], {
        stdout: "pipe",
        stderr: "pipe",
      })
    const a = spawn("reqA", true)
    const deadline = Date.now() + 10000
    while (!existsSync(`${dataDir}/pause-A`)) {
      if (Date.now() > deadline) throw new Error("worker A never paused")
      await Bun.sleep(25)
    }
    // B 与持锁的 A 竞争 → 锁超时 → 冲突报告（而非决策成功）
    const b = spawn("reqB", false)
    await b.exited
    const bOut = await new Response(b.stdout).text()
    expect(b.exitCode).toBe(0)
    expect(bOut).toContain("lock_contention_observed")
    writeFileSync(`${dataDir}/resume-A`, "1")
    await a.exited
    const aOut = await new Response(a.stdout).text()
    expect(a.exitCode).toBe(0)
    const aResult = JSON.parse(aOut.trim()) as { injected: boolean; reason: string }
    expect(aResult).toEqual({ injected: true, reason: "initial_reminder" })
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(2)
    expect(after.budget.initial_fulfilled).toBe(true)
    // B 重试：先查 initial_fulfilled 再查预算 → fulfilled_initial，不再注入（G2：非 no_budget）
    const b2 = spawn("reqB", false)
    await b2.exited
    const b2Out = await new Response(b2.stdout).text()
    expect(b2.exitCode).toBe(0)
    expect(JSON.parse(b2Out.trim())).toEqual({ injected: false, reason: "fulfilled_initial" })
  }, 30000)

  // plug-10 (G5) 全链 R1/P12 回归：chat.message/transform/board.put 生产路径
  test("plug-10: identity loss and recovery across full chain", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p10"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    // ① admitted → 两处 round_known=true
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const streamId = scope.resolveSession(sessionId).streamId
    let meta = scope.readMeta(streamId)
    expect(meta.rounds.round_known).toBe(true)
    expect(meta.budget.round_known).toBe(true)
    // ② requestVerified=false（admitted 输入不在本次上下文）→ 不注入，两处置 false
    const m = userMsg(sessionId, "msg_other", "next")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m] as never })
    expect(m.parts.length).toBe(1)
    meta = scope.readMeta(streamId)
    expect(meta.rounds.round_known).toBe(false)
    expect(meta.budget.round_known).toBe(false)
    // ③ board.put → created_round === null
    const out1 = await plugin.tool!.board_put.execute(
      { description: "d1", content: "c1", idempotency_key: "k1" },
      forgeCtx(sessionId),
    )
    expect(out1).toContain("stored")
    const rec1 = scope.readEntry(streamId, scope.readMeta(streamId).high_water)
    expect(rec1?.created_round ?? null).toBe(null)
    // ④ 同一 admitted 输入幂等恢复 → 两处 round_known=true，轮次/预算不变
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    meta = scope.readMeta(streamId)
    expect(meta.rounds.current_round).toBe(1)
    expect(meta.rounds.round_known).toBe(true)
    expect(meta.budget.round_known).toBe(true)
    expect(meta.budget.round_used).toBe(0)
    expect(meta.budget.round_id).toBe("msg_1")
    // ⑤ board.put → created_round === current_round
    const out2 = await plugin.tool!.board_put.execute(
      { description: "d2", content: "c2", idempotency_key: "k2" },
      forgeCtx(sessionId),
    )
    expect(out2).toContain("stored")
    const rec2 = scope.readEntry(streamId, scope.readMeta(streamId).high_water)
    expect(rec2?.created_round ?? null).toBe(meta.rounds.current_round)
  })

  // 决策日志：blackboard.log 含 {ev:"decision"} / {ev:"round"} 行（schema：无内容体）
  test("plugin logs decision and round lines without content bodies", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_log"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const m = userMsg(sessionId, "msg_1", "secret-body")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m] as never })
    const lines = readFileSync(join(dataDir, "log/blackboard.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.ev === "round")).toBe(true)
    const decision = lines.find((l) => l.ev === "decision")
    expect(decision).toBeDefined()
    expect(decision!.reason).toBe("initial_reminder")
    expect(decision!.request_id).toBe(`${sessionId}:msg_1`)
    expect(JSON.stringify(lines)).not.toContain("secret-body")
  })
})
