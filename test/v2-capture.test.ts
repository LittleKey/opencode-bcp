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
  // 重复事件测试的确定性等待：按事件名计数等待「新」终结日志出现。既有 settle 只判定
  // 是否已存在任一 final_capture/delivery_observation——同一事件的后续事件（重复终稿、
  // unconfirmed 之后又 stored）会立即返回；按计数等待，超时返回让断言给出明确失败。
  const settleFor = async (ev: string, minCount: number): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (logLines().filter((l) => l.ev === ev).length >= minCount) {
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
    settleFor,
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
    await h.settleFor("final_capture", 2)
    const again = h.logLines().filter((l) => l.ev === "final_capture").pop() as { status: string; id: string }
    expect(again.status).toBe("replay")
    expect(again.id).toBe(final.id)
    expect(h.entryCount("s1")).toBe(1)
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

// Oracle 裁决（bb://08f43290-4450-4bb9-9773-5d7efbe15e82/175b5d3e-02b1-4e65-9f83-8767d92ba52c/e000001）冻结的条件 system 注入回归：AUTO 门控 =
// `autoCapture && confirmed !== null`（src/adapters/v2/index.ts），confirmed 为尾 user
// 且其 id 在候选池；与 nudge 的 boundary/request 门控相互独立（两门控不得混写）。
// 本组只文档测试现状，不改生产逻辑。
describe("v2 AUTO 条件 system 注入门控（冻结裁决回归）", () => {
  const noAuto = (system: Array<{ type?: string; text?: string }>) => {
    expect(system.some((p) => p?.text === AUTO_CAPTURE_INSTRUCTION)).toBe(false)
  }
  const autoCount = (system: Array<{ type?: string; text?: string }>) =>
    system.filter((p) => p?.text === AUTO_CAPTURE_INSTRUCTION).length

  test("正常业务输入：已有 system 内容与顺序保留、恰好一份；prompt 与消息原对象不被改动", async () => {
    const h = await makeAutoHost({
      sessions: { sA: { id: "sA", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
    })
    const promptInput = { sessionID: "sA", messageID: "uA1", prompt: { text: "task one" } }
    await h.hooks.prompt(promptInput as never)
    const uA1 = um("uA1", "task one")
    const msgs = [uA1]
    const before = JSON.parse(JSON.stringify(msgs))
    // fake SDK 的 ctx.session 只有 get/context/hook，没有 instructions 字段——注入不得依赖
    // ctx.session.instructions（依赖即导致 AUTO 缺席或抛错）。
    const system: Array<{ type?: string; text?: string }> = [
      { type: "text", text: "identity-contract" },
      { type: "text", text: "tool-guide" },
    ]
    await h.hooks.context({ sessionID: "sA", agent: "author", messages: msgs, system } as never)
    // 已有内容与顺序保留，AUTO 追加在末尾，恰好一份
    expect(system.map((p) => p?.text)).toEqual(["identity-contract", "tool-guide", AUTO_CAPTURE_INSTRUCTION])
    expect(autoCount(system)).toBe(1)
    // AUTO 只追加 system 槽位：prompt 观测原文与消息原对象保持不变
    expect((promptInput.prompt as { text: string }).text).toBe("task one")
    expect(msgs.length).toBe(1)
    expect(msgs[0]).toBe(uA1)
    expect(msgs).toEqual(before)
  })

  test("重复与重试：同 draft 重入仍一份、预置同文本不重复、新 draft 重试与工具续步各一份", async () => {
    const h = await makeAutoHost({
      sessions: { sB: { id: "sB", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
    })
    await h.hooks.prompt({ sessionID: "sB", messageID: "uB1", prompt: { text: "task" } } as never)
    const msgs = [um("uB1", "task")]
    // 同一 draft 重入（宿主复用同一 system 数组再次执行 context hook）：至多一份
    const system: Array<{ type?: string; text?: string }> = []
    await h.hooks.context({ sessionID: "sB", agent: "author", messages: msgs, system } as never)
    await h.hooks.context({ sessionID: "sB", agent: "author", messages: msgs, system } as never)
    expect(autoCount(system)).toBe(1)
    // 预置相同文本：查重前置，不重复追加
    const seeded: Array<{ type?: string; text?: string }> = [{ type: "text", text: AUTO_CAPTURE_INSTRUCTION }]
    await h.hooks.context({ sessionID: "sB", agent: "author", messages: msgs, system: seeded } as never)
    expect(autoCount(seeded)).toBe(1)
    // 新 draft（重试重建 system 数组）：重新评估仍恰好一份，无「会话只注入一次」缓存
    const retry = await h.admit("sB", "author", "uB1", "task")
    expect(autoCount(retry)).toBe(1)
    // 工具续步（尾部无 id 的 role:"tool" call-result 可跳过）：同一业务输入的续步请求各一份
    const cont: Array<{ type?: string; text?: string }> = []
    await h.hooks.context({
      sessionID: "sB",
      agent: "author",
      messages: [
        um("uB1", "task"),
        { id: "aB1", role: "assistant", content: [{ type: "text", text: "working" }] },
        { role: "tool", content: "result" },
      ],
      system: cont,
    } as never)
    expect(autoCount(cont)).toBe(1)
  })

  test("未确认输入不注入：无 prompt 观测 / 历史旧候选不能兜底 / 无 id 尾 user / 宿主 synthetic 通知", async () => {
    const h = await makeAutoHost({
      sessions: {
        c1: { id: "c1", agent: "author" },
        c2: { id: "c2", agent: "author" },
        c3: { id: "c3", agent: "author" },
        c4: { id: "c4", agent: "author" },
      },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
    })
    // ① 无 prompt 观测：候选池为空，即便尾 user 有 id 也不注入
    const s1: Array<{ type?: string; text?: string }> = []
    await h.hooks.context({ sessionID: "c1", agent: "author", messages: [um("uC1", "input")], system: s1 } as never)
    noAuto(s1)
    // ② 历史旧候选不能兜底：uOld 在候选池，但当前输入槽位（尾 user）是未观测的 uNew
    await h.hooks.prompt({ sessionID: "c2", messageID: "uOld", prompt: { text: "old input" } } as never)
    const s2: Array<{ type?: string; text?: string }> = []
    await h.hooks.context({
      sessionID: "c2",
      agent: "author",
      messages: [
        um("uOld", "old input"),
        { id: "aC2", role: "assistant", content: [{ type: "text", text: "done" }] },
        um("uNew", "newer input"),
      ],
      system: s2,
    } as never)
    noAuto(s2)
    // ③ 无 id 尾 user：无关联资格（failed:false fail closed）
    await h.hooks.prompt({ sessionID: "c3", messageID: "uC3", prompt: { text: "input" } } as never)
    const s3: Array<{ type?: string; text?: string }> = []
    await h.hooks.context({
      sessionID: "c3",
      agent: "author",
      messages: [um("uC3", "input"), { role: "user", content: [{ type: "text", text: "continue" }] }],
      system: s3,
    } as never)
    noAuto(s3)
    // ④ 宿主 synthetic 通知：prompt 观测不构成 admission 候选（admitted:false），
    // 后续 context 也不因该文本注入
    await h.hooks.prompt({ sessionID: "c4", messageID: "uS4", prompt: { text: "[blackboard] background job finished" } } as never)
    expect(h.logLines().some((l) => l.ev === "round_observed" && l.admitted === false)).toBe(true)
    const s4: Array<{ type?: string; text?: string }> = []
    await h.hooks.context({ sessionID: "c4", agent: "author", messages: [um("uS4", "[blackboard] background job finished")], system: s4 } as never)
    noAuto(s4)
  })

  test("两种门控分离：确认输入但请求边界 unknown——AUTO 按现状注入，nudge 保守失效不推进预算", async () => {
    const h = await makeAutoHost({
      sessions: { sD: { id: "sD", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
    })
    await h.hooks.prompt({ sessionID: "sD", messageID: "uD1", prompt: { text: "task" } } as never)
    const system: Array<{ type?: string; text?: string }> = []
    // 尾部为无 id 的非 tool 消息（无法证明请求边界）→ boundary unknown；AUTO 的业务
    // 输入确认门控独立评估（尾 user uD1 有 id 且在候选池）→ 照常注入一份。
    await h.hooks.context({
      sessionID: "sD",
      agent: "author",
      messages: [um("uD1", "task"), { role: "assistant", content: [{ type: "text", text: "pending" }] }],
      system,
    } as never)
    expect(autoCount(system)).toBe(1)
    // nudge 走既有保守失效事务：request_id 归并为 unknown、identity_unrecoverable、
    // 预算不推进（round_used/bytes 均 0）、无轮次推进日志。
    const decision = h.logLines().find((l) => l.ev === "decision") as {
      request_id: string
      reason: string
      round_used: number
      bytes: number
    }
    expect(decision.request_id).toBe("sD:unknown")
    expect(decision.reason).toBe("identity_unrecoverable")
    expect(decision.round_used).toBe(0)
    expect(decision.bytes).toBe(0)
    expect(h.logLines().some((l) => l.ev === "round")).toBe(false)
  })

  test("模式与兼容：autoCapture:false 不注入；缺少 system 数组不阻塞请求管线", async () => {
    const manual = await makeAutoHost({
      sessions: { sE1: { id: "sE1", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
      autoCapture: false,
    })
    const sysManual = await manual.admit("sE1", "author", "uE1", "task")
    expect(autoCount(sysManual)).toBe(0)
    expect(sysManual.length).toBe(0)
    // 缺少 system 数组：AUTO 静默跳过不抛错，既有 nudge 管线照常走完（决策事务完成）
    const h = await makeAutoHost({
      sessions: { sE2: { id: "sE2", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
    })
    await h.hooks.prompt({ sessionID: "sE2", messageID: "uE2", prompt: { text: "task" } } as never)
    const ran = await h.hooks.context({ sessionID: "sE2", agent: "author", messages: [um("uE2", "task")] } as never)
    expect(ran).toBeUndefined()
    const decision = h.logLines().find((l) => l.ev === "decision") as { reason: string }
    expect(decision.reason).toBe("no_signal")
  })

  test("留存安全：回复含 NO_STORE → skipped publication_restricted 不落盘", async () => {
    const completed = Date.now() + 60_000
    const h = await makeAutoHost({
      sessions: { sF: { id: "sF", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
      context: {
        sF: [wu("uF", "in"), wa("aF", { agent: "author", finish: "stop", completed, text: "internal notes\n<!-- bcp:no-store -->" })],
      },
    })
    await h.admit("sF", "author", "uF", "in")
    h.emit("session.step.ended", { sessionID: "sF", assistantMessageID: "aF", finish: "stop" })
    await h.settle()
    const final = h.logLines().find((l) => l.ev === "final_capture") as { status: string; reason?: string; id?: string }
    expect(final.status).toBe("skipped")
    expect(final.reason).toBe("publication_restricted")
    expect(final.id).toBeUndefined()
    expect(h.entryCount("sF")).toBe(0)
  })

  test("synthetic 续步：回复带保存标记也不能替代当前输入关联（fail closed）；随后正常输入照常留存", async () => {
    const completed = Date.now() + 60_000
    const h = await makeAutoHost({
      sessions: { sG: { id: "sG", agent: "author" }, sG2: { id: "sG2", agent: "author" } },
      agents: [{ id: "author", name: "Author", permissions: FULL_RULES }],
      // sG 的 wire 只含 aG1（assistant 无前驱 user → 无推导 parentID）；标记置于 wire
      // 文本（waitCompleted 的 wire refresh 是权威视图，会覆盖 ordinal 0 观测文本）。
      // sG2 的装配上下文只在第二步前注入。
      context: {
        sG: [wa("aG1", { agent: "author", finish: "stop", completed, text: 'done\n<!-- bcp:store description="topic; result; limit" -->' })],
        sG2: [wu("uG2", "second"), wa("aG2", { agent: "author", finish: "stop", completed, text: 'ok\n<!-- bcp:store description="second; stored; limit" -->' })],
      },
    })
    await h.admit("sG", "author", "uG1", "first")
    // synthetic 续步请求：尾 user 无 id → confirmed=null → 不注入，且运行输入关联清空
    const cont: Array<{ type?: string; text?: string }> = []
    await h.hooks.context({
      sessionID: "sG",
      agent: "author",
      messages: [
        um("uG1", "first"),
        { id: "aG0", role: "assistant", content: [{ type: "text", text: "step" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
      system: cont,
    } as never)
    noAuto(cont)
    // 续步回复带保存标记：标记本身不构成当前业务输入关联 → unconfirmed，不落盘。
    // text.ended 与 wire 文本一致（真实事件流；wire refresh 会以权威 wire 文本覆盖观测）。
    h.emit("session.text.ended", { sessionID: "sG", assistantMessageID: "aG1", ordinal: 0, text: 'done\n<!-- bcp:store description="topic; result; limit" -->' })
    h.emit("session.step.ended", { sessionID: "sG", assistantMessageID: "aG1", finish: "stop" })
    await h.settle()
    const final = h.logLines().find((l) => l.ev === "final_capture") as {
      status: string
      reason?: string
      message_id?: string
      id?: string
    }
    expect(final.message_id).toBe("aG1")
    expect(final.status).toBe("unconfirmed")
    expect(final.reason).toBe("not_completed_author_reply")
    expect(final.id).toBeUndefined()
    expect(h.entryCount("sG")).toBe(0)
    // 既有管线不受影响：随后正常确认输入的终稿照常留存（按计数等待新终结日志）
    await h.admit("sG2", "author", "uG2", "second")
    h.emit("session.text.ended", { sessionID: "sG2", assistantMessageID: "aG2", ordinal: 0, text: 'ok\n<!-- bcp:store description="second; stored; limit" -->' })
    h.emit("session.step.ended", { sessionID: "sG2", assistantMessageID: "aG2", finish: "stop" })
    await h.settleFor("final_capture", 2)
    const second = h.logLines().filter((l) => l.ev === "final_capture").pop() as { status: string; id?: string }
    expect(second.status).toBe("stored")
    expect(second.id).toBeDefined()
    expect(h.entryCount("sG2")).toBe(1)
  })
})
