// agg-1…14（聚合计划 Task A Step 5）。全部 dataDir = 临时目录；同进程顺序提交
// （进程内无真实 flock 竞争——真实互斥证据由 lockcheck aggregateRace 承载）。

import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openScopeForRoot, faultHook, type Scope, type AggregateArgs } from "../src/storage"
import { buildRecordBytes, recordHash, type BbRecord } from "../src/schema"
import { formatBbId, entryFileName } from "../src/ids"
import { aggregateCandidates, candidateSetIdOf } from "../src/aggregate"
import { listIndex, snapshotCounts } from "../src/indexing"

const AUTHOR = { sessionId: "agg-author", agent: "build" }
const NAV_BODY = "# 导航\n- 成员列表见 members"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bb-agg-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  faultHook.current = null
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): { scope: Scope; streamId: string } {
  const scope = openScopeForRoot({ rootSessionId: "agg-root", dataDir: tempDir() })
  const { streamId } = scope.registerSession(AUTHOR.sessionId, AUTHOR.agent)
  return { scope, streamId }
}

function aggWriter(mid = "agg-call"): AggregateArgs["writer"] {
  return { agent: AUTHOR.agent, session_id: AUTHOR.sessionId, message_id: mid }
}

function aggArgs(memberIds: string[], extra: Partial<AggregateArgs> = {}): AggregateArgs {
  return { writer: aggWriter(), memberIds, description: "聚合摘要", navigationBody: NAV_BODY, ...extra }
}

function seedAged(
  scope: Scope,
  streamId: string,
  count: number,
  opts: { createdRound?: number | null; sessionId?: string; agent?: string } = {},
): { id: string; hash: string; sequence: number }[] {
  const out: { id: string; hash: string; sequence: number }[] = []
  for (let i = 1; i <= count; i++) {
    const r = scope.put(streamId, {
      writer: { agent: opts.agent ?? AUTHOR.agent, session_id: opts.sessionId ?? AUTHOR.sessionId, message_id: `seed-${out.length + 1}` },
      createdRound: opts.createdRound === undefined ? 45 : opts.createdRound,
      description: `aged 记录 ${out.length + 1}`,
      content: `aged 内容 ${out.length + 1}`,
    })
    if (r.status !== "stored") throw new Error(`seed put failed: ${JSON.stringify(r)}`)
    out.push({ id: r.id, hash: r.hash, sequence: r.sequence })
  }
  return out
}

/** rounds 预置（机械可验的老化分布）：created_round=45 → current_round=49，age=4>2 过 fence */
function admitRounds(scope: Scope, streamId: string, current: number): void {
  scope.withLock(() => {
    const meta = scope.readMeta(streamId)
    meta.rounds = { current_round: current, round_known: true, last_admitted_message_id: meta.rounds.last_admitted_message_id }
    scope.writeMeta(streamId, meta)
  })
}

function entryCount(scope: Scope, streamId: string): number {
  return readdirSync(join(scope.dir, "streams", streamId, "entries")).length
}

function coveredEdges(meta: ReturnType<Scope["readMeta"]>): [string, string][] {
  return Object.entries(meta.nav).filter(([, v]) => v.covered_by !== undefined).map(([k, v]) => [k, v.covered_by!])
}

/** summary.members ⇄ nav.covered_by 双向一致（observe fsck 同款反向核对） */
function expectMembersNavConsistent(scope: Scope, streamId: string, summaryId: string): void {
  const g = scope.getById(summaryId)
  expect(g.status).toBe("found")
  if (g.status !== "found") return
  const meta = scope.readMeta(streamId)
  const members = g.record.members ?? []
  for (const m of members) expect(meta.nav[m.id]!.covered_by).toBe(summaryId)
  const edges = coveredEdges(meta)
  expect(edges).toHaveLength(members.length)
  for (const [id, target] of edges) {
    expect(target).toBe(summaryId)
    expect(members.map((m) => m.id)).toContain(id)
  }
}

describe("aggregate", () => {
  // agg-1
  test("合法 8 成员聚合成功：kind/members/summary_basis/high_water+1", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 14)
    admitRounds(scope, streamId, 49)
    const members = seeded.slice(0, 8)
    const before = scope.readMeta(streamId).high_water
    const r = scope.aggregate(streamId, aggArgs(members.map((m) => m.id)))
    expect(r.status).toBe("aggregated")
    if (r.status !== "aggregated") return
    expect(r.sequence).toBe(before + 1)
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
    const g = scope.getById(r.id)
    expect(g.status).toBe("found")
    if (g.status !== "found") return
    expect(g.hash).toBe(r.hash)
    const rec = g.record
    expect(rec.kind).toBe("index_summary")
    expect(rec.summary_basis).toBe("descriptions")
    expect(rec.members).toHaveLength(8)
    expect(rec.members!.map((m) => m.hash)).toEqual(members.map((m) => m.hash))
    expect(scope.readMeta(streamId).high_water).toBe(before + 1)
  })

  // agg-2
  test("nav covered_by 全部成员指向摘要；成员原 hash 不变（原条目永不改写）", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 14)
    admitRounds(scope, streamId, 49)
    const members = seeded.slice(0, 8)
    const r = scope.aggregate(streamId, aggArgs(members.map((m) => m.id)))
    expect(r.status).toBe("aggregated")
    if (r.status !== "aggregated") return
    const meta = scope.readMeta(streamId)
    for (const m of members) {
      expect(meta.nav[m.id]!.covered_by).toBe(r.id)
      const g = scope.getById(m.id)
      expect(g.status).toBe("found")
      if (g.status === "found") expect(g.hash).toBe(m.hash)
    }
  })

  // agg-3
  test("数量边界：7 → batch_size_7；16 合法通过；17 → batch_size_17", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 23) // 17 可用 + 6 近期尾部
    admitRounds(scope, streamId, 49)
    const ids = seeded.map((s) => s.id)
    expect(scope.aggregate(streamId, aggArgs(ids.slice(0, 7)))).toEqual({
      status: "invalid",
      errors: [{ id: "*", reason: "batch_size_7" }],
    })
    expect(scope.aggregate(streamId, aggArgs(ids.slice(0, 17)))).toEqual({
      status: "invalid",
      errors: [{ id: "*", reason: "batch_size_17" }],
    })
    const r16 = scope.aggregate(streamId, aggArgs(ids.slice(0, 16)))
    expect(r16.status).toBe("aggregated")
  })

  // agg-4
  test("整批拒绝不缩小：fence / 年龄足够却 recent6；无摘要无 nav 变化 high_water 不变", () => {
    const { scope, streamId } = setup()
    const fenced = seedAged(scope, streamId, 1, { createdRound: 48 }) // age=1 → fence（seq1 不在 recent6）
    const aged = seedAged(scope, streamId, 7)
    const tail = seedAged(scope, streamId, 6) // seq9..14 = recent6
    admitRounds(scope, streamId, 49)
    expect(entryCount(scope, streamId)).toBe(14)
    const r1 = scope.aggregate(streamId, aggArgs([fenced[0]!.id, ...aged.map((m) => m.id)]))
    expect(r1).toEqual({ status: "invalid", errors: [{ id: fenced[0]!.id, reason: "fence" }] })
    const r2 = scope.aggregate(streamId, aggArgs([...aged.map((m) => m.id), tail[0]!.id]))
    expect(r2).toEqual({ status: "invalid", errors: [{ id: tail[0]!.id, reason: "recent" }] })
    const meta = scope.readMeta(streamId)
    expect(meta.high_water).toBe(14)
    expect(coveredEdges(meta)).toHaveLength(0)
    expect(meta.agg_pending).toBeNull()
    expect(entryCount(scope, streamId)).toBe(14)
  })

  // agg-5
  test("非原作者双字段整批拒绝：换 session / 同 session 换 agent 均拒绝", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 14)
    admitRounds(scope, streamId, 49)
    const ids = seeded.slice(0, 8).map((m) => m.id)
    const r1 = scope.aggregate(streamId, aggArgs(ids, { writer: { agent: AUTHOR.agent, session_id: "other-session", message_id: "x1" } }))
    expect(r1.status).toBe("invalid")
    if (r1.status === "invalid") {
      expect(r1.errors).toHaveLength(8)
      expect(r1.errors.every((e) => e.reason === "not_original_author")).toBe(true)
    }
    const r2 = scope.aggregate(streamId, aggArgs(ids, { writer: { agent: "plan", session_id: AUTHOR.sessionId, message_id: "x2" } }))
    expect(r2.status).toBe("invalid")
    if (r2.status === "invalid") {
      expect(r2.errors.every((e) => e.reason === "not_original_author")).toBe(true)
    }
    expect(scope.readMeta(streamId).high_water).toBe(14)
  })

  // agg-6
  test("pinned：①候选含 pinned 整批拒绝；②候选通过后提交前被 pin（updateConfig I3）→ 重验证拒绝", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 14)
    admitRounds(scope, streamId, 49)
    const members = seeded.slice(0, 8)
    const ids = members.map((m) => m.id)
    // ①
    scope.updateConfig((cfg) => ({ ...cfg, pins: [members[3]!.id] }))
    const r1 = scope.aggregate(streamId, aggArgs(ids))
    expect(r1).toEqual({ status: "invalid", errors: [{ id: members[3]!.id, reason: "pinned" }] })
    // ②候选生成（无 pin）→ 受信入口写入 pin → 提交重验证
    scope.updateConfig((cfg) => ({ ...cfg, pins: [] }))
    const caller = { sessionId: AUTHOR.sessionId, agent: AUTHOR.agent }
    const cand = aggregateCandidates(scope, streamId, caller, 49)
    expect(cand).not.toBeNull()
    if (!cand) return
    expect(cand.members.map((m) => m.id)).toEqual(ids)
    expect(cand.setHash).toBe(candidateSetIdOf(streamId, cand.members))
    scope.updateConfig((cfg) => ({ ...cfg, pins: [members[0]!.id] }))
    const r2 = scope.aggregate(streamId, aggArgs(ids))
    expect(r2).toEqual({ status: "invalid", errors: [{ id: members[0]!.id, reason: "pinned" }] })
    const meta = scope.readMeta(streamId)
    expect(meta.high_water).toBe(14)
    expect(coveredEdges(meta)).toHaveLength(0)
    expect(entryCount(scope, streamId)).toBe(14)
  })

  // agg-7
  test("created_round 未知成员 → invalid round_unknown", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 8, { createdRound: null })
    admitRounds(scope, streamId, 49)
    const r = scope.aggregate(streamId, aggArgs(seeded.map((m) => m.id)))
    expect(r.status).toBe("invalid")
    if (r.status === "invalid") {
      expect(r.errors).toHaveLength(8)
      expect(r.errors.every((e) => e.reason === "round_unknown")).toBe(true)
    }
    expect(scope.readMeta(streamId).high_water).toBe(8)
  })

  // agg-8
  test("reason 子集：already_covered / index_summary / cross_stream / duplicate / 跨 scope not_found", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 23)
    admitRounds(scope, streamId, 49)
    const ids = seeded.map((s) => s.id)
    const r1 = scope.aggregate(streamId, aggArgs(ids.slice(0, 8)))
    expect(r1.status).toBe("aggregated")
    if (r1.status !== "aggregated") return
    const summaryId = r1.id
    // 跨流（同 scope 第二 session 的流）
    const { streamId: streamId2 } = scope.registerSession("sess-2", "plan")
    const cross = scope.put(streamId2, { writer: { agent: "plan", session_id: "sess-2", message_id: "c1" }, createdRound: 45, description: "跨流", content: "跨流" })
    if (cross.status !== "stored") throw new Error("cross put failed")
    // 跨 scope（独立根 → 独立 scope_id）
    const other = openScopeForRoot({ rootSessionId: "foreign-root", dataDir: tempDir() })
    const { streamId: otherStream } = other.registerSession("foreign-sess", "build")
    const foreign = other.put(otherStream, { writer: { agent: "build", session_id: "foreign-sess", message_id: "f1" }, createdRound: 45, description: "跨 scope", content: "跨 scope" })
    if (foreign.status !== "stored") throw new Error("foreign put failed")
    const batch = [ids[0]!, summaryId, cross.id, foreign.id, ids[8]!, ids[8]!, ids[9]!, ids[10]!]
    const r2 = scope.aggregate(streamId, aggArgs(batch))
    expect(r2).toEqual({
      status: "invalid",
      errors: [
        { id: ids[0]!, reason: "already_covered" },
        { id: summaryId, reason: "index_summary" },
        { id: cross.id, reason: "cross_stream" },
        { id: foreign.id, reason: "not_found" },
        { id: ids[8]!, reason: "duplicate_member" },
      ],
    })
    const meta = scope.readMeta(streamId)
    expect(meta.high_water).toBe(24) // 23 条种子 + r1 摘要；r2 整批拒绝不落盘
    expect(entryCount(scope, streamId)).toBe(24)
  })

  // agg-9
  test("agg_after_reserve 崩溃 + 存量 metadata（无 agg_pending 键）：读入口自动恢复且计数一致", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 14)
    admitRounds(scope, streamId, 49)
    const members = seeded.slice(0, 8)
    // 第一轮存量格式：手工删掉 agg_pending 键（fix-2 归一化）
    const metaPath = join(scope.dir, "streams", streamId, "metadata.json")
    const raw = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>
    delete raw.agg_pending
    writeFileSync(metaPath, JSON.stringify(raw))
    faultHook.current = (at) => {
      if (at === "agg_after_reserve") throw new Error("agg-crash-reserve")
    }
    expect(() => scope.aggregate(streamId, aggArgs(members.map((m) => m.id)))).toThrow("agg-crash-reserve")
    faultHook.current = null
    // 未手动 recover：直接 getById(成员) → recover-on-read
    const g0 = scope.getById(members[0]!.id)
    expect(g0.status).toBe("found")
    if (g0.status === "found") expect(g0.hash).toBe(members[0]!.hash)
    const meta = scope.readMeta(streamId)
    expect(meta.agg_pending).toBeNull()
    const summaryId = formatBbId(scope.config.scope_id, streamId, 15)
    for (const m of members) expect(meta.nav[m.id]!.covered_by).toBe(summaryId)
    expect(scope.getById(summaryId).status).toBe("found")
    expectMembersNavConsistent(scope, streamId, summaryId)
    // 独立调用 snapshotCounts + listIndex：与直算一致（Task B 折叠口径：8 个 covered 成员
    // 不列示、不计 visible；keyword 未命中 → 无 RF1 穿透）
    const caller = { sessionId: AUTHOR.sessionId, agent: AUTHOR.agent }
    const counts = snapshotCounts(scope, streamId, caller, 49)
    expect(counts.knowledge_total).toBe(15)
    expect(counts.visible_items).toBe(7)
    expect(counts.index_summary_count).toBe(1)
    expect(counts.eligible).toBe(0)
    expect(counts.protected).toBe(15)
    const listed = listIndex(scope, streamId, { caller })
    expect(listed.items).toHaveLength(7)
    expect(listed.nextCursor).toBeNull()
  })

  // agg-10
  test("agg_after_publish 崩溃 + 仅 agg_pending：反复读入口稳定、entry 不重建", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 14)
    admitRounds(scope, streamId, 49)
    const members = seeded.slice(0, 8)
    faultHook.current = (at) => {
      if (at === "agg_after_publish") throw new Error("agg-crash-publish")
    }
    expect(() => scope.aggregate(streamId, aggArgs(members.map((m) => m.id)))).toThrow("agg-crash-publish")
    faultHook.current = null
    const summaryId = formatBbId(scope.config.scope_id, streamId, 15)
    const entryPath = join(scope.dir, "streams", streamId, "entries", entryFileName(15))
    const inoBefore = statSync(entryPath).ino
    const caller = { sessionId: AUTHOR.sessionId, agent: AUTHOR.agent }
    // 反复调用，各自锁内恢复后一致，只见终态、无第三态
    for (let i = 0; i < 3; i++) {
      const g = scope.getById(members[0]!.id)
      expect(g.status).toBe("found")
      if (g.status === "found") expect(g.hash).toBe(members[0]!.hash)
      expect(snapshotCounts(scope, streamId, caller, 49).knowledge_total).toBe(15)
      expect(listIndex(scope, streamId, { caller }).items).toHaveLength(7)
    }
    // entry 已存在路径：不重建、不覆盖原字节
    expect(statSync(entryPath).ino).toBe(inoBefore)
    const meta = scope.readMeta(streamId)
    expect(meta.agg_pending).toBeNull()
    expect(Object.keys(meta.idem_pending)).toHaveLength(0) // 仅 agg_pending 的恢复（idem 空不提前 return）
    for (const m of members) expect(meta.nav[m.id]!.covered_by).toBe(summaryId)
  })

  // agg-11
  test("失败终态=旧目录完整：invalid 后无摘要、无 covered_by 边", () => {
    const { scope, streamId } = setup()
    const fenced = seedAged(scope, streamId, 1, { createdRound: 48 })
    const aged = seedAged(scope, streamId, 13)
    admitRounds(scope, streamId, 49)
    const before = scope.readMeta(streamId)
    const r = scope.aggregate(streamId, aggArgs([...aged.slice(0, 7).map((m) => m.id), fenced[0]!.id]))
    expect(r.status).toBe("invalid")
    const after = scope.readMeta(streamId)
    expect(after.high_water).toBe(before.high_water)
    expect(coveredEdges(after)).toHaveLength(0)
    expect(after.agg_pending).toBeNull()
    expect(entryCount(scope, streamId)).toBe(14)
  })

  // agg-12
  test("配额三阶段峰值：独立序列化 R/C 交叉断言 peak；quota=peak+1 边界下第二条 quota_exceeded", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 22) // 批A=seq1..8、批B=seq9..16、尾部=seq17..22(recent6)
    admitRounds(scope, streamId, 49)
    const ids = seeded.map((s) => s.id)
    const batchA = ids.slice(0, 8)
    // 独立序列化 R/C（含 agg_pending），与实现的键序/字段逐一同构
    const meta0 = scope.readMeta(streamId)
    const seq = meta0.high_water + 1
    const id = formatBbId(scope.config.scope_id, streamId, seq)
    const members = batchA.map((mid) => ({ id: mid, hash: seeded.find((s) => s.id === mid)!.hash }))
    const summary: BbRecord = {
      schema_version: 1, id, scope_id: scope.config.scope_id, stream_id: streamId, sequence: seq,
      writer: aggWriter(), created_at: new Date().toISOString(), created_round: 49,
      description: "聚合摘要", content: NAV_BODY,
      kind: "index_summary", members, summary_basis: "descriptions",
    }
    const entryBytes = buildRecordBytes(summary)
    const reserveMeta = { ...meta0, high_water: seq, agg_pending: { seq, members, entry_bytes_b64: Buffer.from(entryBytes).toString("base64") } }
    const commitMeta = { ...reserveMeta, agg_pending: null }
    for (const m of members) commitMeta.nav = { ...commitMeta.nav, [m.id]: { ...commitMeta.nav[m.id], covered_by: id } }
    const R = Buffer.byteLength(JSON.stringify(reserveMeta))
    const C = Buffer.byteLength(JSON.stringify(commitMeta))
    const U0 = scope.usageBytes()
    const M0 = statSync(join(scope.dir, "streams", streamId, "metadata.json")).size
    const base = U0 - M0
    const E1 = entryBytes.length
    const peakExpected = Math.max(U0 + R, base + R + E1, base + E1 + R + C)
    const r1 = scope.aggregate(streamId, aggArgs(batchA))
    expect(r1.status).toBe("aggregated")
    if (r1.status !== "aggregated") return
    expect(r1.peak_commit_bytes).toBe(peakExpected)
    // 边界：quota = peak+1 → 第二条合法批次超峰
    scope.updateConfig((cfg) => ({ ...cfg, quota_bytes: r1.peak_commit_bytes + 1 }))
    const highWaterAfterA = scope.readMeta(streamId).high_water
    const r2 = scope.aggregate(streamId, aggArgs(ids.slice(8, 16)))
    expect(r2.status).toBe("quota_exceeded")
    if (r2.status === "quota_exceeded") {
      expect(r2.quota).toBe(r1.peak_commit_bytes + 1)
      expect(r2.used).toBeGreaterThanOrEqual(r2.quota)
    }
    // 既有集合不变
    const meta = scope.readMeta(streamId)
    expect(meta.high_water).toBe(highWaterAfterA)
    expect(coveredEdges(meta)).toHaveLength(8)
    expect(meta.agg_pending).toBeNull()
    expect(entryCount(scope, streamId)).toBe(23)
  })

  // agg-13
  test("顺序重叠批次：恰一个 aggregated、败者 invalid already_covered；members⇄nav 双向一致", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 22)
    admitRounds(scope, streamId, 49)
    const ids = seeded.map((s) => s.id)
    const rA = scope.aggregate(streamId, aggArgs(ids.slice(0, 8)))
    expect(rA.status).toBe("aggregated")
    if (rA.status !== "aggregated") return
    const rB = scope.aggregate(streamId, aggArgs(ids.slice(4, 12))) // 共享 seq5..8 已 covered
    expect(rB.status).toBe("invalid")
    if (rB.status === "invalid") {
      expect(rB.errors).toHaveLength(4)
      expect(rB.errors.every((e) => e.reason === "already_covered")).toBe(true)
    }
    expectMembersNavConsistent(scope, streamId, rA.id)
  })

  // agg-14
  test("摘要字节可验证：recordHash(summaryBytes)===hash；members 不含摘要自身 id", () => {
    const { scope, streamId } = setup()
    const seeded = seedAged(scope, streamId, 14)
    admitRounds(scope, streamId, 49)
    const r = scope.aggregate(streamId, aggArgs(seeded.slice(0, 8).map((m) => m.id)))
    expect(r.status).toBe("aggregated")
    if (r.status !== "aggregated") return
    const bytes = scope.readEntryBytes(streamId, r.sequence)
    expect(bytes).not.toBeNull()
    expect(recordHash(bytes!)).toBe(r.hash)
    const g = scope.getById(r.id)
    expect(g.status).toBe("found")
    if (g.status !== "found") return
    expect((g.record.members ?? []).map((m) => m.id)).not.toContain(r.id)
  })
})
