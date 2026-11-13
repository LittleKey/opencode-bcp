// v2 派发接收方身份 + 编辑证据钩子链定向回归（独立 Oracle e000001 P1/P2 + e000002 P1）：
// - 原生 subagent 续聊读 sessionID（宿主 v2.1.4 schema），兼容 task 工具读其 task_id；
//   不猜字段（subagent 上的 task_id 不作数）。
// - 显式续聊不可证（会话不存在 / 非本会话子会话 / 会话级 deny / 读取错误）→ 原 prompt
//   逐字保留，不降格为 agent profile 路径重写。
// - 全新独立派发（无续聊字段）→ 仍按 agent profile 判定；不把前次 reviewer 当作者。
// - 编辑证据走真实插件注册钩子链：tool.execute.before（pending journal）→ tool.execute.after
//   （observeEdits 完成 native_edit 观察行）→ 真实事件泵终稿 capture → native_edit 绑定
//   → handoff author_sources/author_feedback。不直接补写 journal、不手工构造 native_edit 记录。
// - tool-only 归属（oracle 矩阵）：首工具即纯工具调用（assistant 零 text part、未登记）时，
//   before 钩子用宿主新鲜 wire 解析唯一归属（唯一 assistant → 回溯首个 user 行 === 已确认
//   输入），成功才签发 pending + 一次性代币；解析不可证 → volatile 负证据；after 只消费
//   原代币，completed-only；持久负证据走 journal pending/.incomplete 哨兵，跨重启保留。
// - 失效矩阵：before/after 之间换输入、authorize await 期间换输入（isCurrent 栅栏）、
//   无 before 的孤立 after、no-store 输入 → 一律 fail-closed（无 native 绑定 / 不留存）。
// 夹具沿用 test/adapters-v2-delivery-repro.test.ts 的 2.0.20 实测 wire 形状；断言全部走
// 真实共享核（storage/capture/handoff）与真磁盘 dataDir。这是沙箱钩子链回归，非 live 宿主 E2E。
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlackboardV2Plugin } from "../src/adapters/v2/index"
import { openScopeById, type Scope } from "../src/storage"

type Wire = Record<string, unknown>
type SessionRow = { id: string; parentID?: string | null; agent?: string; permissions?: unknown; location?: unknown }
type Journal = { input: string; observations: Array<{ call: string; pending?: true; files?: unknown[] }> }

const ALLOW = [{ action: "*", resource: "*", effect: "allow" }]
const DENY_BOARD_GET = [{ action: "board_get", resource: "*", effect: "deny" }]

const P = "ses_dispatch_parent"
const C = "ses_dispatch_child"
const X = "ses_dispatch_foreign"
const R = "ses_dispatch_reviewer"

const PU = "msg_p_u1"
const CU = "msg_c_u1"
const CA = "msg_c_a1"
const RU = "msg_r_u1"
const RA = "msg_r_a1"

const wu = (id: string, text: string): Wire => ({ id, type: "user", text, time: { created: 1 } })
const waText = (id: string, agent: string, text: string, completed = 3): Wire => ({
  id,
  type: "assistant",
  agent,
  model: { id: "fixture-worker", providerID: "fixture" },
  content: [{ type: "text", text }],
  finish: "stop",
  time: { created: 2, completed },
})
const um = (id: string, text = "input") => ({ id, role: "user", content: [{ type: "text", text }] })
// tool-only 场景的 assistant wire：已存在于宿主 context、但零 text part 且无 completed——
// 事件泵从未为其发过 text.ended，插件 receipts 里也没有它的登记（缺陷触发前提）。
const waEmpty = (id: string, agent: string): Wire => ({
  id,
  type: "assistant",
  agent,
  model: { id: "fixture-worker", providerID: "fixture" },
  content: [],
  time: { created: 2 },
})

const CLEANUPS: string[] = []
afterEach(() => {
  for (const dir of CLEANUPS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// 断言专用：打开会话所属 scope（scope-index 键记首个注册会话，同项目目录共享）。
function openSessionScope(dataDir: string, session: string, agent: string): { scope: Scope; streamId: string } {
  const index = JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8")) as { scopes?: Record<string, string> }
  const scope = openScopeById(index.scopes![session] ?? Object.values(index.scopes ?? {})[0]!, { dataDir })
  const { streamId } = scope.registerSession(session, agent)
  return { scope, streamId }
}

// 断言专用：按 bb:// id 读真实落盘记录（getById，recover-on-read）。
function readRecord(dataDir: string, id: string): { id?: string; bindings?: Array<{ native_edit?: boolean }>; origin?: { input_message_id?: string; source_errors?: string[] }; writer?: { session_id?: string } } | undefined {
  const parsed = JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8")) as { scopes?: Record<string, string> }
  const scope = openScopeById(Object.values(parsed.scopes ?? {})[0]!, { dataDir })
  const found = scope.getById(id)
  return found.status === "found" ? (found.record as ReturnType<typeof readRecord>) : undefined
}

// 断言专用：读某输入的编辑证据 journal（edits/<sha256(input)>.json）。
function readJournal(dataDir: string, session: string, agent: string, input: string): Journal | undefined {
  const { scope, streamId } = openSessionScope(dataDir, session, agent)
  const path = join(scope.dir, "streams", streamId, "edits", createHash("sha256").update(input).digest("hex") + ".json")
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8")) as Journal
}

// 断言专用：journal 的 .incomplete 哨兵是否存在（invalidateEditEvidence 写空文件，
// 与 journal 主文件互相独立）。
function journalIncompleteExists(dataDir: string, session: string, agent: string, input: string): boolean {
  const { scope, streamId } = openSessionScope(dataDir, session, agent)
  return existsSync(join(scope.dir, "streams", streamId, "edits", createHash("sha256").update(input).digest("hex") + ".json.incomplete"))
}

async function makeHost(opts: {
  sessions: Record<string, SessionRow>
  // 数组或取数闭包（闭包可中途改为抛错，模拟 agent list RPC 不可用）。
  agents?: Array<{ id: string; name?: string; permissions?: unknown }> | (() => Array<{ id: string; permissions?: unknown }>)
  // 可选闸门：armed() 为真时挂起 ctx.agent.list（authorize 的身份/权限 RPC），entered 在
  // 钩子真实进入闸门后、阻塞前回调（一次性语义由测试在 entered 内翻转 armed 保证）。
  // 注意：readMessage 对 user 输入走 snapshots 缓存（admit 的 prompt 钩子 observeUser 及
  // miss 时 refresh），不会请求 ctx.session.context；after 钩子体内唯一确定的挂起点是
  // authorize 的 agent.list，而 :1100-1102 初始栅栏在 hook 体内严格先于该调用——entered
  // 触发即证明初始栅栏已通过、readMessage 已取得旧输入。
  gateAuthorize?: { armed: () => boolean; wait: Promise<unknown>; entered?: () => void }
  // 重启场景：复用既有 dataDir / 跨实例共享同一 wire 视图（不再次登记清理）。
  dataDir?: string
  sharedWires?: Record<string, Wire[]>
  // 真开关：为真时 ctx.session.context RPC 抛错（归属解析的 context_unavailable 路径）。
  contextError?: () => boolean
  // 文件准备内部挂起闸门：armed 且计数超过 skip 时挂起 ctx.session.get（ask 的会话
  // 权限中途复核走 sessionInfo=session.get）。after 编辑钩子的 session.get 顺序确定：
  // 第 1 次=authorize 内 sessionInfo（skip:1 放行），第 2 次=observeEdits→
  // prepareArtifacts→ask 复核（挂起+entered）——entered 触发即证明已真实进入
  // FileAccess.ask，而非 authorize 入口。
  gateSessionGet?: { armed: () => boolean; skip?: number; wait: Promise<unknown>; entered?: () => void }
}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "bb-v2-dispatch-"))
  if (!opts.dataDir) CLEANUPS.push(dataDir)
  const sessions: Record<string, SessionRow> = {}
  for (const [id, row] of Object.entries(opts.sessions)) {
    sessions[id] = { location: { directory: dataDir, project: { directory: dataDir, canonical: dataDir } }, ...row }
  }
  const wires: Record<string, Wire[]> = opts.sharedWires ?? {}
  let gateSessionGetCalls = 0
  const waiters: Array<(r: { value: unknown; done: boolean }) => void> = []
  const queued: Array<{ type: string; data?: unknown }> = []
  // 真实注册面：插件经 ctx.tool.transform add 的工具（board_get/board_index/board_store…）。
  const added = new Map<string, { name: string; description: string; input: unknown; execute: (rawArgs: unknown, tctx: unknown) => Promise<{ content: string }> }>()
  const logLines = (): Array<Record<string, unknown>> =>
    existsSync(join(dataDir, "log/blackboard.log"))
      ? (readFileSync(join(dataDir, "log/blackboard.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) as Array<Record<string, unknown>>)
      : []
  const emit = (type: string, data?: unknown): void => {
    const w = waiters.shift()
    if (w) w({ value: { type, data }, done: false })
    else queued.push({ type, data })
  }
  const settle = async (minFinalCaptures = 1): Promise<void> => {
    // 终结留存异步落盘（waitCompleted 有界轮询）；等满 minFinalCaptures 条 final_capture。
    for (let i = 0; i < 200; i++) {
      if (logLines().filter((l) => l.ev === "final_capture").length >= minFinalCaptures) {
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
    agent: {
      list: async () => {
        if (opts.gateAuthorize?.armed()) {
          opts.gateAuthorize.entered?.()
          await opts.gateAuthorize.wait
        }
        return typeof opts.agents === "function" ? opts.agents() : opts.agents ?? []
      },
    },
    tool: {
      transform: async (cb: (editor: never) => Promise<void> | void) => {
        const editor = {
          // 真实注册：记录插件 add 的工具（含 board_store 的包装 execute），供回归直接
          // 以真实 ToolContext 执行（message-store 手动补存链路）。
          add: (tool: { name: string; description: string; input: unknown; execute: (rawArgs: unknown, tctx: unknown) => Promise<{ content: string }> }) => {
            added.set(tool.name, tool)
          },
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
      get: async (input: { sessionID: string }) => {
        if (opts.gateSessionGet?.armed()) {
          gateSessionGetCalls += 1
          if (gateSessionGetCalls > (opts.gateSessionGet.skip ?? 0)) {
            opts.gateSessionGet.entered?.()
            await opts.gateSessionGet.wait
          }
        }
        return sessions[input.sessionID] ?? null
      },
      context: async (input: { sessionID: string }) => {
        if (opts.contextError?.()) throw new Error("context rpc unavailable")
        return wires[input.sessionID] ?? []
      },
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
  // setup 返回事件泵清理函数（abort 订阅 + 桥注销）：重启场景先关旧实例再开新实例，
  // 避免双实例双泵对同一终稿事件重复 captureFinal。
  const close = await BlackboardV2Plugin.setup(ctx as never)
  const admit = async (sessionID: string, agent: string, userId: string, text: string): Promise<void> => {
    await hooks.prompt({ sessionID, messageID: userId, prompt: { text } } as never)
    await hooks.context({ sessionID, agent, messages: [um(userId, text)], system: [] } as never)
  }
  // 派发：直接调 tool execute.before 钩子，返回（可能被改写的）args。
  const delegate = async (tool: string, sessionID: string, callId: string, args: Record<string, unknown>): Promise<{ prompt: string }> => {
    const input: Record<string, unknown> = { ...args }
    await hooks["tool:execute.before"]({ tool, sessionID, messageID: PU, id: callId, input } as never)
    return input as unknown as { prompt: string }
  }
  // 等待事件泵处理完当前队列：step.failed 仅产生一条日志，以其为哨兵，
  // 轮询到它即保证先入队的 text.ended 已被处理（单泵 FIFO）。
  const pumpSettled = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (logLines().some((l) => l.ev === "step_failed")) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  // 子会话终结留存：admit →（可选真实编辑钩子链）→ wire 终稿 → 终结事件 → settle。
  const finalizeChild = async (o: {
    session: string
    agent: string
    userId: string
    inputText: string
    finalText: string
    editBeforeFinal?: { filePath: string; callId: string; body?: string }
    completed?: number
  }): Promise<void> => {
    await admit(o.session, o.agent, o.userId, o.inputText)
    const finalId = `${o.userId}_a`
    if (o.editBeforeFinal) {
      // 兼容场景（文本先行）：同 step 内首个文本 part 先终结（登记 assistant id），随后
      // 才是工具钩子（messageID=assistant id，见宿主 step.ts:97）。这不是宿主唯一顺序——
      // 首个工具就是纯工具调用（assistant 零 text part、未经事件泵登记）同样真实存在，
      // 由下方 tool-only 归属矩阵直接驱动真实钩子对覆盖。before 钩子写 pending journal，
      // after 钩子经真实 observeEdits（含 authorize 与 isCurrent 栅栏）完成观察行。
      wires[o.session] = [wu(o.userId, o.inputText), waText(finalId, o.agent, "Reading the file before editing.", o.completed ?? 3)]
      emit("session.text.ended", { sessionID: o.session, assistantMessageID: finalId, ordinal: 0, text: "Reading the file before editing." })
      emit("session.step.failed", { sessionID: o.session, assistantMessageID: `${finalId}_probe`, error: "fixture-sentinel" })
      await pumpSettled()
      await hooks["tool:execute.before"]({ tool: "edit", sessionID: o.session, messageID: finalId, id: o.editBeforeFinal.callId, input: { filePath: o.editBeforeFinal.filePath } } as never)
      // 宿主真实链：before 与 after 之间确实发生文件修改——after 钩子的 observeEdits 与
      // 后续 captureFinal 读到的是这里的 NEW 字节（journal 观察行 + 留存快照均对应新内容）。
      if (o.editBeforeFinal.body !== undefined) writeFileSync(o.editBeforeFinal.filePath, o.editBeforeFinal.body)
      await hooks["tool:execute.after"]({ tool: "edit", sessionID: o.session, messageID: finalId, id: o.editBeforeFinal.callId, input: { filePath: o.editBeforeFinal.filePath }, status: "completed", result: {} } as never)
    }
    // 终稿 completed 用真实墙钟（editEvidence 按 observed_at <= completed 选取观察行）。
    wires[o.session] = [wu(o.userId, o.inputText), waText(finalId, o.agent, o.finalText, o.completed ?? Date.now())]
    emit("session.text.ended", { sessionID: o.session, assistantMessageID: finalId, ordinal: o.editBeforeFinal ? 1 : 0, text: o.finalText })
    emit("session.step.ended", { sessionID: o.session, assistantMessageID: finalId, finish: "stop" })
  }
  // board_store 真实执行：经注册面取工具，以真实 ToolContext（caller=P orchestrator）
  // 调包装 execute（message-store 手动补存链路：list 发现 → store 留存）。
  const boardStore = async (args: Record<string, unknown>, messageID = "msg_p_store_call"): Promise<Record<string, unknown>> => {
    const tool = added.get("board_store")
    if (!tool) throw new Error("board_store not registered")
    const res = await tool.execute({ ...args }, { sessionID: P, agent: "orchestrator", messageID, id: `${messageID}_call` } as never)
    return JSON.parse(res.content) as Record<string, unknown>
  }
  return { dataDir, wires, emit, settle, admit, delegate, logLines, finalizeChild, hooks, pumpSettled, added, boardStore, close: () => { if (typeof close === "function") void close() } }
}

// 造作 File 记录（编辑证据 → native_edit 绑定）与 reviewer 记录（正文 file:// 引用 →
// 非 native 绑定），并把两条记录经父链 remember 到 P 的 recentSources。
// before→after 之间真实改写文件：oldBody（before 前）与 newBody（两钩子之间）都返回给
// 调用方，供精确 SHA256/快照内容断言。
async function seedAuthorAndReviewer(
  h: Awaited<ReturnType<typeof makeHost>>,
  file: string,
): Promise<{ oldBody: string; newBody: string }> {
  mkdirSync(join(file, ".."), { recursive: true })
  const oldBody = "The dispatcher restated the bug as a caching problem; the real cause is a stale index handle. ".repeat(4)
  const newBody = "REWRITTEN between the edit hooks; the retained snapshot must hold exactly these new bytes. ".repeat(4)
  writeFileSync(file, oldBody)
  const puText = `Check the record about ${file} before revising.`
  await h.admit(P, "orchestrator", PU, puText)
  // 作者（C）：真实钩子链编辑证据 + 终稿留存（native_edit 绑定 file，快照=NEW 字节）。
  await h.finalizeChild({
    session: C,
    agent: "fixer",
    userId: CU,
    inputText: `You are a subagent spawned by another session.\n${puText}`,
    finalText: `Reproduced and fixed the stale index handle.\n<!-- bcp:store description="Fixer author original" -->`,
    editBeforeFinal: { filePath: file, callId: "ce1", body: newBody },
  })
  // 评审（R）：只读引用同一 file（非 native 绑定）。
  await h.finalizeChild({
    session: R,
    agent: "oracle",
    userId: RU,
    inputText: "Review the child result.",
    finalText: `Finding: the rename path in file://${file} was missed; the cache index must be invalidated too.\n<!-- bcp:store description="Reviewer finding original" -->`,
  })
  await h.settle(2)
  return { oldBody, newBody }
}

describe("v2 dispatch recipient identity (oracle e000001 P1)", () => {
  test("native subagent sessionID continuation delivers author feedback to the original author", async () => {
    const h = await makeHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator" },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: ALLOW },
        [R]: { id: R, parentID: P, agent: "oracle", permissions: ALLOW },
      },
      agents: [
        { id: "orchestrator", permissions: ALLOW },
        { id: "fixer", permissions: ALLOW },
        { id: "oracle", permissions: ALLOW },
      ],
    })
    const file = join(h.dataDir, "notes", "spec.md")
    const { oldBody, newBody } = await seedAuthorAndReviewer(h, file)
    const ids = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored").map((l) => l.id as string)
    expect(ids.length).toBe(2)
    // 正常钩子链：作者记录带真实 native_edit 绑定，且绑定的是 before→after 之间写入的
    // NEW 字节（精确 SHA256 + 留存快照内容双证），不是 before 前的旧版。
    const newSha = createHash("sha256").update(newBody, "utf8").digest("hex")
    const oldSha = createHash("sha256").update(oldBody, "utf8").digest("hex")
    const authorRecord = readRecord(h.dataDir, ids[0]!)
    const native = (authorRecord?.origin as { file_bindings?: Array<{ native_edit?: boolean; path?: string; ref?: string }> } | undefined)?.file_bindings?.filter((b) => b.native_edit && b.path === file && typeof b.ref === "string") ?? []
    expect(native.length).toBeGreaterThanOrEqual(1)
    expect(native[0]!.ref).toContain(`#sha256=${newSha}`)
    expect(native[0]!.ref).not.toContain(`#sha256=${oldSha}`)
    expect(readFileSync(fileURLToPath(native[0]!.ref!.split("#")[0]!), "utf8")).toBe(newBody)

    // 原生 subagent + sessionID=C：原作者续聊 → 作者反馈送达。
    const out = await h.delegate("subagent", P, "call-author", {
      agent: "fixer",
      description: "Revise spec",
      prompt: `Revise ${file} per the findings.`,
      sessionID: C,
    })
    expect(out.prompt).toContain("<bcp_author_feedback>")
    const handoff = h.logLines().filter((l) => l.ev === "source_handoff" && l.call === "call-author")
    expect(handoff.length).toBe(1)
    expect(handoff[0]).toMatchObject({ session: P, recipient: C })
    expect(new Set(handoff[0]!.references as string[])).toEqual(new Set(ids))

    // 同一会话经兼容 task 的真实 task_id 续聊 → 同一接收方路径，不回归。
    const viaTask = await h.delegate("task", P, "call-task", {
      subagent_type: "fixer",
      description: "Revise spec",
      prompt: `Revise ${file} per the findings.`,
      task_id: C,
    })
    expect(viaTask.prompt).toContain("<bcp_author_feedback>")
    expect(h.logLines().find((l) => l.ev === "source_handoff" && l.call === "call-task")).toMatchObject({ recipient: C })

    // 不猜字段：subagent 携带 task_id 不作数（按其真实 schema 读 sessionID）→ profile 路径。
    const wrongField = await h.delegate("subagent", P, "call-wrong-field", {
      agent: "fixer",
      description: "Revise spec",
      prompt: `Revise ${file} per the findings.`,
      task_id: C,
    })
    expect(wrongField.prompt).not.toContain("<bcp_author_feedback>")
    expect(h.logLines().find((l) => l.ev === "source_handoff" && l.call === "call-wrong-field")).toMatchObject({ recipient: "fixer" })
  })

  test("fresh independent dispatch follows agent profile and never receives the previous reviewer's findings", async () => {
    const h = await makeHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator" },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: ALLOW },
        [R]: { id: R, parentID: P, agent: "oracle", permissions: ALLOW },
      },
      agents: [
        { id: "orchestrator", permissions: ALLOW },
        { id: "fixer", permissions: ALLOW },
        { id: "oracle", permissions: ALLOW },
      ],
    })
    const file = join(h.dataDir, "notes", "spec.md")
    await seedAuthorAndReviewer(h, file)

    // 无续聊字段 = 全新独立派发（oracle）：按 profile 放行；派发者自有来源仍可引用，
    // 但前次 reviewer 对作者文件的 findings 不得出现（recipient=undefined → findings 恒空）。
    const fresh = await h.delegate("subagent", P, "call-fresh", {
      agent: "oracle",
      description: "Fresh review",
      prompt: `Independently review ${file}.`,
    })
    expect(fresh.prompt).not.toContain("<bcp_author_feedback>")
    const freshLog = h.logLines().find((l) => l.ev === "source_handoff" && l.call === "call-fresh")
    expect(freshLog).toMatchObject({ recipient: "oracle" })
    expect(freshLog!.references as string[]).not.toHaveLength(0) // 作者工件仍随派发者来源送达
  })

  test("session-level board_get deny overrides profile allow and keeps the prompt verbatim", async () => {
    const h = await makeHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator" },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: DENY_BOARD_GET },
        [R]: { id: R, parentID: P, agent: "oracle", permissions: ALLOW },
      },
      agents: [
        { id: "orchestrator", permissions: ALLOW },
        { id: "fixer", permissions: ALLOW },
        { id: "oracle", permissions: ALLOW },
      ],
    })
    const file = join(h.dataDir, "notes", "spec.md")
    await seedAuthorAndReviewer(h, file)
    const original = `Revise ${file} per the findings.`
    const out = await h.delegate("subagent", P, "call-deny", {
      agent: "fixer",
      description: "Revise spec",
      prompt: original,
      sessionID: C,
    })
    expect(out.prompt).toBe(original) // 会话 deny 覆盖 profile allow → 原文逐字保留
    expect(h.logLines().some((l) => l.ev === "source_handoff" && l.call === "call-deny")).toBe(false)
  })

  test("unverifiable explicit continuations keep the prompt verbatim and log no source_handoff", async () => {
    const h = await makeHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator" },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: ALLOW },
        [X]: { id: X, parentID: "ses_other_root", agent: "fixer", permissions: ALLOW },
      },
      agents: [
        { id: "orchestrator", permissions: ALLOW },
        { id: "fixer", permissions: ALLOW },
      ],
    })
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Seeded body so a wrong profile fallback would visibly rewrite the prompt. ".repeat(4))
    const puText = `Check the record about ${file} before revising.`
    await h.admit(P, "orchestrator", PU, puText)
    await h.finalizeChild({
      session: C,
      agent: "fixer",
      userId: CU,
      inputText: `You are a subagent spawned by another session.\n${puText}`,
      finalText: `Fixed the stale index handle.\n<!-- bcp:store description="Fixer author original" -->`,
      editBeforeFinal: { filePath: file, callId: "ce1", body: "Rewritten between the hooks for the unverifiable-continuation matrix. ".repeat(4) },
    })
    await h.settle(1)
    const original = `Continue fixing ${file}.`
    const base = { agent: "fixer", description: "Continue", prompt: original }

    // (a) 不存在的会话 → 不可证 → 原文保留（不降格 profile 重写）。
    const missing = await h.delegate("subagent", P, "call-missing", { ...base, sessionID: "ses_missing" })
    expect(missing.prompt).toBe(original)
    // (b) 非本会话子会话 → 原文保留。
    const foreign = await h.delegate("subagent", P, "call-foreign", { ...base, sessionID: X })
    expect(foreign.prompt).toBe(original)
    expect(h.logLines().some((l) => l.ev === "source_handoff" && (l.call === "call-missing" || l.call === "call-foreign"))).toBe(false)

    // (c) 接收方读取能力不可证（agent list RPC 失败）→ 原文保留。先证同路可重写，
    // 再翻转 RPC 失败：身份/权限不可证时不得继续重写。
    const h2 = await makeHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator" },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: ALLOW },
      },
      agents: () => agentList(),
    })
    let agentList: () => Array<{ id: string; permissions?: unknown }> = () => [
      { id: "orchestrator", permissions: ALLOW },
      { id: "fixer", permissions: ALLOW },
    ]
    const file2 = join(h2.dataDir, "notes", "spec.md")
    mkdirSync(join(file2, ".."), { recursive: true })
    writeFileSync(file2, "Second seeded body for the read-error path. ".repeat(6))
    const puText2 = `Check the record about ${file2} before revising.`
    await h2.admit(P, "orchestrator", PU, puText2)
    await h2.finalizeChild({
      session: C,
      agent: "fixer",
      userId: CU,
      inputText: `You are a subagent spawned by another session.\n${puText2}`,
      finalText: `Fixed it.\n<!-- bcp:store description="Fixer author original" -->`,
      editBeforeFinal: { filePath: file2, callId: "ce1", body: "Rewritten between the hooks for the read-error path. ".repeat(4) },
    })
    await h2.settle(1)
    const original2 = `Continue fixing ${file2}.`
    const before = await h2.delegate("subagent", P, "call-readable", {
      agent: "fixer",
      description: "Continue",
      prompt: original2,
      sessionID: C,
    })
    expect(before.prompt).not.toBe(original2) // 可证时正常重写（作者工件随行）
    agentList = () => {
      throw new Error("agent rpc unavailable")
    }
    const readError = await h2.delegate("subagent", P, "call-read-error", {
      agent: "fixer",
      description: "Continue",
      prompt: original2,
      sessionID: C,
    })
    expect(readError.prompt).toBe(original2)
    expect(h2.logLines().some((l) => l.ev === "source_handoff" && l.call === "call-read-error")).toBe(false)
  })
})

describe("v2 edit evidence hook chain (oracle e000002 P1)", () => {
  const HOSTS = {
    sessions: {
      [P]: { id: P, agent: "orchestrator" },
      [C]: { id: C, parentID: P, agent: "fixer", permissions: ALLOW },
    },
    agents: [
      { id: "orchestrator", permissions: ALLOW },
      { id: "fixer", permissions: ALLOW },
    ],
  }

  test("normal same-input edit produces a real native_edit binding via the registered hook chain", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const oldBody = "Author-edited body captured through the real before/after hook chain. ".repeat(4)
    const newBody = "REPLACED between the edit hooks; the journal row and the snapshot must carry these bytes. ".repeat(4)
    writeFileSync(file, oldBody)
    await h.finalizeChild({
      session: C,
      agent: "fixer",
      userId: CU,
      inputText: `Fix the spec at ${file}.`,
      finalText: `Edited and stored.\n<!-- bcp:store description="Native edit author original" -->`,
      editBeforeFinal: { filePath: file, callId: "ce1", body: newBody },
    })
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    const bindings = (record?.origin as { file_bindings?: Array<{ native_edit?: boolean; path?: string; ref?: string }> } | undefined)?.file_bindings ?? []
    // 精确 SHA256：绑定指向 before→after 之间写入的 NEW 字节，而非旧版。
    const newSha = createHash("sha256").update(newBody, "utf8").digest("hex")
    const oldSha = createHash("sha256").update(oldBody, "utf8").digest("hex")
    expect(bindings.some((b) => b.native_edit && b.path === file && b.ref?.includes(`#sha256=${newSha}`))).toBe(true)
    expect(bindings.some((b) => b.ref?.includes(`#sha256=${oldSha}`))).toBe(false)
    // 借 artifact 读取验证留存快照确为新内容。
    const nb = bindings.find((b) => b.native_edit)!
    expect(readFileSync(fileURLToPath(nb.ref!.split("#")[0]!), "utf8")).toBe(newBody)
    // journal 观察行由真实 after 钩子完成（非 pending）。
    const row = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce1")
    expect(row).toBeDefined()
    expect(row!.pending).toBeUndefined()
  })

  test("a new confirmed input between before and after never completes the old journal", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body whose edit observation must not leak across inputs. ".repeat(4))
    const cu2 = "msg_c_u2"
    await h.admit(C, "fixer", CU, `First turn about ${file}.`)
    h.wires[C] = [wu(CU, `First turn about ${file}.`), waText(CA, "fixer", "Reading before editing.", 3)]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: CA, ordinal: 0, text: "Reading before editing." })
    h.emit("session.step.failed", { sessionID: C, assistantMessageID: `${CA}_probe`, error: "fixture-sentinel" })
    await h.pumpSettled()
    // before 钩子（CU1 域，pending 行）→ 真实修改文件 → 换输入（新确认输入 CU2）→
    // after 钩子必须拒绝：即使文件在两钩子之间确实变了，该修改也不得被归因。
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-cross", input: { filePath: file } } as never)
    writeFileSync(file, "MODIFIED between before and after while the journal row is pending. ".repeat(4))
    await h.admit(C, "fixer", cu2, `Second turn about ${file}.`)
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-cross", input: { filePath: file }, status: "completed", result: {} } as never)
    // 新输入的终结留存：新 assistant 消息（新回合）。
    const a2 = "msg_c_a2"
    h.wires[C] = [wu(cu2, `Second turn about ${file}.`), waText(a2, "fixer", `Second turn stored.\n<!-- bcp:store description="Second turn original" -->`, Date.now())]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: a2, ordinal: 0, text: `Second turn stored.\n<!-- bcp:store description="Second turn original" -->` })
    h.emit("session.step.ended", { sessionID: C, assistantMessageID: a2, finish: "stop" })
    await h.settle(1)
    // CU1 journal 行仍 pending（isCurrent 拒绝 → 观察行未写入，不得串绑到新域）。
    const oldRow = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-cross")
    expect(oldRow?.pending).toBe(true)
    // 新输入记录不含任何绑定（含两钩子之间的真实修改，零归因）。
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect((record?.origin as { input_message_id?: string } | undefined)?.input_message_id).toBe(cu2)
    expect((record?.origin as { file_bindings?: unknown[] } | undefined)?.file_bindings ?? []).toHaveLength(0)
    const bindings = (record?.origin as { file_bindings?: Array<{ native_edit?: boolean }> } | undefined)?.file_bindings ?? []
    expect(bindings.some((b) => b.native_edit)).toBe(false)
  })

  test("input change during the after hook's authorize await is rejected by the isCurrent fence (initial guard provably passed)", async () => {
    let armed = false
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))
    let enteredCount = 0
    let resolveEntered!: () => void
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
    const h = await makeHost({
      sessions: HOSTS.sessions,
      agents: HOSTS.agents,
      // 握手闸门挂在 authorize 的 agent.list RPC（after 钩子体内唯一确定的挂起点）：
      // 进入闸门先 signal（并一次性解除武装，避免 admit/settle 阶段的 agent.list 被误挂），
      // 再阻塞等待测试放行。readMessage 对 user 输入走 snapshots 缓存，不会请求
      // ctx.session.context，故不存在可挂的 readMessage await——见 makeHost 注释。
      gateAuthorize: {
        armed: () => armed,
        wait: gate,
        entered: () => {
          armed = false
          enteredCount += 1
          resolveEntered()
        },
      },
    })
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited while a second input arrives mid-authorize. ".repeat(4))
    const cu2 = "msg_c_u2b"
    await h.admit(C, "fixer", CU, `Race turn about ${file}.`)
    h.wires[C] = [wu(CU, `Race turn about ${file}.`), waText(CA, "fixer", "Reading before editing.", 3)]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: CA, ordinal: 0, text: "Reading before editing." })
    h.emit("session.step.failed", { sessionID: C, assistantMessageID: `${CA}_probe`, error: "fixture-sentinel" })
    await h.pumpSettled()
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-race", input: { filePath: file } } as never)
    // after 钩子体内顺序：:1100-1102 初始栅栏（此刻 CU1 仍 current，通过）→ readMessage
    // （user 输入缓存命中，确定取得 CU1）→ authorize（agent.list RPC，闸门）。armed 置位
    // 必须在 before 之后，使唯一被挡的调用点是 after 钩子自己的 authorize。
    armed = true
    const afterDone = h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-race", input: { filePath: file }, status: "completed", result: {} } as never) as Promise<void>
    try {
      // 确定性握手：entered 触发 ⇒ 初始栅栏已被评估并通过（它在 hook 体内严格先于
      // authorize），且 readMessage 已成功返回有效 CU1（若 readMessage 返回空，钩子会在
      // authorize 之前提前 return，闸门永不进入 → await entered 撞框架超时而失败）。
      // 因此挂起期间换输入后，剩余唯一拒绝点就是 observeEdits 入口的 isCurrent 栅栏。
      await entered
      // 挂起期间真实写入新内容并确认新输入 CU2（receipts.begin() 切换 current）。
      writeFileSync(file, "REWRITTEN inside the authorize await window; this change must not be attributed. ".repeat(4))
      await h.admit(C, "fixer", cu2, `Raced second turn about ${file}.`)
    } finally {
      releaseGate()
    }
    await afterDone
    expect(enteredCount).toBe(1)
    const a2 = "msg_c_a2b"
    h.wires[C] = [wu(cu2, `Raced second turn about ${file}.`), waText(a2, "fixer", `Raced turn stored.\n<!-- bcp:store description="Raced turn original" -->`, Date.now())]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: a2, ordinal: 0, text: `Raced turn stored.\n<!-- bcp:store description="Raced turn original" -->` })
    h.emit("session.step.ended", { sessionID: C, assistantMessageID: a2, finish: "stop" })
    await h.settle(1)
    // authorize await 期间换输入 → isCurrent 栅栏（observeEdits 入口）拒绝 → 行仍 pending。
    const oldRow = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-race")
    expect(oldRow?.pending).toBe(true)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect((record?.origin as { input_message_id?: string } | undefined)?.input_message_id).toBe(cu2)
    // 挂起窗口内的真实文件修改零归因：新输入记录无任何文件绑定。
    expect((record?.origin as { file_bindings?: unknown[] } | undefined)?.file_bindings ?? []).toHaveLength(0)
  })

  test("after-hook without a before-hook yields no native evidence (fail closed)", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body for an after hook whose before hook never ran. ".repeat(4))
    await h.admit(C, "fixer", CU, `Orphan turn about ${file}.`)
    h.wires[C] = [wu(CU, `Orphan turn about ${file}.`), waText(CA, "fixer", "Reading before editing.", 3)]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: CA, ordinal: 0, text: "Reading before editing." })
    h.emit("session.step.failed", { sessionID: C, assistantMessageID: `${CA}_probe`, error: "fixture-sentinel" })
    await h.pumpSettled()
    // 只有 after 钩子（无 before → 无 pending 行、无代币）→ volatile 负证据：
    // 归属不可证（no-store 未知），不落持久形态，但该输入的编辑证据整体拒绝。
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-orphan", input: { filePath: file }, status: "completed", result: {} } as never)
    h.wires[C] = [wu(CU, `Orphan turn about ${file}.`), waText(CA, "fixer", `Orphan stored.\n<!-- bcp:store description="Orphan original" -->`, Date.now())]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: CA, ordinal: 1, text: `Orphan stored.\n<!-- bcp:store description="Orphan original" -->` })
    h.emit("session.step.ended", { sessionID: C, assistantMessageID: CA, finish: "stop" })
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const origin = readRecord(h.dataDir, stored[0]!.id as string)?.origin as { file_bindings?: Array<{ native_edit?: boolean }>; source_errors?: string[] } | undefined
    expect((origin?.file_bindings ?? []).some((b) => b.native_edit)).toBe(false)
    expect(origin?.source_errors?.join(" ")).toContain("edit_evidence_attribution_unproven")
  })

  test("no-store input skips edit evidence and capture entirely (fail closed)", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited under a no-store directive must not be observed. ".repeat(4))
    await h.finalizeChild({
      session: C,
      agent: "fixer",
      userId: CU,
      inputText: `<!-- bcp:no-store -->\nFix the spec at ${file} but keep this turn unrecorded.`,
      finalText: `Edited under no-store.\n<!-- bcp:store description="Should never be stored" -->`,
      editBeforeFinal: { filePath: file, callId: "ce-nostore", body: "Rewritten between the hooks under a no-store input. ".repeat(4) },
    })
    await h.settle(1)
    // 终稿留存被 no-store 输入拒绝：无 stored 记录。
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(0)
    // before/after 钩子都在 no-store 检查处提前返回：journal 根本不存在。
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    // 且无持久哨兵、无任何留存工件对应新字节。
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(false)
    const newBody = "Rewritten between the hooks under a no-store input. ".repeat(4)
    const newSha = createHash("sha256").update(newBody, "utf8").digest("hex")
    const { scope, streamId } = openSessionScope(h.dataDir, C, "fixer")
    const artifactsDir = join(scope.dir, "streams", streamId, "artifacts")
    const leaked = existsSync(artifactsDir) && readdirSync(artifactsDir).some((f) => f.startsWith(newSha))
    expect(leaked).toBe(false)
  })
})

describe("v2 tool-only edit attribution (oracle matrix)", () => {
  const HOSTS = {
    sessions: {
      [P]: { id: P, agent: "orchestrator" },
      [C]: { id: C, parentID: P, agent: "fixer", permissions: ALLOW },
    },
    agents: [
      { id: "orchestrator", permissions: ALLOW },
      { id: "fixer", permissions: ALLOW },
    ],
  }

  // tool-only 公共步：assistant 只有零 text part 的 wire 行（无 text.ended、不泵事件、
  // receipts 未登记），直接驱动真实 before/after 钩子对；between 模拟两钩子之间的真实写入。
  const runEditPair = async (
    h: Awaited<ReturnType<typeof makeHost>>,
    session: string,
    assistantId: string,
    callId: string,
    file: string,
    between?: () => void,
    status = "completed",
  ): Promise<void> => {
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: session, messageID: assistantId, id: callId, input: { filePath: file } } as never)
    between?.()
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: session, messageID: assistantId, id: callId, input: { filePath: file }, status, result: {} } as never)
  }

  // 终稿：wire 替换为带 completed 的 assistant + 留存标记 → 真实事件泵 capture。
  // agent 默认 fixer；身份漂移场景传漂移后身份（capture.ts:71 要求终稿 assistant 的
  // agent 与当前登记身份一致，漂移后轮次本就以新身份完成）。
  const finishTurn = async (h: Awaited<ReturnType<typeof makeHost>>, session: string, userId: string, inputText: string, assistantId: string, finalText: string, agent = "fixer"): Promise<void> => {
    h.wires[session] = [wu(userId, inputText), waText(assistantId, agent, finalText, Date.now())]
    h.emit("session.text.ended", { sessionID: session, assistantMessageID: assistantId, ordinal: 0, text: finalText })
    h.emit("session.step.ended", { sessionID: session, assistantMessageID: assistantId, finish: "stop" })
  }

  const nativeBindings = (record: ReturnType<typeof readRecord>): Array<{ native_edit?: boolean; path?: string; ref?: string }> =>
    (record?.origin as { file_bindings?: Array<{ native_edit?: boolean; path?: string; ref?: string }> } | undefined)?.file_bindings ?? []
  // 共享 dataDir 场景：旧实例的 final_capture 行已计入 total → 以基线相对等待。
  const settleMore = async (h: Awaited<ReturnType<typeof makeHost>>, baseline: number, extra = 1): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (h.logLines().filter((l) => l.ev === "final_capture").length >= baseline + extra) {
        await new Promise((r) => setTimeout(r, 10))
        return
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const sourceErrors = (record: ReturnType<typeof readRecord>): string =>
    ((record?.origin as { source_errors?: string[] } | undefined)?.source_errors ?? []).join(" ")
  // 工件目录可能从未创建（零快照=期望的阴性结果）→ 视为不存在指定快照。
  const artifactExists = (dataDir: string, session: string, agent: string, sha: string): boolean => {
    const { scope, streamId } = openSessionScope(dataDir, session, agent)
    const artifactsDir = join(scope.dir, "streams", streamId, "artifacts")
    if (!existsSync(artifactsDir)) return false
    return readdirSync(artifactsDir).some((name) => name.startsWith(sha))
  }

  test("tool-only first edit (assistant never registered) attributes the edit to the confirmed input", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const oldBody = "Original body before any tool-only edit observation. ".repeat(4)
    const newBody = "NEW bytes written between the tool-only before and after hooks. ".repeat(4)
    const thirdBody = "THIRD on-site revision after the after hook; bindings must still point at NEW. ".repeat(4)
    writeFileSync(file, oldBody)
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    // 缺陷前提：assistant 已在宿主 context、但零 text part 且从未经事件泵登记。
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await runEditPair(h, C, CA, "ce-t1", file, () => writeFileSync(file, newBody))
    // after 之后的现场第三版：留存绑定必须仍指向 NEW（不得事后改指旧版或现场最新）。
    writeFileSync(file, thirdBody)
    await finishTurn(h, C, CU, inputText, CA, `Edited and stored.\n<!-- bcp:store description="Tool-only author original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect((record?.origin as { input_message_id?: string } | undefined)?.input_message_id).toBe(CU)
    const bindings = nativeBindings(record)
    const newSha = createHash("sha256").update(newBody, "utf8").digest("hex")
    const oldSha = createHash("sha256").update(oldBody, "utf8").digest("hex")
    const thirdSha = createHash("sha256").update(thirdBody, "utf8").digest("hex")
    expect(bindings.some((b) => b.native_edit && b.path === file && b.ref?.includes(`#sha256=${newSha}`))).toBe(true)
    expect(bindings.some((b) => b.ref?.includes(`#sha256=${oldSha}`) || b.ref?.includes(`#sha256=${thirdSha}`))).toBe(false)
    const nb = bindings.find((b) => b.native_edit)!
    expect(readFileSync(fileURLToPath(nb.ref!.split("#")[0]!), "utf8")).toBe(newBody)
    const row = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-t1")
    expect(row).toBeDefined()
    expect(row!.pending).toBeUndefined()
  })

  test("consecutive tool-only steps on the same input keep completing each row and bind the latest bytes", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const oldBody = "Original body before two consecutive tool-only edit steps. ".repeat(4)
    const new1 = "NEW1 bytes from the first tool-only step. ".repeat(6)
    const new2 = "NEW2 bytes from the second tool-only step must win the binding. ".repeat(4)
    writeFileSync(file, oldBody)
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    const a1 = "msg_c_a_s1"
    const a2 = "msg_c_a_s2"
    h.wires[C] = [wu(CU, inputText), waEmpty(a1, "fixer")]
    await runEditPair(h, C, a1, "ce-s1", file, () => writeFileSync(file, new1))
    h.wires[C] = [wu(CU, inputText), waEmpty(a1, "fixer"), waEmpty(a2, "fixer")]
    await runEditPair(h, C, a2, "ce-s2", file, () => writeFileSync(file, new2))
    // 终稿：a1 只发 text.ended（不终结 step），a2 发 text.ended + step.ended 驱动一次 capture。
    const finalText = `Both steps stored.\n<!-- bcp:store description="Consecutive steps original" -->`
    h.wires[C] = [wu(CU, inputText), waText(a1, "fixer", "Reading before editing.", Date.now()), waText(a2, "fixer", finalText, Date.now())]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: a1, ordinal: 0, text: "Reading before editing." })
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: a2, ordinal: 0, text: finalText })
    h.emit("session.step.ended", { sessionID: C, assistantMessageID: a2, finish: "stop" })
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const journal = readJournal(h.dataDir, C, "fixer", CU)
    expect(journal?.observations.find((r) => r.call === "ce-s1")?.pending).toBeUndefined()
    expect(journal?.observations.find((r) => r.call === "ce-s2")?.pending).toBeUndefined()
    const bindings = nativeBindings(readRecord(h.dataDir, stored[0]!.id as string))
    const new2Sha = createHash("sha256").update(new2, "utf8").digest("hex")
    const oldSha = createHash("sha256").update(oldBody, "utf8").digest("hex")
    expect(bindings.some((b) => b.native_edit && b.ref?.includes(`#sha256=${new2Sha}`))).toBe(true)
    expect(bindings.some((b) => b.ref?.includes(`#sha256=${oldSha}`))).toBe(false)
    const nb2 = bindings.find((b) => b.native_edit && b.ref?.includes(`#sha256=${new2Sha}`))!
    expect(readFileSync(fileURLToPath(nb2.ref!.split("#")[0]!), "utf8")).toBe(new2)
  })

  test("unprovable attribution (duplicate/synthetic/mismatch/orphan/agent conflict) yields volatile negative evidence only", async () => {
    const inputTextFor = (file: string): string => `Fix the spec at ${file}.`
    const cases: Array<{ name: string; wires: (userId: string) => Wire[] }> = [
      { name: "duplicate assistant id", wires: (userId) => [wu(userId, "x"), waEmpty(CA, "fixer"), waEmpty(CA, "fixer")] },
      { name: "synthetic boundary before the assistant", wires: (userId) => [wu(userId, "x"), { id: "msg_syn1", type: "synthetic" }, waEmpty(CA, "fixer")] },
      { name: "preceding user id does not match the confirmed input", wires: () => [wu("msg_other_u", "x"), waEmpty(CA, "fixer")] },
      { name: "assistant without any user predecessor", wires: () => [waEmpty(CA, "fixer")] },
      { name: "wire agent differs from the registered session identity", wires: (userId) => [wu(userId, "x"), waEmpty(CA, "someone_else")] },
    ]
    for (const c of cases) {
      const h = await makeHost(HOSTS)
      const file = join(h.dataDir, "notes", "spec.md")
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, "Body whose edit must not be attributed when the wire cannot prove ownership. ".repeat(4))
      const inputText = inputTextFor(file)
      await h.admit(C, "fixer", CU, inputText)
      h.wires[C] = c.wires(CU)
      await runEditPair(h, C, CA, "ce-cf", file)
      // 归属先于落盘：解析不可证 → 不建 pending、不签发代币。
      expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
      await finishTurn(h, C, CU, inputText, CA, `Stored with unproven attribution.\n<!-- bcp:store description="Unproven attribution original" -->`)
      await h.settle(1)
      const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
      expect(stored.length).toBe(1)
      const record = readRecord(h.dataDir, stored[0]!.id as string)
      // volatile 负证据：整体拒绝该输入的编辑证据，且无任何 native 绑定。
      expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
      expect(nativeBindings(record).some((b) => b.native_edit)).toBe(false)
    }
  })

  test("context RPC failure during attribution keeps evidence volatile", async () => {
    let ctxFail = false
    const h = await makeHost({ ...HOSTS, contextError: () => ctxFail })
    await h.admit(P, "orchestrator", PU, "Parent dispatch turn.")
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited while the context RPC is unavailable. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    ctxFail = true
    await runEditPair(h, C, CA, "ce-ctx", file)
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    ctxFail = false
    await finishTurn(h, C, CU, inputText, CA, `Stored after context failure.\n<!-- bcp:store description="Context failure original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    expect(nativeBindings(record).some((b) => b.native_edit)).toBe(false)
  })

  test("before hook without messageID is unprovable and never issues a token", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited by a before hook that carries no assistant message id. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, id: "ce-nomid", input: { filePath: file } } as never)
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-nomid", input: { filePath: file }, status: "completed", result: {} } as never)
    await finishTurn(h, C, CU, inputText, CA, `Stored without a message id.\n<!-- bcp:store description="Missing id original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    expect(nativeBindings(record).some((b) => b.native_edit)).toBe(false)
  })

  test("non-completed after hook invalidates durably and keeps the pending row", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const newBody = "NEW bytes written before the edit call ended in an error. ".repeat(4)
    writeFileSync(file, "Original body whose edit call ends in an error status. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-err", input: { filePath: file } } as never)
    writeFileSync(file, newBody)
    // completed-only：error 可能部分写入——原域显式失效（.incomplete 哨兵），不以未完成调用补拍。
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-err", input: { filePath: file }, status: "error", result: {} } as never)
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(true)
    const row = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-err")
    expect(row?.pending).toBe(true)
    await finishTurn(h, C, CU, inputText, CA, `Stored after an errored edit.\n<!-- bcp:store description="Errored edit original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_incomplete")
    // error 路径同样先落 volatile：报告同时携带归属不可证。
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    expect(nativeBindings(record).some((b) => b.native_edit)).toBe(false)
  })

  test("a late duplicate after event cannot claim the new input or disturb the old binding", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const newBody = "NEW bytes from the first turn whose after event will arrive late once more. ".repeat(4)
    writeFileSync(file, "Original body for the late-event scenario. ".repeat(4))
    const input1 = `First turn about ${file}.`
    await h.admit(C, "fixer", CU, input1)
    h.wires[C] = [wu(CU, input1), waEmpty(CA, "fixer")]
    await runEditPair(h, C, CA, "ce-late", file, () => writeFileSync(file, newBody))
    await finishTurn(h, C, CU, input1, CA, `First turn stored.\n<!-- bcp:store description="Late event first original" -->`)
    await h.settle(1)
    const firstId = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored").map((l) => l.id as string)[0]!
    const firstSha = createHash("sha256").update(newBody, "utf8").digest("hex")
    expect(nativeBindings(readRecord(h.dataDir, firstId)).some((b) => b.native_edit && b.ref?.includes(`#sha256=${firstSha}`))).toBe(true)
    // 新输入确认后，同一 call 的迟到旧 after 不得认领新输入：volatile 负证据。
    const cu2 = "msg_c_u_late2"
    const input2 = `Second turn about ${file}.`
    await h.admit(C, "fixer", cu2, input2)
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-late", input: { filePath: file }, status: "completed", result: {} } as never)
    const a2 = "msg_c_a_late2"
    h.wires[C] = [wu(CU, input1), waText(CA, "fixer", `First turn stored.\n<!-- bcp:store description="Late event first original" -->`, Date.now()), wu(cu2, input2), waText(a2, "fixer", `Second turn stored.\n<!-- bcp:store description="Late event second original" -->`, Date.now())]
    h.emit("session.text.ended", { sessionID: C, assistantMessageID: a2, ordinal: 0, text: `Second turn stored.\n<!-- bcp:store description="Late event second original" -->` })
    h.emit("session.step.ended", { sessionID: C, assistantMessageID: a2, finish: "stop" })
    await h.settle(2)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(2)
    // 旧绑定原样保留；新输入零绑定 + volatile 负证据。
    expect(nativeBindings(readRecord(h.dataDir, firstId)).some((b) => b.native_edit && b.ref?.includes(`#sha256=${firstSha}`))).toBe(true)
    const second = readRecord(h.dataDir, stored.map((l) => l.id as string).find((id) => id !== firstId)!)
    expect((second?.origin as { input_message_id?: string } | undefined)?.input_message_id).toBe(cu2)
    expect(nativeBindings(second).some((b) => b.native_edit)).toBe(false)
    expect(sourceErrors(second)).toContain("edit_evidence_attribution_unproven")
  })

  test("token eviction (cap 128) turns the evicted call's after into volatile negative evidence", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited by 130 consecutive before hooks that evict the earliest token. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    for (let i = 0; i < 130; i++) {
      await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: `ce-e${i}`, input: { filePath: file } } as never)
    }
    // 代币 FIFO 上限 128 → ce-e0 最早被淘汰；其 after 无代币 → volatile，不得补拍。
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-e0", input: { filePath: file }, status: "completed", result: {} } as never)
    const journal = readJournal(h.dataDir, C, "fixer", CU)
    expect(journal?.observations.length).toBe(130)
    expect(journal?.observations.find((r) => r.call === "ce-e0")?.pending).toBe(true)
    await finishTurn(h, C, CU, inputText, CA, `Stored after eviction.\n<!-- bcp:store description="Eviction original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    expect(sourceErrors(record)).toContain("edit_evidence_incomplete")
    expect(nativeBindings(record).some((b) => b.native_edit)).toBe(false)
  })

  test("quota exhaustion at beginEditObservation writes the durable sentinel and blocks native evidence", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited while the scope quota cannot fit a journal row. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // 诚实触发：config getter 每次重读 scope.json——把配额压到当前用量之下。
    const { scope } = openSessionScope(h.dataDir, C, "fixer")
    const cfgPath = join(scope.dir, "scope.json")
    const original = readFileSync(cfgPath, "utf8")
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(original), quota_bytes: 10 }))
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-q", input: { filePath: file } } as never)
    // journal 写失败 → catch 落持久哨兵；主 journal 不存在。
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(true)
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    // 恢复配额，让终稿留存正常走完，验证哨兵持续拒绝 native 证据。
    writeFileSync(cfgPath, original)
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-q", input: { filePath: file }, status: "completed", result: {} } as never)
    await finishTurn(h, C, CU, inputText, CA, `Stored after quota failure.\n<!-- bcp:store description="Quota original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    // 读侧报告语义属共享 edit-evidence 形状（本 scope 不改）：journal 文件从未写成功时，
    // 编辑证据整体报 unavailable（哨兵检查在 journal 存在分支内）；叠加 volatile 负证据，
    // native 绑定恒空。哨兵本身已在盘上（上方 journalIncompleteExists 断言）。
    expect(sourceErrors(record)).toContain("edit_evidence_unavailable")
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    expect(nativeBindings(record).some((b) => b.native_edit)).toBe(false)
  })

  test("restart loses in-memory tokens but the on-disk pending row still blocks substitution", async () => {
    const h1 = await makeHost(HOSTS)
    const file = join(h1.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited right before a simulated host restart. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h1.admit(C, "fixer", CU, inputText)
    h1.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // 只有 before 钩子：pending 行落盘 + 代币只在内存（after 迟到，留给重启后的新实例）。
    await h1.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-r", input: { filePath: file } } as never)
    const rowBefore = readJournal(h1.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-r")
    expect(rowBefore?.pending).toBe(true)
    // 模拟重启：关实例1（abort 事件泵），新实例同 dataDir / 同 wire 视图；代币只在内存 → 丢失。
    h1.close()
    const h2 = await makeHost({ ...HOSTS, dataDir: h1.dataDir, sharedWires: h1.wires })
    await h2.admit(C, "fixer", CU, inputText)
    await h2.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-r", input: { filePath: file }, status: "completed", result: {} } as never)
    // 重启前的 pending 行仍在盘上 → 负证据保留，旧快照不得冒充新结果。
    const row = readJournal(h2.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-r")
    expect(row?.pending).toBe(true)
    await finishTurn(h2, C, CU, inputText, CA, `Stored after restart.\n<!-- bcp:store description="Restart original" -->`)
    await h2.settle(1)
    const stored = h2.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h2.dataDir, stored[0]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_incomplete")
    // h2 的 after 无代币 → volatile 单调负证据同样入报告。
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    expect(nativeBindings(record).some((b) => b.native_edit)).toBe(false)
  })

  // ---- 第四轮返修矩阵：安全边界（负证据单调 / 冻结域复核 / 失效写入 fail-closed） ----

  test("a later successful edit cannot launder an earlier unproven edit of the same input", async () => {
    // 单调负证据：同 State 一旦出现归属不可证，后续成功编辑不得洗白——旧 A 快照不得复活。
    const h = await makeHost(HOSTS)
    const fileA = join(h.dataDir, "notes", "alpha.md")
    const fileB = join(h.dataDir, "notes", "beta.md")
    mkdirSync(join(fileA, ".."), { recursive: true })
    const a1 = "ALPHA v1 observed cleanly by the first successful call. ".repeat(4)
    const a2 = "ALPHA v2 written by an unattributable orphan call. ".repeat(4)
    const bNew = "BETA rewritten by a later successful call in the same input. ".repeat(4)
    writeFileSync(fileA, "ALPHA v0 before any observation. ".repeat(4))
    writeFileSync(fileB, "BETA v0 before any observation. ".repeat(4))
    const inputText = `Tidy ${fileA} and ${fileB}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // ① 成功观测 A=ALPHA v1（干净基线：journal 行完成 + 代币正常消费）。
    await runEditPair(h, C, CA, "ce-mono-a", fileA, () => writeFileSync(fileA, a1))
    // ② 未可归属调用真实把 A 改为 v2（wire 中无该 assistant 行 → 归属不可证）。
    const ghost = "msg_c_a_ghost"
    writeFileSync(fileA, a2)
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: ghost, id: "ce-mono-ghost", input: { filePath: fileA } } as never)
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: ghost, id: "ce-mono-ghost", input: { filePath: fileA }, status: "completed", result: {} } as never)
    // ③ 同输入内的成功编辑 B 不得洗白 ②（volatile 标记随 State 单调保留）。
    await runEditPair(h, C, CA, "ce-mono-b", fileB, () => writeFileSync(fileB, bNew))
    await finishTurn(h, C, CU, inputText, CA, `Stored after the laundering attempt.\n<!-- bcp:store description="Monotonic unproven original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    // volatile 单调保留 → 该输入编辑证据整体降级：无任何 native 绑定（A=v1/v2 旧快照都不得复活）。
    expect(nativeBindings(record)).toHaveLength(0)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    // 场景真实性：A 在盘上确是未可归属的 v2；成功行已完成，但证据仍整体拒绝。
    expect(readFileSync(fileA, "utf8")).toBe(a2)
    const journal = readJournal(h.dataDir, C, "fixer", CU)
    expect(journal?.observations.find((r) => r.call === "ce-mono-a")?.pending).toBeUndefined()
    expect(journal?.observations.find((r) => r.call === "ce-mono-b")?.pending).toBeUndefined()
    expect(journal?.observations.find((r) => r.call === "ce-mono-ghost")).toBeUndefined()
  })

  // 身份漂移场景：漂移目标 agent 必须是真实 ALLOW profile——否则终稿留存本身也被拒，
  // 观察不到编辑证据的负证据报告。编辑证据仍必须 fail-closed。
  const HOSTS_DRIFT = {
    sessions: {
      [P]: { id: P, agent: "orchestrator" },
      [C]: { id: C, parentID: P, agent: "fixer", permissions: ALLOW },
    },
    agents: [
      { id: "orchestrator", permissions: ALLOW },
      { id: "fixer", permissions: ALLOW },
      { id: "oracle", permissions: ALLOW },
    ],
  }

  test("an agent identity change on the same input during the before authorize await blocks token issuance", async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))
    let armed = false
    let enteredCount = 0
    let resolveEntered!: () => void
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
    const h = await makeHost({
      sessions: HOSTS_DRIFT.sessions,
      agents: HOSTS_DRIFT.agents,
      gateAuthorize: {
        armed: () => armed,
        wait: gate,
        entered: () => {
          armed = false
          enteredCount += 1
          resolveEntered()
        },
      },
    })
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited while the same input re-registers under a new agent. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // armed 置位后启动 before：初始栅栏/contextMessages/resolveEditInput 已过，确定性挂起于
    // authorize 的 agent.list（before 钩子体内唯一 await 闸门）。
    armed = true
    const beforeDone = h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-id-b", input: { filePath: file } } as never) as Promise<void>
    try {
      await entered
      // 同一输入、同一 State：真实 context 钩子把登记 agent 原地改写（refreshIdentity
      // 不清 confirmed/runInput——正是 stable() 三元组检测不到的漂移）。
      await h.hooks.context({ sessionID: C, agent: "oracle", messages: [um(CU, inputText)], system: [] } as never)
    } finally {
      releaseGate()
    }
    await beforeDone
    expect(enteredCount).toBe(1)
    // 域漂移：不得签发代币、不得写 pending 行；已核实原域失败 → 持久哨兵落盘 + volatile。
    expect(readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-id-b")).toBeUndefined()
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(true)
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-id-b", input: { filePath: file }, status: "completed", result: {} } as never)
    // 漂移后轮次以新身份 oracle 完成；fixer 名下 pending 缺失 + volatile 不得产生旧作者 native。
    await finishTurn(h, C, CU, inputText, CA, `Stored after identity drift.\n<!-- bcp:store description="Identity drift original" -->`, "oracle")
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(nativeBindings(record)).toHaveLength(0)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
  })

  test("a skip-agent re-registration on the same input during the before authorize await taints the domain fail closed", async () => {
    // skipAgents 在 setup 时捕获（createBlackboardState 读一次环境变量），须在 makeHost 前设置。
    process.env.BLACKBOARD_SKIP_AGENTS = "oracle"
    try {
      let releaseGate!: () => void
      const gate = new Promise<void>((resolve) => (releaseGate = resolve))
      let armed = false
      let enteredCount = 0
      let resolveEntered!: () => void
      const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
      const h = await makeHost({
        sessions: HOSTS_DRIFT.sessions,
        agents: HOSTS_DRIFT.agents,
        gateAuthorize: {
          armed: () => armed,
          wait: gate,
          entered: () => {
            armed = false
            enteredCount += 1
            resolveEntered()
          },
        },
      })
      const file = join(h.dataDir, "notes", "spec.md")
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, "Body edited while the same input re-registers under a skip agent. ".repeat(4))
      const inputText = `Fix the spec at ${file}.`
      await h.admit(C, "fixer", CU, inputText)
      h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
      armed = true
      const beforeDone = h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-taint", input: { filePath: file } } as never) as Promise<void>
      try {
        await entered
        // skip 名单内 agent 的重新登记：registerScopeContext 走 taintAndInvalidate
        // （st.skipTainted + scope 持久 skip_tainted），冻结域复核必须拒绝。
        await h.hooks.context({ sessionID: C, agent: "oracle", messages: [um(CU, inputText)], system: [] } as never)
      } finally {
        releaseGate()
      }
      await beforeDone
      expect(enteredCount).toBe(1)
      expect(readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-taint")).toBeUndefined()
      expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(true)
      // skip 污染是该会话证据域的持久状态：终稿留存本身也被拒（更强 fail-closed）——
      // 无记录即无任何 native 绑定，不依赖负证据报告。
      await finishTurn(h, C, CU, inputText, CA, `Stored after taint.\n<!-- bcp:store description="Tainted domain original" -->`)
      await h.settle(1)
      const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
      expect(stored.length).toBe(0)
    } finally {
      delete process.env.BLACKBOARD_SKIP_AGENTS
    }
  })

  test("an agent identity change on the same input during the after authorize await keeps the row pending", async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))
    let armed = false
    let enteredCount = 0
    let resolveEntered!: () => void
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
    const h = await makeHost({
      sessions: HOSTS_DRIFT.sessions,
      agents: HOSTS_DRIFT.agents,
      gateAuthorize: {
        armed: () => armed,
        wait: gate,
        entered: () => {
          armed = false
          enteredCount += 1
          resolveEntered()
        },
      },
    })
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited while the after authorize await re-registers the agent. ".repeat(4))
    const newBody = "NEW bytes whose pending row must not complete after identity drift. ".repeat(4)
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // before 未武装：pending 行 + 代币正常签发。
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-id-a", input: { filePath: file } } as never)
    expect(readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-id-a")?.pending).toBe(true)
    // armed 在 before 之后置位：唯一被挡的调用点是 after 钩子自己的 authorize。
    armed = true
    writeFileSync(file, newBody)
    const afterDone = h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-id-a", input: { filePath: file }, status: "completed", result: {} } as never) as Promise<void>
    try {
      await entered
      await h.hooks.context({ sessionID: C, agent: "oracle", messages: [um(CU, inputText)], system: [] } as never)
    } finally {
      releaseGate()
    }
    await afterDone
    expect(enteredCount).toBe(1)
    // 观察域漂移：pending 行不得完成（旧作者身份不得产生 native 证据）。
    const row = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-id-a")
    expect(row?.pending).toBe(true)
    await finishTurn(h, C, CU, inputText, CA, `Stored after after-hook identity drift.\n<!-- bcp:store description="After drift original" -->`, "oracle")
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(nativeBindings(record)).toHaveLength(0)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    expect(sourceErrors(record)).toContain("edit_evidence_incomplete")
  })

  test("when both begin and sentinel writes fail, the volatile mark still blocks the old snapshot", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const body1 = "Body observed cleanly before the journal directory went unwritable. ".repeat(4)
    const body2 = "Body written by the call whose journal and sentinel writes both fail. ".repeat(4)
    writeFileSync(file, "Original body before any edit call. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // 先有成功 A 快照行（健康 journal：ce-io-1 完成，快照=body1）。
    await runEditPair(h, C, CA, "ce-io-1", file, () => writeFileSync(file, body1))
    const { scope, streamId } = openSessionScope(h.dataDir, C, "fixer")
    const editsDir = join(scope.dir, "streams", streamId, "edits")
    // 真实文件系统故障：edits 目录只读 → begin 与 sentinel 写都必须失败。
    chmodSync(editsDir, 0o555)
    try {
      writeFileSync(file, body2)
      await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-io-2", input: { filePath: file } } as never)
      // 两个持久写入都失败（哨兵未落盘）；volatile 负证据仍在内存。
      expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(false)
    } finally {
      chmodSync(editsDir, 0o755)
    }
    // 恢复后 after（无代币）→ volatile；终稿留存不得复活 body1 旧快照。
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-io-2", input: { filePath: file }, status: "completed", result: {} } as never)
    await finishTurn(h, C, CU, inputText, CA, `Stored after the IO failure window.\n<!-- bcp:store description="IO failure original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(nativeBindings(record)).toHaveLength(0)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
    const journal = readJournal(h.dataDir, C, "fixer", CU)
    expect(journal?.observations.find((r) => r.call === "ce-io-1")?.pending).toBeUndefined()
    expect(journal?.observations.find((r) => r.call === "ce-io-2")).toBeUndefined()
  })

  test("an edit after without a message id leaves explicit negative evidence, not a silent pass", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const body1 = "Body observed cleanly before the id-less after event arrived. ".repeat(4)
    const body2 = "Body written by the call whose after event carries no message id. ".repeat(4)
    writeFileSync(file, "Original body before the id-less call. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await runEditPair(h, C, CA, "ce-nomid-1", file, () => writeFileSync(file, body1))
    writeFileSync(file, body2)
    // 缺 messageID 的 edit after：不得静默通过让健康旧 journal 成功。
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, id: "ce-nomid-2", input: { filePath: file }, status: "completed", result: {} } as never)
    await finishTurn(h, C, CU, inputText, CA, `Stored after the id-less after event.\n<!-- bcp:store description="Id-less after original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(nativeBindings(record)).toHaveLength(0)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
  })

  test("an assistant wire row without an agent identity is rejected conservatively", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited under an assistant row that carries no agent identity. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    // assistant 行缺 agent 字段：归属解析保守拒绝（不得回落登记身份签代币）。
    h.wires[C] = [wu(CU, inputText), { id: CA, type: "assistant", content: [] }]
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-noagent", input: { filePath: file } } as never)
    expect(readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-noagent")).toBeUndefined()
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-noagent", input: { filePath: file }, status: "completed", result: {} } as never)
    await finishTurn(h, C, CU, inputText, CA, `Stored after the agent-less wire row.\n<!-- bcp:store description="Agent-less row original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(nativeBindings(record)).toHaveLength(0)
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
  })

  test("write tool calls bind the new bytes through the same attribution chain", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "w.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const oldBody = "WRITE old bytes before the tool runs. ".repeat(4)
    const newBody = "WRITE new bytes landed between the hooks. ".repeat(4)
    writeFileSync(file, oldBody)
    const inputText = `Write the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // v2 write 输入字段是 path（非 v1 的 filePath）。
    await h.hooks["tool:execute.before"]({ tool: "write", sessionID: C, messageID: CA, id: "cw-1", input: { path: file } } as never)
    writeFileSync(file, newBody)
    await h.hooks["tool:execute.after"]({ tool: "write", sessionID: C, messageID: CA, id: "cw-1", input: { path: file }, status: "completed", result: {} } as never)
    await finishTurn(h, C, CU, inputText, CA, `Stored after the write.\n<!-- bcp:store description="Write tool original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    const newSha = createHash("sha256").update(newBody, "utf8").digest("hex")
    const oldSha = createHash("sha256").update(oldBody, "utf8").digest("hex")
    const bound = nativeBindings(record).find((b) => b.native_edit && b.path === file)
    expect(bound?.ref).toContain(`#sha256=${newSha}`)
    expect(bound?.ref).not.toContain(oldSha)
    expect(readFileSync(fileURLToPath(bound!.ref!.split("#")[0]!), "utf8")).toBe(newBody)
  })

  test("a session-level read deny during the edit pair keeps edited files out of native bindings", async () => {
    // 授权面收敛：read 被会话规则拒绝时，observeEdits 的 ask（read）被拒 →
    // 该文件的快照制备失败并落入 journal 文件级 error（行完成但无 ref）→
    // 终稿 editEvidence 对该路径不产 native_edit 绑定：未经授权的读取不产生归因。
    // deny 必须在编辑对期间生效——留存期不再询问（快照已在编辑时制备/拒绝）。
    const h = await makeHost({
      sessions: {
        [P]: { id: P, agent: "orchestrator" },
        [C]: { id: C, parentID: P, agent: "fixer", permissions: [{ action: "read", resource: "*", effect: "deny" }] },
      },
      agents: HOSTS.agents,
    })
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const newBody = "NEW bytes whose snapshot ask is denied by a session read rule. ".repeat(4)
    writeFileSync(file, "Original body before the denied edit. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await runEditPair(h, C, CA, "ce-deny", file, () => writeFileSync(file, newBody))
    const row = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-deny")
    expect(row?.pending).toBeUndefined()
    expect((row?.files?.[0] as { error?: string } | undefined)?.error).toContain("capture_source_permission_not_granted")
    await finishTurn(h, C, CU, inputText, CA, `Stored under a read deny.\n<!-- bcp:store description="Read deny original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(nativeBindings(record)).toHaveLength(0)
    expect(sourceErrors(record)).toContain("capture_source_permission_not_granted")
  })

  test("patch tool calls bind via result metadata file paths", async () => {
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "p.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const oldBody = "PATCH old bytes before the tool runs. ".repeat(4)
    const newBody = "PATCH new bytes landed between the hooks. ".repeat(4)
    writeFileSync(file, oldBody)
    const inputText = `Patch the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // v2 patch 输入只有 patchText，路径在 result.metadata.files[]。
    await h.hooks["tool:execute.before"]({ tool: "patch", sessionID: C, messageID: CA, id: "cp-1", input: { patchText: `Update ${file}` } } as never)
    writeFileSync(file, newBody)
    await h.hooks["tool:execute.after"]({ tool: "patch", sessionID: C, messageID: CA, id: "cp-1", input: { patchText: `Update ${file}` }, status: "completed", result: { metadata: { files: [{ filePath: file }] } } } as never)
    await finishTurn(h, C, CU, inputText, CA, `Stored after the patch.\n<!-- bcp:store description="Patch tool original" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    const newSha = createHash("sha256").update(newBody, "utf8").digest("hex")
    const oldSha = createHash("sha256").update(oldBody, "utf8").digest("hex")
    const bound = nativeBindings(record).find((b) => b.native_edit && b.path === file)
    expect(bound?.ref).toContain(`#sha256=${newSha}`)
    expect(bound?.ref).not.toContain(oldSha)
    expect(readFileSync(fileURLToPath(bound!.ref!.split("#")[0]!), "utf8")).toBe(newBody)
  })

  // ---- 第五轮返修矩阵：P1-1 缓存/wire no-store 分歧、P1-2 冷恢复连续性、P1-3 unknown 边界确定性握手 ----

  test("a no-store marker visible only in the fresh wire blocks every evidence write (P1-1 cache/wire divergence)", async () => {
    // 缓存（prompt 钩子时点）无标记、最终 wire（宿主 prompt 钩子可串行改写后持久化）
    // 含标记，且该限制持续到终稿留存（不用干净输入覆盖）：before 拒绝签发、行保持
    // pending 之外，终稿 capture 读到含标记的新鲜输入原文 → 整次留存被拒
    // （publication_restricted）→ 零记录/零 journal/零哨兵/零工件。
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body whose input turned no-store before the edit ran. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    // 终局 wire：同输入 ID 的 user 原文已含 no-store（宿主 prompt 钩子串行改写语义）。
    const freshNoStoreText = `${inputText}\n<!-- bcp:no-store -->`
    h.wires[C] = [wu(CU, freshNoStoreText), waEmpty(CA, "fixer")]
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-ns1", input: { filePath: file } } as never)
    writeFileSync(file, "NEW bytes that must never be snapshotted under the fresh no-store. ".repeat(4))
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-ns1", input: { filePath: file }, status: "completed", result: {} } as never)
    // 终稿 wire 保持真实限制（同 ID user 原文仍含标记）→ 留存读取入口按新鲜原文
    // 忠实返回 → capture 核拒绝整次留存，而不是生成"无编辑证据"的记录。
    await finishTurn(h, C, CU, freshNoStoreText, CA, `Stored without edit evidence.\n<!-- bcp:store description="Fresh wire no-store" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(0)
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(false)
    // 工件目录无 NEW 字节快照。
    const { scope, streamId } = openSessionScope(h.dataDir, C, "fixer")
    const artifactsDir = join(scope.dir, "streams", streamId, "artifacts")
    const newSha = createHash("sha256").update("NEW bytes that must never be snapshotted under the fresh no-store. ".repeat(4), "utf8").digest("hex")
    expect(artifactExists(h.dataDir, C, "fixer", newSha)).toBe(false)
  })

  test("a cached no-store marker is not laundered by a cleaner fresh wire (P1-1 reverse direction)", async () => {
    // 缓存已见 no-store 不得被更宽松的终局 wire 解除：零 journal/哨兵/工件，且终稿
    // 留存本身被输入缓存 no-store 拒绝（capture 既有 publication_restricted 语义）。
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body edited under a cached no-store directive. ".repeat(4))
    const inputText = `<!-- bcp:no-store -->\nFix the spec at ${file} without recording.`
    await h.admit(C, "fixer", CU, inputText)
    // 终局 wire 变宽松（无标记）→ 不得借此洗白缓存已见的 no-store。
    h.wires[C] = [wu(CU, `Fix the spec at ${file} without recording.`), waEmpty(CA, "fixer")]
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-ns2", input: { filePath: file } } as never)
    writeFileSync(file, "NEW bytes under a cached no-store input. ".repeat(4))
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-ns2", input: { filePath: file }, status: "completed", result: {} } as never)
    await finishTurn(h, C, CU, inputText, CA, `Edited under no-store.\n<!-- bcp:store description="Should never be stored" -->`)
    await h.settle(1)
    // 终稿留存被拒（publication_restricted）→ 无任何 stored 记录。
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(0)
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(false)
    const { scope, streamId } = openSessionScope(h.dataDir, C, "fixer")
    const artifactsDir = join(scope.dir, "streams", streamId, "artifacts")
    const newSha = createHash("sha256").update("NEW bytes under a cached no-store input. ".repeat(4), "utf8").digest("hex")
    expect(artifactExists(h.dataDir, C, "fixer", newSha)).toBe(false)
  })

  test("cold recovery cannot treat an existing journal as observation continuity (P1-2 restart)", async () => {
    // A 成功观察（实例1，空白起点）→ 下一次编辑 context 失败（现场变 B，无行）→
    // 重启新实例（同 dataDir/同输入）→ 新实例成功编辑 C → 终稿：冷恢复无覆盖起点
    // 证明 → 旧 A/新 C 都不得成为 native 绑定；已留存 A 记录原样不改。
    let contextFail = false
    const h1 = await makeHost({ ...HOSTS, contextError: () => contextFail })
    const file = join(h1.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const bodyA = "Version A observed cleanly by the first instance. ".repeat(4)
    const bodyB = "Version B written while the context RPC was failing. ".repeat(4)
    writeFileSync(file, bodyA)
    const inputText = `Fix the spec at ${file}.`
    await h1.admit(C, "fixer", CU, inputText)
    h1.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await runEditPair(h1, C, CA, "ce-a", file, () => writeFileSync(file, bodyA))
    const rowA = readJournal(h1.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-a")
    expect(rowA?.pending).toBeUndefined()
    // 实例1 内 A 的留存是合法正证据（空白起点覆盖）。
    await finishTurn(h1, C, CU, inputText, CA, `Stored version A.\n<!-- bcp:store description="Cold recovery A" -->`)
    await h1.settle(1)
    const storedA = h1.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(storedA.length).toBe(1)
    const recordA = readRecord(h1.dataDir, storedA[0]!.id as string)
    const aSha = createHash("sha256").update(bodyA, "utf8").digest("hex")
    expect(nativeBindings(recordA).some((b) => b.native_edit && b.ref?.includes(aSha))).toBe(true)
    // 第二次编辑：context RPC 失败 → before 无法证明归属（无行、无代币），现场变 B。
    h1.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    contextFail = true
    await h1.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-b", input: { filePath: file } } as never)
    contextFail = false
    writeFileSync(file, bodyB)
    expect(readJournal(h1.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-b")).toBeUndefined()
    // 重启：新实例同 dataDir / 同 wire 视图，同一输入重新确认。
    h1.close()
    const h2 = await makeHost({ ...HOSTS, dataDir: h1.dataDir, sharedWires: h1.wires })
    await h2.admit(C, "fixer", CU, inputText)
    h2.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // 新实例的成功编辑照常记录（行完成），但冷恢复无空白起点证明 → 不得恢复正证据。
    const bodyC = "Version C written successfully after the restart. ".repeat(4)
    await runEditPair(h2, C, CA, "ce-c", file, () => writeFileSync(file, bodyC))
    const rowC = readJournal(h2.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-c")
    expect(rowC?.pending).toBeUndefined()
    await finishTurn(h2, C, CU, inputText, "msg_c_a2cold", `Stored version B on-site.\n<!-- bcp:store description="Cold recovery final" -->`)
    await settleMore(h2, h2.logLines().filter((l) => l.ev === "final_capture").length, 1)
    // 共享日志含实例1的 A 记录行 → h2 的终稿是最后一条 stored。
    const stored = h2.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    const record = readRecord(h2.dataDir, stored[stored.length - 1]!.id as string)
    // 冷恢复拒绝：journal 在盘、本实例无覆盖起点证明 → 零 native，显式 continuity 错误。
    expect(sourceErrors(record)).toContain("edit_evidence_continuity_unproven")
    expect(nativeBindings(record)).toHaveLength(0)
    // 已留存的 A 记录原样不改：绑定仍指向 A。
    const recordAAfter = readRecord(h2.dataDir, recordA!.id as string)
    expect(nativeBindings(recordAAfter).some((b) => b.native_edit && b.ref?.includes(aSha))).toBe(true)
  })

  test("double IO failure then restart refuses new native bindings for the recovered input (P1-2)", async () => {
    // A 成功观察 → 第二次编辑 begin+哨兵双 IO 失败（只 volatile）→ 现场变 B → 重启 →
    // 新实例成功编辑 C → 终稿：无覆盖起点证明 → 零 native；A 记录不改。
    const h1 = await makeHost(HOSTS)
    const file = join(h1.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const bodyA = "Version A observed before the journal directory went read-only. ".repeat(4)
    writeFileSync(file, bodyA)
    const inputText = `Fix the spec at ${file}.`
    await h1.admit(C, "fixer", CU, inputText)
    h1.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await runEditPair(h1, C, CA, "ce-a", file, () => writeFileSync(file, bodyA))
    await finishTurn(h1, C, CU, inputText, CA, `Stored version A.\n<!-- bcp:store description="IO failure A" -->`)
    await h1.settle(1)
    const storedA = h1.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(storedA.length).toBe(1)
    const recordA = readRecord(h1.dataDir, storedA[0]!.id as string)
    const aSha = createHash("sha256").update(bodyA, "utf8").digest("hex")
    expect(nativeBindings(recordA).some((b) => b.native_edit && b.ref?.includes(aSha))).toBe(true)
    const { scope, streamId } = openSessionScope(h1.dataDir, C, "fixer")
    const editsDir = join(scope.dir, "streams", streamId, "edits")
    chmodSync(editsDir, 0o555)
    try {
      const bodyB = "Version B written while journal and sentinel writes both failed. ".repeat(4)
      h1.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
      await h1.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-b", input: { filePath: file } } as never)
      writeFileSync(file, bodyB)
      await h1.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-b", input: { filePath: file }, status: "completed", result: {} } as never)
      // 双写失败：无 ce-b 行，哨兵也未能落盘。
      expect(readJournal(h1.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-b")).toBeUndefined()
      expect(journalIncompleteExists(h1.dataDir, C, "fixer", CU)).toBe(false)
    } finally {
      chmodSync(editsDir, 0o755)
    }
    h1.close()
    const h2 = await makeHost({ ...HOSTS, dataDir: h1.dataDir, sharedWires: h1.wires })
    await h2.admit(C, "fixer", CU, inputText)
    h2.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    const bodyC = "Version C written successfully after recovery. ".repeat(4)
    await runEditPair(h2, C, CA, "ce-c", file, () => writeFileSync(file, bodyC))
    await finishTurn(h2, C, CU, inputText, "msg_c_a2io", `Stored after IO recovery.\n<!-- bcp:store description="IO failure final" -->`)
    await settleMore(h2, h2.logLines().filter((l) => l.ev === "final_capture").length, 1)
    // 共享日志含实例1的 A 记录行 → h2 的终稿是最后一条 stored。
    const stored = h2.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    const record = readRecord(h2.dataDir, stored[stored.length - 1]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_continuity_unproven")
    expect(nativeBindings(record)).toHaveLength(0)
    const recordAAfter = readRecord(h2.dataDir, recordA!.id as string)
    expect(nativeBindings(recordAAfter).some((b) => b.native_edit && b.ref?.includes(aSha))).toBe(true)
  })

  test("an unadmitted user boundary between the hooks keeps the observation pending (P1-3 literal repro)", async () => {
    // 合法 before → context 切到未 admitted 的 user 边界（runInput 删除、State 不变）
    // → 现场修改 → after：统一谓词在入口栅栏拒绝 → 行保持 pending，无完成/工件。
    const h = await makeHost(HOSTS)
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body observed before the unknown boundary appeared. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-u1", input: { filePath: file } } as never)
    // 未 admitted 的尾部 user 边界 → confirmedCandidate 为 null → runInput 删除。
    await h.hooks.context({ sessionID: C, agent: "fixer", messages: [um(CU, inputText), um("msg_unknown_u9", "an unadmitted user boundary")], system: [] } as never)
    writeFileSync(file, "NEW bytes written across an unconfirmed boundary. ".repeat(4))
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-u1", input: { filePath: file }, status: "completed", result: {} } as never)
    const row = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-u1")
    expect(row?.pending).toBe(true)
    await finishTurn(h, C, CU, inputText, CA, `Stored across an unconfirmed boundary.\n<!-- bcp:store description="Unknown boundary" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_incomplete")
    expect(nativeBindings(record)).toHaveLength(0)
  })

  test("an unadmitted user boundary during the after authorize await keeps the row pending (P1-3 handshake, initial fence provably passed)", async () => {
    // 确定性握手：after 入口栅栏通过后挂起于 authorize await；挂起期间 unknown 边界
    // 删 runInput + 现场写入 THIRD → await 返回后统一谓词拒绝 → 行保持 pending。
    let armed = false
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))
    let enteredCount = 0
    let resolveEntered!: () => void
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
    const h = await makeHost({
      sessions: HOSTS.sessions,
      agents: HOSTS.agents,
      gateAuthorize: {
        armed: () => armed,
        wait: gate,
        entered: () => {
          armed = false
          enteredCount += 1
          resolveEntered()
        },
      },
    })
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body observed before the after-hook handshake. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-u2", input: { filePath: file } } as never)
    armed = true
    const afterDone = h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-u2", input: { filePath: file }, status: "completed", result: {} } as never) as Promise<void>
    try {
      // entered ⇒ 入口栅栏已通过且 readMessage 已取得有效 CU（否则钩子在 authorize 前提前
      // return、闸门永不进入 → 撞框架超时）。挂起期间注入 unknown 边界 + 真实 THIRD 写入。
      await entered
      await h.hooks.context({ sessionID: C, agent: "fixer", messages: [um(CU, inputText), um("msg_unknown_u9", "an unadmitted user boundary")], system: [] } as never)
      writeFileSync(file, "THIRD bytes written inside the after-hook handshake window. ".repeat(4))
    } finally {
      releaseGate()
    }
    await afterDone
    expect(enteredCount).toBe(1)
    // authorize await 返回后：统一同步谓词（含 runInput）拒绝 → 行保持 pending。
    const row = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-u2")
    expect(row?.pending).toBe(true)
    await finishTurn(h, C, CU, inputText, CA, `Stored after the handshake.\n<!-- bcp:store description="After unknown boundary" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_incomplete")
    expect(nativeBindings(record)).toHaveLength(0)
    // 挂起窗口的 THIRD 字节零工件。
    const { scope, streamId } = openSessionScope(h.dataDir, C, "fixer")
    const artifactsDir = join(scope.dir, "streams", streamId, "artifacts")
    const thirdSha = createHash("sha256").update("THIRD bytes written inside the after-hook handshake window. ".repeat(4), "utf8").digest("hex")
    expect(artifactExists(h.dataDir, C, "fixer", thirdSha)).toBe(false)
  })

  test("an unadmitted user boundary during the before authorize await invalidates evidence fail closed (P1-3 handshake)", async () => {
    // before 已通过归属证明、挂起于 authorize await；挂起期间 unknown 边界删 runInput
    // → await 返回后统一谓词拒绝 → 已核实原域的显式持久失效（哨兵落盘）+ 无代币。
    let armed = false
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))
    let enteredCount = 0
    let resolveEntered!: () => void
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
    const h = await makeHost({
      sessions: HOSTS.sessions,
      agents: HOSTS.agents,
      gateAuthorize: {
        armed: () => armed,
        wait: gate,
        entered: () => {
          armed = false
          enteredCount += 1
          resolveEntered()
        },
      },
    })
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body observed before the before-hook handshake. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    armed = true
    const beforeDone = h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-u3", input: { filePath: file } } as never) as Promise<void>
    try {
      // entered ⇒ 归属证明（fresh wire 解析）已通过、挂起点是 authorize await。
      await entered
      await h.hooks.context({ sessionID: C, agent: "fixer", messages: [um(CU, inputText), um("msg_unknown_u9", "an unadmitted user boundary")], system: [] } as never)
      writeFileSync(file, "NEW bytes written inside the before-hook handshake window. ".repeat(4))
    } finally {
      releaseGate()
    }
    await beforeDone
    expect(enteredCount).toBe(1)
    // 已核实原域的授权后失败：哨兵落盘（持久显式不完整），无 pending 行、无代币。
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(true)
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-u3", input: { filePath: file }, status: "completed", result: {} } as never)
    await finishTurn(h, C, CU, inputText, CA, `Stored after the before handshake.\n<!-- bcp:store description="Before unknown boundary" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(nativeBindings(record)).toHaveLength(0)
    expect(sourceErrors(record)).toContain("edit_evidence_unavailable")
    expect(sourceErrors(record)).toContain("edit_evidence_attribution_unproven")
  })

  test("a no-store marker that appears only in the fresh terminal wire blocks the whole final capture (unified retention entry, no edits)", async () => {
    // 无编辑链：统一留存读取入口（captureHost.message）对纯终稿留存同样生效——
    // 输入缓存原文干净、终局 wire 同 ID user 原文含标记 → 按新鲜原文忠实返回 →
    // capture 核 publication_restricted 拒绝整次留存（不生成"无编辑证据"记录）。
    const h = await makeHost(HOSTS)
    const inputText = "A plain input whose persisted wire gained a no-store marker."
    await h.admit(C, "fixer", CU, inputText)
    const freshNoStoreText = `${inputText}\n<!-- bcp:no-store -->`
    await finishTurn(h, C, CU, freshNoStoreText, CA, `Reply under a fresh wire no-store.\n<!-- bcp:store description="Fresh wire no-store terminal" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(0)
    // 从未有过编辑观察：journal/哨兵都不存在。
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(false)
  })

  test("a missing fresh wire read fails the final capture closed (context unavailable, no loose-cache fallback)", async () => {
    // 统一入口的保守失败面：终稿留存时 context RPC 不可得 → captureMessage 返回 null
    // （不回落宽松缓存）→ captureFinal 以 input_unavailable 保守 unconfirmed，零记录。
    let contextFail = false
    const h = await makeHost({ ...HOSTS, contextError: () => contextFail })
    const inputText = "A plain input whose context disappears before retention."
    await h.admit(C, "fixer", CU, inputText)
    contextFail = true
    try {
      await finishTurn(h, C, CU, inputText, CA, `Reply without a readable input.\n<!-- bcp:store description="Context missing" -->`)
      await h.settle(1)
    } finally {
      contextFail = false
    }
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(0)
    const captures = h.logLines().filter((l) => l.ev === "final_capture")
    expect(captures.length).toBeGreaterThanOrEqual(1)
    expect(readJournal(h.dataDir, C, "fixer", CU)).toBeUndefined()
    expect(journalIncompleteExists(h.dataDir, C, "fixer", CU)).toBe(false)
  })

  test("an unadmitted user boundary inside the FileAccess.ask await keeps the row pending (P1-3 handshake inside file preparation)", async () => {
    // 确定性握手深入文件准备内部：after 钩子的 session.get 顺序确定——第 1 次=
    // authorize 内 sessionInfo（skip 放行），第 2 次=observeEdits→prepareArtifacts→
    // ask 的会话权限中途复核（挂起+entered）。entered 触发即证明已真实进入 ask，
    // 而非 authorize 入口；挂起期间注入 unknown 边界（删 runInput）+ 写入 THIRD →
    // 释放后 observeEdits 的 current() 栅栏拒绝 → 行保持 pending、零 native、THIRD
    // 字节零工件（prepareArtifacts 只读内存字节，retainArtifacts 不执行）。
    let armed = false
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))
    let enteredCount = 0
    let resolveEntered!: () => void
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
    const h = await makeHost({
      sessions: HOSTS.sessions,
      agents: HOSTS.agents,
      gateSessionGet: {
        armed: () => armed,
        skip: 1,
        wait: gate,
        entered: () => {
          armed = false
          enteredCount += 1
          resolveEntered()
        },
      },
    })
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "Body observed before the ask-window handshake. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-ask1", input: { filePath: file } } as never)
    armed = true
    const afterDone = h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-ask1", input: { filePath: file }, status: "completed", result: {} } as never) as Promise<void>
    try {
      await entered
      // 挂起窗口=FileAccess.ask 内部：注入 unknown 边界 + 现场写入 THIRD。
      await h.hooks.context({ sessionID: C, agent: "fixer", messages: [um(CU, inputText), um("msg_unknown_u9", "an unadmitted user boundary")], system: [] } as never)
      writeFileSync(file, "THIRD bytes written inside the FileAccess.ask window. ".repeat(4))
    } finally {
      releaseGate()
    }
    await afterDone
    expect(enteredCount).toBe(1)
    const row = readJournal(h.dataDir, C, "fixer", CU)?.observations.find((r) => r.call === "ce-ask1")
    expect(row?.pending).toBe(true)
    await finishTurn(h, C, CU, inputText, CA, `Stored across an ask-window boundary.\n<!-- bcp:store description="Ask window boundary" -->`)
    await h.settle(1)
    const stored = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(stored.length).toBe(1)
    const record = readRecord(h.dataDir, stored[0]!.id as string)
    expect(sourceErrors(record)).toContain("edit_evidence_incomplete")
    expect(nativeBindings(record)).toHaveLength(0)
    const thirdSha = createHash("sha256").update("THIRD bytes written inside the FileAccess.ask window. ".repeat(4), "utf8").digest("hex")
    expect(artifactExists(h.dataDir, C, "fixer", thirdSha)).toBe(false)
  })


// ---- 最终 gate 收敛：历史手动补存（board_store）不得绕过负证据/连续性/覆盖资格 ----
// 每个新 native 绑定都需要目标输入连续覆盖的正证据；找不到目标 State 不是"没有负证据"。
// 历史正文照常留存（绑定清空+显式错误）；已存记录走 existing/replay 原样返回。
// 全部经真实注册的 board_store 工具（ctx.tool.transform 注册面）与真实 storage 驱动，
// 不手写 journal/record。
describe("v2 historical manual retention (final gate)", () => {
  const sha256 = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex")

  test("manual retention after the input switched stores the text but mints no new native binding (Oracle 3/3 counterexample)", async () => {
    let ctxFail = false
    const h = await makeHost({ ...HOSTS, contextError: () => ctxFail })
    await h.admit(P, "orchestrator", PU, "Parent dispatch turn.")
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const bodyA = "OBSERVED-A bytes captured by the successful first edit. ".repeat(4)
    const bodyB = "UNOBSERVED-B bytes written while the context RPC was unavailable. ".repeat(4)
    writeFileSync(file, "Seed bytes before any observation. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    const cu2 = "msg_c_u2h"
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    // U1 第一对：成功观察 A（journal 完成行，绑定 ref=A）。
    await runEditPair(h, C, CA, "ce-h1", file, () => writeFileSync(file, bodyA))
    // U1 第二对：context RPC 不可得 → 实际写入 B，只产生 volatile 负证据
    // （无 pending 行、无代币；标记随 U1 的 State 单调保留）。
    ctxFail = true
    await h.hooks["tool:execute.before"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-h2", input: { filePath: file } } as never)
    writeFileSync(file, bodyB)
    await h.hooks["tool:execute.after"]({ tool: "edit", sessionID: C, messageID: CA, id: "ce-h2", input: { filePath: file }, status: "completed", result: {} } as never)
    ctxFail = false
    // U1 回复终结，但不带留存标记（无自动留存）。
    const replyText = "Historically stored reply text after the input switched."
    await finishTurn(h, C, CU, inputText, CA, replyText)
    // 新确认输入 U2（fresh context 保留历史行）。
    await h.admit(C, "fixer", cu2, `Second turn about ${file}.`)
    const listed = await h.boardStore({ action: "list", session_id: C, limit: 5 })
    const reply = (listed.replies as Array<Record<string, unknown>>).find((r) => r.message_id === CA)
    expect(reply).toBeDefined()
    expect(reply?.input_message_id).toBe(CU)
    // 手动补存历史输入 U1：正文照常 stored；但本实例对 U1 没有连续覆盖正证明——
    // 新 native 绑定一律不发，显式错误说明限制；现场 B 不被补拍，A 也不被再快照。
    const stored = await h.boardStore({ action: "store", session_id: C, message_id: CA, description: "Historical manual retention" }, "msg_p_store_1")
    expect(stored.status).toBe("stored")
    expect(stored.id).toBeDefined()
    const record = readRecord(h.dataDir, stored.id as string)!
    expect(sourceErrors(record)).toContain("edit_evidence_coverage_unproven")
    expect(nativeBindings(record)).toHaveLength(0)
    expect(((stored.source_refs as string[]) ?? [])).toHaveLength(0)
    expect(String((record as { content?: unknown }).content)).toContain("Historically stored reply text")
    expect(readFileSync(file, "utf8")).toBe(bodyB)
    // A 的工件来自 ce-h1 的真实成功观察（observeEdits→prepareArtifacts），合法存在；
    // 契约禁止的是留存期把未观察的现场 B 补拍成证据工件。
    expect(artifactExists(h.dataDir, C, "fixer", sha256(bodyA))).toBe(true)
    expect(artifactExists(h.dataDir, C, "fixer", sha256(bodyB))).toBe(false)
  })

  test("a healthy historical input without any negative marker still cannot mint new native bindings", async () => {
    // 刻意保守策略：即便 U1 的观察完全健康、无任何负证据标记，切换输入后缺少目标
    // 覆盖正证明本身就不构成签发新绑定的资格——错误信息如实解释该限制。
    const h = await makeHost(HOSTS)
    await h.admit(P, "orchestrator", PU, "Parent dispatch turn.")
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const bodyA = "HEALTHY-A bytes observed without any negative marker. ".repeat(4)
    writeFileSync(file, "Seed bytes before the healthy observation. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    const cu2 = "msg_c_u2n"
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await runEditPair(h, C, CA, "ce-h3", file, () => writeFileSync(file, bodyA))
    await finishTurn(h, C, CU, inputText, CA, "Healthy historical reply text.")
    await h.admit(C, "fixer", cu2, `Second turn about ${file}.`)
    const stored = await h.boardStore({ action: "store", session_id: C, message_id: CA, description: "Healthy historical retention" }, "msg_p_store_2")
    expect(stored.status).toBe("stored")
    const record = readRecord(h.dataDir, stored.id as string)!
    expect(sourceErrors(record)).toContain("edit_evidence_coverage_unproven")
    expect(nativeBindings(record)).toHaveLength(0)
    expect(String((record as { content?: unknown }).content)).toContain("Healthy historical reply text")
  })

  test("an already-stored historical reply replays unchanged with the same record id", async () => {
    // 已存记录经 existing/replay 幂等路径原样返回：不新增记录、不改绑定、不补拍现场。
    const h = await makeHost(HOSTS)
    await h.admit(P, "orchestrator", PU, "Parent dispatch turn.")
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const bodyA = "REPLAY-A bytes observed and stored on the current input. ".repeat(4)
    writeFileSync(file, "Seed bytes before the replayed observation. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    const cu2 = "msg_c_u2r"
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await runEditPair(h, C, CA, "ce-h4", file, () => writeFileSync(file, bodyA))
    await finishTurn(h, C, CU, inputText, CA, `Auto stored on the current input.\n<!-- bcp:store description="Historical replay original" -->`)
    await h.settle(1)
    const auto = h.logLines().filter((l) => l.ev === "final_capture" && l.status === "stored")
    expect(auto.length).toBe(1)
    const r1 = auto[0]!.id as string
    const rec1 = readRecord(h.dataDir, r1)
    // 当前输入健康留存：native 绑定不受影响（正资格完好）。
    expect(nativeBindings(rec1)).toHaveLength(1)
    expect(nativeBindings(rec1)[0]!.ref).toContain(`#sha256=${sha256(bodyA)}`)
    await h.admit(C, "fixer", cu2, `Second turn about ${file}.`)
    const bodyThird = "THIRD bytes written after the record already existed. ".repeat(4)
    writeFileSync(file, bodyThird)
    const replay = await h.boardStore({ action: "store", session_id: C, message_id: CA, description: "Replay request" }, "msg_p_store_3")
    expect(replay.status).toBe("replay")
    expect(replay.id).toBe(r1)
    const rec2 = readRecord(h.dataDir, r1)
    expect(nativeBindings(rec2)).toHaveLength(1)
    expect(nativeBindings(rec2)[0]!.ref).toBe(nativeBindings(rec1)[0]!.ref)
    expect(artifactExists(h.dataDir, C, "fixer", sha256(bodyThird))).toBe(false)
  })

  test("qualification is re-checked at the evidence return boundary when the input changes inside the evidence ask await", async () => {
    // 确定性握手（复用 gateSessionGet）：手动补存发起时 U1 仍是当前输入（资格为正），
    // 挂起点=editEvidence→prepareArtifacts→FileAccess.ask 的会话权限复核——前置
    // session.get 依次为 authorizeCaller 的 authorize(P)、messageStore 的 authorize(C)、
    // captureFinal 的 authorize(C)，skip:3 放行后第 4 次即证据准备内部。挂起期间把
    // 当前输入切到 U2 → 释放后返回边界必须按新输入重新判定，不得带出切换前的正资格。
    let armed = false
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))
    let enteredCount = 0
    let resolveEntered!: () => void
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
    const h = await makeHost({
      ...HOSTS,
      gateSessionGet: {
        armed: () => armed,
        skip: 3,
        wait: gate,
        entered: () => {
          armed = false
          enteredCount += 1
          resolveEntered()
        },
      },
    })
    await h.admit(P, "orchestrator", PU, "Parent dispatch turn.")
    const file = join(h.dataDir, "notes", "spec.md")
    mkdirSync(join(file, ".."), { recursive: true })
    const bodyA = "BOUNDARY-A bytes observed before the evidence ask handshake. ".repeat(4)
    writeFileSync(file, "Seed bytes before the boundary observation. ".repeat(4))
    const inputText = `Fix the spec at ${file}.`
    const cu2 = "msg_c_u2b2"
    await h.admit(C, "fixer", CU, inputText)
    h.wires[C] = [wu(CU, inputText), waEmpty(CA, "fixer")]
    await runEditPair(h, C, CA, "ce-h5", file, () => writeFileSync(file, bodyA))
    await finishTurn(h, C, CU, inputText, CA, "Boundary race reply text.")
    armed = true
    const storeDone = h.boardStore({ action: "store", session_id: C, message_id: CA, description: "Boundary race retention" }, "msg_p_store_4")
    try {
      await entered
      // 挂起窗口=evidence 准备内部：期间切换当前输入到 U2。
      await h.admit(C, "fixer", cu2, `Raced second turn about ${file}.`)
    } finally {
      releaseGate()
    }
    const stored = await storeDone
    expect(enteredCount).toBe(1)
    expect(stored.status).toBe("stored")
    const record = readRecord(h.dataDir, stored.id as string)!
    expect(sourceErrors(record)).toContain("edit_evidence_coverage_unproven")
    expect(nativeBindings(record)).toHaveLength(0)
    expect(String((record as { content?: unknown }).content)).toContain("Boundary race reply text")
  })
})
})
