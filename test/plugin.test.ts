// Task 5 插件装配测试：直接调用 hooks，伪造 client / ToolContext / messages。
import { describe, test, expect, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { Message } from "@opencode-ai/sdk"
import { BlackboardPlugin } from "../src/plugin"
import { openScopeForRoot, Scope, type StreamMeta, AGG_TRIGGER_VISIBLE, AGG_TRIGGER_SUM_DESC_BYTES } from "../src/storage"
import { aggregateCandidates } from "../src/aggregate"

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

  // plug-5（Task C G7 迁移）admission → 轮次 +1 持久化只发生在 transform 关联验证后；
  // budget.round_id = 新 messageId（chat.message 接收侧仅登记准入）
  test("plug-5: admitted input rolls round and ledger via transform verification", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p5"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const streamId = scope.resolveSession(sessionId).streamId
    expect(scope.readMeta(streamId).rounds.current_round).toBe(0) // 接收侧不推进
    const m = userMsg(sessionId, "msg_1", "hi")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m] as never })
    const meta = scope.readMeta(streamId)
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

  // plug-8 (P13，Task C G7 迁移) 预算耗尽（round_used=1 且 initial_fulfilled=true）→ 零注入。
  // 轮次推进经 transform 关联验证发生（推进轮注入初始提醒消耗额度），随后手置预算保证耗尽前提。
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
    const mA = [userMsg(sessionId, "msgSeed", "hi")]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: mA as never })
    expect(mA[0]!.parts.length).toBe(2) // 推进轮的初始提醒注入（round_used 0→1）
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      budget: { ...meta.budget, round_used: 1, initial_fulfilled: true },
    })
    const mB = userMsg(sessionId, "msgSeed", "hi")
    const msgsB = [mB, { info: { id: "asst_1", sessionID: sessionId, role: "assistant" } as unknown as Message, parts: [] }]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: msgsB as never })
    expect(mB.parts.length).toBe(1) // 预算耗尽 → fulfilled_initial 零注入
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

  // plug-10 (G5，Task C G7 迁移) 全链 R1/P12 回归：chat.message/transform/board.put 生产路径。
  // 推进与恢复均经 transform 关联验证；恢复不增轮、不 roll 额度/去重（fix-5）。
  test("plug-10: identity loss and recovery across full chain", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p10"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    // ① admitted → transform 关联验证推进 → 两处 round_known=true
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const streamId = scope.resolveSession(sessionId).streamId
    const m1 = userMsg(sessionId, "msg_1", "hi")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m1] as never })
    let meta = scope.readMeta(streamId)
    expect(meta.rounds.current_round).toBe(1)
    expect(meta.rounds.round_known).toBe(true)
    expect(meta.budget.round_known).toBe(true)
    // ② requestVerified=false（admitted 输入不在本次上下文）→ 不注入，两处置 false
    const m = userMsg(sessionId, "msg_other", "next")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m] as never })
    expect(m.parts.length).toBe(1)
    meta = scope.readMeta(streamId)
    expect(meta.rounds.round_known).toBe(false)
    expect(meta.budget.round_known).toBe(false)
    // 手置轮内额度已消耗——恢复路径不得重置（fix-5 断言点）
    scope.writeMeta(streamId, {
      ...meta,
      budget: { ...meta.budget, round_used: 1, initial_fulfilled: true },
    })
    // ③ board.put → created_round === null
    const out1 = await plugin.tool!.board_put.execute(
      { description: "d1", content: "c1", idempotency_key: "k1" },
      forgeCtx(sessionId),
    )
    expect(out1).toContain("stored")
    const rec1 = scope.readEntry(streamId, scope.readMeta(streamId).high_water)
    expect(rec1?.created_round ?? null).toBe(null)
    // ④ 同一 admitted 输入经 transform 幂等恢复 → 两处 round_known=true，
    //    不增轮、额度/去重不重置、本轮已履行 → 不注入
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const m1b = userMsg(sessionId, "msg_1", "hi again")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m1b] as never })
    meta = scope.readMeta(streamId)
    expect(meta.rounds.current_round).toBe(1)
    expect(meta.rounds.round_known).toBe(true)
    expect(meta.budget.round_known).toBe(true)
    expect(meta.budget.round_used).toBe(1) // 未被恢复路径重置
    expect(meta.budget.round_id).toBe("msg_1")
    expect(m1b.parts.length).toBe(1) // fulfilled_initial → 零注入
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

  /** p-agg-1 夹具：注册会话 + chat.message 滚轮（msgSeed）+ 31 条老化记录（createdRound=45）+ 轮次拨到 49 */
  async function aggFixture(dataDir: string, sessionId: string) {
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msgSeed" },
      { message: {} as never, parts: [] as never },
    )
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const streamId = scope.resolveSession(sessionId).streamId
    for (let i = 0; i < 31; i++) {
      const r = scope.put(streamId, {
        writer: { agent: "build", session_id: sessionId, message_id: `seed${i}` },
        createdRound: 45,
        description: `旧记录 ${i}`,
        content: "c",
      })
      if (r.status !== "stored") throw new Error(`put failed: ${JSON.stringify(r)}`)
    }
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, { ...meta, rounds: { ...meta.rounds, current_round: 49, round_known: true } })
    return { plugin, scope, streamId }
  }

  // p-agg-1（Task B Step 4）：生产接线——候选集压力注入直驱 transform（不经 decideNudge）
  test("p-agg-1: A 初始优先注入 → B 同轮压力/集合抑制 → C 新轮初始再次优先/跨轮抑制 → D 预算耗尽 → fix-9 触发边界", async () => {
    const readDecisions = (dataDir: string) =>
      readFileSync(join(dataDir, "log/blackboard.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.ev === "decision")
    // —— A/B/C 段共用夹具 ——
    const dataDir = tmpDataDir()
    const sessionId = "ses_pa"
    const f = await aggFixture(dataDir, sessionId)
    const run = async (ids: string[]) => {
      const msgs = ids.map((id) => userMsg(sessionId, id, "hi"))
      await f.plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      return msgs.at(-1)!
    }
    // A：候选集非空 + 初始未履行 → initial_reminder 优先注入（candidateSetId 生产接线）
    const mA = await run(["msgSeed"])
    expect(mA.parts.length).toBe(2)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("initial_reminder")
    expect(f.scope.readMeta(f.streamId).budget.round_used).toBe(1)
    // B：同轮初始已履行 + 候选集 → pressure_reminder；同轮重发同集合 → set_already_prompted（R3-2）
    const mB = await run(["msgSeed", "msgB"])
    expect(mB.parts.length).toBe(2)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("pressure_reminder")
    expect(f.scope.readMeta(f.streamId).budget.round_used).toBe(2)
    const mB2 = await run(["msgSeed", "msgB", "msgB2"])
    expect(mB2.parts.length).toBe(1)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("set_already_prompted")
    expect(f.scope.readMeta(f.streamId).budget.round_used).toBe(2)
    // C：roll 后初始再次优先注入（初始不被压力阻断）；集合抑制跨轮仍生效
    await f.plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msgC" },
      { message: {} as never, parts: [] as never },
    )
    const mC = await run(["msgC"])
    expect(mC.parts.length).toBe(2)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("initial_reminder")
    expect(f.scope.readMeta(f.streamId).budget.round_used).toBe(1)
    const mC2 = await run(["msgC", "msgC2"])
    expect(mC2.parts.length).toBe(1)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("set_already_prompted")
    // —— D 段独立夹具：初始一次 + S1 压力一次 → 同轮新集合 S2 → no_budget；重发 S2 仍 no_budget ——
    const dataDir2 = tmpDataDir()
    const sessionId2 = "ses_pd"
    const f2 = await aggFixture(dataDir2, sessionId2)
    const run2 = async (ids: string[]) => {
      const msgs = ids.map((id) => userMsg(sessionId2, id, "hi"))
      await f2.plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      return msgs.at(-1)!
    }
    const mA2 = await run2(["msgSeed"])
    expect(readDecisions(dataDir2).at(-1)!.reason).toBe("initial_reminder")
    const mB1 = await run2(["msgSeed", "msgS1"])
    expect(readDecisions(dataDir2).at(-1)!.reason).toBe("pressure_reminder")
    // 候选集合演变：撤回首个成员 → 首批 16 eligible 变化 → 新集合 S2
    const first = f2.scope.readEntry(f2.streamId, 1)!
    f2.scope.markTombstone(f2.streamId, first.id, "撤回")
    const mB2d = await run2(["msgSeed", "msgS1", "msgS2"])
    expect(mB2d.parts.length).toBe(1)
    expect(readDecisions(dataDir2).at(-1)!.reason).toBe("no_budget")
    expect(f2.scope.readMeta(f2.streamId).budget.round_used).toBe(2)
    const mB3 = await run2(["msgSeed", "msgS1", "msgS2", "msgS2b"])
    expect(mB3.parts.length).toBe(1)
    expect(readDecisions(dataDir2).at(-1)!.reason).toBe("no_budget")
    // —— fix-9 触发边界（unit 级直接驱动 aggregateCandidates + 生产门槛公式）——
    // caller 必须与写入者同一身份，否则 classifyEligibility 全员 not_original_author
    const caller = { sessionId: "s", agent: "build" }
    const gate = (c: ReturnType<typeof aggregateCandidates>) =>
      c !== null && (c.visibleItems > AGG_TRIGGER_VISIBLE || c.sumDescriptionBytes > AGG_TRIGGER_SUM_DESC_BYTES)
        ? c.setHash
        : null
    const unitScope = (root: string, descs: string[]) => {
      const scope = openScopeForRoot({ rootSessionId: root, dataDir: tmpDataDir() })
      const { streamId } = scope.registerSession("s", "build")
      descs.forEach((d, i) => {
        const r = scope.put(streamId, {
          writer: { agent: "build", session_id: "s", message_id: `u${i}` },
          createdRound: 45,
          description: d,
          content: "c",
        })
        if (r.status !== "stored") throw new Error("put failed")
      })
      const meta = scope.readMeta(streamId)
      scope.writeMeta(streamId, { ...meta, rounds: { ...meta.rounds, current_round: 49, round_known: true } })
      return { scope, streamId }
    }
    const plain = (count: number) => Array.from({ length: count }, (_, i) => `旧记录 ${i}`)
    // eligible 7 → aggregateCandidates null
    const s7 = unitScope("ses_b7", plain(13))
    expect(aggregateCandidates(s7.scope, s7.streamId, caller, 49)).toBeNull()
    // 可见 24 → 门槛 null；25 → 非 null
    const s24 = unitScope("ses_b24", plain(24))
    const c24 = aggregateCandidates(s24.scope, s24.streamId, caller, 49)
    expect(c24).not.toBeNull()
    expect(gate(c24)).toBeNull()
    const s25 = unitScope("ses_b25", plain(25))
    expect(gate(aggregateCandidates(s25.scope, s25.streamId, caller, 49))).not.toBeNull()
    // 字节 4096 → 门槛 null；4097 → 非 null（17 条：eligible 11 ≥ 8、visible 17 ≤ 24；CJK 3B/字）
    const d256 = "汉".repeat(85) + "x" // 256 B
    const d128 = "汉".repeat(42) + "ab" // 128 B
    const s4096 = unitScope("ses_b96", [...Array.from({ length: 15 }, () => d256), d128, d128])
    const c4096 = aggregateCandidates(s4096.scope, s4096.streamId, caller, 49)!
    expect(c4096.sumDescriptionBytes).toBe(4096)
    expect(gate(c4096)).toBeNull()
    const s4097 = unitScope("ses_b97", [...Array.from({ length: 15 }, () => d256), d128, d128 + "c"])
    const c4097 = aggregateCandidates(s4097.scope, s4097.streamId, caller, 49)!
    expect(c4097.sumDescriptionBytes).toBe(4097)
    expect(gate(c4097)).not.toBeNull()
  }, 30000)

  // p-red-2（Task C 偏差② G7 + fix-11）：轮次仅在关联验证后推进。
  // 第一段为 RED 证据（修复前 chat.message 接收即推进 → current_round===1 ≠ 0）。
  test("p-red-2 轮次仅在 transform 关联验证后推进（含合成 continuation 不推进）", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_pr2"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    const scope = openScopeForRoot({ rootSessionId: sessionId, dataDir })
    const { streamId } = scope.registerSession(sessionId, "build")
    const tx = async (ids: string[]) => {
      const msgs = ids.map((id) => userMsg(sessionId, id, "hi"))
      await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      return msgs.at(-1)!
    }
    // 第一段（RED）：chat.message(admitted M1) 仅登记准入 → transform 不含 M1 → 不推进
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [{ type: "text", text: "hi" }] as never },
    )
    expect(scope.readMeta(streamId).rounds.current_round).toBe(0) // 接收侧不推进轮次
    // 第二段：transform 含 M1 → 关联验证推进 + 首次 verified 请求注入初始提醒（fix-5 正常预算消耗）
    const m1 = await tx(["msg_1"])
    let meta = scope.readMeta(streamId)
    expect(meta.rounds.current_round).toBe(1)
    expect(meta.budget.round_id).toBe("msg_1")
    expect(meta.budget.round_used).toBe(1)
    expect(m1.parts.length).toBe(2)
    // 第三段（fix-11）：合成 continuation（SYNTHETIC_RE 命中）→ internal 分类 →
    // 不准入、不推进轮次、不 roll 预算、不产生注入
    const contText = "<dcp-continuation 压缩摘要"
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_cont" },
      { message: {} as never, parts: [{ type: "text", text: contText }] as never },
    )
    const mc = await tx(["msg_cont"])
    meta = scope.readMeta(streamId)
    expect(meta.rounds.current_round).toBe(1) // 不推进
    expect(meta.budget.round_id).toBe("msg_1") // 不 roll
    expect(meta.budget.round_used).toBe(1) // 不消耗额度
    expect(mc.parts.length).toBe(1) // 不注入
  })
})
