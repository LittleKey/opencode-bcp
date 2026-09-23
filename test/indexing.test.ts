import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openScopeForRoot, type Scope } from "../src/storage"
import { listIndex, snapshotCounts } from "../src/indexing"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let n = 0
function put(scope: Scope, streamId: string, extra: Partial<Parameters<Scope["put"]>[1]> = {}) {
  n++
  const r = scope.put(streamId, {
    writer: { agent: "build", session_id: "s", message_id: `m${n}` },
    createdRound: null,
    description: `描述 ${n}`,
    content: `正文 ${n}`,
    ...extra,
  })
  if (r.status !== "stored") throw new Error(`put failed: ${JSON.stringify(r)}`)
  return r
}
function items(scope: Scope, streamId: string, opts: Partial<Parameters<typeof listIndex>[2]> = {}) {
  return listIndex(scope, streamId, { caller: { sessionId: "s", agent: "build" }, ...opts })
}

describe("indexing", () => {
  // idx-1
  test("compact 排除 tombstoned；all 保留并带 tombstoned:true 标注", () => {
    const scope = openScopeForRoot({ rootSessionId: "i1", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const r1 = put(scope, streamId)
    const r2 = put(scope, streamId)
    scope.markTombstone(streamId, r2.id, "撤回")
    const compact = items(scope, streamId, { view: "compact" }).items
    expect(compact.map((i) => i.id)).toEqual([r1.id])
    const all = items(scope, streamId, { view: "all" }).items
    expect(all.map((i) => i.id)).toEqual([r1.id, r2.id])
    expect(all[0]!.tombstoned).toBe(false)
    expect(all[1]!.tombstoned).toBe(true)
  })

  // idx-2
  test("keyword 大小写不敏感命中原 description（M1-11 第一步前提）", () => {
    const scope = openScopeForRoot({ rootSessionId: "i2", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const a = put(scope, streamId, { description: "登录模块超时修复" })
    const b = put(scope, streamId, { description: "登录模块压测结论" })
    put(scope, streamId, { description: "DeployNotes" })
    expect(items(scope, streamId, { keyword: "超时" }).items.map((i) => i.id)).toEqual([a.id])
    expect(items(scope, streamId, { keyword: "压测" }).items.map((i) => i.id)).toEqual([b.id])
    expect(items(scope, streamId, { keyword: "deploy" }).items.length).toBe(1) // 大小写不敏感
  })

  // idx-3
  test("kind 过滤只留该 kind", () => {
    const scope = openScopeForRoot({ rootSessionId: "i3", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    put(scope, streamId, { kind: "note" })
    const f = put(scope, streamId, { kind: "finding" })
    put(scope, streamId, { kind: "note" })
    const got = items(scope, streamId, { kind: "finding" }).items
    expect(got.length).toBe(1)
    expect(got[0]!.id).toBe(f.id)
    expect(got[0]!.kind).toBe("finding")
  })

  // idx-4
  test("limit=2 分页三次取完且不重不漏、nextCursor 终值 null", () => {
    const scope = openScopeForRoot({ rootSessionId: "i4", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    for (let i = 0; i < 5; i++) put(scope, streamId)
    const seen: number[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const page = items(scope, streamId, { limit: 2, cursor })
      seen.push(...page.items.map((i) => i.sequence))
      pages++
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(pages).toBe(3)
    expect(seen).toEqual([1, 2, 3, 4, 5])
  })

  // idx-5
  test("sinceSeq 只返回新条目", () => {
    const scope = openScopeForRoot({ rootSessionId: "i5", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    for (let i = 0; i < 4; i++) put(scope, streamId)
    const got = items(scope, streamId, { sinceSeq: 2 }).items
    expect(got.map((i) => i.sequence)).toEqual([3, 4])
  })

  // idx-6
  test("pinned 条目标注 pinned:true（受信元数据）", () => {
    const scope = openScopeForRoot({ rootSessionId: "i6", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const r1 = put(scope, streamId)
    put(scope, streamId)
    const scopeJsonPath = join(scope.dir, "scope.json")
    const cfg = JSON.parse(readFileSync(scopeJsonPath, "utf8"))
    cfg.pins.push(r1.id)
    writeFileSync(scopeJsonPath, JSON.stringify(cfg))
    const got = items(scope, streamId).items
    expect(got[0]!.pinned).toBe(true)
    expect(got[1]!.pinned).toBe(false)
  })

  // idx-7
  test("cursor 绑定：跨流或改查询复用 → cursor_mismatch（C3/I7）", () => {
    const scope = openScopeForRoot({ rootSessionId: "i7", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const a = scope.registerSession("sa", "build")
    const b = scope.registerSession("sb", "build")
    for (let i = 0; i < 4; i++) put(scope, a.streamId)
    put(scope, b.streamId)
    const p1 = items(scope, a.streamId, { limit: 2 })
    expect(p1.nextCursor).not.toBeNull()
    expect(() => items(scope, b.streamId, { limit: 2, cursor: p1.nextCursor! })).toThrow("cursor_mismatch")
    expect(() => items(scope, a.streamId, { limit: 2, keyword: "x", cursor: p1.nextCursor! })).toThrow("cursor_mismatch")
    // 同流同查询复用合法
    const p2 = items(scope, a.streamId, { limit: 2, cursor: p1.nextCursor! })
    expect(p2.items.map((i) => i.sequence)).toEqual([3, 4])
  })

  // idx-8（Task 4 Step 4）：new_since_last_shown 按计数而非 maxSeq 差——序号空洞不失真（I8）
  test("空号 3 时 new_since_last_shown === 3（非 4）", () => {
    const scope = openScopeForRoot({ rootSessionId: "i8", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    for (let i = 0; i < 4; i++) put(scope, streamId)
    // 手工制造空号 3：删除第 3 条 entry 文件（seq 1、2、4 保留）
    rmSync(join(scope.dir, "streams", streamId, "entries", "e000003.json"))
    // last_shown_seq=0（newStreamMeta 预置），显式断言前提
    expect(scope.readMeta(streamId).budget.last_shown_seq).toBe(0)
    const counts = snapshotCounts(scope, streamId, { sessionId: "s", agent: "build" }, null)
    expect(counts.new_since_last_shown).toBe(3) // seq 1、2、4 → 按条目计数
    expect(counts.knowledge_total).toBe(3)
    expect(counts.visible_items).toBe(3)
  })

  /** 聚合夹具：老化种子（createdRound=45，可覆写 description）+ 6 条尾部使其退出 recent 窗 + 轮次拨到 49 */
  function seedAged(
    scope: Scope,
    streamId: string,
    count: number,
    descOf?: (i: number) => string,
  ): { id: string; hash: string }[] {
    const out: { id: string; hash: string }[] = []
    for (let i = 0; i < count; i++) {
      const r = scope.put(streamId, {
        writer: { agent: "build", session_id: "s", message_id: `agg-seed-${i}` },
        createdRound: 45,
        description: descOf ? descOf(i) : `旧记录 ${i}`,
        content: "c",
      })
      if (r.status !== "stored") throw new Error(`put failed: ${JSON.stringify(r)}`)
      out.push({ id: r.id, hash: r.hash })
    }
    for (let i = 0; i < 6; i++) {
      const r = scope.put(streamId, {
        writer: { agent: "build", session_id: "s", message_id: `agg-tail-${i}` },
        createdRound: 49,
        description: `尾部 ${i}`,
        content: "t",
      })
      if (r.status !== "stored") throw new Error(`put failed: ${JSON.stringify(r)}`)
    }
    return out
  }
  function admitRounds(scope: Scope, streamId: string, current = 49): void {
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, { ...meta, rounds: { ...meta.rounds, current_round: current, round_known: true } })
  }
  function aggregateOnce(scope: Scope, streamId: string, memberIds: string[]): { id: string } {
    const r = scope.aggregate(streamId, {
      writer: { agent: "build", session_id: "s", message_id: "agg-call" },
      memberIds,
      description: "聚合摘要",
      navigationBody: "# 导航\n- 索引见成员",
    })
    if (r.status !== "aggregated") throw new Error(`aggregate failed: ${JSON.stringify(r)}`)
    return r
  }

  // idx-agg-1（Task B Step 4）：折叠口径——省略 view 与 compact 均不再列示被覆盖原项；all 列示并带 covered_by
  test("idx-agg-1: 聚合后 compact（含省略 view）隐藏 covered 原项并含摘要；all 列示原项带 covered_by", () => {
    const scope = openScopeForRoot({ rootSessionId: "iagg1", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const seeds = seedAged(scope, streamId, 8)
    const t9 = put(scope, streamId)
    const t10 = put(scope, streamId)
    admitRounds(scope, streamId)
    const sum = aggregateOnce(scope, streamId, seeds.map((m) => m.id))
    const folded = items(scope, streamId).items // 省略 view → compact
    expect(folded).toHaveLength(9) // 6 内置尾部 + t9 + t10 + 摘要；8 个 covered 成员折叠
    expect(folded.every((i) => !seeds.some((s) => s.id === i.id))).toBe(true)
    expect(folded.find((i) => i.id === t9.id)).toBeDefined()
    expect(folded.find((i) => i.id === t10.id)).toBeDefined()
    expect(folded.find((i) => i.id === sum.id)!.kind).toBe("index_summary")
    const explicit = items(scope, streamId, { view: "compact" }).items
    expect(explicit.map((i) => i.id)).toEqual(folded.map((i) => i.id))
    const all = items(scope, streamId, { view: "all" }).items
    expect(all).toHaveLength(17)
    for (const s of seeds) expect(all.find((i) => i.id === s.id)!.covered_by).toBe(sum.id)
    expect(all.find((i) => i.id === sum.id)!.covered_by).toBeNull()
  })

  // idx-agg-2（Task B Step 4）：keyword 命中被覆盖原描述 → compact 中 RF1 穿透列示并带 covered_by
  test("idx-agg-2: keyword 命中 covered 原项 → compact 列示该原项且 covered_by 指向摘要", () => {
    const scope = openScopeForRoot({ rootSessionId: "iagg2", dataDir: mkdtempSync(join(tmpdir(), "bb-idx-")) })
    dirs.push(scope.dir)
    const { streamId } = scope.registerSession("s", "build")
    const seeds = seedAged(scope, streamId, 8, (i) => (i === 3 ? "量子纠缠纠错结论" : `旧记录 ${i}`))
    admitRounds(scope, streamId)
    const sum = aggregateOnce(scope, streamId, seeds.map((m) => m.id))
    const hit = items(scope, streamId, { keyword: "量子" }).items
    expect(hit).toHaveLength(1)
    expect(hit[0]!.id).toBe(seeds[3]!.id)
    expect(hit[0]!.covered_by).toBe(sum.id)
  })
})
