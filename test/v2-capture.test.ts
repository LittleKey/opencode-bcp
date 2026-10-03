// v2 自动留存与权限 fail-closed（test/v2-*.test.ts 范围）。
// 夹具形状按 @opencode/plugin 2.0.20（ctx.agent.list / ctx.session.context /
// session.text.ended|step.ended 事件 / context hook 的 system 数组），消息为 2.0.20
// wire（SessionMessageInfo，无 parentID——父子关系由适配层建立）。
// 断言全部走真实共享核（storage/capture/reply）与真磁盘 dataDir。
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlackboardV2Plugin } from "../src/adapters/v2/index"
import { listIndex } from "../src/indexing"
import { openScopeById } from "../src/storage"
import { AUTO_CAPTURE_INSTRUCTION, AUTO_TASK_DESC_APPEND, TASK_DESC_APPEND } from "../src/constants"

type Wire = Record<string, unknown>
type SessionRow = { id: string; parentID?: string | null; agent?: string; permissions?: unknown; location?: unknown }
type AddedTool = { name: string; description: string; execute: (raw: unknown, tctx: { sessionID: string; agent: string; messageID: string }) => Promise<{ content: string }> }

const wu = (id: string, text: string): Wire => ({ id, type: "user", text, time: { created: 1 } })
const wa = (id: string, o: { agent: string; text: string; finish?: string; completed?: number; modelID?: string; providerID?: string }): Wire => ({
  id,
  type: "assistant",
  agent: o.agent,
  model: { id: o.modelID ?? "model-x", providerID: o.providerID ?? "prov-y" },
  content: [{ type: "text", text: o.text }],
  ...(o.finish === undefined ? {} : { finish: o.finish }),
  time: { created: 2, ...(o.completed === undefined ? {} : { completed: o.completed }) },
})
const um = (id: string, text = "input") => ({ id, role: "user", content: [{ type: "text", text }] })

const CLEANUPS: string[] = []
afterEach(() => {
  for (const dir of CLEANUPS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function makeAutoHost(opts: {
  sessions: Record<string, SessionRow>
  // AgentInfo 形状（@opencode/schema/agent）：授权主体是 id；name 仅为显示名。
  agents?: Array<{ id: string; name?: string; permissions?: unknown }>
  context?: Record<string, Wire[]>
  autoCapture?: boolean
}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-v2-capture-"))
  CLEANUPS.push(dataDir)
  const sessions: Record<string, SessionRow> = {}
  for (const [id, row] of Object.entries(opts.sessions)) {
    sessions[id] = { location: { directory: dataDir, project: { directory: dataDir, canonical: dataDir } }, ...row }
  }
  const waiters: Array<(r: { value: unknown; done: boolean }) => void> = []
  const queued: Array<{ type: string; data?: unknown }> = []
  const logLines = (): Array<Record<string, unknown>> =>
    existsSync(join(dataDir, "log/blackboard.log"))
      ? (readFileSync(join(dataDir, "log/blackboard.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) as Array<Record<string, unknown>>)
      : []
  const emit = (type: string, data?: unknown): void => {
    const w = waiters.shift()
    if (w) w({ value: { type, data }, done: false })
    else queued.push({ type, data })
  }
  const settle = async (): Promise<void> => {
    // 终结事件由插件异步落盘（waitCompleted 有界轮询 ≈200ms 后才写 final_capture），
    // 固定短睡会与处理循环竞态：等待终结日志出现（final_capture/delivery_observation），
    // 上限 2s，超时返回让断言给出明确失败。
    for (let i = 0; i < 200; i++) {
      const hit = logLines().some((l) => l.ev === "final_capture" || l.ev === "delivery_observation")
      if (hit) {
        await new Promise((r) => setTimeout(r, 10))
        return
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const added: AddedTool[] = []
  const subagent = { id: "subagent", description: "Delegate work.", execute: async () => ({}) }
  const hooks: Record<string, (input: never) => Promise<void> | void> = {}
  const ctx = {
    options: { dataDir, ...(opts.autoCapture === undefined ? {} : { autoCapture: opts.autoCapture }) },
    location: { directory: dataDir },
    agent: { list: () => opts.agents ?? [] },
    tool: {
      transform: async (cb: (editor: never) => Promise<void> | void) => {
        const editor = {
          add: (tool: AddedTool) => added.push(tool),
          update: (id: string, fn: (tool: { description: string }) => void) => {
            if (id === "subagent") fn(subagent)
          },
          get: () => undefined,
          list: () => [],
          remove: () => {},
          namespace: () => {},
        }
        await cb(editor as never)
      },
      hook: async (name: string, cb: (input: never) => Promise<void> | void) => {
        hooks[`tool:${name}`] = cb
        return { dispose: async () => {} }
      },
    },
    session: {
      get: async (input: { sessionID: string }) => sessions[input.sessionID] ?? null,
      context: async (input: { sessionID: string }) => opts.context?.[input.sessionID] ?? [],
      hook: async (name: string, cb: (input: never) => Promise<void> | void) => {
        hooks[name] = cb
        return { dispose: async () => {} }
      },
    },
    event: {
      // 2.0.20 真实面：subscribe(options?) 同步返回 AsyncIterable（SharedEvents.SubscribeOptions）。
      subscribe: (input: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<{ value: unknown; done: boolean }> => {
            if (input.signal.aborted) return { value: undefined, done: true }
            const q = queued.shift()
            if (q) return { value: q, done: false }
            return await new Promise((resolve) => {
              waiters.push((r) => (input.signal.aborted ? resolve({ value: undefined, done: true }) : resolve(r)))
            })
          },
        }),
      }),
    },
  }
  await BlackboardV2Plugin.setup(ctx as never)
  return {
    dataDir,
    emit,
    settle,
    added,
    subagent,
    hooks,
    admit: async (sessionID: string, agent: string, userId: string, text = "input") => {
      await hooks.prompt({ sessionID, messageID: userId, prompt: { text } } as never)
      const system: Array<{ type?: string; text?: string }> = []
      await hooks.context({ sessionID, agent, messages: [um(userId, text)], system } as never)
      return system
    },
    logLines,
    scopeOf: (root: string) => {
      const index = JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8")) as { scopes?: Record<string, string> }
      return openScopeById(index.scopes![root]!, { dataDir })
    },
    // 真实存储 API（src/indexing.listIndex）：统计会话流可见条目数。
    entryCount: (root: string, sessionId = root) => {
      const scope = openScopeById(
        (JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8")) as { scopes?: Record<string, string> }).scopes![root]!,
        { dataDir },
      )
      return listIndex(scope, scope.resolveSession(sessionId).streamId, { limit: 50, caller: { sessionId, agent: "" } }).items.length
    },
  }
}

const FULL_RULES = [
  { action: "board_store", resource: "*", effect: "allow" },
  { action: "board_get", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
]

describe("v2 auto-capture 工具面与契约切换", () => {
  test("auto 模式注册 board_store、不注册 board_put；subagent 描述切换为 auto 契约", async () => {
    const h = await makeAutoHost({ sessions: { s1: { id: "s1" } } })
    const names = h.added.map((t) => t.name)
    expect(names).toContain("board_store")
    expect(names).not.toContain("board_put")
    expect(names).toContain("board_get")
    expect(h.subagent.description).toContain(AUTO_TASK_DESC_APPEND)
    expect(h.subagent.description).not.toContain(TASK_DESC_APPEND)
  })

  test("manual 模式（autoCapture:false）保留 board_put 与手动契约", async () => {
    const h = await makeAutoHost({ sessions: { s1: { id: "s1" } }, autoCapture: false })
    expect(h.added.map((t) => t.name)).toContain("board_put")
    expect(h.subagent.description).toContain(TASK_DESC_APPEND)
  })
})

describe("v2 自动留存（session.step.ended finish=stop）", () => {
  test("终结回复以宿主鉴权自动留存：作者身份、输入关联、marker 屏蔽、幂等 replay", async () => {
    const completed = Date.now() + 60_000
    const h = await makeAutoHost({
      sessions: { s1: { id: "s1", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
      context: {
        s1: [wu("u1", "input one"), wa("a1", { agent: "author", finish: "stop", completed, text: 'done\n<!-- bcp:store description="topic; result; limit" -->' })],
      },
    })
    await h.admit("s1", "author", "u1", "input one")
    h.emit("session.step.ended", { sessionID: "s1", assistantMessageID: "a1", finish: "stop" })
    await h.settle()
    const final = h.logLines().find((l) => l.ev === "final_capture") as { status: string; id: string }
    expect(final.status).toBe("stored")
    const scope = h.scopeOf("s1")
    const found = scope.getById(final.id)
    expect(found.status).toBe("found")
    const record = (found as unknown as { record: Record<string, unknown> & { writer: Record<string, string>; origin: Record<string, unknown> } }).record
    expect(record.writer).toMatchObject({ agent: "author", session_id: "s1", message_id: "a1" })
    expect(record.origin.kind).toBe("host_final")
    expect(record.origin.input_message_id).toBe("u1")
    expect(record.description).toBe("topic; result; limit")
    // 原文保真是共享核契约（对照 test/capture.test.ts:121：入库含原始 marker）；对外交付由 publicReply/mask 屏蔽。
    expect(record.content).toBe('done\n<!-- bcp:store description="topic; result; limit" -->')
    // 重放同终结：幂等 replay，不重复入库
    h.emit("session.step.ended", { sessionID: "s1", assistantMessageID: "a1", finish: "stop" })
    await h.settle()
    const again = h.logLines().filter((l) => l.ev === "final_capture").pop() as { status: string; id: string }
    expect(again.status).toBe("replay")
    expect(again.id).toBe(final.id)
  })

  test("输入含 NO_STORE：skipped publication_restricted，不落盘", async () => {
    const completed = Date.now() + 60_000
    const h = await makeAutoHost({
      sessions: { s2: { id: "s2", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
      context: {
        s2: [wu("u2", "off record <!-- bcp:no-store -->"), wa("a2", { agent: "author", finish: "stop", completed, text: "answer <!-- bcp:store -->" })],
      },
    })
    await h.admit("s2", "author", "u2", "off record <!-- bcp:no-store -->")
    h.emit("session.step.ended", { sessionID: "s2", assistantMessageID: "a2", finish: "stop" })
    await h.settle()
    const final = h.logLines().find((l) => l.ev === "final_capture") as { status: string; reason?: string }
    expect(final.status).toBe("skipped")
    expect(final.reason).toBe("publication_restricted")
    expect(h.entryCount("s2")).toBe(0)
  })

  test("agent 权限缺失（无 board_store allow）：fail closed，不落盘", async () => {
    const completed = Date.now() + 60_000
    const h = await makeAutoHost({
      sessions: { s3: { id: "s3", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: [{ action: "read", resource: "*", effect: "allow" }] }],
      context: {
        s3: [wu("u3", "in"), wa("a3", { agent: "author", finish: "stop", completed, text: "text\n<!-- bcp:store -->" })],
      },
    })
    await h.admit("s3", "author", "u3", "in")
    h.emit("session.step.ended", { sessionID: "s3", assistantMessageID: "a3", finish: "stop" })
    await h.settle()
    const final = h.logLines().find((l) => l.ev === "final_capture") as { status: string; reason?: string; id?: string }
    // 共享核契约：无 board_store allow → skipped publication_not_authorized（src/capture.ts，见 test/capture.test.ts:281），
    // 同样 fail closed：不落盘、无 id。
    expect(final.status).toBe("skipped")
    expect(final.reason).toBe("publication_not_authorized")
    expect(final.id).toBeUndefined()
    expect(h.entryCount("s3")).toBe(0)
  })

  test("终结消息不在宿主装配上下文中：unconfirmed 且缺失事实可见（无 toast 原语的显式记录）", async () => {
    const h = await makeAutoHost({
      sessions: { s4: { id: "s4", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
      context: {}, // context 为空：消息原文不可得
    })
    await h.admit("s4", "author", "u4", "in")
    h.emit("session.step.ended", { sessionID: "s4", assistantMessageID: "ghost", finish: "stop" })
    await h.settle()
    const final = h.logLines().find((l) => l.ev === "final_capture") as { status: string; reason?: string }
    expect(final.status).toBe("unconfirmed")
    const gap = h.logLines().find((l) => l.ev === "final_capture_unconfirmed") as { notice?: string }
    expect(gap.notice).toContain("tui_toast_unavailable")
  })

  test("auto 契约注入 context hook 的 system（确认的输入，恰好一份）", async () => {
    const h = await makeAutoHost({
      sessions: { s5: { id: "s5", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
    })
    const sys1 = await h.admit("s5", "author", "u5", "first")
    expect(sys1.filter((p) => p?.text === AUTO_CAPTURE_INSTRUCTION).length).toBe(1)
    const sys2 = await h.admit("s5", "author", "u6", "second")
    expect(sys2.filter((p) => p?.text === AUTO_CAPTURE_INSTRUCTION).length).toBe(1)
  })
})

describe("v2 授权按 AgentInfo.id（原生 Build id=build、显示名 Build）", () => {
  test("原生 Build（id=build，name=Build）：按 id 鉴权自动留存，writer 记录 id 而非显示名", async () => {
    const completed = Date.now() + 60_000
    const h = await makeAutoHost({
      sessions: { b1: { id: "b1", agent: "build" } },
      // 2.0.20 原生内建：AgentInfo {id:"build", name:"Build"}——id 与显示名不同。
      agents: [{ id: "build", name: "Build", permissions: FULL_RULES }],
      context: {
        b1: [wu("ub1", "native build input"), wa("ab1", { agent: "build", finish: "stop", completed, text: 'done\n<!-- bcp:store description="build; native id; limit" -->' })],
      },
    })
    await h.admit("b1", "build", "ub1", "native build input")
    h.emit("session.step.ended", { sessionID: "b1", assistantMessageID: "ab1", finish: "stop" })
    await h.settle()
    const final = h.logLines().find((l) => l.ev === "final_capture") as { status: string; id?: string }
    expect(final.status).toBe("stored")
    const record = (h.scopeOf("b1").getById(final.id!) as unknown as { record: { writer: Record<string, string>; origin: Record<string, unknown> } }).record
    expect(record.writer).toMatchObject({ agent: "build", session_id: "b1", message_id: "ab1" })
    expect(record.origin.kind).toBe("host_final")
    expect(record.origin.input_message_id).toBe("ub1")
  })

  test("显示名不可当授权主体：identity=Build（无此 id 的 profile）→ fail closed 不落盘", async () => {
    const completed = Date.now() + 60_000
    const h = await makeAutoHost({
      sessions: { b2: { id: "b2", agent: "Build" } },
      agents: [{ id: "build", name: "Build", permissions: FULL_RULES }],
      context: {
        b2: [wu("ub2", "impersonation input"), wa("ab2", { agent: "Build", finish: "stop", completed, text: "text\n<!-- bcp:store -->" })],
      },
    })
    await h.admit("b2", "Build", "ub2", "impersonation input") // 声称显示名，非 Agent.ID
    h.emit("session.step.ended", { sessionID: "b2", assistantMessageID: "ab2", finish: "stop" })
    await h.settle()
    const final = h.logLines().find((l) => l.ev === "final_capture") as { status: string; reason?: string; id?: string }
    expect(final.status).toBe("skipped")
    expect(final.reason).toBe("publication_not_authorized")
    expect(final.id).toBeUndefined()
    expect(h.entryCount("b2")).toBe(0)
  })
})
