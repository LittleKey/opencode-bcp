// 原生后台子代理交付回执测试（DESIGN §11.9 冻结契约 / §16.7 接线）。
// 覆盖 R*1-8（R3 由 R8 域定义替换）+ R8 域定义 + 降级清单全表：
// 冷缓存/重启不关联、delivered 未追平不关联、窗口外同文/回拨不命中旧记录、
// 非终稿同文不制造唯一、compaction/revert/容量淘汰后不恢复、多 text parts、
// 空输出占位跳过、裸插值 description 逐字节复现、同 id 重投幂等、续跑不改指新结果。
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlackboardV2Plugin } from "../src/adapters/v2/index"
import { openScopeById } from "../src/storage"
import { replyKey } from "../src/reply"
import {
  subagentNotificationText, receiptTail, SubagentReceiptLedger, attachSubagentReceipts,
  DESCRIPTIONS_CAP, ASSISTANTS_CAP, TEXT_PARTS_CAP, CHILD_EVIDENCE_BYTES_CAP, SEEN_CHILDREN_CAP,
} from "../src/adapters/v2/subagent-receipt"
import type { ReceiptDeps } from "../src/adapters/v2/subagent-receipt"

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex")

type Wire = Record<string, unknown>
type Msg = { id?: string; role: string; content: unknown }

const u = (id: string, text = "input"): Msg => ({ id, role: "user", content: [{ type: "text", text }] })
const draftNotice = (id: string, text: string): Msg => ({ id, role: "user", content: text })

const PARENT = "parent"
const CHILD = "child"

async function makeHost(sessions: Record<string, { id: string; parentID?: string | null; agent?: string }>, opts: { autoCapture?: boolean; boardGetEffect?: "allow" | "deny"; boardStoreEffect?: "allow" | "deny" } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-v2-receipt-"))
  const hostEvents: Array<{ type: string; data?: unknown }> = []
  const eventWaiters: Array<(r: { value: unknown; done: boolean }) => void> = []
  let barrier: (() => void) | undefined
  const deliver = (ev: { type: string; data?: unknown }) => {
    if (ev.type === "test.barrier") barrier = (ev.data as { resolve: () => void }).resolve
    return { value: ev, done: false }
  }
  const emit = (type: string, data?: unknown): void => {
    const ev = { type, data }
    const w = eventWaiters.shift()
    if (w) w(deliver(ev))
    else hostEvents.push(ev)
  }
  // 下一次订阅拉取才确认前一个事件处理完成；不靠固定 sleep 猜 capture 是否落盘。
  const settle = (): Promise<void> => new Promise((resolve) => emit("test.barrier", { resolve }))
  // 每会话可变 wire 表（ctx.session.context 按会话返回；测试直接改写模拟宿主装配视图）。
  const wires: Record<string, Wire[]> = {}
  const agentPermissions = [
    { action: "board_get", resource: "*", effect: opts.boardGetEffect ?? "allow" },
    { action: "board_store", resource: "*", effect: opts.boardStoreEffect ?? "allow" },
  ]
  const hooks: Record<string, (input: never) => Promise<unknown> | unknown> = {}
  const ctx = {
    options: { dataDir, autoCapture: opts.autoCapture ?? false },
    permission: {},
    tool: {
      transform: async (cb: (editor: never) => Promise<void> | void) => {
        const editor = { add: () => {}, update: () => {}, get: () => undefined, list: () => [], remove: () => {}, namespace: () => {} }
        await cb(editor as never)
      },
      hook: async (name: string, cb: (input: never) => Promise<unknown> | unknown) => {
        hooks[`tool:${name}`] = cb
        return { dispose: async () => {} }
      },
    },
    session: {
      get: async (input: { sessionID: string }) => sessions[input.sessionID] ?? null,
      context: async (input: { sessionID: string }) => wires[input.sessionID] ?? [],
      hook: async (name: string, cb: (input: never) => Promise<unknown> | unknown) => {
        hooks[name] = cb
        return { dispose: async () => {} }
      },
    },
    agent: {
      list: async () => ({ data: [{ id: "build", name: "Build", permissions: agentPermissions }] }),
    },
    location: { directory: dataDir },
    event: {
      subscribe: (_opts?: unknown) => {
        const iterator = {
          next: (): Promise<{ value: unknown; done: boolean }> => {
            const complete = barrier
            barrier = undefined
            complete?.()
            const ev = hostEvents.shift()
            if (ev) return Promise.resolve(deliver(ev))
            return new Promise((resolve) => eventWaiters.push(resolve))
          },
          [Symbol.asyncIterator]: () => iterator,
        }
        return iterator
      },
    },
  }
  const cleanup = await BlackboardV2Plugin.setup(ctx as never)
  const context = async (input: { sessionID: string; agent: string; messages: Msg[] }): Promise<void> => {
    await hooks.context!(input as never)
  }
  const toolAfter = async (input: Record<string, unknown>): Promise<void> => {
    await hooks["tool:execute.after"]!(input as never)
  }
  const scopeOf = (sessionId: string) => {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs")
    const indexPath = join(dataDir, "scope-index.json")
    if (!existsSync(indexPath)) return null
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as { scopes?: Record<string, string> }
    const root = sessions[sessionId]?.parentID ? sessions[sessionId]!.parentID! : sessionId
    const scopeId = index.scopes?.[root]
    if (!scopeId) return null
    return openScopeById(scopeId, { dataDir })
  }
  const close = () => {
    try {
      cleanup?.()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
  return { dataDir, wires, agentPermissions, emit, settle, context, toolAfter, scopeOf, close, hooks }
}

const hosts: Host[] = []
afterEach(() => {
  while (hosts.length > 0) hosts.pop()!.close()
})

const baseSessions = (): Record<string, { id: string; parentID: string | null; agent: string }> => ({
  [PARENT]: { id: PARENT, parentID: null, agent: "build" },
  [CHILD]: { id: CHILD, parentID: PARENT, agent: "build" },
})

type Host = Awaited<ReturnType<typeof makeHost>>

// 标准世界：父/子注册 + 新建派发观察 + 子输入/文本/finish 观察 + 留存记录 + 父 wire 通知 + delivered。
async function seedWorld(h: Host, knobs: {
  description?: string
  parts?: string[]
  finish?: string
  assistantId?: string
  childInputId?: string
  noticeId?: string
  noticeState?: string
  record?: boolean
  recordKind?: "host_final" | "host_stage"
  recordHash?: string
  recordMessageId?: string
  recordInputId?: string | null
  observeDispatch?: boolean
  observeCreated?: boolean
  inputBeforeDispatch?: boolean
  dispatchBeforeCreated?: boolean
  observeChildInput?: boolean
  observeChildText?: boolean
  emitDelivered?: boolean
  outputStatus?: "completed" | "running"
} = {}) {
  const description = knobs.description ?? "Do the thing"
  const parts = knobs.parts ?? ["The answer"]
  const finish = knobs.finish ?? "stop"
  const assistantId = knobs.assistantId ?? "as-1"
  const childInputId = knobs.childInputId ?? "c-in"
  const noticeId = knobs.noticeId ?? "n-1"
  const dispatch = async () => {
    if (knobs.observeDispatch === false) return
    await h.toolAfter({
      tool: "subagent", sessionID: PARENT, messageID: "ta-1", id: "call-1", status: "completed",
      input: { agent: "explore", description, prompt: "go" },
      result: { output: { sessionID: CHILD, status: knobs.outputStatus ?? "completed", output: "done" } },
    })
  }
  await h.context({ sessionID: PARENT, agent: "build", messages: [u("p-in")] })
  if (knobs.dispatchBeforeCreated) await dispatch()
  if (knobs.observeCreated !== false) h.emit("session.created", { sessionID: CHILD, parentID: PARENT })
  if (!knobs.inputBeforeDispatch && !knobs.dispatchBeforeCreated) await dispatch()
  await h.context({ sessionID: CHILD, agent: "build", messages: [u(childInputId)] })
  if (knobs.observeChildInput !== false) {
    h.emit("session.inbox.enqueued", { sessionID: CHILD, inboxID: childInputId })
  }
  if (knobs.inputBeforeDispatch) {
    await h.settle()
    await dispatch()
  }
  if (knobs.observeChildText !== false) {
    for (let i = 0; i < parts.length; i++) {
      h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: assistantId, ordinal: i, text: parts[i] })
    }
  }
  h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: assistantId, finish })
  await h.settle()
  let bbId = ""
  if (knobs.record !== false) {
    const scope = h.scopeOf(CHILD)
    if (!scope) throw new Error("child scope missing")
    const streamId = scope.resolveSession(CHILD).streamId
    const publicContent = parts.join("\n")
    const result = scope.put(streamId, {
      writer: { agent: "build", session_id: CHILD, message_id: knobs.recordMessageId ?? assistantId },
      createdRound: null,
      description: "seed",
      content: publicContent,
      idempotencyKey: replyKey(CHILD, knobs.recordMessageId ?? assistantId, "final"),
      origin: {
        kind: knobs.recordKind ?? "host_final",
        input_message_id: knobs.recordInputId === null ? "never-observed" : (knobs.recordInputId ?? childInputId),
        text_sha256: knobs.recordHash ?? sha256hex(publicContent),
        message_completed_at: 1,
      },
    })
    if (result.status === "stored" || result.status === "replay") bbId = result.id
    else throw new Error(`record put failed: ${result.status}`)
  }
  const rendered = parts.filter((t) => t.length > 0).join("\n\n") || "Subagent completed without a text response."
  const noticeText = subagentNotificationText(CHILD, knobs.noticeState ?? "completed", description, rendered)
  h.wires[CHILD] = [
    { id: childInputId, type: "user", text: "go" },
    { id: assistantId, type: "assistant", agent: "explore", model: { id: "m", providerID: "p" }, finish, time: { created: 1, completed: 2 }, content: parts.map((t) => ({ type: "text", text: t })) },
  ]
  if (knobs.emitDelivered !== false) {
    h.emit("session.inbox.delivered", { sessionID: PARENT, inboxID: noticeId })
    await h.settle()
  }
  h.wires[PARENT] = [
    { id: "p-in", type: "user", text: "delegate" },
    { id: noticeId, type: "synthetic", text: noticeText, metadata: { source: "subagent", childID: CHILD, agent: "explore", state: knobs.noticeState ?? "completed" }, time: { created: 3 } },
  ]
  const draft: Msg[] = [u("p-in", "delegate"), draftNotice(noticeId, noticeText), u("p-out", "next")]
  return { draft, noticeText, bbId, noticeId, description, parts, assistantId }
}

const runParentContext = async (h: Host, draft: Msg[]): Promise<void> => {
  await h.context({ sessionID: PARENT, agent: "build", messages: draft })
}

describe("subagent delivery receipt: positive association (R*.4-8, R8.6)", () => {
  test("attaches the frozen two-line receipt to the matched notification only", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, bbId } = await seedWorld(h)
    await runParentContext(h, draft)
    const content = draft[1]!.content as string
    expect(bbId.startsWith("bb://")).toBe(true)
    expect(content.endsWith(receiptTail(bbId))).toBe(true)
    expect(content).toContain(`Retained: ${bbId}\nBefore relying on this result, read the original with board_get and check its version and limits; retention is not acceptance.`)
    // R*.8：只改目标通知槽位，其余消息不动（不泄漏）。
    expect(draft[0]).toEqual(u("p-in", "delegate"))
    expect(draft[2]).toEqual(u("p-out", "next"))
    expect(draft[1]!.id).toBe("n-1")
  })
  test("multi text parts: notice renders with \\n\\n, retained hash uses the publicReply \\n join", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, bbId } = await seedWorld(h, { parts: ["Part one", "Part two"] })
    await runParentContext(h, draft)
    const content = draft[1]!.content as string
    expect(content.startsWith('<subagent sessionID="child" state="completed" description="Do the thing">\nPart one\n\nPart two\n</subagent>')).toBe(true)
    expect(content.endsWith(receiptTail(bbId))).toBe(true)
  })
  test("bare interpolation description (quotes/angle-bracket/newline) matches byte-exact", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const description = 'He said "> boom\nnext "line"'
    const { draft, bbId } = await seedWorld(h, { description })
    await runParentContext(h, draft)
    expect((draft[1]!.content as string).endsWith(receiptTail(bbId))).toBe(true)
  })
  test("backgrounded dispatch (tool completed, output.status running) still observes the new child", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, bbId } = await seedWorld(h, { outputStatus: "running" })
    await runParentContext(h, draft)
    expect((draft[1]!.content as string).endsWith(receiptTail(bbId))).toBe(true)
  })
  test("two children in one draft attach independently", async () => {
    const h = hosts[hosts.push(await makeHost({
      [PARENT]: { id: PARENT, parentID: null, agent: "build" },
      [CHILD]: { id: CHILD, parentID: PARENT, agent: "build" },
      child2: { id: "child2", parentID: PARENT, agent: "build" },
    })) - 1]!
    // child A = 标准世界；child B 走同样的种子但换 ID。
    const a = await seedWorld(h, { noticeId: "n-a" })
    // child B：派发 + 注册 + 记录 + 观察 + 通知。
    h.emit("session.created", { sessionID: "child2", parentID: PARENT })
    await h.toolAfter({
      tool: "subagent", sessionID: PARENT, messageID: "ta-2", id: "call-2", status: "completed",
      input: { agent: "explore", description: "Second task", prompt: "go2" },
      result: { output: { sessionID: "child2", status: "completed", output: "done" } },
    })
    await h.context({ sessionID: "child2", agent: "build", messages: [u("c2-in")] })
    h.emit("session.inbox.enqueued", { sessionID: "child2", inboxID: "c2-in" })
    h.emit("session.text.ended", { sessionID: "child2", assistantMessageID: "as-2", ordinal: 0, text: "Answer B" })
    h.emit("session.step.ended", { sessionID: "child2", assistantMessageID: "as-2", finish: "stop" })
    await h.settle()
    const scope = h.scopeOf("child2")!
    const result = scope.put(scope.resolveSession("child2").streamId, {
      writer: { agent: "build", session_id: "child2", message_id: "as-2" },
      createdRound: null, description: "seed b", content: "Answer B",
      idempotencyKey: replyKey("child2", "as-2", "final"),
      origin: { kind: "host_final", input_message_id: "c2-in", text_sha256: sha256hex("Answer B"), message_completed_at: 1 },
    })
    const bbIdB = result.status === "stored" || result.status === "replay" ? result.id : ""
    expect(bbIdB).not.toBe("")
    const noticeB = subagentNotificationText("child2", "completed", "Second task", "Answer B")
    h.emit("session.inbox.delivered", { sessionID: PARENT, inboxID: "n-b" })
    await h.settle()
    h.wires["child2"] = [
      { id: "c2-in", type: "user", text: "go2" },
      { id: "as-2", type: "assistant", finish: "stop", time: { created: 1, completed: 2 }, content: [{ type: "text", text: "Answer B" }] },
    ]
    h.wires[PARENT] = [
      ...h.wires[PARENT]!,
      { id: "n-b", type: "synthetic", text: noticeB, metadata: { source: "subagent", childID: "child2", agent: "explore", state: "completed" }, time: { created: 4 } },
    ]
    const draft: Msg[] = [draftNotice("n-a", a.noticeText), draftNotice("n-b", noticeB)]
    await runParentContext(h, draft)
    expect((draft[0]!.content as string).endsWith(receiptTail(a.bbId))).toBe(true)
    expect((draft[1]!.content as string).endsWith(receiptTail(bbIdB))).toBe(true)
  })
})

describe("subagent delivery receipt: provenance gates (R*.2-6)", () => {
  test("cold cache / restart (empty ledger, no dispatch observed) never associates", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { observeDispatch: false })
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("delivered not observed (backlog not drained) → silent skip", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { emitDelivered: false })
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("delivered seen for another session does not prove this parent's delivery", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, noticeId } = await seedWorld(h, { emitDelivered: false })
    h.emit("session.inbox.delivered", { sessionID: "other-parent", inboxID: noticeId })
    await h.settle()
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("notice missing from parent wire / metadata mismatch → not verified (body ID alone proves nothing)", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, noticeText } = await seedWorld(h, { noticeState: "error" })
    // state=error：wire metadata.state=error → 不验证（首期只处理 completed）。
    await runParentContext(h, draft)
    expect(draft[1]!.content).toBe(noticeText)
  })
  test("notice absent from parent wire → skip even if draft content matches", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, noticeText } = await seedWorld(h)
    h.wires[PARENT] = [{ id: "p-in", type: "user", text: "delegate" }]
    await runParentContext(h, draft)
    expect(draft[1]!.content).toBe(noticeText)
  })
  test("parentage unverified (child belongs to another parent) → skip", async () => {
    const h = hosts[hosts.push(await makeHost({
      [PARENT]: { id: PARENT, parentID: null, agent: "build" },
      [CHILD]: { id: CHILD, parentID: "unrelated", agent: "build" },
      unrelated: { id: "unrelated", parentID: null, agent: "build" },
    })) - 1]!
    const { draft } = await seedWorld(h)
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("description mismatch (no byte-exact template match) → skip", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h)
    const mismatched = subagentNotificationText(CHILD, "completed", "Other description", "The answer")
    draft[1] = draftNotice("n-1", mismatched)
    // wire 里的通知正文保持原样 → draft 正文与 wire 不一致，模板复算不命中。
    await runParentContext(h, draft)
    expect(draft[1]!.content).toBe(mismatched)
  })
  test("NO_TEXT placeholder output → skip", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { parts: [] })
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
})

describe("subagent delivery receipt: retention verification (R*.6)", () => {
  test("no retained record → skip", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { record: false })
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("retained record whose input message was never observed in the child domain → skip", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { recordInputId: null })
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("content hash mismatch / wrong writer message / non-final origin → skip", async () => {
    for (const knobs of [{ recordHash: sha256hex("other") }, { recordMessageId: "as-other" }, { recordKind: "host_stage" as const }]) {
      const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
      const { draft } = await seedWorld(h, knobs)
      await runParentContext(h, draft)
      expect(draft[1]!.content).not.toContain("Retained: bb://")
    }
  })
  test("parent without board_get allow → skip (receipt would instruct an unreadable read)", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions(), { boardGetEffect: "deny" })) - 1]!
    const { draft } = await seedWorld(h)
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
})

describe("subagent delivery receipt: uniqueness & host selection (R*.4, R8.6)", () => {
  test("same text on a non-final assistant does not manufacture uniqueness (two matches → skip)", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { assistantId: "as-2" })
    // as-1 同文（非终稿 finish=tool-calls），账本观察齐全，wire 两条同文 → 唯一性失败。
    h.emit("session.inbox.enqueued", { sessionID: CHILD, inboxID: "c-in" })
    h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: "as-1", ordinal: 0, text: "The answer" })
    h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: "as-1", finish: "tool-calls" })
    await h.settle()
    h.wires[CHILD] = [
      { id: "c-in", type: "user", text: "go" },
      { id: "as-1", type: "assistant", finish: "tool-calls", time: { created: 1, completed: 2 }, content: [{ type: "text", text: "The answer" }] },
      { id: "as-2", type: "assistant", finish: "stop", time: { created: 3, completed: 4 }, content: [{ type: "text", text: "The answer" }] },
    ]
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("same text outside the 20-message window still counts in the full-prefix domain → two matches → skip", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { assistantId: "as-last" })
    // as-old 在 wire 头部（窗口外），同文；账本必须观察全部来源域（R8.2）。
    const wire: Wire[] = [{ id: "c-in", type: "user", text: "go" }]
    wire.push({ id: "as-old", type: "assistant", finish: "stop", time: { created: 1, completed: 2 }, content: [{ type: "text", text: "The answer" }] })
    h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: "as-old", ordinal: 0, text: "The answer" })
    h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: "as-old", finish: "stop" })
    for (let i = 0; i < 24; i++) {
      const id = `filler-${i}`
      wire.push({ id, type: "assistant", finish: "stop", time: { created: 2, completed: 3 }, content: [{ type: "text", text: `filler ${i}` }] })
      h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: id, ordinal: 0, text: `filler ${i}` })
      h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: id, finish: "stop" })
    }
    wire.push({ id: "as-last", type: "assistant", finish: "stop", time: { created: 9, completed: 10 }, content: [{ type: "text", text: "The answer" }] })
    h.wires[CHILD] = wire
    await h.settle()
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
})

describe("subagent delivery receipt: coverage domain & invalidation (R8.1-5)", () => {
  test("wire contains an unobserved assistant → coverage gap → invalidate; later fixed wire does NOT recover", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h)
    h.wires[CHILD] = [...h.wires[CHILD]!, { id: "as-ghost", type: "assistant", finish: "stop", time: { created: 5, completed: 6 }, content: [{ type: "text", text: "ghost" }] }]
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
    // 资格整体失效：wire 修复后也不恢复（不从剩余窗口自动恢复）。
    h.wires[CHILD] = h.wires[CHILD]!.filter((m) => m.id !== "as-ghost")
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("ledger observed a message the wire lacks (observation ahead of wire) → skip, no association", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h)
    h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: "as-new", ordinal: 0, text: "newer answer" })
    h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: "as-new", finish: "stop" })
    await h.settle()
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("text rewind (same ordinal, different text) invalidates the child", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h)
    h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: "as-1", ordinal: 0, text: "rewritten" })
    await h.settle()
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("parent compaction does not invalidate the child's eligibility", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    h.emit("session.compaction.started", { sessionID: PARENT, reason: "auto" })
    await h.settle()
    const { draft, bbId } = await seedWorld(h)
    await runParentContext(h, draft)
    expect((draft[1]!.content as string).endsWith(receiptTail(bbId))).toBe(true)
  })
  test("child compaction → no association, and no recovery after the fact", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const seeded = await seedWorld(h)
    h.emit("session.compaction.started", { sessionID: CHILD, reason: "auto" })
    await h.settle()
    const draft = seeded.draft
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("child compaction.ended / compaction.failed invalidate too", async () => {
    for (const type of ["session.compaction.ended", "session.compaction.failed"]) {
      const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
      const { draft } = await seedWorld(h)
      h.emit(type, { sessionID: CHILD, reason: "auto" })
      await h.settle()
      await runParentContext(h, draft)
      expect(draft[1]!.content).not.toContain("Retained: bb://")
    }
  })
  test("child revert.committed → no association", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h)
    h.emit("session.revert.committed", { sessionID: CHILD, to: "c-in" })
    await h.settle()
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("forked child → no association", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h)
    h.emit("session.forked", { sessionID: CHILD })
    await h.settle()
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("child ledger capacity eviction (33rd child) invalidates the oldest child", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h)
    for (let i = 0; i < 32; i++) {
      await h.toolAfter({
        tool: "subagent", sessionID: PARENT, messageID: `ta-x${i}`, id: `call-x${i}`, status: "completed",
        input: { agent: "explore", description: `filler ${i}`, prompt: "go" },
        result: { output: { sessionID: `evict-${i}`, status: "completed", output: "done" } },
      })
    }
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("delivered ledger capacity eviction (129th inboxID) drops the proven delivery", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, noticeId } = await seedWorld(h)
    for (let i = 0; i < 128; i++) {
      h.emit("session.inbox.delivered", { sessionID: PARENT, inboxID: `inbox-${i}` })
    }
    await h.settle()
    expect(noticeId).toBe("n-1")
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
})

describe("subagent delivery receipt: continuation semantics (R*.7)", () => {
  test("old association is not re-pointed after continuation; second notice uses the new generation", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const first = await seedWorld(h, { noticeId: "n-1" })
    // 续跑：同 child 新一代描述 + 新答案。
    await h.toolAfter({
      tool: "subagent", sessionID: PARENT, messageID: "ta-2", id: "call-2", status: "completed",
      input: { agent: "explore", description: "Second round", prompt: "more", sessionID: CHILD },
      result: { output: { sessionID: CHILD, status: "completed", output: "done2" } },
    })
    h.emit("session.inbox.enqueued", { sessionID: CHILD, inboxID: "c-in-2" })
    h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: "as-2", ordinal: 0, text: "Second answer" })
    h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: "as-2", finish: "stop" })
    await h.settle()
    const scope = h.scopeOf(CHILD)!
    const r2 = scope.put(scope.resolveSession(CHILD).streamId, {
      writer: { agent: "build", session_id: CHILD, message_id: "as-2" },
      createdRound: null, description: "seed 2", content: "Second answer",
      idempotencyKey: replyKey(CHILD, "as-2", "final"),
      origin: { kind: "host_final", input_message_id: "c-in-2", text_sha256: sha256hex("Second answer"), message_completed_at: 1 },
    })
    const bbId2 = r2.status === "stored" || r2.status === "replay" ? r2.id : ""
    expect(bbId2).not.toBe("")
    h.wires[CHILD] = [
      ...h.wires[CHILD]!,
      { id: "as-2", type: "assistant", finish: "stop", time: { created: 5, completed: 6 }, content: [{ type: "text", text: "Second answer" }] },
    ]
    const notice2 = subagentNotificationText(CHILD, "completed", "Second round", "Second answer")
    h.emit("session.inbox.delivered", { sessionID: PARENT, inboxID: "n-2" })
    await h.settle()
    h.wires[PARENT] = [
      ...h.wires[PARENT]!,
      { id: "n-2", type: "synthetic", text: notice2, metadata: { source: "subagent", childID: CHILD, agent: "explore", state: "completed" }, time: { created: 7 } },
    ]
    // 旧通知重投（新请求重建 draft）：仍指向旧记录，不改指新结果。
    const oldDraft: Msg[] = [draftNotice("n-1", first.noticeText)]
    await runParentContext(h, oldDraft)
    expect((oldDraft[0]!.content as string).endsWith(receiptTail(first.bbId))).toBe(true)
    // 新通知：新描述代次 + 新来源 → 指向新记录。
    const newDraft: Msg[] = [draftNotice("n-2", notice2)]
    await runParentContext(h, newDraft)
    expect((newDraft[0]!.content as string).endsWith(receiptTail(bbId2))).toBe(true)
  })
  test("continuation with identical answer text → ambiguity → skip (conservative)", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const first = await seedWorld(h, { noticeId: "n-1" })
    await h.toolAfter({
      tool: "subagent", sessionID: PARENT, messageID: "ta-2", id: "call-2", status: "completed",
      input: { agent: "explore", description: "Second round", prompt: "more", sessionID: CHILD },
      result: { output: { sessionID: CHILD, status: "completed", output: "done2" } },
    })
    h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: "as-2", ordinal: 0, text: "The answer" })
    h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: "as-2", finish: "stop" })
    await h.settle()
    h.wires[CHILD] = [
      ...h.wires[CHILD]!,
      { id: "as-2", type: "assistant", finish: "stop", time: { created: 5, completed: 6 }, content: [{ type: "text", text: "The answer" }] },
    ]
    await runParentContext(h, first.draft)
    expect(first.draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("continuation for a never-dispatched child → no association (R8.1 start unknown)", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { observeDispatch: false })
    await h.toolAfter({
      tool: "subagent", sessionID: PARENT, messageID: "ta-2", id: "call-2", status: "completed",
      input: { agent: "explore", description: "Do the thing", prompt: "more", sessionID: CHILD },
      result: { output: { sessionID: CHILD, status: "completed", output: "done" } },
    })
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
})

describe("subagent delivery receipt: idempotency & display-copy boundary (R*.8)", () => {
  test("same draft object re-run → no duplicate tail; fresh draft (host rebuild) → attaches once again", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, bbId } = await seedWorld(h)
    await runParentContext(h, draft)
    const once = draft[1]!.content as string
    expect(once.split("Retained: bb://").length - 1).toBe(1)
    await runParentContext(h, draft)
    expect(draft[1]!.content).toBe(once)
    // 宿主从持久 wire 重建 draft（无回执）→ 新请求再次附加一次（仅展示副本语义）。
    const freshDraft: Msg[] = [u("p-in", "delegate"), draftNotice("n-1", subagentNotificationText(CHILD, "completed", "Do the thing", "The answer")), u("p-out", "next")]
    await runParentContext(h, freshDraft)
    expect((freshDraft[1]!.content as string).endsWith(receiptTail(bbId))).toBe(true)
  })
})

describe("receipt repair: native ordering and real automatic capture", () => {
  test("initial inbox before tool return AND tool return before Created consumption both work", async () => {
    for (const order of [{ inputBeforeDispatch: true }, { dispatchBeforeCreated: true }]) {
      const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
      const { draft, bbId } = await seedWorld(h, order)
      await runParentContext(h, draft)
      expect((draft[1]!.content as string).endsWith(receiptTail(bbId))).toBe(true)
    }
  })
  test("tool result cannot replace missing live creation proof", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft } = await seedWorld(h, { observeCreated: false })
    await runParentContext(h, draft)
    expect(draft[1]!.content).not.toContain("Retained: bb://")
  })
  test("a completed no-text step is observed even without a text event", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions())) - 1]!
    const { draft, bbId } = await seedWorld(h)
    h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: "tool-only", finish: "tool-calls" })
    await h.settle()
    h.wires[CHILD]!.splice(1, 0, { id: "tool-only", type: "assistant", finish: "tool-calls", time: { completed: 1 }, content: [] })
    await runParentContext(h, draft)
    expect((draft[1]!.content as string).endsWith(receiptTail(bbId))).toBe(true)
  })

  async function autoWorld(h: Host, body: string, inputText = "go") {
    await h.hooks.prompt!({ sessionID: PARENT, messageID: "p-in", prompt: { text: "delegate" } } as never)
    await h.context({ sessionID: PARENT, agent: "build", messages: [u("p-in", "delegate")] })
    h.emit("session.created", { sessionID: CHILD, parentID: PARENT })
    h.emit("session.inbox.enqueued", { sessionID: CHILD, inboxID: "c-in" })
    await h.settle() // 宿主 prompt 先于工具返回；不是通过等待后重发输入弥补缺口。
    h.wires[CHILD] = [{ id: "c-in", type: "user", text: inputText }]
    await h.hooks.prompt!({ sessionID: CHILD, messageID: "c-in", prompt: { text: inputText } } as never)
    await h.context({ sessionID: CHILD, agent: "build", messages: [u("c-in", inputText)] })
    await h.toolAfter({
      tool: "subagent", sessionID: PARENT, messageID: "ta-1", id: "call-1", status: "completed",
      input: { agent: "build", description: "Do the thing", prompt: inputText },
      result: { output: { sessionID: CHILD, status: "running" } },
    })
    // 无文本工具步骤不能被排除于来源域，也不能导致后续真实终稿永远 coverage_gap。
    const toolStep = { id: "as-tool", type: "assistant", agent: "build", finish: "tool-calls",
      time: { created: 1, completed: 2 }, content: [{ type: "tool", id: "t1", name: "read", state: { status: "completed" } }] }
    const terminal = { id: "as-final", type: "assistant", agent: "build", finish: "stop",
      time: { created: 3, completed: 4 }, content: [{ type: "text", text: body }] }
    h.wires[CHILD]!.push(toolStep, terminal)
    h.emit("session.step.started", { sessionID: CHILD, assistantMessageID: "as-tool" })
    h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: "as-tool", finish: "tool-calls" })
    h.emit("session.step.started", { sessionID: CHILD, assistantMessageID: "as-final" })
    h.emit("session.text.ended", { sessionID: CHILD, assistantMessageID: "as-final", ordinal: 0, text: body })
    h.emit("session.step.ended", { sessionID: CHILD, assistantMessageID: "as-final", finish: "stop" })
    await h.settle()
    const scope = h.scopeOf(CHILD)!
    const hit = scope.readMeta(scope.resolveSession(CHILD).streamId).idem[replyKey(CHILD, "as-final", "final")]
    const notice = subagentNotificationText(CHILD, "completed", "Do the thing", body)
    h.wires[PARENT] = [
      { id: "p-in", type: "user", text: "delegate" },
      { id: "n-auto", type: "synthetic", text: notice, metadata: { source: "subagent", childID: CHILD, state: "completed" } },
    ]
    h.emit("session.inbox.delivered", { sessionID: PARENT, inboxID: "n-auto" })
    await h.settle()
    const draft = [u("p-in", "delegate"), draftNotice("n-auto", notice)]
    await runParentContext(h, draft)
    return { scope, hit, draft, body, log: readFileSync(join(h.dataDir, "log/blackboard.log"), "utf8") }
  }

  test("autoCapture:true + real store marker → captureFinal record → parent receipt (no manual put)", async () => {
    const h = hosts[hosts.push(await makeHost(baseSessions(), { autoCapture: true })) - 1]!
    const { scope, hit, draft, body, log } = await autoWorld(h, 'Done.\n\n<!-- bcp:store description="native capture regression" -->')
    expect(hit, log).toBeDefined()
    expect(hit?.id).toStartWith("bb://")
    const record = scope.getById(hit!.id)
    expect(record.status).toBe("found")
    if (record.status !== "found") throw Error("automatic record missing")
    expect(record.record.origin?.kind).toBe("host_final")
    expect(record.record.origin?.input_message_id).toBe("c-in")
    expect(record.record.content).toBe(body)
    expect((draft[1]!.content as string).endsWith(receiptTail(hit!.id))).toBe(true)
  })
  test("automatic path still respects absent marker, NO_STORE and publication denial", async () => {
    for (const scenario of [
      { body: "No publication marker" },
      { body: 'Done.\n\n<!-- bcp:store description="blocked" -->', input: "go <!-- bcp:no-store -->" },
      { body: 'Done.\n\n<!-- bcp:store description="denied" -->', denied: true },
    ]) {
      const h = hosts[hosts.push(await makeHost(baseSessions(), { autoCapture: true, boardStoreEffect: scenario.denied ? "deny" : "allow" })) - 1]!
      const { hit, draft } = await autoWorld(h, scenario.body, scenario.input)
      expect(hit).toBeUndefined()
      expect(draft[1]!.content).not.toContain("Retained: bb://")
    }
  })
})

// 直接控制 await 边界与资源预算；留存/权限本身的真实接线由上面的 adapter 电池验证。
function receiptFixture() {
  const ledger = new SubagentReceiptLedger()
  ledger.observeCreated(PARENT, CHILD)
  ledger.observeDispatch(PARENT, CHILD, "task")
  ledger.observeChildInput(CHILD, "c-in")
  ledger.observeChildText(CHILD, "a", 0, "A")
  ledger.observeChildFinish(CHILD, "a", "stop")
  ledger.observeDelivered(PARENT, "n")
  const text = subagentNotificationText(CHILD, "completed", "task", "A")
  const msgs: Msg[] = [draftNotice("n", text)]
  const wire: Wire[] = [{ id: "a", type: "assistant", finish: "stop", time: { completed: 1 }, content: [{ type: "text", text: "A" }] }]
  const notice = { id: "n", type: "synthetic", text, metadata: { source: "subagent", childID: CHILD, state: "completed" } }
  const id = "bb://00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/e000001"
  const deps: ReceiptDeps = {
    parentSessionID: PARENT, msgs: msgs as Array<Record<string, unknown>>, ledger,
    parentWire: async () => [notice], childWire: async () => wire, childParentID: async () => PARENT,
    retainedRecord: async () => id, parentCanRead: async () => true, log: () => {},
  }
  return { ledger, text, msgs, wire, notice, id, deps }
}

describe("receipt repair: raw notification, race fences and bounded evidence", () => {
  test("persistent A + valid but different draft B never receives B's reference", async () => {
    const f = receiptFixture()
    f.ledger.observeChildText(CHILD, "b", 0, "B")
    f.ledger.observeChildFinish(CHILD, "b", "stop")
    f.wire.push({ id: "b", type: "assistant", finish: "stop", time: { completed: 2 }, content: [{ type: "text", text: "B" }] })
    f.msgs[0]!.content = subagentNotificationText(CHILD, "completed", "task", "B")
    await attachSubagentReceipts(f.deps)
    expect(f.msgs[0]!.content).not.toContain("Retained:")
  })
  test("persistent notification changed during permission await is rechecked", async () => {
    const f = receiptFixture()
    f.deps.parentCanRead = async () => { f.notice.text = "replaced"; return true }
    await attachSubagentReceipts(f.deps)
    expect(f.msgs[0]!.content).toBe(f.text)
  })
  test("invalidation at each async gate cannot publish stale evidence", async () => {
    for (const gate of ["childParentID", "childWire", "retainedRecord", "parentCanRead"] as const) {
      for (const reason of ["compaction", "revert", "deleted", "reset", "capacity", "new_text", "delivery_evicted"]) {
        const f = receiptFixture()
        const invalidate = () => {
          if (reason === "deleted") f.ledger.forgetSession(CHILD)
          else if (reason === "reset") f.ledger.resetAll()
          else if (reason === "capacity") for (let i = 0; i < 32; i++) f.ledger.observeCreated(PARENT, `new-${i}`)
          else if (reason === "new_text") f.ledger.observeChildStart(CHILD, "new-message")
          else if (reason === "delivery_evicted") for (let i = 0; i < 128; i++) f.ledger.observeDelivered(PARENT, `new-${i}`)
          else f.ledger.invalidate(CHILD, reason)
        }
        if (gate === "childParentID") f.deps.childParentID = async () => { invalidate(); return PARENT }
        if (gate === "childWire") f.deps.childWire = async () => { invalidate(); return f.wire }
        if (gate === "retainedRecord") f.deps.retainedRecord = async () => { invalidate(); return f.id }
        if (gate === "parentCanRead") f.deps.parentCanRead = async () => { invalidate(); return true }
        await attachSubagentReceipts(f.deps)
        expect(f.msgs[0]!.content).toBe(f.text)
      }
    }
  })
  test("description collision survives all retained generations; overflow invalidates, never shifts", async () => {
    const f = receiptFixture()
    f.ledger.observeChildText(CHILD, "old", 0, 'embedded\">\nB')
    f.ledger.observeChildFinish(CHILD, "old", "stop")
    f.wire.push({ id: "old", type: "assistant", finish: "stop", time: { completed: 1 }, content: [{ type: "text", text: 'embedded\">\nB' }] })
    f.ledger.observeChildText(CHILD, "new", 0, "B")
    f.ledger.observeChildFinish(CHILD, "new", "stop")
    f.wire.push({ id: "new", type: "assistant", finish: "stop", time: { completed: 2 }, content: [{ type: "text", text: "B" }] })
    f.ledger.observeContinuation(PARENT, CHILD, 'task\">\nembedded')
    f.notice.text = subagentNotificationText(CHILD, "completed", "task", 'embedded\">\nB')
    f.msgs[0]!.content = f.notice.text
    await attachSubagentReceipts(f.deps)
    expect(f.msgs[0]!.content).not.toContain("Retained:") // 两条候选，而非过滤旧来源。
    for (let i = 2; i < DESCRIPTIONS_CAP; i++) f.ledger.observeContinuation(PARENT, CHILD, `filler-${i}`)
    const before = f.ledger.eligibleChild(PARENT, CHILD)!
    expect(before.descriptions.length).toBe(DESCRIPTIONS_CAP)
    f.ledger.observeContinuation(PARENT, CHILD, "overflow")
    expect(before.invalid).toBe("descriptions_limit")
    expect(before.assistants.size).toBe(0)
    expect(before.descriptions.length).toBe(0)
    await attachSubagentReceipts(f.deps)
    expect(f.msgs[0]!.content).not.toContain("Retained:")
  })
  test("assistant, text-part and UTF-8 byte limits release the entire evidence domain", () => {
    const messages = receiptFixture()
    const entry = messages.ledger.eligibleChild(PARENT, CHILD)!
    for (let i = 1; i < ASSISTANTS_CAP; i++) messages.ledger.observeChildStart(CHILD, `m-${i}`)
    expect(entry.assistants.size).toBe(ASSISTANTS_CAP)
    messages.ledger.observeChildStart(CHILD, "one-too-many")
    expect(entry.invalid).toBe("assistants_limit")
    expect(entry.assistants.size).toBe(0)
    expect(entry.bytes).toBe(0)
    const parts = receiptFixture()
    const partsEntry = parts.ledger.eligibleChild(PARENT, CHILD)!
    for (let i = 1; i < TEXT_PARTS_CAP; i++) parts.ledger.observeChildText(CHILD, "a", i, "")
    expect(partsEntry.parts).toBe(TEXT_PARTS_CAP)
    parts.ledger.observeChildText(CHILD, "a", TEXT_PARTS_CAP, "")
    expect(partsEntry.invalid).toBe("text_parts_limit")
    expect(partsEntry.assistants.size).toBe(0)
    const bytes = receiptFixture()
    const bytesEntry = bytes.ledger.eligibleChild(PARENT, CHILD)!
    bytes.ledger.observeChildText(CHILD, "a", 1, "x".repeat(CHILD_EVIDENCE_BYTES_CAP - bytesEntry.bytes))
    expect(bytesEntry.bytes).toBe(CHILD_EVIDENCE_BYTES_CAP)
    bytes.ledger.observeChildText(CHILD, "a", 2, "中")
    expect(bytesEntry.invalid).toBe("evidence_bytes_limit")
    expect(bytesEntry.assistants.size).toBe(0)
    expect(bytesEntry.bytes).toBe(0)
  })
  test("input evidence never silently drops its oldest member", () => {
    const f = receiptFixture()
    const entry = f.ledger.eligibleChild(PARENT, CHILD)!
    for (let i = 1; i < 16; i++) f.ledger.observeChildInput(CHILD, `input-${i}`)
    expect(entry.inputIDs.length).toBe(16)
    f.ledger.observeChildInput(CHILD, "overflow")
    expect(entry.invalid).toBe("input_ids_limit")
    expect(entry.inputIDs).toEqual([])
    expect(entry.assistants.size).toBe(0)
  })
  test("eviction/deletion/reset cannot re-open old children; tombstones are bounded", () => {
    for (const mode of ["eviction", "deleted", "reset"]) {
      const f = receiptFixture()
      if (mode === "eviction") for (let i = 0; i < 32; i++) f.ledger.observeCreated(PARENT, `new-${i}`)
      if (mode === "deleted") f.ledger.forgetSession(CHILD)
      if (mode === "reset") f.ledger.resetAll()
      f.ledger.observeCreated(PARENT, CHILD)
      f.ledger.observeDispatch(PARENT, CHILD, "task")
      expect(f.ledger.eligibleChild(PARENT, CHILD)).toBeNull()
    }
    const ledger = new SubagentReceiptLedger()
    for (let i = 0; i <= SEEN_CHILDREN_CAP; i++) ledger.observeCreated(PARENT, `child-${i}`)
    ledger.observeCreated(PARENT, "fresh-after-limit")
    ledger.observeDispatch(PARENT, "fresh-after-limit", "task")
    expect(ledger.eligibleChild(PARENT, "fresh-after-limit")).toBeNull()
  })
})
