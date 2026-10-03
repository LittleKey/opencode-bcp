// 离线复现 v2-facade-live 唯一失败点 handoff_compact_no_full_body=false（不启动宿主/模型）。
// 证据锚点（/home/littlekey/.local/share/opencode/verification/dual-host-2.0/v2-facade-live/）：
// - artifacts/RESULT.json：除 handoff_compact_no_full_body 外全部通过；parent 工具输出中
//   桥响应含 association="host_message_identity"、capture={status:"replay"}，但无 result_reference。
// - isolated.db：parent(orchestrator) SessionInfo.permissions=null；child(fixer)=M 规则列表
//   （首 5 条 = 2.0.20 宿主 Agent.Info 默认权限，实机二进制 default 变换逐字一致）。
// - 会话/消息 ID、正文规模、双轮结构取自 session_message 与 parent/child-messages.json；
//   终结 assistant 为单 text part、agent=fixer、finish=stop、time.completed 存在。
// 原文身份和 BCP 作用域可读不等于宿主允许调用 board_get：必须另有有效读取权限。
// 以下权限形状用于有界对照，不把模拟的空规则面当作实际宿主权限已观测的证据。
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlackboardV2Plugin } from "../src/adapters/v2/index"
import { DELIVERY_BRIDGE, type DeliveryRequest } from "../src/delivery"

type Wire = Record<string, unknown>
type SessionRow = { id: string; parentID?: string | null; agent?: string; permissions?: unknown; location?: unknown }

// 2.0.20 实机 Agent.Info 默认权限（裸字符串代理 default 变换，逐字）。
const DEFAULT5 = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]
// 实测 child(fixer) session_v2.permission 物化列表（isolated.db，逐字结构）。
const M = [
  ...DEFAULT5,
  { action: "question", resource: "*", effect: "allow" },
  { action: "task_cancel", resource: "*", effect: "deny" },
  { action: "task_message", resource: "*", effect: "deny" },
  { action: "task_revive", resource: "*", effect: "deny" },
  { action: "task_status", resource: "*", effect: "deny" },
  { action: "task_result", resource: "*", effect: "deny" },
  { action: "wait_for_user", resource: "*", effect: "deny" },
  { action: "marketplace_inspect", resource: "*", effect: "deny" },
  { action: "marketplace_manage", resource: "*", effect: "deny" },
  { action: "skill", resource: "*", effect: "deny" },
  { action: "context7_resolve-library-id", resource: "*", effect: "deny" },
  { action: "context7_get-library-docs", resource: "*", effect: "deny" },
  { action: "gh_grep_search_code", resource: "*", effect: "deny" },
  { action: "gh_grep_get_file", resource: "*", effect: "deny" },
]

// 实测输入原文（parent-messages.json / child-messages.json，逐字）。
const PU1 =
  "Reproduce the failing module described below and return the full public explanation plus the retained-original marker in one reply. Current input: module tmp-cache violates the size budget."
const CU1 = `You are a subagent spawned by another session.\n${PU1}`
// 构造超过 8192 字节的确定性正文（桥内条件是逐字节相等 + sha256），
// 末尾带实测同款留存标记（capture 据此取 description="Fixer original reply one"）。
const BODY = `${"Reproduce the failing module tmp-cache. ".repeat(248)}\n<!-- bcp:store description="Fixer original reply one" -->\n`

const wu = (id: string, text: string): Wire => ({ id, type: "user", text, time: { created: 1 } })
const waText = (id: string, agent: string, text: string): Wire => ({
  id,
  type: "assistant",
  agent,
  model: { id: "fixture-worker", providerID: "fixture" },
  content: [{ type: "text", text }],
  finish: "stop",
  time: { created: 2, completed: 3 },
})
const waTool = (id: string, agent: string, callID: string, tool: string): Wire => ({
  id,
  type: "assistant",
  agent,
  model: { id: "fixture-worker", providerID: "fixture" },
  content: [{ type: "tool", id: callID, name: tool, state: { status: "completed", time: { ran: 2, completed: 3 } } }],
  finish: "tool-calls",
  time: { created: 2, completed: 3 },
})
const um = (id: string, text = "input") => ({ id, role: "user", content: [{ type: "text", text }] })

const CLEANUPS: string[] = []
afterEach(() => {
  for (const dir of CLEANUPS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// makeAutoHost 的双会话克隆：context wire 可变（child 终结前后两个状态），其余同构。
async function makeReproHost(opts: {
  sessions: Record<string, SessionRow>
  agents?: Array<{ id: string; name?: string; permissions?: unknown }>
}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-v2-delivery-"))
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
    agent: { list: () => opts.agents ?? [] },
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

// 实测 ID（session_message / RESULT.json / records.json）。
const P = "ses_f05440553ffevk1DXFrLzJJA8B"
const C = "ses_f054403f6ffe3eY1IsgsqKzpOy"
const PU1_ID = "msg_0fabbfb94001KdlWL4jMp6TQen"
const P_TOOL1_ID = "msg_0fabbfbcb001FS3HvSjfm73wHu"
const CU1_ID = "msg_0fabbfc14001noxX1oOjDYirtG"
const CA1_ID = "msg_0fabbfc33001X3l0lf4GVGUuBc"
const HANDOFF_CALL_1 = "call-handoff-1"

describe("v2 交付桥：facade-live handoff_compact_no_full_body 失败点离线复现", () => {
  test("实测序列（child 单 text part 终结、capture replay、作者/输入一致）→ 桥必须返回 result_reference", async () => {
    const h = await makeReproHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator" },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: M },
      },
      agents: [
        { id: "orchestrator", name: "orchestrator", permissions: DEFAULT5 },
        { id: "fixer", name: "fixer", permissions: DEFAULT5 },
      ],
    })
    await h.admit(P, "orchestrator", PU1_ID, PU1)
    // 实测 parent 第一轮在 child 完成前已产生工具步 assistant（wire 状态镜像 DB）。
    h.wires[P] = [wu(PU1_ID, PU1), waTool(P_TOOL1_ID, "orchestrator", HANDOFF_CALL_1, "subagent")]
    await h.admit(C, "fixer", CU1_ID, CU1)
    // child 终结：正文段事件 + 终步事件（真实事件序），wire 随后含完成的终结消息。
    h.wires[C] = [wu(CU1_ID, CU1), waText(CA1_ID, "fixer", BODY)]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: CA1_ID, ordinal: 0, text: BODY })
    h.emit("session.step.ended", { sessionID: C, assistantMessageID: CA1_ID, finish: "stop" })
    await h.settle()
    // 前置条件：自动留存按实测落盘（final_capture status=stored）。
    const finalCapture = h.logLines().find((l) => l.ev === "final_capture") as Record<string, unknown> | undefined
    expect(finalCapture).toMatchObject({ session: C, message_id: CA1_ID, status: "stored" })

    const response = await h.bridgeHandler()({
      callerSessionID: P,
      taskID: C,
      generation: 1,
      terminalRevision: 1,
      state: "completed",
      inputMessageID: CU1_ID,
      terminalMessageID: CA1_ID,
    })
    // 实测已达成的部分（回归锚）：关联身份 + capture replay + 候选 current_input。
    expect(response.association).toBe("host_message_identity")
    expect(response.candidates).toEqual([
      expect.objectContaining({ id: finalCapture!.id, readability: "found", origin: "current_input", writer: expect.objectContaining({ agent: "fixer", session_id: C, message_id: CA1_ID }) }),
    ])
    // 显式可读权限与原文身份均已给出，才允许返回 result_reference。
    expect(response.capture).toMatchObject({ id: finalCapture!.id, status: "replay" })
    expect(response.result_reference).toEqual(
      expect.objectContaining({
        id: finalCapture!.id,
        description: "Fixer original reply one",
        input_message_id: CU1_ID,
        writer: expect.objectContaining({ agent: "fixer", session_id: C, message_id: CA1_ID }),
      }),
    )
  })

  test.each([undefined, null])("权限面不可见（会话 permissions=%p）→ 保留原文，不推断引用可读", async (permissions) => {
    const h = await makeReproHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator", permissions },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: M },
      },
      // 模拟插件看不到有效规则；宿主的默认策略可能为 allow、ask 或 deny。
      // 仅凭此前另一输入的成功读取或 BCP 内部 ACL，不能确定本输入的工具权限。
      agents: [
        { id: "orchestrator", name: "orchestrator", permissions: [] },
        { id: "fixer", name: "fixer", permissions: [] },
      ],
    })
    await h.admit(P, "orchestrator", PU1_ID, PU1)
    await h.admit(C, "fixer", CU1_ID, CU1)
    h.wires[C] = [wu(CU1_ID, CU1), waText(CA1_ID, "fixer", BODY)]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: CA1_ID, ordinal: 0, text: BODY })
    h.emit("session.step.ended", { sessionID: C, assistantMessageID: CA1_ID, finish: "stop" })
    await h.settle()
    const finalCapture = h.logLines().find((l) => l.ev === "final_capture") as Record<string, unknown> | undefined
    // 前提：留存成功（fixer 规则 [] + 会话规则 M → board_store allow，与实测一致）。
    expect(finalCapture).toMatchObject({ session: C, message_id: CA1_ID, status: "stored" })
    const response = await h.bridgeHandler()({
      callerSessionID: P,
      taskID: C,
      generation: 1,
      terminalRevision: 1,
      state: "completed",
      inputMessageID: CU1_ID,
      terminalMessageID: CA1_ID,
    })
    // 实测已达成的部分保持不变：关联身份 + capture replay + 候选 current_input。
    expect(response.association).toBe("host_message_identity")
    expect(response.capture).toMatchObject({ id: finalCapture!.id, status: "replay" })
    expect(response.result_reference).toBeUndefined()
  })

  test("对照：显式 ask 规则可见时维持 fail closed → 无 result_reference（deny/ask raw fallback 不变）", async () => {
    const h = await makeReproHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator" },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: M },
      },
      agents: [
        // orchestrator 显式 board_get=ask：规则可见 → 维持 v1 契约不给引用。
        { id: "orchestrator", name: "orchestrator", permissions: [{ action: "board_get", resource: "*", effect: "ask" }] },
        // fixer 显式 board_store=allow：留存路径不受影响（与留存授权规则来源一致）。
        { id: "fixer", name: "fixer", permissions: [{ action: "board_store", resource: "*", effect: "allow" }] },
      ],
    })
    await h.admit(P, "orchestrator", PU1_ID, PU1)
    await h.admit(C, "fixer", CU1_ID, CU1)
    h.wires[C] = [wu(CU1_ID, CU1), waText(CA1_ID, "fixer", BODY)]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: CA1_ID, ordinal: 0, text: BODY })
    h.emit("session.step.ended", { sessionID: C, assistantMessageID: CA1_ID, finish: "stop" })
    await h.settle()
    const finalCapture = h.logLines().find((l) => l.ev === "final_capture") as Record<string, unknown> | undefined
    expect(finalCapture).toMatchObject({ status: "stored" })
    const response = await h.bridgeHandler()({
      callerSessionID: P,
      taskID: C,
      generation: 1,
      terminalRevision: 1,
      state: "completed",
      inputMessageID: CU1_ID,
      terminalMessageID: CA1_ID,
    })
    expect(response.association).toBe("host_message_identity")
    expect(response.result_reference).toBeUndefined()
  })
})
