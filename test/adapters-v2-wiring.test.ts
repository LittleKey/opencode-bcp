// v2 adapter 接线级测试（复审最小必办 2）：真实 adapter 状态机（src/adapters/v2/index.ts）
// + 真实共享 core（storage/nudge/rounds/aggregate/tools）+ 夹具宿主（内存 session 表、
// 捕获 hooks、真磁盘临时 dataDir）。覆盖 I1/I2/I3/I4 反例与 unknown 失效→恢复。
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlackboardV2Plugin } from "../src/adapters/v2/index"
import { openScopeById } from "../src/storage"
import { PRESSURE_REMINDER_TEMPLATE, TASK_DESC_APPEND } from "../src/constants"

type Msg = { id?: string; role: string; content: Array<{ type: string; text?: string; [k: string]: unknown }> }
type CtxInput = { sessionID: string; agent: string; messages: Msg[] }

const u = (id: string, text = "input"): Msg => ({ id, role: "user", content: [{ type: "text", text }] })
// v2 规范形状（packages/ai/src/schema/messages.ts:130-159）：call {id,name,input} / result {id,name,result}，
// 每组按前置 assistant id 配对唯一调用 ID；tool-result 消息本身无 id（宿主形状）。
const a = (id: string): Msg => ({ id, role: "assistant", content: [{ type: "text", text: "working" }, { type: "tool-call", id: `call-${id}`, name: "tool", input: {} }] })
const t = (anchor = "a1"): Msg => ({ role: "tool", content: [{ type: "tool-result", id: `call-${anchor}`, name: "tool", result: { type: "text", value: "ok" } }] })

async function makeHost(sessions: Record<string, { id: string; parentID?: string | null; agent?: string }>) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-v2-wiring-"))
  const hostEvents: Array<{ type: string; data?: unknown }> = []
  const eventWaiters: Array<(r: { value: unknown; done: boolean }) => void> = []
  const emit = (type: string, data?: unknown): void => {
    const ev = { type, data }
    const w = eventWaiters.shift()
    if (w) w({ value: ev, done: false })
    else hostEvents.push(ev)
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5))
  }
  const added: Array<{ name: string; execute: (raw: unknown, tctx: { sessionID: string; agent: string; messageID: string }) => Promise<{ content: string }> }> = []
  const subagent = { id: "subagent", description: "Delegate work.", execute: async () => ({}) }
  const hooks: Record<string, (input: never) => Promise<void> | void> = {}
  let transformCb: ((editor: never) => Promise<void> | void) | null = null
  const ctx = {
    options: { dataDir },
    tool: {
      transform: async (cb: (editor: never) => Promise<void> | void) => {
        transformCb = cb
        const editor = {
          add: (tool: { name: string }) => added.push(tool as never),
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
    },
    session: {
      get: async (input: { sessionID: string }) => sessions[input.sessionID] ?? null,
      hook: async (name: string, cb: (input: never) => Promise<void> | void) => {
        hooks[name] = cb
        return { dispose: async () => {} }
      },
    },
    event: {
      // 可控事件泵：测试用 emit() 投递 created/forked，settle() 等后台消费循环排空。
      subscribe: (_opts?: unknown) => {
        const iterator = {
          next: (): Promise<{ value: unknown; done: boolean }> => {
            const ev = hostEvents.shift()
            if (ev) return Promise.resolve({ value: ev, done: false })
            return new Promise((resolve) => eventWaiters.push(resolve))
          },
          [Symbol.asyncIterator]: () => iterator,
        }
        return iterator
      },
    },
  }
  const cleanup = await BlackboardV2Plugin.setup(ctx as never)
  const prompt = async (sessionId: string, messageId: string, text = "input"): Promise<void> => {
    await hooks.prompt!({ sessionID: sessionId, messageID: messageId, prompt: { text } } as never)
  }
  const context = async (input: CtxInput): Promise<void> => {
    await hooks.context!(input as never)
  }
  const tool = async (name: string, tctx: { sessionID: string; agent: string; messageID: string }, raw: unknown) => {
    const def = added.find((x) => x.name === name)
    if (!def) throw new Error(`tool not registered: ${name}`)
    return def.execute(raw, tctx)
  }
  // 真实存储读取：scope-index.json → openScopeById → meta/entry
  const scopeOf = (sessionId: string) => {
    const indexPath = join(dataDir, "scope-index.json")
    if (!existsSync(indexPath)) return null
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as { scopes?: Record<string, string> }
    const root = sessions[sessionId]?.parentID === null || !sessions[sessionId]?.parentID ? sessionId : sessions[sessionId]!.parentID!
    const scopeId = index.scopes?.[root]
    if (!scopeId) return null
    return openScopeById(scopeId, { dataDir })
  }
  const meta = (sessionId: string) => {
    const scope = scopeOf(sessionId)!
    return scope.readMeta(scope.resolveSession(sessionId).streamId)
  }
  const sessionIndex = (sessionId: string) => {
    const scope = scopeOf(sessionId)!
    return scope.config.session_index[sessionId]
  }
  const close = () => {
    try {
      cleanup?.()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
  return { dataDir, added, subagent, transformCb, emit, settle, prompt, context, tool, meta, sessionIndex, scopeOf, close }
}

const hosts: Array<{ close: () => void }> = []
afterEach(() => {
  while (hosts.length > 0) hosts.pop()!.close()
  delete process.env.BLACKBOARD_SKIP_AGENTS
  delete process.env.BLACKBOARD_ISOLATED_AGENTS
})

function track<T extends { close: () => void }>(h: T): T {
  hosts.push(h)
  return h
}

describe("v2 adapter 接线（I1 身份刷新）", () => {
  test("context 每次以实际 agent 权威刷新：build→councillor 切换更新注册身份与 isolated", async () => {
    const h = track(await makeHost({ ses_i1: { id: "ses_i1", parentID: null } }))
    const msgs = [u("u1")]
    await h.context({ sessionID: "ses_i1", agent: "build", messages: msgs })
    expect(h.sessionIndex("ses_i1")?.agent).toBe("build")
    expect(h.sessionIndex("ses_i1")?.isolated).toBe(false)
    await h.context({ sessionID: "ses_i1", agent: "councillor", messages: msgs }) // councillor 默认隔离名单
    expect(h.sessionIndex("ses_i1")?.agent).toBe("councillor") // 旧实现此处仍是 build（I1 反例）
    expect(h.sessionIndex("ses_i1")?.isolated).toBe(true)
  })
  test("skip 身份 → taint 阻断；合法身份 context 恢复（注册身份、taint 清除、工具可用）", async () => {
    process.env.BLACKBOARD_SKIP_AGENTS = "paused"
    const h = track(await makeHost({ ses_i1b: { id: "ses_i1b", parentID: null } }))
    const msgs = [u("u1")]
    await h.context({ sessionID: "ses_i1b", agent: "builder", messages: msgs })
    await h.context({ sessionID: "ses_i1b", agent: "paused", messages: msgs }) // 切到 skip → taint
    expect(h.sessionIndex("ses_i1b")?.skip_tainted).toBe(true)
    await h.context({ sessionID: "ses_i1b", agent: "builder", messages: msgs }) // 合法恢复
    expect(h.sessionIndex("ses_i1b")?.skip_tainted).toBe(false)
    expect(h.sessionIndex("ses_i1b")?.agent).toBe("builder")
    const out = await h.tool("board_get", { sessionID: "ses_i1b", agent: "paused", messageID: "m1" }, { ids: ["x"] })
    expect(out.content).toContain("rejected") // 工具路径仍只查不建且 taint 阻断（身份不给回退）
  })
})

describe("v2 adapter 接线（R1 迟到 created 不得回滚身份）", () => {
  test("迟到 session.created（旧 agent）不得回滚 context 权威身份与隔离属性", async () => {
    const h = track(await makeHost({ ses_r1: { id: "ses_r1", parentID: null } }))
    const msgs = [u("u1")]
    await h.context({ sessionID: "ses_r1", agent: "build", messages: msgs })
    await h.context({ sessionID: "ses_r1", agent: "councillor", messages: msgs })
    await h.emit("session.created", { sessionID: "ses_r1", agent: "build" }) // 创建时旧值，异步迟到
    await h.settle() // 等后台消费循环处理完（含异步父链查询返回后）
    expect(h.sessionIndex("ses_r1")?.agent).toBe("councillor")
    expect(h.sessionIndex("ses_r1")?.isolated).toBe(true)
  })
  test("迟到 created 不得解除 skip taint；仅 context 以合法身份恢复", async () => {
    process.env.BLACKBOARD_SKIP_AGENTS = "paused"
    const h = track(await makeHost({ ses_r1b: { id: "ses_r1b", parentID: null } }))
    const msgs = [u("u1")]
    await h.context({ sessionID: "ses_r1b", agent: "builder", messages: msgs })
    await h.context({ sessionID: "ses_r1b", agent: "paused", messages: msgs })
    expect(h.sessionIndex("ses_r1b")?.skip_tainted).toBe(true)
    await h.emit("session.created", { sessionID: "ses_r1b", agent: "builder" })
    await h.settle()
    expect(h.sessionIndex("ses_r1b")?.skip_tainted).toBe(true)
    await h.context({ sessionID: "ses_r1b", agent: "builder", messages: msgs })
    expect(h.sessionIndex("ses_r1b")?.skip_tainted).toBe(false)
  })
})

describe("v2 adapter 接线（R2 FIFO 不驱逐已确认候选）", () => {
  test("确认后 32 个 pending 不触发失效；溢出只淘汰未确认观测", async () => {
    const h = track(await makeHost({ ses_r2: { id: "ses_r2", parentID: null } }))
    await h.prompt("ses_r2", "u1", "active")
    await h.context({ sessionID: "ses_r2", agent: "build", messages: [u("u1")] })
    expect(h.meta("ses_r2").rounds.current_round).toBe(1)
    for (let i = 0; i < 32; i++) await h.prompt("ses_r2", `q${i}`, `queued ${i}`) // 全部未入快照
    await h.context({ sessionID: "ses_r2", agent: "build", messages: [u("u1"), a("a1"), t()] })
    let m = h.meta("ses_r2")
    expect(m.rounds.round_known).toBe(true) // R2 反例：FIFO 驱逐 u1 → 无关双失效
    expect(m.budget.round_known).toBe(true)
    expect(m.rounds.current_round).toBe(1)
    expect(m.rounds.last_admitted_message_id).toBe("u1")
    await h.prompt("ses_r2", "q32", "queued 32") // 溢出边界：第 33 个淘汰最旧未确认 q0
    await h.context({ sessionID: "ses_r2", agent: "build", messages: [u("u1"), a("a1"), t()] })
    m = h.meta("ses_r2")
    expect(m.rounds.round_known).toBe(true) // 已确认候选不受淘汰影响
    expect(h.meta("ses_r2").budget.round_known).toBe(true)
  })
  test("N1：淘汰候选真正入快照不得借历史 confirmed 保持 known——双失效+有压力零注入+created_round:null", async () => {
    const h = track(await makeHost({ ses_n1: { id: "ses_n1", parentID: null } }))
    await h.prompt("ses_n1", "u1", "active")
    await h.context({ sessionID: "ses_n1", agent: "build", messages: [u("u1")] }) // 确认 u1（round 1）
    // 压力前置：25 条 round1 目录项（> AGG_TRIGGER_VISIBLE=24）+ 推进到 round 4（fence 4−1>2）
    for (let i = 0; i < 25; i++) {
      const out = await h.tool("board_put", { sessionID: "ses_n1", agent: "build", messageID: "m0" }, { description: `p${i}`, content: "c" })
      expect(out.content).toContain("stored")
    }
    for (const [n, tail] of [["2", "u2"], ["3", "u3"], ["4", "u4"]] as const) {
      await h.prompt("ses_n1", tail, `round-${n}`)
      const hist = [u("u1"), a("a1"), t(), u("u2"), a("a2"), t("a2"), u("u3"), a("a3"), t("a3"), u("u4")]
      await h.context({ sessionID: "ses_n1", agent: "build", messages: hist.slice(0, hist.findIndex((x) => x.id === tail) + 1) })
    }
    expect(h.meta("ses_n1").rounds.current_round).toBe(4)
    expect(h.meta("ses_n1").budget.round_used).toBe(0) // 推进期 fence 未过，未消耗
    for (let i = 0; i < 33; i++) await h.prompt("ses_n1", `q${i}`, `queued ${i}`) // q0 被 FIFO 淘汰
    // q0 此刻才真正被准入进入快照——历史 u1..u4 在场，但尾 user q0 的 admission 证据已随淘汰丢失
    const snap = [u("u1"), a("a1"), t(), u("u2"), a("a2"), t("a2"), u("u3"), a("a3"), t("a3"), u("u4"), a("a4"), t("a4"), u("q0")]
    await h.context({ sessionID: "ses_n1", agent: "build", messages: snap })
    let m = h.meta("ses_n1")
    expect(m.rounds.round_known).toBe(false) // 不得借 u1..u4 保持 known
    expect(m.budget.round_known).toBe(false)
    expect(m.rounds.current_round).toBe(4) // 不推进（q0 不是新 admitted）
    expect(snap.every((x) => (x.content ?? []).every((p) => p.text !== PRESSURE_REMINDER_TEMPLATE))).toBe(true) // 压力在eligible 仍零注入
    expect(m.budget.round_used).toBe(0) // 未扣减
    // unknown 期间落盘 → created_round:null
    const out = await h.tool("board_put", { sessionID: "ses_n1", agent: "build", messageID: "m1" }, { description: "during lost-evidence", content: "c" })
    expect(out.content).toContain("stored")
    const scope = h.scopeOf("ses_n1")!
    const streamId = scope.resolveSession("ses_n1").streamId
    const entriesDir = join(scope.dir, "streams", streamId, "entries")
    const files = (existsSync(entriesDir) ? readdirSync(entriesDir) : []) as string[]
    const rec = JSON.parse(readFileSync(join(entriesDir, files[0]!), "utf8")) as { description: string; created_round: number | null }
    expect(rec.description).toBe("during lost-evidence")
    expect(rec.created_round).toBeNull() // 不得继承旧 created_round
    // 之后已确认输入重新成为尾 user → 恢复既有身份（不伪造 q0 admission）
    await h.context({ sessionID: "ses_n1", agent: "build", messages: [u("u1"), a("a1"), t(), u("u2"), a("a2"), t("a2"), u("u3"), a("a3"), t("a3"), u("u4"), a("a4"), t("a4")] })
    m = h.meta("ses_n1")
    expect(m.rounds.round_known).toBe(true)
    expect(m.rounds.last_admitted_message_id).toBe("u4")
  })
})

describe("v2 adapter 接线（I2 候选集合）", () => {
  test("queued 输入不顶替已入快照的有效输入；入快照后才确认推进", async () => {
    const h = track(await makeHost({ ses_i2: { id: "ses_i2", parentID: null } }))
    await h.prompt("ses_i2", "u1", "first")
    await h.prompt("ses_i2", "u2", "second (queued)")
    await h.context({ sessionID: "ses_i2", agent: "build", messages: [u("u1")] }) // 快照只含 u1
    let m = h.meta("ses_i2")
    expect(m.rounds.last_admitted_message_id).toBe("u1") // I2 反例：单槽会卡在 u2 → 不推进
    expect(m.rounds.round_known).toBe(true)
    expect(m.budget.round_known).toBe(true)
    expect(m.rounds.current_round).toBe(1)
    await h.context({ sessionID: "ses_i2", agent: "build", messages: [u("u1"), a("a1"), t()] }) // 工具循环无 u2
    m = h.meta("ses_i2")
    expect(m.rounds.round_known).toBe(true) // 不因 u2 未入快照而失效
    await h.context({ sessionID: "ses_i2", agent: "build", messages: [u("u1"), a("a1"), t(), u("u2")] })
    m = h.meta("ses_i2")
    expect(m.rounds.last_admitted_message_id).toBe("u2") // u2 入快照 → 推进
    expect(m.rounds.current_round).toBe(2)
  })
  test("取消的候选不触发失效；两 session 互不串扰", async () => {
    const h = track(
      await makeHost({
        ses_i2b: { id: "ses_i2b", parentID: null },
        ses_i2c: { id: "ses_i2c", parentID: null },
      }),
    )
    await h.prompt("ses_i2b", "u1", "real")
    await h.prompt("ses_i2b", "u9", "queued then cancelled")
    await h.context({ sessionID: "ses_i2b", agent: "build", messages: [u("u1")] })
    expect(h.meta("ses_i2b").rounds.round_known).toBe(true)
    // u9 取消（永不出现在快照）→ 后续请求不受污染
    await h.context({ sessionID: "ses_i2b", agent: "build", messages: [u("u1"), a("a1"), t()] })
    expect(h.meta("ses_i2b").rounds.round_known).toBe(true)
    // 交错：另一 session 独立确认
    await h.prompt("ses_i2c", "w1", "other session")
    await h.context({ sessionID: "ses_i2c", agent: "build", messages: [u("w1")] })
    expect(h.meta("ses_i2c").rounds.last_admitted_message_id).toBe("w1")
    expect(h.meta("ses_i2b").rounds.last_admitted_message_id).toBe("u1")
  })
})

describe("v2 adapter 接线（I3 工具循环边界 + 压力后提醒）", () => {
  test("首请求无压力 → 工具步后压力 → 新边界键命中提醒（不 unknown、不重复扣减）", async () => {
    const h = track(await makeHost({ ses_i3: { id: "ses_i3", parentID: null } }))
    // Round 1：无压力确认
    await h.prompt("ses_i3", "u1", "round1")
    const snap1 = [u("u1")]
    await h.context({ sessionID: "ses_i3", agent: "author", messages: snap1 })
    expect(h.meta("ses_i3").rounds.current_round).toBe(1)
    // 25 条目录项（> AGG_TRIGGER_VISIBLE=24；round1 创建，fence 2 轮后到期）
    for (let i = 0; i < 25; i++) {
      const out = await h.tool("board_put", { sessionID: "ses_i3", agent: "author", messageID: "u1" }, { description: `entry ${i}`, content: `c${i}` })
      expect(out.content).toContain("stored")
    }
    // Rounds 2/3：推进但 fence 未过（current − created ≤ 2）→ 无压力注入
    for (const id of ["u2", "u3"]) {
      await h.prompt("ses_i3", id, `round-${id}`)
      await h.context({ sessionID: "ses_i3", agent: "author", messages: [u("u1"), a("a1"), t(), u(id)] })
    }
    expect(h.meta("ses_i3").rounds.current_round).toBe(3)
    // Round 4 请求 a：快照尾 u4（无压力：meta0 读段在推进前，fence 未过）
    await h.prompt("ses_i3", "u4", "round4")
    const snap4a = [u("u1"), a("a1"), t(), u("u2"), a("a2"), t("a2"), u("u3"), a("a3"), t("a3"), u("u4")]
    await h.context({ sessionID: "ses_i3", agent: "author", messages: snap4a })
    expect(h.meta("ses_i3").rounds.current_round).toBe(4)
    expect(h.meta("ses_i3").budget.round_used).toBe(0)
    expect(JSON.stringify(snap4a)).not.toContain("blackboard") // 无注入
    // Round 4 请求 b（工具步）：真实无 id tool-result 尾部 → 边界=a4 新键（旧实现此处 unknown）
    const snap4b = [...snap4a, a("a4"), t("a4")]
    await h.context({ sessionID: "ses_i3", agent: "author", messages: snap4b })
    const m = h.meta("ses_i3")
    expect(m.budget.round_known).toBe(true) // I3 反例：旧算法此处双失效
    expect(m.rounds.round_known).toBe(true)
    expect(m.budget.round_used).toBe(1) // 压力后提醒恰好扣一次
    const lastUser = snap4b[snap4b.length - 3]! // u4
    const hits = lastUser.content.filter((p) => p.text === PRESSURE_REMINDER_TEMPLATE)
    expect(hits.length).toBe(1) // 恰好一份提醒
  })
})

describe("v2 adapter 接线（I4 预检分段）", () => {
  test("预检失败（已有模板 / 冻结快照）→ 零扣减零推进，不注入", async () => {
    const h = track(await makeHost({ ses_i4: { id: "ses_i4", parentID: null } }))
    await h.prompt("ses_i4", "u1", "with template already")
    const withTpl = { id: "u1", role: "user", content: [{ type: "text", text: PRESSURE_REMINDER_TEMPLATE }] }
    await h.context({ sessionID: "ses_i4", agent: "author", messages: [withTpl] })
    let m = h.meta("ses_i4")
    expect(m.budget.round_used).toBe(0)
    expect(m.rounds.current_round).toBe(0) // 预检失败 → 整个 verified 事务不执行（保守欠推进）
    expect(m.rounds.round_known).toBe(false)
    expect(withTpl.content.length).toBe(1)
    const frozen = Object.freeze([u("u1")])
    await h.prompt("ses_i4", "u1", "frozen")
    await h.context({ sessionID: "ses_i4", agent: "author", messages: frozen as unknown as Msg[] })
    m = h.meta("ses_i4")
    expect(m.budget.round_used).toBe(0)
    expect(m.rounds.current_round).toBe(0)
  })
  test("(b) writeMeta 失败 → 不注入不抛出；(c) 提交后赋值失败 → 保守损失已扣减", async () => {
    const h = track(await makeHost({ ses_i4b: { id: "ses_i4b", parentID: null } }))
    await h.prompt("ses_i4b", "u1", "round1")
    await h.context({ sessionID: "ses_i4b", agent: "author", messages: [u("u1")] })
    for (let i = 0; i < 25; i++) {
      await h.tool("board_put", { sessionID: "ses_i4b", agent: "author", messageID: "u1" }, { description: `e${i}`, content: "c" })
    }
    // 三轮推进过 fence（同 I3 场景的最短路径：直接再推 3 轮）
    for (const id of ["u2", "u3", "u4"]) {
      await h.prompt("ses_i4b", id, `r-${id}`)
      await h.context({ sessionID: "ses_i4b", agent: "author", messages: [u("u1"), u(id)] })
    }
    expect(h.meta("ses_i4b").rounds.current_round).toBe(4)
    // (b) 持久化失败：stream 目录只读 → writeMeta（atomicWrite 临时文件+rename）抛出 → degrade，不注入
    const scope = h.scopeOf("ses_i4b")!
    const streamDir = join(scope.dir, "streams", scope.resolveSession("ses_i4b").streamId)
    chmodSync(streamDir, 0o555)
    try {
      const snap = [u("u1"), u("u4"), a("a4"), t("a4")]
      await h.context({ sessionID: "ses_i4b", agent: "author", messages: snap }) // 不得抛出
      expect(snap.some((x) => (x.content ?? []).some((p) => p.text === PRESSURE_REMINDER_TEMPLATE))).toBe(false)
    } finally {
      chmodSync(streamDir, 0o755)
    }
    // (c) 提交后赋值失败：Proxy 让元素赋值抛出 → 预算已扣（保守损失），数组未被污染
    const underlying = [u("u1"), u("u4"), a("a4"), t("a4")]
    const proxy = new Proxy(underlying, {
      set(_t, _p, _v) {
        throw new Error("readonly snapshot")
      },
    }) as unknown as Msg[]
    await h.context({ sessionID: "ses_i4b", agent: "author", messages: proxy }) // 不得抛出
    const m = h.meta("ses_i4b")
    expect(m.budget.round_used).toBe(1) // 已扣（真提交后失败允许保守损失）
    expect(underlying.some((x) => (x.content ?? []).some((p) => p.text === PRESSURE_REMINDER_TEMPLATE))).toBe(false)
  })
})

describe("v2 adapter 接线（unknown 失效 → 恢复）", () => {
  test("known→额度消耗→unknown 双失效落盘→board_put created_round:null→同输入复验恢复不重置", async () => {
    const h = track(await makeHost({ ses_i5: { id: "ses_i5", parentID: null } }))
    // Round 1 建立已知身份
    await h.prompt("ses_i5", "u1", "round1")
    await h.context({ sessionID: "ses_i5", agent: "author", messages: [u("u1")] })
    expect(h.meta("ses_i5").rounds.current_round).toBe(1)
    // M1：先实际消耗一次额度——制造压力（25 条 > 24）并按 fence 推进到 round 4
    for (let i = 0; i < 25; i++) {
      await h.tool("board_put", { sessionID: "ses_i5", agent: "author", messageID: "u1" }, { description: `e${i}`, content: "c" })
    }
    for (const id of ["u2", "u3"]) {
      await h.prompt("ses_i5", id, `round-${id}`)
      await h.context({ sessionID: "ses_i5", agent: "author", messages: [u("u1"), a("a1"), t(), u(id)] })
    }
    await h.prompt("ses_i5", "u4", "round4")
    const snap4: Msg[] = [u("u1"), a("a1"), t(), u("u2"), a("a2"), t("a2"), u("u3"), a("a3"), t("a3"), u("u4")]
    await h.context({ sessionID: "ses_i5", agent: "author", messages: snap4 })
    const snap4b: Msg[] = [...snap4, a("a4"), t("a4")] // 工具步：无 id tool-result 尾 → 边界 a4
    await h.context({ sessionID: "ses_i5", agent: "author", messages: snap4b })
    let m = h.meta("ses_i5")
    expect(m.budget.round_used).toBe(1) // 提醒已消耗一次额度
    expect(m.budget.seen_requests.length).toBeGreaterThan(0)
    const usedBefore = m.budget.round_used
    const seenBefore = [...m.budget.seen_requests]
    const setsBefore = [...m.budget.prompted_set_hashes]
    // unknown（synthetic continuation：无 id user 尾部）→ 双失效
    await h.context({ sessionID: "ses_i5", agent: "author", messages: [u("u1"), { role: "user", content: [{ type: "text", text: "<system-reminder>continued" }] }] })
    m = h.meta("ses_i5")
    expect(m.rounds.round_known).toBe(false)
    expect(m.budget.round_known).toBe(false)
    expect(m.rounds.current_round).toBe(4) // 不推进
    // unknown 期间落盘 → created_round=null（G8 防线）
    const out = await h.tool("board_put", { sessionID: "ses_i5", agent: "author", messageID: "m1" }, { description: "during unknown", content: "c" })
    expect(out.content).toContain("stored")
    const scope = h.scopeOf("ses_i5")!
    const streamId = scope.resolveSession("ses_i5").streamId
    const entriesDir = join(scope.dir, "streams", streamId, "entries")
    const files = (existsSync(entriesDir) ? readdirSync(entriesDir) : []) as string[]
    const recs = files.map((f) => JSON.parse(readFileSync(join(entriesDir, f), "utf8")) as { description: string; created_round: number | null })
    const duringUnknown = recs.find((r) => r.description === "during unknown")
    expect(duringUnknown).toBeDefined()
    expect(duringUnknown!.created_round).toBeNull()
    const before = recs.filter((r) => r.description !== "during unknown")
    expect(before.length).toBe(25)
    expect(before.every((r) => r.created_round === 1)).toBe(true) // known 期间落盘不受影响
    // 同输入复验（同 id 集、fresh 无模板副本，模拟宿主持久历史未被本次注入污染）→ identityRestored
    const snapRestore: Msg[] = [u("u1"), a("a1"), t(), u("u2"), a("a2"), t("a2"), u("u3"), a("a3"), t("a3"), u("u4"), a("a4"), t("a4")]
    await h.context({ sessionID: "ses_i5", agent: "author", messages: snapRestore })
    m = h.meta("ses_i5")
    expect(m.rounds.round_known).toBe(true)
    expect(m.budget.round_known).toBe(true)
    expect(m.rounds.current_round).toBe(4)
    expect(m.rounds.last_admitted_message_id).toBe("u4")
    // M1：恢复不重置——已花额度、已见请求、已提示集合全部保持
    expect(m.budget.round_used).toBe(usedBefore)
    for (const key of seenBefore) expect(m.budget.seen_requests).toContain(key)
    expect(m.budget.prompted_set_hashes).toEqual(setsBefore)
  })
})

describe("v2 adapter 接线（subagent 幂等标记，回归不改动）", () => {
  test("重复 transform 后恰好一份标记", async () => {
    const h = track(await makeHost({ ses_dt: { id: "ses_dt", parentID: null } }))
    const editor = {
      add: () => {},
      update: (id: string, fn: (t: { description: string }) => void) => {
        if (id === "subagent") fn(h.subagent as { description: string })
      },
      get: () => undefined,
      list: () => [],
      remove: () => {},
      namespace: () => {},
    }
    await (h.transformCb as unknown as (e: unknown) => Promise<void> | void)(editor)
    await (h.transformCb as unknown as (e: unknown) => Promise<void> | void)(editor)
    expect(h.subagent.description.split(TASK_DESC_APPEND).length - 1).toBe(1)
  })
})
