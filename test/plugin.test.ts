// Task 5 插件装配测试：直接调用 hooks，伪造 client / ToolContext / messages。
import { describe, test, expect, afterEach } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { Message } from "@opencode-ai/sdk"
import { BlackboardPlugin } from "../src/plugin"
import { openScopeForRoot, Scope, type StreamMeta, AGG_TRIGGER_VISIBLE, AGG_TRIGGER_SUM_DESC_BYTES } from "../src/storage"
import { aggregateCandidates } from "../src/aggregate"
import { ENTRY_REMINDER_TEMPLATE, PRESSURE_REMINDER_TEMPLATE, NORMATIVE_SENTENCE, TASK_DESC_APPEND } from "../src/constants"

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

// I1 测试夹具：14 条同写手旧记录（created 1 / 当前 5 → 过 fence；避开 recent6；
// 描述合计 >4KiB → 满足 §8.1 压力阈值），使聚合候选恰好可达。
function seedPressureBoard(scope: Scope, streamId: string, sessionId: string, agent: string): void {
  const meta = scope.readMeta(streamId)
  scope.writeMeta(streamId, {
    ...meta,
    rounds: { current_round: 5, round_known: true, last_admitted_message_id: "msgSeed" },
    budget: { ...meta.budget, round_id: "msgSeed", round_known: true, round_used: 0 },
  })
  for (let i = 0; i < 14; i++) {
    const r = scope.put(streamId, {
      writer: { agent, session_id: sessionId, message_id: `m${i}` },
      createdRound: 1,
      description: `d${i}:${"x".repeat(600)}`,
      content: "c",
    })
    if (r.status !== "stored") throw new Error("seed put failed")
  }
}

const byteLen = (s: string) => new TextEncoder().encode(s).length

describe("plugin", () => {
  // plug-1（§10.4① 迁移）：入口信号（bb://）transform → 原地追加 ENTRY_REMINDER_TEMPLATE
  // 常量模板到末条 user 消息 parts（part id 形如 part_bb_<lastMsgId>，≤512B）
  test("plug-1: signal prompt injects entry reminder once, in place", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_p1"
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msg_1" },
      { message: {} as never, parts: [] as never },
    )
    const m = userMsg(sessionId, "msg_1", "请先读 bb://scope/stream/1 再开始")
    const msgs = [m]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
    expect(m.parts.length).toBe(2)
    expect((m.parts[1] as unknown as { id?: string }).id).toBe(`part_bb_msg_1`)
    expect(m.parts[1]!.text).toBe(ENTRY_REMINDER_TEMPLATE)
    expect(byteLen(m.parts[1]!.text)).toBeLessThanOrEqual(512)
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
    const m1 = userMsg(sessionId, "msg_1", "bb://s/1")
    await plugin["experimental.chat.messages.transform"]!({}, { messages: [m1] as never })
    expect(m1.parts.length).toBe(2)
    const m2 = userMsg(sessionId, "msg_1", "bb://s/1")
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
    expect(meta.budget.entry_prompted_message_ids).toEqual([])
  })

  // plug-8 (P13，Task C G7 迁移 + §10.3 预算上限迁移) 预算耗尽（round_used=2）→ 入口信号亦零注入（no_budget）。
  // §10.3 预算依附 admitted 业务输入：耗尽态必须在**同一预算身份内**构造（新 admitted = 新预算身份，
  // 经 roll 重置后可再注入——该语义由 nudge-8/nudge-12 单测覆盖，不属本用例）。
  // 故在已验证 admitted msgSeed 上手置 2/2 并清空入口事件去重，验证入口注入前显式预算检查。
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
    const mA = [userMsg(sessionId, "msgSeed", "bb://s/1")]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: mA as never })
    expect(mA[0]!.parts.length).toBe(2) // 入口提醒注入（round_used 0→1）
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      budget: { ...meta.budget, round_used: 2, entry_prompted_message_ids: [] },
    })
    // 同 admitted（msgSeed）二次请求（asst_1 收尾使 requestId 新鲜，避开 duplicate_hook）：
    // 无 roll、入口事件待提示、额度 2/2 → no_budget 零注入
    const mB = userMsg(sessionId, "msgSeed", "bb://s/2")
    const msgsB = [mB, { info: { id: "asst_1", sessionID: sessionId, role: "assistant" } as unknown as Message, parts: [] }]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: msgsB as never })
    expect(mB.parts.length).toBe(1) // 预算耗尽 → no_budget 零注入（入口信号亦不破例）
    expect(scope.readMeta(streamId).budget.round_used).toBe(2)
  })

  // plug-9 (P11/P13/F2) 真实子进程预算竞争 + 冲突报告协议（I4：恢复预算竞争语义——
  // A/B 携带不同压力候选集、起点 round_used=1：A 持锁消费最后额度注入，B 重试 no_budget）
  test("plug-9: budget race across real processes reports conflict once", async () => {
    const dataDir = tmpDataDir()
    const rootId = "ses_p9"
    const scope = openScopeForRoot({ rootSessionId: rootId, dataDir })
    scope.registerSession(rootId, "build")
    const streamId = scope.resolveSession(rootId).streamId
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 1, round_known: true, last_admitted_message_id: "msgSeed" },
      budget: { ...meta.budget, round_id: "msgSeed", round_known: true, round_used: 1 },
    })
    const spawn = (req: string, cand: string, pause: boolean) =>
      Bun.spawn(["bun", "scripts/budget-race.ts", dataDir, rootId, req, cand, ...(pause ? ["--pause"] : [])], {
        stdout: "pipe",
        stderr: "pipe",
      })
    // I4：A/B 用不同压力候选集；起点 round_used=1（仅剩最后额度）
    const a = spawn("reqA", "S1", true)
    const deadline = Date.now() + 10000
    while (!existsSync(`${dataDir}/pause-A`)) {
      if (Date.now() > deadline) throw new Error("worker A never paused")
      await Bun.sleep(25)
    }
    // B 与持锁的 A 竞争 → 锁超时 → 冲突报告（而非决策成功）
    const b = spawn("reqB", "S2", false)
    await b.exited
    const bOut = await new Response(b.stdout).text()
    expect(b.exitCode).toBe(0)
    expect(bOut).toContain("lock_contention_observed")
    writeFileSync(`${dataDir}/resume-A`, "1")
    await a.exited
    const aOut = await new Response(a.stdout).text()
    expect(a.exitCode).toBe(0)
    // I4：A 持锁完成决策 → S1 未提示 ∧ round_used=1<2 → 消费最后额度注入压力提醒
    const aResult = JSON.parse(aOut.trim()) as { injected: boolean; reason: string }
    expect(aResult).toEqual({ injected: true, reason: "pressure_reminder" })
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(2)
    // B 重试（锁已释放）：S2 为新集合但额度已耗尽 → no_budget（竞争输家不注入）
    const b2 = spawn("reqB", "S2", false)
    await b2.exited
    const b2Out = await new Response(b2.stdout).text()
    expect(b2.exitCode).toBe(0)
    expect(JSON.parse(b2Out.trim())).toEqual({ injected: false, reason: "no_budget" })
  }, 30000)

  // —— oracle 复审（I1/M3）新增 ——
  // I1-①：持久索引空 agent + 显式 hook agent 到达 → 注册身份刷新（缓存与 session_index 对齐）
  test("i1-1: identity refresh aligns empty persisted agent with explicit hook agent", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1a"
    const scope = await setupSession(dataDir, sessionId, "") // 宿主 session_index 空串长期行为
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msgSeed" },
      { message: {} as never, parts: [] as never },
    )
    expect(scope.config.session_index[sessionId]!.agent).toBe("build") // 注册路径验证值已回写
  })

  // I1-②：缓存命中后显式 agent 变更到达 → 身份刷新（不再 stale）
  test("i1-2: cached context refreshes on explicit agent change", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1b"
    const scope = await setupSession(dataDir, sessionId, "build")
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "m1" }, { message: {} as never, parts: [] as never })
    await plugin["chat.message"]!({ sessionID: sessionId, agent: "lead", messageID: "m2" }, { message: {} as never, parts: [] as never })
    expect(scope.config.session_index[sessionId]!.agent).toBe("lead")
  })

  // I1-③：skipAgents 在注册与刷新路径均不被绕过
  test("i1-3: skipAgents not bypassed by registration or refresh path", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1c"
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    try {
      const scope = await setupSession(dataDir, sessionId, "build")
      const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      // 注册路径：skip agent → 不建立会话上下文（工具路径拒绝）
      await plugin["chat.message"]!({ sessionID: "ses_i1cspy", agent: "spy", messageID: "m1" }, { message: {} as never, parts: [] as never })
      const res = await plugin.tool!.board_index.execute({}, forgeCtx("ses_i1cspy"))
      const out = typeof res === "string" ? res : res.output
      expect(out).toContain("rejected: unregistered_session")
      // 刷新路径：已缓存 build 会话收到 spy → 拒绝刷新，注册保持
      await plugin["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "m2" }, { message: {} as never, parts: [] as never })
      await plugin["chat.message"]!({ sessionID: sessionId, agent: "spy", messageID: "m3" }, { message: {} as never, parts: [] as never })
      expect(scope.config.session_index[sessionId]!.agent).toBe("build")
    } finally {
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  // I1-④：未知身份保守路径——null 身份不冒充作者（空串 caller × 空串 writer 不匹配）、聚合候选为无
  test("i1-4: null identity is conservative — no author impersonation, no candidates", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1d"
    const scope = await setupSession(dataDir, sessionId, "")
    const streamId = scope.resolveSession(sessionId).streamId
    seedPressureBoard(scope, streamId, sessionId, "") // 记录同为未知写手（历史空串行为）
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!({ sessionID: sessionId, messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
    const msgs = [userMsg(sessionId, "msgSeed", "hello")]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
    expect(msgs[0]!.parts.length).toBe(1) // 无压力注入（未知身份不参与原作者匹配）
    expect(scope.readMeta(streamId).budget.round_used).toBe(0)
  })

  // I1-⑤（口径分叉回归）：board_index.counts 与 transform 聚合候选统一用注册验证身份——
  // live 样本异常（counts eligible:0/protected:29 而聚合候选产出 pressure_reminder）根因是
  // counts 用 ToolContext.agent（live 常空串）、聚合用注册身份；现两处同源。
  test("i1-5: counts and aggregate candidates share the resolved identity caliber", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1e"
    const scope = await setupSession(dataDir, sessionId, "build")
    const streamId = scope.resolveSession(sessionId).streamId
    seedPressureBoard(scope, streamId, sessionId, "build")
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
    const res = await plugin.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "" })
    const out = typeof res === "string" ? res : res.output
    const parsed = JSON.parse(out) as { stream: { counts: { eligible: number; protected: number } } }
    expect(parsed.stream.counts.eligible).toBeGreaterThanOrEqual(8) // 空 ToolContext agent 不再致 counts 全保护
    const msgs = [userMsg(sessionId, "msgSeed", "hello")]
    await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
    expect(msgs[0]!.parts.length).toBe(2) // 同一口径 → 压力候选成立 → 模板②注入
    expect(scope.readMeta(streamId).budget.round_used).toBe(1)
  })

  // I1 微修（T5 live 残余）：委派注册 fixer → 新插件状态（模拟新进程空缓存）→
  // 无 agent 信息的 CLI 续接（agent=""）不得遮蔽已注册验证身份（此前 resolved.agent=null
  // 致工具路径全员 not_original_author）
  test("i1-6: CLI resume without agent falls back to registered delegated identity", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1f"
    const scope = await setupSession(dataDir, sessionId, "fixer") // 委派注册（持久层保有 fixer）
    seedPressureBoard(scope, scope.resolveSession(sessionId).streamId, sessionId, "fixer")
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir }) // 新进程：空缓存重装配
    await plugin["chat.message"]!({ sessionID: sessionId, agent: "", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
    expect(scope.config.session_index[sessionId]!.agent).toBe("fixer") // 空串未覆盖已知身份
    // 工具路径（缓存命中）→ counts 按回退身份 fixer 判定（未修时被 null 遮蔽 → 全 protected）
    const res = await plugin.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "" })
    const out = typeof res === "string" ? res : res.output
    const parsed = JSON.parse(out) as { stream: { counts: { eligible: number; protected: number } } }
    expect(parsed.stream.counts.eligible).toBeGreaterThanOrEqual(8)
  })

  // I1-R 反例①（冷启动借道）：持久注册身份 spy + 进程 skipAgents 含 spy + CLI chat.message
  // agent=""——三级回退出 spy 后必须按 skip 语义处理：不缓存、不登记 admission、路径阻断
  test("i1-7: skip applies to final fallback identity on cold start — path blocked", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1g"
    const scope = await setupSession(dataDir, sessionId, "spy") // 持久注册身份即 spy
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    try {
      const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await plugin["chat.message"]!({ sessionID: sessionId, agent: "", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      // 可见性：空 agent transform 不注入（无缓存放行、无 admission 登记）
      const msgs = [userMsg(sessionId, "msgSeed", "bb://s/1")]
      await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      expect(msgs[0]!.parts.length).toBe(1)
      expect(scope.readMeta(scope.resolveSession(sessionId).streamId).budget.round_used).toBe(0)
      // 工具路径同样阻断
      const res = await plugin.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "" })
      const out = typeof res === "string" ? res : res.output
      expect(out).toContain("rejected")
    } finally {
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  // I1-R 反例②（缓存残留）：缓存按 build 建立后显式 spy 到达被拒——既有缓存失效并标记会话，
  // 后续空 agent 请求落入保守路径（不凭旧缓存放行）；显式有效身份重新登记后恢复
  test("i1-8: skipped identity arrival invalidates cache — empty-agent requests go conservative", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1h"
    const scope = await setupSession(dataDir, sessionId, "build")
    const streamId = scope.resolveSession(sessionId).streamId
    seedPressureBoard(scope, streamId, sessionId, "build")
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    try {
      const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await plugin["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never }) // 缓存按 build 建立
      await plugin["chat.message"]!({ sessionID: sessionId, agent: "spy", messageID: "m2" }, { message: {} as never, parts: [] as never }) // 显式 spy：拒绝 + 失效
      // 可见性：空 agent transform 不再凭旧 build 缓存做压力注入（保守路径）
      const msgs = [userMsg(sessionId, "msgSeed", "hello")]
      await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      expect(msgs[0]!.parts.length).toBe(1)
      expect(scope.readMeta(streamId).budget.round_used).toBe(0)
      // 显式有效身份重新登记后恢复（注册身份仍为 build，资格判定恢复）
      await plugin["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      const msgs2 = [userMsg(sessionId, "msgSeed", "hello")]
      await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs2 as never })
      expect(msgs2[0]!.parts.length).toBe(2) // 恢复为 build：压力候选成立 → 模板②注入
      expect(scope.readMeta(streamId).budget.round_used).toBe(1)
    } finally {
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  test("i1-9: skip taint persists across restart — empty-agent resume stays blocked until explicit re-registration", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1i"
    const scope = await setupSession(dataDir, sessionId, "build")
    const streamId = scope.resolveSession(sessionId).streamId
    seedPressureBoard(scope, streamId, sessionId, "build")
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    try {
      // 实例 A：注册 build → 显式 skip 身份到达（缓存失效 + 持久 taint 落盘）
      const pluginA = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await pluginA["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      await pluginA["chat.message"]!({ sessionID: sessionId, agent: "spy", messageID: "m2" }, { message: {} as never, parts: [] as never })
      // 实例 B：同 dataDir 全新插件状态（模拟重启，内存 taint 已失）
      const pluginB = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await pluginB["chat.message"]!({ sessionID: sessionId, agent: "", messageID: "msgSeed" }, { message: {} as never, parts: [] as never }) // 空 agent 续接：不得借旧 build 身份放行
      const msgs = [userMsg(sessionId, "msgSeed", "hello")]
      await pluginB["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      expect(msgs[0]!.parts.length).toBe(1) // 不注入
      expect(scope.readMeta(streamId).budget.round_used).toBe(0) // 不消耗预算
      const res = await pluginB.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "" })
      const out = typeof res === "string" ? res : res.output
      expect(out).toContain("rejected") // board 工具拒绝
      // 显式有效身份再登记 → 清除持久标记，恢复正常
      await pluginB["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      const msgs2 = [userMsg(sessionId, "msgSeed", "hello")]
      await pluginB["experimental.chat.messages.transform"]!({}, { messages: msgs2 as never })
      expect(msgs2[0]!.parts.length).toBe(2) // 恢复：压力候选成立 → 模板②注入
      expect(scope.readMeta(streamId).budget.round_used).toBe(1)
    } finally {
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  // I2-A：显式 skip 身份冷到达且会话已有持久 Scope——只查不建地落持久标记（此前缺口：
  // 冷入口提前 return 既不持久标记也无内存 taint，空 agent 续接借旧身份放行）
  test("i1-10: cold-entry skip arrival with existing scope persists taint via probe (T6-R4/I2-A)", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1j"
    const scope = await setupSession(dataDir, sessionId, "build")
    const streamId = scope.resolveSession(sessionId).streamId
    seedPressureBoard(scope, streamId, sessionId, "build")
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    try {
      const pluginA = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await pluginA["chat.message"]!({ sessionID: sessionId, agent: "spy", messageID: "m1" }, { message: {} as never, parts: [] as never })
      expect(scope.config.session_index[sessionId]?.skip_tainted).toBe(true) // 持久标记已落盘
      // 另一实例（模拟重启）空 agent 续接：不得借旧 build 身份放行
      const pluginB = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await pluginB["chat.message"]!({ sessionID: sessionId, agent: "", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      const msgs = [userMsg(sessionId, "msgSeed", "hello")]
      await pluginB["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      expect(msgs[0]!.parts.length).toBe(1) // 不注入
      expect(scope.readMeta(streamId).budget.round_used).toBe(0) // 不消耗预算
      const res = await pluginB.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "" })
      const out = typeof res === "string" ? res : res.output
      expect(out).toContain("rejected") // board 工具拒绝
    } finally {
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  // I2-B：跨实例持久 taint——B② 显式同名身份不得绕过标记清除；B① 热缓存空 agent 定向读持久标记
  test("i1-11: cross-instance persistent taint — same-name arrival clears, hot-cache empty-agent blocks (T6-R4/I2-B)", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1k"
    const scope = await setupSession(dataDir, sessionId, "build")
    const streamId = scope.resolveSession(sessionId).streamId
    seedPressureBoard(scope, streamId, sessionId, "build")
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    try {
      const pluginP = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await pluginP["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      // Q（同 dataDir 另一实例）：显式 skip 身份到达 → 落持久标记（P 的内存/缓存不知情）
      const pluginQ = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await pluginQ["chat.message"]!({ sessionID: sessionId, agent: "spy", messageID: "m1" }, { message: {} as never, parts: [] as never })
      // 阶段 1（I2-B②）：P 缓存仍热、显式同名 build 到达——不得提前返回跳过标记清除
      await pluginP["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      expect(scope.config.session_index[sessionId]?.skip_tainted).toBe(false) // 持久标记已清除
      const msgsA = [userMsg(sessionId, "msgSeed", "hello")]
      await pluginP["experimental.chat.messages.transform"]!({}, { messages: msgsA as never })
      expect(msgsA[0]!.parts.length).toBe(2) // 缓存身份仍有效 → 压力注入
      expect(scope.readMeta(streamId).budget.round_used).toBe(1)
      // 阶段 2（I2-B①+T6-R5/漏口1）：Q 再次落标记 → P 热缓存调用被持久 taint 阻断——
      // 与 agent 是否为空无关（工具路径只查不刷新，非空 ctx.agent 不得绕过）
      await pluginQ["chat.message"]!({ sessionID: sessionId, agent: "spy", messageID: "m2" }, { message: {} as never, parts: [] as never })
      const resH = await pluginP.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "build" })
      const outH = typeof resH === "string" ? resH : resH.output
      expect(outH).toContain("rejected") // 非空 agent 热缓存路径同样阻断（漏口1）
      const res = await pluginP.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "" })
      const out = typeof res === "string" ? res : res.output
      expect(out).toContain("rejected")
      // 恢复：显式 build 再登记 → 身份解析可用（持久标记清除；board 工具不再拒绝。
      // 注：不重复断言第二次注入——同一压力候选集受 prompted_set_hashes 去重，按设计不再注入）
      await pluginP["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      expect(scope.config.session_index[sessionId]?.skip_tainted).toBe(false)
      const res2 = await pluginP.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "build" })
      const out2 = typeof res2 === "string" ? res2 : JSON.stringify(res2.output)
      expect(out2).not.toContain("rejected")
      expect(scope.readMeta(streamId).budget.round_used).toBe(1)
    } finally {
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  // I2-C：持久化失败只丢跨重启保护——本实例必须先失效再尝试持久化，不得保留放行
  test("i1-12: skip-taint persist failure still blocks locally (T6-R4/I2-C)", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1l"
    const scope = await setupSession(dataDir, sessionId, "build")
    const streamId = scope.resolveSession(sessionId).streamId
    seedPressureBoard(scope, streamId, sessionId, "build")
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    const scopeDir = dirname(scope.lockPath)
    try {
      const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      await plugin["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      chmodSync(scopeDir, 0o555) // 注入写盘故障：markSessionSkipTainted 将抛错
      await plugin["chat.message"]!({ sessionID: sessionId, agent: "spy", messageID: "m1" }, { message: {} as never, parts: [] as never })
      expect(scope.config.session_index[sessionId]?.skip_tainted).not.toBe(true) // 持久化失败（仅丢跨重启保护）
      // 本实例仍阻断：缓存已被保守失效，空 agent 不得借旧身份放行
      const msgs = [userMsg(sessionId, "msgSeed", "hello")]
      await plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      expect(msgs[0]!.parts.length).toBe(1)
      expect(scope.readMeta(streamId).budget.round_used).toBe(0)
      const res = await plugin.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "" })
      const out = typeof res === "string" ? res : res.output
      expect(out).toContain("rejected")
    } finally {
      chmodSync(scopeDir, 0o755)
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
    // 恢复（写盘已复原）：显式 build 再登记 → 正常注入，且插件未因持久化失败整体降级
    const plugin2 = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    await plugin2["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
    const msgs2 = [userMsg(sessionId, "msgSeed", "hello")]
    await plugin2["experimental.chat.messages.transform"]!({}, { messages: msgs2 as never })
    expect(msgs2[0]!.parts.length).toBe(2)
    expect(scope.readMeta(streamId).budget.round_used).toBe(1)
  })

  // T6-R5/漏口2：冷探测失败（scope-index.json 不可解析）不得吞掉本实例失效——
  // skip 到达先本地失效再探测；索引恢复后同实例空 agent 续接仍拒绝，显式合法身份可恢复
  test("i1-13: cold probe failure keeps local invalidation, explicit identity recovers (T6-R5)", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1m"
    const scope = await setupSession(dataDir, sessionId, "build")
    const streamId = scope.resolveSession(sessionId).streamId
    const indexPath = join(dataDir, "scope-index.json")
    const indexBackup = readFileSync(indexPath, "utf8")
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    try {
      const pluginP = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      // 显式 spy 冷到达：本地失效先行 → 探测遇损坏索引抛错（旧实现此处直接外层 catch，无失效）
      writeFileSync(indexPath, "{corrupted")
      await pluginP["chat.message"]!({ sessionID: sessionId, agent: "spy", messageID: "m1" }, { message: {} as never, parts: [] as never })
      // 索引恢复后：同实例空 agent 续接——本地 taint 仍生效（探测失败只丢跨重启标记）
      writeFileSync(indexPath, indexBackup)
      const res = await pluginP.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "" })
      const out = typeof res === "string" ? res : res.output
      expect(out).toContain("rejected")
      const msgs = [userMsg(sessionId, "msgSeed", "hello")]
      await pluginP["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      expect(msgs[0]!.parts.length).toBe(1) // 身份不可用 → 保守不注入
      // T6-R6/M2：前移「未落盘」证明——必须在显式 build 恢复**之前**断言（若曾写 true
      // 后被恢复清 false 也通过则失去证明力）；恢复后的缺省/清除检查保留
      expect(scope.config.session_index[sessionId]?.skip_tainted ?? false).toBe(false) // 探测失败从未落盘（字段可缺省）
      // 恢复：显式合法身份登记 → 清除内存 taint，工具恢复
      await pluginP["chat.message"]!({ sessionID: sessionId, agent: "build", messageID: "msgSeed" }, { message: {} as never, parts: [] as never })
      const res2 = await pluginP.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "build" })
      const out2 = typeof res2 === "string" ? res2 : JSON.stringify(res2.output)
      expect(out2).not.toContain("rejected")
      expect(scope.config.session_index[sessionId]?.skip_tainted ?? false).toBe(false) // 恢复后仍无标记
    } finally {
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  // T6-R6/M1：冷工具路径探测异常 → 统一降级回执——工具结果为正常 rejected 回执
  // （unregistered_session），不得以原始 JSON 解析异常 Promise 冒泡
  test("i1-14: cold tool-path probe failure yields rejected receipt, not thrown promise (T6-R6/M1)", async () => {
    const dataDir = tmpDataDir()
    const sessionId = "ses_i1n"
    await setupSession(dataDir, sessionId, "build")
    const indexPath = join(dataDir, "scope-index.json")
    const indexBackup = readFileSync(indexPath, "utf8")
    process.env.BLACKBOARD_SKIP_AGENTS = "spy"
    try {
      const pluginP = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
      writeFileSync(indexPath, "{corrupted")
      const res = await pluginP.tool!.board_index.execute({}, { ...forgeCtx(sessionId), agent: "spy" })
      const out = typeof res === "string" ? res : res.output
      expect(out).toContain("rejected")
      expect(out).toContain("unregistered_session")
    } finally {
      writeFileSync(indexPath, indexBackup)
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  // M3：tool.definition hook 仅 task 追加，且宿主描述不以空白结尾时补段落分隔
  test("m3: tool.definition hook appends with paragraph separator on task only", async () => {
    const dataDir = tmpDataDir()
    const plugin = await BlackboardPlugin(forgeInput(dataDir), { dataDir })
    const taskOut = { description: "Delegate subtasks to agents." }
    await plugin["tool.definition"]!({ toolID: "task" }, taskOut as never)
    expect(taskOut.description).toBe(`Delegate subtasks to agents.\n\n${TASK_DESC_APPEND}`)
    const spacedOut = { description: "Delegate.\n" }
    await plugin["tool.definition"]!({ toolID: "task" }, spacedOut as never)
    expect(spacedOut.description).toBe(`Delegate.\n${TASK_DESC_APPEND}`) // 已有尾空白不重复加分隔
    const otherOut = { description: "Untouched." }
    await plugin["tool.definition"]!({ toolID: "board_put" }, otherOut as never)
    expect(otherOut.description).toBe("Untouched.")
  })

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
      budget: { ...meta.budget, round_used: 1 },
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
    expect(m1b.parts.length).toBe(1) // 无信号（"hi again"）→ no_signal 零注入
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
    expect(decision!.reason).toBe("no_signal") // 无信号 prompt → 决策留痕（§10.6）
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

  // p-agg-1（Task B Step 4 + §10.4③ 迁移）：生产接线——候选集压力注入直驱 transform；
  // 首个已验证请求直接落压力分支（无每轮初始下限，§10.7 已废除）；集合抑制跨轮持续；预算 ≤2/轮。
  test("p-agg-1: A 压力注入(模板②,无板数据) → B 同集合抑制 → C 跨轮抑制持续 → D 预算耗尽 no_budget(bytes:0 留痕) → fix-9 触发边界", async () => {
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
    // A：候选集非空 + 首个已验证请求 → pressure_reminder 注入模板②（无每轮初始下限）
    const mA = await run(["msgSeed"])
    expect(mA.parts.length).toBe(2)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("pressure_reminder")
    expect(mA.parts[1]!.text).toBe(PRESSURE_REMINDER_TEMPLATE) // 常量模板，不含板数据
    expect(mA.parts[1]!.text).not.toContain("旧记录")
    expect(byteLen(mA.parts[1]!.text)).toBeLessThanOrEqual(512)
    expect(f.scope.readMeta(f.streamId).budget.round_used).toBe(1)
    // B：同集合 → set_already_prompted（R3-2：先判集合）；同轮重发同集合 → 同因
    const mB = await run(["msgSeed", "msgB"])
    expect(mB.parts.length).toBe(1)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("set_already_prompted")
    expect(f.scope.readMeta(f.streamId).budget.round_used).toBe(1)
    const mB2 = await run(["msgSeed", "msgB", "msgB2"])
    expect(mB2.parts.length).toBe(1)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("set_already_prompted")
    expect(f.scope.readMeta(f.streamId).budget.round_used).toBe(1)
    // C：roll 后集合抑制跨轮仍生效（无初始机会再注入——§10.7）
    await f.plugin["chat.message"]!(
      { sessionID: sessionId, agent: "build", messageID: "msgC" },
      { message: {} as never, parts: [] as never },
    )
    const mC = await run(["msgC"])
    expect(mC.parts.length).toBe(1)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("set_already_prompted")
    expect(f.scope.readMeta(f.streamId).budget.round_used).toBe(0)
    const mC2 = await run(["msgC", "msgC2"])
    expect(mC2.parts.length).toBe(1)
    expect(readDecisions(dataDir).at(-1)!.reason).toBe("set_already_prompted")
    // —— D 段独立夹具：S1 压力一次 → 演变出 S2 → 压力第二次（额度 2/2）→ 演变出 S3 → no_budget 且 bytes:0 留痕 ——
    const dataDir2 = tmpDataDir()
    const sessionId2 = "ses_pd"
    const f2 = await aggFixture(dataDir2, sessionId2)
    const run2 = async (ids: string[]) => {
      const msgs = ids.map((id) => userMsg(sessionId2, id, "hi"))
      await f2.plugin["experimental.chat.messages.transform"]!({}, { messages: msgs as never })
      return msgs.at(-1)!
    }
    const mA2 = await run2(["msgSeed"])
    expect(readDecisions(dataDir2).at(-1)!.reason).toBe("pressure_reminder")
    const mB1 = await run2(["msgSeed", "msgS1"])
    expect(readDecisions(dataDir2).at(-1)!.reason).toBe("set_already_prompted")
    // 候选集合演变：撤回首个成员 → 首批 16 eligible 变化 → 新集合 S2
    const first = f2.scope.readEntry(f2.streamId, 1)!
    f2.scope.markTombstone(f2.streamId, first.id, "撤回")
    const mB2d = await run2(["msgSeed", "msgS1", "msgS2"])
    expect(mB2d.parts.length).toBe(2)
    expect(readDecisions(dataDir2).at(-1)!.reason).toBe("pressure_reminder")
    expect(f2.scope.readMeta(f2.streamId).budget.round_used).toBe(2)
    // 再撤回一个成员 → S3：集合检查通过但额度耗尽 → no_budget，bytes:0 留痕
    const second = f2.scope.readEntry(f2.streamId, 2)!
    f2.scope.markTombstone(f2.streamId, second.id, "撤回")
    const mB3 = await run2(["msgSeed", "msgS1", "msgS2", "msgS3"])
    expect(mB3.parts.length).toBe(1)
    expect(readDecisions(dataDir2).at(-1)!.reason).toBe("no_budget")
    expect(readDecisions(dataDir2).at(-1)!.bytes).toBe(0)
    const mB4 = await run2(["msgSeed", "msgS1", "msgS2", "msgS3", "msgS3b"])
    expect(mB4.parts.length).toBe(1)
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
    // 第二段：transform 含 M1 → 关联验证推进；无信号 prompt → no_signal 零注入零预算
    const m1 = await tx(["msg_1"])
    let meta = scope.readMeta(streamId)
    expect(meta.rounds.current_round).toBe(1)
    expect(meta.budget.round_id).toBe("msg_1")
    expect(meta.budget.round_used).toBe(0)
    expect(m1.parts.length).toBe(1)
    // 手置轮内额度已消耗——未验证 transform 不得重置/回滚额度（§10.3 预算依附身份，fix-11 断言点）
    scope.writeMeta(streamId, { ...meta, budget: { ...meta.budget, round_used: 1 } })
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
