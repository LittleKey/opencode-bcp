import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openScopeForRoot, type Scope } from "../src/storage"
import { formatBbId } from "../src/ids"
import { defineBoardTools, type BoardToolContext } from "../src/tools"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CTX: BoardToolContext = { sessionID: "s1", agent: "build", messageID: "m1" }

function makeScope(root: string): Scope {
  const scope = openScopeForRoot({ rootSessionId: root, dataDir: mkdtempSync(join(tmpdir(), "bb-tools-")) })
  dirs.push(scope.dir)
  return scope
}

/** resolveScope 桩：返回 caller 已注册的 scope；log 捕获到数组 */
function stub(scope: Scope, streamId: string, isolated = false) {
  const logs: Record<string, unknown>[] = []
  const tools = defineBoardTools({
    resolveScope: async () => ({ scope, streamId, isolated }),
    log: (line) => logs.push(line),
  })
  return { tools, logs }
}

function mustStore(r: ReturnType<Scope["put"]>): Extract<ReturnType<Scope["put"]>, { status: "stored" }> {
  if (r.status !== "stored") throw new Error(`put failed: ${JSON.stringify(r)}`)
  return r
}

function entryCount(scope: Scope, streamId: string): number {
  return readdirSync(join(scope.dir, "streams", streamId, "entries")).filter((x) => !x.startsWith(".tmp-")).length
}
function getJson(out: string): unknown[] {
  return JSON.parse(out.slice(0, out.indexOf("\n（")))
}

/** 聚合用夹具：老化种子（createdRound=45）+ 轮次钟表拨到 49；补 6 条尾部使其退出 recent 保护窗 */
function seedAged(scope: Scope, streamId: string, count: number): { id: string; hash: string }[] {
  const out: { id: string; hash: string }[] = []
  for (let i = 0; i < count; i++) {
    const r = mustStore(
      scope.put(streamId, {
        writer: { agent: "build", session_id: "s1", message_id: `agg-seed-${i}` },
        createdRound: 45,
        description: `旧记录 ${i}`,
        content: `c${i}`,
      }),
    )
    out.push({ id: r.id, hash: r.hash })
  }
  for (let i = 0; i < 6; i++) {
    mustStore(
      scope.put(streamId, {
        writer: { agent: "build", session_id: "s1", message_id: `agg-tail-${i}` },
        createdRound: 49,
        description: `尾部 ${i}`,
        content: `t${i}`,
      }),
    )
  }
  return out
}
function admitRounds(scope: Scope, streamId: string, current = 49): void {
  const meta = scope.readMeta(streamId)
  scope.writeMeta(streamId, { ...meta, rounds: { ...meta.rounds, current_round: current, round_known: true } })
}
const AGG_NAV = "# 导航\n- 成员列表见 members"
function aggArgs(memberIds: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { member_ids: memberIds, description: "聚合摘要", navigation_body: AGG_NAV, ...extra }
}
function placeholderIds(count: number, seed = "p"): string[] {
  return Array.from({ length: count }, (_, i) => formatBbId("sc", "st", i + 1 + seed.length * 1000 + i))
}

let n = 0
function putArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  n++
  return { description: `描述 ${n}`, content: `正文 ${n}`, ...extra }
}

describe("tools", () => {
  // tools-1
  test("put 成功：stored/hash/sequence 输出，落盘 writer = ctx 三元组，log 发 stored 事件", async () => {
    const scope = makeScope("t1")
    const { streamId } = scope.registerSession("s1", "build")
    const { tools, logs } = stub(scope, streamId)
    const out = await tools.board_put.execute(CTX, putArgs())
    expect(out).toContain("stored")
    expect(out).toContain("hash sha256:")
    expect(out).toContain("sequence 1")
    const rec = JSON.parse(readFileSync(join(scope.dir, "streams", streamId, "entries", "e000001.json"), "utf8"))
    expect(rec.writer).toEqual({ agent: "build", session_id: "s1", message_id: "m1" })
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatchObject({ ev: "stored", session: "s1", stream: streamId, sequence: 1 })
  })

  // tools-2
  test("description 空白 → rejected: description_blank 且 entries 不变（M1-1）", async () => {
    const scope = makeScope("t2")
    const { streamId } = scope.registerSession("s1", "build")
    const { tools } = stub(scope, streamId)
    const out = await tools.board_put.execute(CTX, { description: "   ", content: "c" })
    expect(out).toBe("rejected: description_blank")
    expect(entryCount(scope, streamId)).toBe(0)
  })

  // tools-3
  test("同 key 逐字节相同载荷重试 → 同一 id、entries 不增、replay 回执含 hash（P20/R6）", async () => {
    const scope = makeScope("t3")
    const { streamId } = scope.registerSession("s1", "build")
    const { tools } = stub(scope, streamId)
    const args = putArgs({ idempotency_key: "k1", source_refs: ["a"] })
    const out1 = await tools.board_put.execute(CTX, args)
    expect(out1).toContain("stored")
    const out2 = await tools.board_put.execute(CTX, args)
    expect(out2).toContain("(idempotent replay)")
    expect(out2).toContain("hash sha256:")
    expect(out2.split("\n")[0]!.split(" ")[1]).toBe(out1.split("\n")[0]!.split(" ")[1])
    expect(entryCount(scope, streamId)).toBe(1)
  })

  // tools-4
  test("同 key 仅 source_refs 顺序不同 → idempotency_conflict（P2 字节精确）", async () => {
    const scope = makeScope("t4")
    const { streamId } = scope.registerSession("s1", "build")
    const { tools } = stub(scope, streamId)
    await tools.board_put.execute(CTX, putArgs({ idempotency_key: "k1", source_refs: ["a", "b"] }))
    const out = await tools.board_put.execute(CTX, putArgs({ idempotency_key: "k1", source_refs: ["b", "a"] }))
    expect(out).toContain("rejected: idempotency_conflict")
  })

  // tools-5
  test("supersedes 不存在 → unknown_ref；存在 → 成功且 nav 标注（§6②）", async () => {
    const scope = makeScope("t5")
    const { streamId } = scope.registerSession("s1", "build")
    const { tools } = stub(scope, streamId)
    const ghost = formatBbId(scope.config.scope_id, streamId, 99)
    expect(await tools.board_put.execute(CTX, putArgs({ supersedes: [ghost] }))).toContain(
      `rejected: unknown_ref ${ghost}`,
    )
    const r1 = await tools.board_put.execute(CTX, putArgs())
    const oldId = r1.split("\n")[0]!.split(" ")[1]!
    const out = await tools.board_put.execute(CTX, putArgs({ supersedes: [oldId] }))
    expect(out).toContain("stored")
    const meta = scope.readMeta(streamId)
    expect(meta.nav[oldId]!.superseded_by).toBe(out.split("\n")[0]!.split(" ")[1])
  })

  // tools-6
  test("get 三态：found 含 hash 与 nav；unavailable；not_found（M1-10）", async () => {
    const scope = makeScope("t6")
    const { streamId } = scope.registerSession("s1", "build")
    const { tools } = stub(scope, streamId)
    const out1 = await tools.board_put.execute(CTX, putArgs())
    const id1 = out1.split("\n")[0]!.split(" ")[1]!
    await tools.board_put.execute(CTX, putArgs())
    scope.markTombstone(streamId, formatBbId(scope.config.scope_id, streamId, 2), "撤回")
    const ghost = formatBbId(scope.config.scope_id, streamId, 42)
    const results = getJson(await tools.board_get.execute(CTX, { ids: [id1, ghost, formatBbId(scope.config.scope_id, streamId, 2)] }))
    expect(results[0]).toMatchObject({ id: id1, status: "found" })
    expect((results[0] as { hash: string }).hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(results[0]).toHaveProperty("nav")
    expect(results[1]).toMatchObject({ id: ghost, status: "not_found" })
    expect(results[2]).toMatchObject({ status: "unavailable" })
  })

  // tools-7
  test("跨 scope id → forbidden 且输出不含原文（M0-9）", async () => {
    const scopeA = makeScope("t7a")
    const { streamId } = scopeA.registerSession("s1", "build")
    const scopeB = makeScope("t7b")
    const sb = scopeB.registerSession("sb", "build")
    const secret = mustStore(
      scopeB.put(sb.streamId, {
        writer: { agent: "build", session_id: "sb", message_id: "mx" },
        createdRound: null,
        description: "机密",
        content: "TOPSECRET-CONTENT",
      }),
    )
    const { tools } = stub(scopeA, streamId)
    const out = await tools.board_get.execute(CTX, { ids: [secret.id] })
    expect(out).toContain('"forbidden"')
    expect(out).not.toContain("TOPSECRET-CONTENT")
    expect(out).not.toContain("机密")
  })

  // tools-8
  test("隔离流引用 unknown_ref 与不存在输出逐字节一致（C2-③ 存在性不泄漏）", async () => {
    const scope = makeScope("t8")
    const s1 = scope.registerSession("s1", "build")
    scope.registerSession("c1", "councillor-x")
    const cStream = scope.config.session_index["c1"]!.stream_id
    const hiddenId = formatBbId(scope.config.scope_id, cStream, 1)
    const { tools } = stub(scope, s1.streamId)
    const before = await tools.board_put.execute(CTX, putArgs({ related: [hiddenId] }))
    expect(before).toContain("rejected: unknown_ref")
    // c1 自己写入该记录（隔离流内），对 s1 仍不可见
    scope.put(cStream, {
      writer: { agent: "councillor-x", session_id: "c1", message_id: "mc1" },
      createdRound: null,
      description: "独立席工作",
      content: "c",
    })
    const after = await tools.board_put.execute(CTX, putArgs({ related: [hiddenId] }))
    expect(before).toBe(after) // 同一 id：不存在 → hidden，存在 → hidden，输出逐字节一致
  })

  // tools-9
  test("index 仅列授权流；绑定 cursor 翻页一致（M0-10）", async () => {
    const scope = makeScope("t9")
    const s1 = scope.registerSession("s1", "build")
    const s2 = scope.registerSession("s2", "build")
    scope.registerSession("c1", "councillor-x")
    scope.put(s2.streamId, {
      writer: { agent: "build", session_id: "s2", message_id: "ms2" },
      createdRound: null,
      description: "他流记录",
      content: "c",
    })
    const { tools } = stub(scope, s1.streamId)
    for (let i = 0; i < 3; i++) await tools.board_put.execute(CTX, putArgs())
    const p1 = JSON.parse(await tools.board_index.execute(CTX, { limit: 2 }))
    expect(p1.stream.items.length).toBe(2)
    expect(p1.stream.nextCursor).not.toBeNull()
    // 隔离流不可列
    const cStream = scope.config.session_index["c1"]!.stream_id
    expect(p1.other_streams.map((s: { stream_id: string }) => s.stream_id)).toEqual([s2.streamId])
    expect(p1.other_streams[0]).toMatchObject({ stream_id: s2.streamId, count: 1 })
    expect(p1.other_streams.map((s: { stream_id: string }) => s.stream_id)).not.toContain(cStream)
    const p2 = JSON.parse(await tools.board_index.execute(CTX, { limit: 2, cursor: p1.stream.nextCursor }))
    expect(p2.stream.items.length).toBe(1)
    expect(p2.stream.nextCursor).toBeNull()
    expect([...p1.stream.items, ...p2.stream.items].map((i: { sequence: number }) => i.sequence)).toEqual([1, 2, 3])
  })

  // tools-10
  test("小配额 → rejected: quota_exceeded 且无 stored 字样（M1-12）", async () => {
    const scope = makeScope("t10")
    const { streamId } = scope.registerSession("s1", "build")
    const { tools } = stub(scope, streamId)
    const scopeJsonPath = join(scope.dir, "scope.json")
    const cfg = JSON.parse(readFileSync(scopeJsonPath, "utf8"))
    cfg.quota_bytes = scope.usageBytes() // 已占用即配额 → 下一 put 必越限
    writeFileSync(scopeJsonPath, JSON.stringify(cfg))
    const out = await tools.board_put.execute(CTX, putArgs())
    expect(out).toContain("rejected: quota_exceeded")
    expect(out).not.toContain("stored")
  })

  // tools-11
  test("index 输出含固定声明行（Global Constraints #7）", async () => {
    const scope = makeScope("t11")
    const { streamId } = scope.registerSession("s1", "build")
    const { tools } = stub(scope, streamId)
    await tools.board_put.execute(CTX, putArgs())
    const out = await tools.board_index.execute(CTX, {})
    expect(out).toContain("（目录与摘要为检索提示；除非逐条 board.get，未读原文）")
  })

  // tools-12
  test("跨流导航防御（C2-②）：supersedes 他流可读记录拒绝；跨流 nav 边不返回", async () => {
    const scope = makeScope("t12")
    const s1 = scope.registerSession("s1", "build")
    const s2 = scope.registerSession("s2", "build")
    scope.registerSession("c1", "councillor-x")
    const cStream = scope.config.session_index["c1"]!.stream_id
    const r2 = mustStore(
      scope.put(s2.streamId, {
        writer: { agent: "build", session_id: "s2", message_id: "ms2" },
        createdRound: null,
        description: "他流可读记录",
        content: "c",
      }),
    )
    const cRec = mustStore(
      scope.put(cStream, {
        writer: { agent: "councillor-x", session_id: "c1", message_id: "mc1" },
        createdRound: null,
        description: "隔离流记录",
        content: "c",
      }),
    )
    const { tools } = stub(scope, s1.streamId)
    // (a) supersedes 指向同 scope 他流可读记录 → 同流限制 → unknown_ref
    expect(await tools.board_put.execute(CTX, putArgs({ supersedes: [r2.id] }))).toContain(
      `rejected: unknown_ref ${r2.id}`,
    )
    const ok = await tools.board_put.execute(CTX, putArgs())
    const id1 = ok.split("\n")[0]!.split(" ")[1]!
    // (b) 手工写入跨流（隔离流）superseded_by 边 → get/index 该字段置 null 不返回
    const meta = scope.readMeta(s1.streamId)
    meta.nav[id1] = { superseded_by: cRec.id }
    scope.writeMeta(s1.streamId, meta)
    const got = getJson(await tools.board_get.execute(CTX, { ids: [id1] }))[0] as {
      nav: { superseded_by: string | null }
    }
    expect(got.nav.superseded_by).toBeNull() // 置 null 不返回，不泄漏他流 ID
    const idx = JSON.parse(await tools.board_index.execute(CTX, {}))
    expect(idx.stream.items.find((i: { id: string }) => i.id === id1).superseded_by).toBeNull()
  })

  // t-agg-1
  test("t-agg-1: 未注册会话 board_aggregate 拒绝", async () => {
    const tools = defineBoardTools({ resolveScope: async () => null, log: () => {} })
    expect(await tools.board_aggregate.execute(CTX, aggArgs(placeholderIds(8)))).toBe(
      "rejected: unregistered_session",
    )
  })

  // t-agg-2
  test("t-agg-2: 引用授权——跨 scope forbidden_ref；格式错/跨流/隔离流 unknown_ref；get 隔离流不泄露", async () => {
    const scope = makeScope("ta2")
    const s1 = scope.registerSession("s1", "build")
    const s2 = scope.registerSession("s2", "build")
    scope.registerSession("c1", "councillor-x")
    const cStream = scope.config.session_index["c1"]!.stream_id
    const cRec = mustStore(
      scope.put(cStream, {
        writer: { agent: "councillor-x", session_id: "c1", message_id: "mc1" },
        createdRound: 45,
        description: "隔离流记录",
        content: "c",
      }),
    )
    const locals = seedAged(scope, s1.streamId, 8).map((m) => m.id)
    admitRounds(scope, s1.streamId)
    const { tools } = stub(scope, s1.streamId)
    // (a) 跨 scope 引用 → forbidden_ref
    const scopeB = makeScope("ta2b")
    scopeB.registerSession("sb", "build")
    const sbStream = scopeB.config.session_index["sb"]!.stream_id
    const secret = mustStore(
      scopeB.put(sbStream, {
        writer: { agent: "build", session_id: "sb", message_id: "sb1" },
        createdRound: 45,
        description: "秘密",
        content: "s",
      }),
    )
    expect(await tools.board_aggregate.execute(CTX, aggArgs([secret.id, ...locals.slice(0, 7)]))).toBe(
      `rejected: forbidden_ref ${secret.id}`,
    )
    // (b) 格式错 → unknown_ref
    expect(await tools.board_aggregate.execute(CTX, aggArgs(["not-a-bb-id", ...locals.slice(0, 7)]))).toBe(
      "rejected: unknown_ref not-a-bb-id",
    )
    // (c) 跨流（同 scope 可读流）→ unknown_ref
    const s2rec = mustStore(
      scope.put(s2.streamId, {
        writer: { agent: "build", session_id: "s2", message_id: "ms2" },
        createdRound: 45,
        description: "他流记录",
        content: "c",
      }),
    )
    expect(await tools.board_aggregate.execute(CTX, aggArgs([s2rec.id, ...locals.slice(0, 7)]))).toBe(
      `rejected: unknown_ref ${s2rec.id}`,
    )
    // (d) 隔离流成员（真实存在也不泄露）→ unknown_ref
    expect(await tools.board_aggregate.execute(CTX, aggArgs([cRec.id, ...locals.slice(0, 7)]))).toBe(
      `rejected: unknown_ref ${cRec.id}`,
    )
    // (e) 同 scope 调用者 board_get 隔离流摘要 id → not_found 文案（hidden 同文案）
    const ghostId = formatBbId(scope.config.scope_id, cStream, 99)
    const out = await tools.board_get.execute(CTX, { ids: [ghostId] })
    expect(getJson(out)[0]).toMatchObject({ id: ghostId, status: "not_found" })
    expect(out).not.toContain("hidden")
    expect(out).not.toContain("隔离流记录")
  })

  // t-agg-3
  test("t-agg-3: board_aggregate 成功输出、日志与导航边", async () => {
    const scope = makeScope("ta3")
    const s1 = scope.registerSession("s1", "build")
    const members = seedAged(scope, s1.streamId, 8)
    admitRounds(scope, s1.streamId)
    const { tools, logs } = stub(scope, s1.streamId)
    const out = await tools.board_aggregate.execute(CTX, aggArgs(members.map((m) => m.id)))
    const summaryId = formatBbId(scope.config.scope_id, s1.streamId, 15)
    expect(out).toContain(`summary ${summaryId} aggregated (covered 8 members)`)
    expect(out).toContain("hash sha256:")
    expect(out).toContain("sequence 15")
    expect(logs[0]).toMatchObject({ ev: "aggregated", session: "s1", stream: s1.streamId, id: summaryId, members: 8 })
    const got = getJson(await tools.board_get.execute(CTX, { ids: [members[0]!.id] }))[0] as {
      nav: { covered_by: string | null }
    }
    expect(got.nav.covered_by).toBe(summaryId)
  })

  // t-agg-4
  test("t-agg-4: 整批 already_covered → rejected: aggregate_invalid 逐成员行", async () => {
    const scope = makeScope("ta4")
    const s1 = scope.registerSession("s1", "build")
    const members = seedAged(scope, s1.streamId, 8)
    admitRounds(scope, s1.streamId)
    const { tools } = stub(scope, s1.streamId)
    const first = await tools.board_aggregate.execute(CTX, aggArgs(members.map((m) => m.id)))
    expect(first).toContain("aggregated (covered 8 members)")
    const second = await tools.board_aggregate.execute(CTX, aggArgs(members.map((m) => m.id)))
    expect(second.startsWith("rejected: aggregate_invalid")).toBe(true)
    for (const m of members) expect(second).toContain(`- ${m.id}: already_covered`)
  })

  // t-agg-5
  test("t-agg-5: 描述校验——缺参 zod 抛错；空白/换行/超长 → rejected: description_*", async () => {
    const scope = makeScope("ta5")
    const s1 = scope.registerSession("s1", "build")
    const { tools } = stub(scope, s1.streamId)
    const ids = placeholderIds(8)
    await expect(
      tools.board_aggregate.execute(CTX, { member_ids: ids, navigation_body: "n" }),
    ).rejects.toThrow()
    expect(await tools.board_aggregate.execute(CTX, aggArgs(ids, { description: "   " }))).toBe(
      "rejected: description_blank",
    )
    expect(await tools.board_aggregate.execute(CTX, aggArgs(ids, { description: "a\r\nb" }))).toBe(
      "rejected: description_newline",
    )
    expect(await tools.board_aggregate.execute(CTX, aggArgs(ids, { description: "a".repeat(81) }))).toBe(
      "rejected: description_too_long",
    )
  })

  // t-agg-6
  test("t-agg-6: zod 边界——member_ids 7/17 → ZodError", async () => {
    const scope = makeScope("ta6")
    const s1 = scope.registerSession("s1", "build")
    const { tools } = stub(scope, s1.streamId)
    await expect(tools.board_aggregate.execute(CTX, aggArgs(placeholderIds(7)))).rejects.toThrow()
    await expect(tools.board_aggregate.execute(CTX, aggArgs(placeholderIds(17)))).rejects.toThrow()
  })
})
