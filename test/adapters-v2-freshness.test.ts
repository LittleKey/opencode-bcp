// 新鲜度回归（离线、无宿主/模型）：复现实机桥读序——text.ended 先于 step.ended、
// 交付桥先于 capture 读终态、context wire 补齐迟到。事件装配的 assistant 观测有意
// 不完整（有正文/finish，缺宿主写入的 time.completed/agent）；修复前桥立即返回该
// 陈旧观测，inspectDelivery 用正确的留存记录对照不完整消息 → 引用被丢
// （实机证据 …/dual-host-2.0/permission-predicate-probe-checked/evaluations.jsonl
// sha256:22496fc3…：agentMatches/contentMatches/textHashMatches 全 false，
// canReadResult 未触达，captureStatus=replay）。修复后 readMessage 以宿主 completed
// 标记为就绪门，沿用 waitCompleted 的 4×50ms 有界刷新；不伪造任何字段。
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlackboardV2Plugin } from "../src/adapters/v2/index"
import { DELIVERY_BRIDGE, type DeliveryRequest } from "../src/delivery"

type Wire = Record<string, unknown>
type SessionRow = { id: string; parentID?: string | null; agent?: string; permissions?: unknown; location?: unknown }

// 2.0.20 实机 Agent.Info 默认权限（同 adapters-v2-delivery-repro，逐字）。
const DEFAULT5 = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]
// child(fixer) 会话权限面：board_store=allow（留存照常），board_get 随 "*" allow。
const M = [
  ...DEFAULT5,
  { action: "board_store", resource: "*", effect: "allow" },
]

const PU1 = "Parent input: module fresh-cache violates the size budget."
const CU1 = "You are a subagent spawned by another session.\nParent input: module fresh-cache violates the size budget."
// >8KiB 确定性正文 + 实测同款留存标记（capture description 取自标记）。
const BODY = `${"Reproduce the failing module fresh-cache. ".repeat(248)}\n<!-- bcp:store description="Fixer fresh reply one" -->\n`

const P = "ses_fresh_parent"
const C = "ses_fresh_child"
const PU1_ID = "msg_fresh_parent_input"
const CU1_ID = "msg_fresh_child_input"
const CA1_ID = "msg_fresh_child_final"

const wu = (id: string, text: string): Wire => ({ id, type: "user", text, time: { created: 1 } })
const waText = (id: string, agent: string, text: string): Wire => ({
  id,
  type: "assistant",
  ...(agent ? { agent } : {}),
  model: { id: "fixture-worker", providerID: "fixture" },
  content: [{ type: "text", text }],
  finish: "stop",
  time: { created: 2, completed: 3 },
})
const um = (id: string, text = "input") => ({ id, role: "user", content: [{ type: "text", text }] })

const CLEANUPS: string[] = []
afterEach(() => {
  for (const dir of CLEANUPS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function makeFreshHost(opts: { sessions: Record<string, SessionRow> }) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-v2-freshness-"))
  CLEANUPS.push(dataDir)
  const sessions: Record<string, SessionRow> = {}
  for (const [id, row] of Object.entries(opts.sessions)) {
    sessions[id] = { location: { directory: dataDir, project: { directory: dataDir, canonical: dataDir } }, ...row }
  }
  const wires: Record<string, Wire[]> = {}
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
    for (let i = 0; i < 200; i++) {
      if (logLines().some((l) => l.ev === "final_capture")) {
        await new Promise((r) => setTimeout(r, 10))
        return
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const subagent = { id: "subagent", description: "Delegate work.", execute: async () => ({}) }
  const hooks: Record<string, (input: never) => Promise<void> | void> = {}
  const ctx = {
    options: { dataDir },
    location: { directory: dataDir },
    agent: { list: () => [{ id: "orchestrator", name: "orchestrator", permissions: DEFAULT5 }, { id: "fixer", name: "fixer", permissions: DEFAULT5 }] },
    tool: {
      transform: async (cb: (editor: never) => Promise<void> | void) => {
        const editor = {
          add: (tool: { id: string; description: string }) => {},
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
      context: async (input: { sessionID: string }) => wires[input.sessionID] ?? [],
      hook: async (name: string, cb: (input: never) => Promise<void> | void) => {
        hooks[name] = cb
        return { dispose: async () => {} }
      },
    },
    event: {
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
  const admit = async (sessionID: string, agent: string, userId: string, text: string): Promise<void> => {
    await hooks.prompt({ sessionID, messageID: userId, prompt: { text } } as never)
    await hooks.context({ sessionID, agent, messages: [um(userId, text)], system: [] } as never)
  }
  const bridgeHandler = (): ((request: DeliveryRequest) => Promise<Record<string, unknown>>) => {
    const map = (globalThis as Record<PropertyKey, unknown>)[DELIVERY_BRIDGE] as Map<string, (r: DeliveryRequest) => Promise<Record<string, unknown>>>
    const handler = map?.get(dataDir)
    if (!handler) throw new Error("delivery bridge handler not registered")
    return handler
  }
  return { dataDir, wires, emit, settle, admit, logLines, bridgeHandler }
}

const request = (): DeliveryRequest => ({
  callerSessionID: P,
  taskID: C,
  generation: 1,
  terminalRevision: 1,
  state: "completed",
  inputMessageID: CU1_ID,
  terminalMessageID: CA1_ID,
})

// 实测事件/上下文次序：wire 先不含终结消息（装配早于完成），text.ended → step.ended
// （自动留存并发启动）→ 桥开始读终态（此刻缓存观测有意不完整）→ context 补齐迟到。
async function runRealOrder(h: Awaited<ReturnType<typeof makeFreshHost>>, completeWire: () => void): Promise<Record<string, unknown>> {
  h.wires[P] = [wu(PU1_ID, PU1)]
  await h.admit(P, "orchestrator", PU1_ID, PU1)
  h.wires[C] = [wu(CU1_ID, CU1)]
  await h.admit(C, "fixer", CU1_ID, CU1)
  // text-ended-before-step-ended：正文段先落，终步随后（触发自动留存）。
  h.emit("session.text.ended", { sessionID: C, assistantMessageID: CA1_ID, ordinal: 0, text: BODY })
  h.emit("session.step.ended", { sessionID: C, assistantMessageID: CA1_ID, finish: "stop" })
  // 桥读先启动；context 补齐在其有界刷新窗口内到达（实机延迟上下文次序）。
  const pending = h.bridgeHandler()(request())
  await new Promise((r) => setTimeout(r, 60))
  completeWire()
  const response = await pending
  await h.settle()
  await new Promise((r) => setTimeout(r, 50))
  return response
}

describe("v2 桥终态读新鲜度（交付桥先于 capture/上下文补齐的有界就绪）", () => {
  test("部分缓存终态 + 迟到 context 补齐 → 桥必须在有界刷新后读到 completed/agent 并返回 result_reference", async () => {
    const h = await makeFreshHost({ sessions: { [P]: { id: P, agent: "orchestrator" }, [C]: { id: C, parentID: P, agent: "fixer", permissions: M } } })
    const response = await runRealOrder(h, () => {
      h.wires[C] = [wu(CU1_ID, CU1), waText(CA1_ID, "fixer", BODY)]
    })
    expect(response.association).toBe("host_message_identity")
    const capture = response.capture as { status: string; id: string } | undefined
    expect(capture).toBeDefined()
    expect(["stored", "replay"]).toContain(capture!.status)
    const captureId = capture!.id
    // 候选照旧：留存记录 origin=current_input、作者 fixer。
    expect(response.candidates).toEqual([
      expect.objectContaining({ id: captureId, readability: "found", origin: "current_input", writer: expect.objectContaining({ agent: "fixer", session_id: C, message_id: CA1_ID }) }),
    ])
    // 引用生成蕴含 delivery.ts:106 的 canReadResult/currentResult 门全部通过（未被削弱）。
    expect(response.result_reference).toEqual(
      expect.objectContaining({
        id: captureId,
        description: "Fixer fresh reply one",
        input_message_id: CU1_ID,
        writer: expect.objectContaining({ agent: "fixer", session_id: C, message_id: CA1_ID }),
      }),
    )
  })

  test("context 永不补齐（lost/trimmed）→ 有界等待后按既有 fail closed 返回，不伪造 completed", async () => {
    const h = await makeFreshHost({ sessions: { [P]: { id: P, agent: "orchestrator" }, [C]: { id: C, parentID: P, agent: "fixer", permissions: M } } })
    const response = await runRealOrder(h, () => {})
    expect(response.association).toBe("host_message_identity")
    // 自动留存无法确认（无 completed → publicReply undefined），留存不伪造。
    expect(response.capture).toMatchObject({ status: "unconfirmed" })
    expect(response.result_reference).toBeUndefined()
  })

  test("completed-but-missing-agent：wire 缺 agent 时诚实 fail closed，不虚构作者（单独上报面）", async () => {
    const h = await makeFreshHost({ sessions: { [P]: { id: P, agent: "orchestrator" }, [C]: { id: C, parentID: P, agent: "fixer", permissions: M } } })
    const response = await runRealOrder(h, () => {
      h.wires[C] = [wu(CU1_ID, CU1), waText(CA1_ID, "", BODY)]
    })
    expect(response.association).toBe("host_message_identity")
    // 留存照常（自动路径 writer.agent=resolved.agent=fixer），但桥读的终态缺 agent →
    // agentMatches=false → 不给引用；这正是需要单独上报的下一道守卫面。
    const capture = response.capture as { status: string; id: string } | undefined
    expect(capture).toBeDefined()
    expect(["stored", "replay"]).toContain(capture!.status)
    expect(response.result_reference).toBeUndefined()
  })
})
