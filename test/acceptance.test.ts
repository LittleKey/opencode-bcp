// acc-m0-4…m0-7/m0-9 + acc-m1-1…m1-12（计划 Task 6 Step 3，13 例）。
// 映射 DESIGN §14.1/§14.2 断言；live L1–L8 由 harness live 运行承载（见 harness/acceptance/results.md）。
// M1-4/7/8/9 的聚合端到端、M1-10 covered_by、M1-11 聚合丢关键词场景 gated 第二步（§14.3），本步函数级/基元级不弱化。

import { describe, test, expect, afterEach } from "bun:test"
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { z } from "zod"
import { openScopeForRoot, openScopeById, faultHook, type PutArgs, type PutResult, type Scope } from "../src/storage"
import { formatBbId, parseBbId, entryFileName } from "../src/ids"
import {
  encodeImmutablePayload, buildRecordBytes, recordHash, payloadBytesEqual, type BbRecord, type PutInput,
} from "../src/schema"
import { defineBoardTools, type BoardToolContext } from "../src/tools"
import { classifyEligibility, type EligibilityCtx } from "../src/eligibility"
import { decideAndPersist, newLedger } from "../src/nudge"
import { listIndex } from "../src/indexing"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bb-acc-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  faultHook.current = null
  delete process.env.BLACKBOARD_ISOLATED_AGENTS
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function asStored(r: PutResult): Extract<PutResult, { status: "stored" }> {
  if (r.status !== "stored") throw new Error(`expected stored, got ${JSON.stringify(r)}`)
  return r
}
function asReplay(r: PutResult): Extract<PutResult, { status: "replay" }> {
  if (r.status !== "replay") throw new Error(`expected replay, got ${JSON.stringify(r)}`)
  return r
}
let n = 0
function open(r: string, opts: { quotaBytes?: number } = {}): Scope {
  return openScopeForRoot({ rootSessionId: `${r}-${++n}`, dataDir: tempDir(), quotaBytes: opts.quotaBytes })
}
let putCount = 0
function putArgs(extra: Partial<PutArgs> = {}): PutArgs {
  putCount++
  return {
    writer: { agent: "build", session_id: "acc-sess", message_id: `am${putCount}` },
    createdRound: null,
    description: "验收描述",
    content: "验收正文",
    ...extra,
  }
}
function entryFiles(scope: Scope, streamId: string): string[] {
  return readdirSync(join(scope.dir, "streams", streamId, "entries")).filter((f) => !f.startsWith(".tmp-"))
}
function entryPath(scope: Scope, streamId: string, seq: number): string {
  return join(scope.dir, "streams", streamId, "entries", entryFileName(seq))
}
function recordOf(scope: Scope, streamId: string, id: string): BbRecord {
  const rec = scope.readEntry(streamId, parseBbId(id).seq)
  if (!rec) throw new Error(`record missing: ${id}`)
  return rec
}
const CTX: BoardToolContext = { sessionID: "acc-sess", agent: "build", messageID: "am-tool" }

function toolsFor(scope: Scope, streamId: string, log: Record<string, unknown>[] = []) {
  return defineBoardTools({
    resolveScope: async () => ({ scope, streamId, isolated: false }),
    log: (l) => log.push(l),
  })
}

describe("acceptance", () => {
  // acc-m0-4（M0-4：并发与双写、重试幂等、parent 不能伪装 child——writer 无工具面字段）
  test("同流 16 并发 put 序号唯一 + 幂等重试同 ID + board.put zod args 无 writer 字段", async () => {
    const scope = open("m0-4")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const rs = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        scope.put(streamId, putArgs({ description: `c${i}`, idempotencyKey: `k${i}` })),
      ),
    )
    const stored = rs.map(asStored)
    expect(new Set(stored.map((r) => r.sequence))).toEqual(new Set(Array.from({ length: 16 }, (_, i) => i + 1)))
    expect(scope.readMeta(streamId).high_water).toBe(16)
    const replay = asReplay(scope.put(streamId, putArgs({ description: "c7", idempotencyKey: "k7" })))
    expect(replay.id).toBe(stored[7]!.id)

    const log: Record<string, unknown>[] = []
    const tools = toolsFor(scope, streamId, log)
    const shape = (tools.board_put.args as z.ZodObject<z.ZodRawShape>).shape
    const keys = Object.keys(shape)
    expect(keys).toContain("description")
    expect(keys).toContain("content")
    for (const w of ["writer", "agent", "session_id", "message_id"]) expect(keys).not.toContain(w)
  })

  // acc-m0-7（M0-7：预算身份丢失跨多个请求时轮内提醒 ≤2 且不误报机会保证已履行）
  test("round_used=2 后身份不可恢复 → 连续 3 新请求 identity_unrecoverable、0 注入", () => {
    const scope = open("m0-7")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      rounds: { current_round: 3, round_known: true, last_admitted_message_id: "adm0" },
      budget: { ...newLedger(), round_id: "adm0", round_known: true, round_used: 2, initial_fulfilled: true },
    })
    for (let i = 1; i <= 3; i++) {
      const d = decideAndPersist(scope, streamId, {
        sessionId: "acc-sess",
        requestId: `req-${i}`,
        requestVerified: false,
        snapshotVersion: `v-${i}`,
        candidateSetId: null,
        maxSeq: 0,
      })
      expect(d).toEqual({ inject: false, reason: "identity_unrecoverable" })
    }
    const after = scope.readMeta(streamId)
    expect(after.budget.round_used).toBe(2) // 预算不重置
    expect(after.budget.round_known).toBe(false)
    expect(after.rounds.round_known).toBe(false)
  })

  // acc-m0-9（M0-9：隔离泄漏被拒绝且不泄漏存在性——引用/读取与不存在记录逐字节同文案）
  test("隔离流记录：related 引用 → unknown_ref、get → not_found，与不存在记录输出逐字节一致", async () => {
    const scope = open("m0-9")
    const mine = scope.registerSession("acc-sess", "build")
    process.env.BLACKBOARD_ISOLATED_AGENTS = "councillor"
    const iso = scope.registerSession("c-sess", "councillor")
    const log: Record<string, unknown>[] = []
    const tools = toolsFor(scope, mine.streamId, log)

    const isoId = formatBbId(scope.config.scope_id, iso.streamId, 1)
    const ghostId = formatBbId(scope.config.scope_id, mine.streamId, 999)
    const mask = (s: string): string => s.replaceAll(isoId, "X").replaceAll(ghostId, "X")

    const refIso = await tools.board_put.execute(CTX, { description: "d", content: "c", related: [isoId] })
    const refGhost = await tools.board_put.execute(CTX, { description: "d", content: "c", related: [ghostId] })
    expect(mask(refIso)).toBe(mask(refGhost))
    expect(refIso).toBe(`rejected: unknown_ref ${isoId}`)

    const getIso = await tools.board_get.execute(CTX, { ids: [isoId] })
    const getGhost = await tools.board_get.execute(CTX, { ids: [ghostId] })
    expect(mask(getIso)).toBe(mask(getGhost))
    expect(getIso).toContain('"not_found"')
    expect(log.filter((l) => l.ev === "stored")).toEqual([])
  })

  // acc-m1-1（M1-1：四变体整条创建失败；无半条记录、无 stored 宣称）
  test("description 缺失/空白/\\r\\n/81 码点 → rejected 且 entries 文件数不变、无 stored", async () => {
    const scope = open("m1-1")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const log: Record<string, unknown>[] = []
    const tools = toolsFor(scope, streamId, log)
    const before = entryFiles(scope, streamId).length

    await expect(tools.board_put.execute(CTX, { content: "c" })).rejects.toThrow() // zod 必填缺失（宿主层拒收）
    expect(await tools.board_put.execute(CTX, { description: "", content: "c" })).toBe("rejected: description_blank")
    expect(await tools.board_put.execute(CTX, { description: "a\r\nb", content: "c" })).toBe("rejected: description_newline")
    expect(await tools.board_put.execute(CTX, { description: "a".repeat(81), content: "c" })).toBe("rejected: description_too_long")

    expect(entryFiles(scope, streamId).length).toBe(before)
    expect(log.filter((l) => l.ev === "stored")).toEqual([])
  })

  // acc-m1-2（M1-2：旧 ID 字节不变、工具面仅三键——无 append/edit 面）
  test("写入后旧 id 文件字节与 hash 不变；defineBoardTools 键集合恰为三工具", async () => {
    const scope = open("m1-2")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const a = asStored(scope.put(streamId, putArgs({ description: "A" })))
    const rawA = readFileSync(entryPath(scope, streamId, a.sequence))
    const hashA = recordHash(new Uint8Array(rawA))

    const log: Record<string, unknown>[] = []
    const tools = toolsFor(scope, streamId, log)
    await tools.board_get.execute(CTX, { ids: [a.id] })
    scope.put(streamId, putArgs({ description: "C" }))

    const rawA2 = readFileSync(entryPath(scope, streamId, a.sequence))
    expect(Buffer.from(rawA2).equals(rawA)).toBe(true)
    expect(recordHash(new Uint8Array(rawA2))).toBe(hashA)
    expect(scope.getById(a.id)).toMatchObject({ status: "found", hash: hashA })
    expect(Object.keys(defineBoardTools({ resolveScope: async () => null, log: () => {} })).sort()).toEqual(
      ["board_get", "board_index", "board_put"],
    )
  })

  // acc-m1-3（M1-3：幂等域矩阵 + 崩溃重试 replay + fsck 两域独立核对）
  test("7 字段差异/数组顺序/缺省 vs 空数组 → conflict；崩溃重试 replay 同 ID；两域核对通过", async () => {
    const scope = open("m1-3")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const h1 = asStored(scope.put(streamId, putArgs({ description: "h1" })))
    const h2 = asStored(scope.put(streamId, putArgs({ description: "h2" })))
    let k = 0
    const attempt = (first: Partial<PutArgs>, second: Partial<PutArgs>): PutResult => {
      const key = `K${++k}`
      asStored(scope.put(streamId, putArgs({ idempotencyKey: key, ...first })))
      return scope.put(streamId, putArgs({ idempotencyKey: key, ...second }))
    }
    // 7 个不可变字段逐字段差异
    expect(attempt({ description: "d1" }, { description: "d2" }).status).toBe("conflict")
    expect(attempt({ content: "c1" }, { content: "c2" }).status).toBe("conflict")
    expect(attempt({ kind: "note" }, { kind: "finding" }).status).toBe("conflict")
    expect(attempt({ sourceRefs: ["a"] }, { sourceRefs: ["a", "b"] }).status).toBe("conflict")
    expect(attempt({ related: ["r1"] }, { related: ["r2"] }).status).toBe("conflict")
    expect(attempt({ supersedes: [h1.id] }, { supersedes: [h2.id] }).status).toBe("conflict")
    expect(attempt({ publicationFor: "p1" }, { publicationFor: "p2" }).status).toBe("conflict")
    // 数组顺序差异；缺省 vs 显式空数组（幂等域显式编码，字节不同）
    expect(attempt({ sourceRefs: ["a", "b"] }, { sourceRefs: ["b", "a"] }).status).toBe("conflict")
    expect(attempt({}, { related: [] }).status).toBe("conflict")

    // 崩溃重试（P6/storage-4 同路径）：after_reserve 故障 → 同 key 重试 → replay 同 ID
    const crashKey = "K_crash"
    faultHook.current = () => {
      throw new Error("acc-crash")
    }
    expect(() => scope.put(streamId, putArgs({ description: "crash", idempotencyKey: crashKey }))).toThrow("acc-crash")
    faultHook.current = null
    const r1 = asReplay(scope.put(streamId, putArgs({ description: "crash", idempotencyKey: crashKey }))) // 预留已恢复并发布
    expect(asReplay(scope.put(streamId, putArgs({ description: "crash", idempotencyKey: crashKey }))).id).toBe(r1.id)

    // fsck 两域核对（N1）：幂等域 TLV 重算比对 + 记录域 recordHash(文件字节) 独立可算
    const meta = scope.readMeta(streamId)
    const ie = meta.idem[crashKey]!
    const raw = readFileSync(entryPath(scope, streamId, parseBbId(ie.id).seq))
    const rec = JSON.parse(raw.toString()) as BbRecord
    const tlv = encodeImmutablePayload({
      description: rec.description,
      content: rec.content,
      ...(rec.kind !== undefined ? { kind: rec.kind } : {}),
      ...(rec.source_refs !== undefined ? { sourceRefs: rec.source_refs } : {}),
      ...(rec.related !== undefined ? { related: rec.related } : {}),
      ...(rec.supersedes !== undefined ? { supersedes: rec.supersedes } : {}),
      ...(rec.publication_for !== undefined ? { publicationFor: rec.publication_for } : {}),
    } satisfies PutInput)
    expect(payloadBytesEqual(Buffer.from(ie.payload_b64, "base64"), tlv)).toBe(true)
    expect(ie.payload_sha256).toBe(recordHash(tlv))
    expect(Buffer.from(buildRecordBytes(rec)).equals(raw)).toBe(true)
    expect(recordHash(new Uint8Array(raw))).toBe(recordHash(buildRecordBytes(rec)))
  })

  // acc-m1-4/8/9 组合（本步函数级/基元级载体；聚合端到端 gated §14.3）
  test("资格分布恰 3 eligible（含 P7 superseded）；after_reserve 重试恰 1 条 entry；16 并发序号唯一", () => {
    const scope = open("m1-4")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const put = (createdRound: number | null, extra: Partial<PutArgs> = {}) =>
      asStored(scope.put(streamId, putArgs({ createdRound, ...extra })))
    const supersededTarget = put(1, { description: "旧" }) // seq1：P7 superseded → eligible
    put(9, { description: "fence1", supersedes: [supersededTarget.id] }) // seq2 fence
    put(8, { description: "fence2" }) // seq3 fence
    const pinnedRec = put(1, { description: "pin" }) // seq4 pinned
    const recentRec = put(1, { description: "recent" }) // seq5 recent
    const coveredRec = put(1, { description: "covered" }) // seq6 covered
    put(1, { description: "normal1" }) // seq7 eligible
    put(1, { description: "normal2" }) // seq8 eligible

    const cfgJsonPath = join(scope.dir, "scope.json")
    const cfgJson = JSON.parse(readFileSync(cfgJsonPath, "utf8")) as { pins: string[] }
    cfgJson.pins.push(pinnedRec.id)
    writeFileSync(cfgJsonPath, JSON.stringify(cfgJson))
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, {
      ...meta,
      nav: { ...meta.nav, [coveredRec.id]: { ...(meta.nav[coveredRec.id] ?? {}), covered_by: "bb://agg/future" } },
    })

    const ctx: EligibilityCtx = {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 10,
      recentIds: [recentRec.id], // 函数级：elig-* 同款受控 recent 集（M1-4 本步载体）
      callerSessionId: "acc-sess",
      callerAgent: "build",
    }
    const dist: Record<string, number> = {}
    for (let seq = 1; seq <= 8; seq++) {
      const rec = scope.readEntry(streamId, seq)
      if (!rec) throw new Error(`missing seq ${seq}`)
      const cls = classifyEligibility(rec, ctx)
      dist[`${cls.status}:${cls.reason}`] = (dist[`${cls.status}:${cls.reason}`] ?? 0) + 1
    }
    expect(dist).toEqual({
      "eligible:formula_pass": 3, // 2 普通 + 1 superseded（P7）
      "protected:fence": 2,
      "protected:pinned": 1,
      "protected:recent": 1,
      "protected:already_covered": 1,
    })

    // M1-8 基元级：after_reserve 崩溃 → 重试恢复恰好 1 条 entry
    const s2 = scope.registerSession("acc-sess-2", "build")
    faultHook.current = () => {
      throw new Error("acc-m1-8")
    }
    expect(() => scope.put(s2.streamId, putArgs({ idempotencyKey: "kk" }))).toThrow("acc-m1-8")
    faultHook.current = null
    expect(entryFiles(scope, s2.streamId)).toEqual([]) // 崩溃后无 entry
    asReplay(scope.put(s2.streamId, putArgs({ idempotencyKey: "kk" })))
    expect(entryFiles(scope, s2.streamId)).toEqual(["e000001.json"]) // 恢复恰好 1 条

    // M1-9 基元级：16 并发序号唯一
    const s3 = scope.registerSession("acc-sess-3", "build")
    const rs = Promise.all(
      Array.from({ length: 16 }, (_, i) => scope.put(s3.streamId, putArgs({ description: `p${i}`, idempotencyKey: `pk${i}` }))),
    )
    return rs.then((all) => {
      expect(new Set(all.map((r) => asStored(r).sequence)).size).toBe(16)
    })
  })

  // acc-m1-5（M1-5：round 未知/重启后不可恢复 → 不按旧记录对待；保护保留）
  test("round_known=false → created_round=null + unknown；close 重开后 round_known 仍 false", () => {
    const scope = open("m1-5")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const r = asStored(scope.put(streamId, putArgs({ description: "unknown-round" })))
    const rec = recordOf(scope, streamId, r.id)
    expect(rec.created_round).toBeNull()
    const ctx: EligibilityCtx = {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 5,
      recentIds: [],
      callerSessionId: "acc-sess",
      callerAgent: "build",
    }
    expect(classifyEligibility(rec, ctx)).toEqual({ status: "unknown", reason: "round_unknown" })

    scope.close()
    const reopened = openScopeById(scope.config.scope_id, { dataDir: scope.rootDir }) // 同 scope，验证持久化
    dirs.push(reopened.dir)
    expect(reopened.readMeta(streamId).rounds.round_known).toBe(false)
    expect(reopened.getById(r.id)).toMatchObject({ status: "found", record: { created_round: null } })
  })

  // acc-m1-6（M1-6：按实际发布时间轮次保护，不立即被聚合）
  test("created_round=当前轮 → protected（fence）", () => {
    const scope = open("m1-6")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const meta = scope.readMeta(streamId)
    scope.writeMeta(streamId, { ...meta, rounds: { ...meta.rounds, round_known: true, current_round: 7, last_admitted_message_id: "m6" } })
    const r = asStored(scope.put(streamId, putArgs({ createdRound: 7, description: "当轮补写" })))
    expect(recordOf(scope, streamId, r.id).created_round).toBe(7)
    const cls = classifyEligibility(recordOf(scope, streamId, r.id), {
      cfg: scope.config,
      meta: scope.readMeta(streamId),
      currentRound: 7,
      recentIds: [],
      callerSessionId: "acc-sess",
      callerAgent: "build",
    })
    expect(cls).toEqual({ status: "protected", reason: "fence" })
  })

  // acc-m1-7（M1-7 第一步：原记录/原 description/工件引用仍可按旧 ID/hash 取回）
  test("写 A、B 后 get(A)/put(C) → getById(A) 原文与 hash 不变", async () => {
    const scope = open("m1-7")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const a = asStored(scope.put(streamId, putArgs({ description: "关键证据", content: "evidence-body" })))
    const rawA = readFileSync(entryPath(scope, streamId, a.sequence))
    scope.put(streamId, putArgs({ description: "B" }))
    const log: Record<string, unknown>[] = []
    const tools = toolsFor(scope, streamId, log)
    await tools.board_get.execute(CTX, { ids: [a.id] })
    scope.put(streamId, putArgs({ description: "C" }))
    const g = scope.getById(a.id)
    expect(g.status).toBe("found")
    if (g.status !== "found") throw new Error("unreachable")
    expect(g.record.description).toBe("关键证据")
    expect(g.record.content).toBe("evidence-body")
    expect(g.hash).toBe(recordHash(new Uint8Array(rawA)))
    expect(Buffer.from(readFileSync(entryPath(scope, streamId, a.sequence))).equals(rawA)).toBe(true)
  })

  // acc-m1-10（M1-10 第一步：删除是显式 unavailable；ID 不变不重定向）
  test("markTombstone → getById unavailable、entry 文件仍在、compact 不列、all 列 tombstoned:true", () => {
    const scope = open("m1-10")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const a = asStored(scope.put(streamId, putArgs({ description: "目标" })))
    scope.put(streamId, putArgs({ description: "其余" }))
    scope.markTombstone(streamId, a.id, "撤回")
    expect(scope.getById(a.id).status).toBe("unavailable")
    expect(existsSync(entryPath(scope, streamId, a.sequence))).toBe(true)
    const caller = { sessionId: "acc-sess", agent: "build" }
    expect(listIndex(scope, streamId, { view: "compact", caller }).items.map((i) => i.id)).not.toContain(a.id)
    const all = listIndex(scope, streamId, { view: "all", caller }).items
    const item = all.find((i) => i.id === a.id)
    expect(item?.tombstoned).toBe(true) // ID 不变，仅标注
  })

  // acc-m1-11（M1-11 第一步等价断言：无聚合 → 原描述即唯一检索面）
  test("两条近似描述 → keyword 各自恰命中原记录", () => {
    const scope = open("m1-11")
    const { streamId } = scope.registerSession("acc-sess", "build")
    const r1 = asStored(scope.put(streamId, putArgs({ description: "部署计划 v1 细节" })))
    const r2 = asStored(scope.put(streamId, putArgs({ description: "部署计划 v2 细节" })))
    const caller = { sessionId: "acc-sess", agent: "build" }
    expect(listIndex(scope, streamId, { keyword: "v1", caller }).items.map((i) => i.id)).toEqual([r1.id])
    expect(listIndex(scope, streamId, { keyword: "v2", caller }).items.map((i) => i.id)).toEqual([r2.id])
  })

  // acc-m1-12（M1-12/P17/F1/G1：三阶段峰值 + R/C 分列独立序列化标定 + 手算交叉断言）
  test("quota 标定：peak_commit_bytes===P1*；P2* > P1*+1 → quota_exceeded；文件集不变", () => {
    const scope = open("m1-12", { quotaBytes: Number.MAX_SAFE_INTEGER })
    const mine = scope.registerSession("acc-sess", "build")
    const other = scope.registerSession("acc-sess-other", "build")
    asStored(scope.put(other.streamId, putArgs({ description: "fixture", content: "fixture-content" })))
    writeFileSync(join(scope.dir, "streams", mine.streamId, "entries", ".tmp-residue"), "r".repeat(111))

    const content4096 = "a".repeat(4096)
    const measure = (): { S: number; T: number; E0: number; M0: number } => {
      let S = 0, T = 0, E0 = 0, M0 = 0
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const p = join(d, name)
          const st = statSync(p)
          if (st.isDirectory()) { walk(p); continue }
          if (name.startsWith(".tmp-")) { T += st.size; continue }
          const parts = relative(scope.dir, p).split("/")
          if (parts[0] === "streams" && parts[1] === mine.streamId) {
            if (parts[2] === "entries") E0 += st.size
            else if (parts[2] === "metadata.json") M0 += st.size
            else S += st.size
          } else S += st.size
        }
      }
      walk(scope.dir)
      return { S, T, E0, M0 }
    }
    const byteLen = (o: unknown): number => Buffer.byteLength(JSON.stringify(o))
    const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64")
    const fixedWriter = { agent: "build", session_id: "acc-sess", message_id: "am-m1-12" }
    const inputOf = (): PutInput => ({ description: "quota", content: content4096 })
    const recordOf = (seq: number): BbRecord => ({
      schema_version: 1,
      id: formatBbId(scope.config.scope_id, mine.streamId, seq),
      scope_id: scope.config.scope_id,
      stream_id: mine.streamId,
      sequence: seq,
      writer: fixedWriter,
      created_at: new Date().toISOString(),
      created_round: null,
      description: "quota",
      content: content4096,
    })

    // 首条事务 oracle P1*（绑定首条前置状态，独立于被测函数）
    const meta1 = scope.readMeta(mine.streamId)
    const pre = measure()
    const rec1 = recordOf(1)
    const tlv1 = encodeImmutablePayload(inputOf())
    const sha1 = recordHash(tlv1)
    const R1 = byteLen({ ...meta1, high_water: 1, idem_pending: { ...meta1.idem_pending, K_a: { seq: 1, payload_b64: b64(tlv1), payload_sha256: sha1, entry_bytes_b64: b64(buildRecordBytes(rec1)) } } })
    const C1 = byteLen({ ...meta1, high_water: 1, idem: { ...meta1.idem, K_a: { id: rec1.id, payload_b64: b64(tlv1), payload_sha256: sha1 } } })
    const E1 = buildRecordBytes(rec1).length
    const P1star = Math.max(pre.S + pre.T + pre.M0 + R1, pre.S + pre.T + R1 + E1, pre.S + pre.T + E1 + R1 + C1)

    const r1 = asStored(scope.put(mine.streamId, putArgs({ description: "quota", content: content4096, idempotencyKey: "K_a", writer: fixedWriter })))
    expect(E1).toBeGreaterThanOrEqual(4096 + 64)
    expect(r1.peak_commit_bytes).toBe(P1star)

    // quota = P1* + 1（先改配额，S′ 反映含 scope.json 改写的真实前置）
    const cfgPath = join(scope.dir, "scope.json")
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { quota_bytes: number }
    cfg.quota_bytes = P1star + 1
    writeFileSync(cfgPath, JSON.stringify(cfg))

    // 第二事务 oracle P2*（新 key、无导航投影；前置已变：+1 entry、metadata 更新、K_a 已入 idem）
    const meta2 = scope.readMeta(mine.streamId)
    const post = measure()
    const rec2 = recordOf(2)
    const tlv2 = encodeImmutablePayload(inputOf())
    const sha2 = recordHash(tlv2)
    const R2 = byteLen({ ...meta2, high_water: 2, idem_pending: { ...meta2.idem_pending, K_b: { seq: 2, payload_b64: b64(tlv2), payload_sha256: sha2, entry_bytes_b64: b64(buildRecordBytes(rec2)) } } })
    const C2 = byteLen({ ...meta2, high_water: 2, idem: { ...meta2.idem, K_b: { id: rec2.id, payload_b64: b64(tlv2), payload_sha256: sha2 } } })
    const E2 = buildRecordBytes(rec2).length
    const P2star = Math.max(post.S + post.T + post.E0 + post.M0 + R2, post.S + post.T + post.E0 + R2 + E2, post.S + post.T + post.E0 + E2 + R2 + C2)
    expect(post.T).toBe(111) // S′/T′ 互斥且残留计入 T′
    expect(post.S).toBeGreaterThan(0)
    expect(post.E0).toBe(E1)
    expect(P2star).toBeGreaterThan(P1star + 1)

    const listFiles = (): string[] => {
      const out: string[] = []
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const p = join(d, name)
          if (statSync(p).isDirectory()) walk(p)
          else out.push(relative(scope.dir, p))
        }
      }
      walk(scope.dir)
      return out.sort()
    }
    const before = listFiles()
    expect(scope.put(mine.streamId, putArgs({ description: "quota", content: content4096, idempotencyKey: "K_b", writer: fixedWriter }))).toEqual({
      status: "quota_exceeded", used: P2star, quota: P1star + 1,
    })
    expect(listFiles()).toEqual(before) // 拒绝路径无任何删除
    expect(scope.getById(r1.id).status).toBe("found")
  })
})
