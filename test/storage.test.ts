// storage-1…17（计划 Task 2 Step 7）。全部 dataDir = 临时目录。
// storage-9/10/13/14 用真实子进程（P11：同进程 Promise.all 不构成并发）。

import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { randomUUID } from "node:crypto"
import {
  openScopeForRoot,
  openScopeById,
  faultHook,
  DEFAULT_QUOTA_BYTES,
  type PutArgs,
  type PutResult,
  type StreamMeta,
  type Scope,
} from "../src/storage"
import { formatBbId, parseBbId } from "../src/ids"
import { encodeImmutablePayload, buildRecordBytes, recordHash, type BbRecord, type PutInput } from "../src/schema"

const REPO = new URL("..", import.meta.url).pathname
const STORAGE_TS = join(REPO, "src/storage.ts")
const LOCKCHECK_TS = join(REPO, "scripts/lockcheck.ts")
const OBSERVE_TS = join(REPO, "scripts/observe.ts")

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bb-storage-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  faultHook.current = null
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

function writer(mid: string): PutArgs["writer"] {
  return { agent: "build", session_id: "s", message_id: mid }
}

let putCount = 0
function putArgs(extra: Partial<PutArgs> = {}): PutArgs {
  putCount++
  return {
    writer: writer(`m${putCount}`),
    createdRound: null,
    description: "测试描述",
    content: "测试正文",
    ...extra,
  }
}

function open(r: string): Scope {
  return openScopeForRoot({ rootSessionId: r, dataDir: tempDir() })
}

function entryFiles(scope: Scope, streamId: string): string[] {
  return readdirSync(join(scope.dir, "streams", streamId, "entries")).filter((n) => !n.startsWith(".tmp-"))
}

function spawnBun(args: string[], code?: string) {
  const proc = Bun.spawn(code ? ["bun", "-e", code] : args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: REPO,
  })
  return {
    proc,
    exited: proc.exited,
    stdout: async () => await new Response(proc.stdout).text(),
    stderr: async () => await new Response(proc.stderr).text(),
  }
}

describe("storage", () => {
  // storage-1
  test("openScopeForRoot 创建 index 映射与 scope 目录；同 root 重开同一 scope_id", () => {
    const dataDir = tempDir()
    const scope = openScopeForRoot({ rootSessionId: "root-1", dataDir })
    const scopeId = scope.config.scope_id
    expect(existsSync(join(scope.dir, "owner-root.json"))).toBe(true)
    const idx = JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8"))
    expect(idx.scopes["root-1"]).toBe(scopeId)
    const again = openScopeForRoot({ rootSessionId: "root-1", dataDir })
    expect(again.config.scope_id).toBe(scopeId)
  })

  // storage-2
  test("不同 root 不同 scope；unknown_scope / unknown_session 错误码", () => {
    const dataDir = tempDir()
    const a = openScopeForRoot({ rootSessionId: "ra", dataDir })
    const b = openScopeForRoot({ rootSessionId: "rb", dataDir })
    expect(a.config.scope_id).not.toBe(b.config.scope_id)
    expect(() => openScopeById("00000000-0000-4000-8000-000000000000", { dataDir })).toThrow(/unknown_scope/)
    a.registerSession("sess-a", "build")
    expect(() => b.resolveSession("sess-a")).toThrow(/unknown_session/)
  })

  // storage-3
  test("keyless put high_water 单调；手工置 5 后下一序号 6（留空号不回退）", () => {
    const scope = open("s3")
    const { streamId } = scope.registerSession("sess3", "build")
    expect(asStored(scope.put(streamId, putArgs())).sequence).toBe(1)
    const meta = scope.readMeta(streamId)
    meta.high_water = 5
    scope.writeMeta(streamId, meta)
    expect(asStored(scope.put(streamId, putArgs())).sequence).toBe(6)
  })

  // storage-4
  test("after_reserve 崩溃：无 entry、nav 无 superseded_by；keyed 重试恢复恰好 1 条并补齐导航", () => {
    const scope = open("s4")
    const { streamId } = scope.registerSession("sess4", "build")
    const id0 = asStored(scope.put(streamId, putArgs())).id
    faultHook.current = () => {
      throw new Error("crash-after-reserve")
    }
    expect(() => scope.put(streamId, putArgs({ idempotencyKey: "k1", supersedes: [id0] }))).toThrow("crash-after-reserve")
    faultHook.current = null
    expect(entryFiles(scope, streamId)).toEqual(["e000001.json"])
    const meta = scope.readMeta(streamId)
    expect(meta.nav[id0]?.superseded_by).toBeUndefined()
    const reservedId = formatBbId(scope.config.scope_id, streamId, meta.high_water)
    const r = asReplay(scope.put(streamId, putArgs({ idempotencyKey: "k1", supersedes: [id0] })))
    expect(r.id).toBe(reservedId)
    expect(entryFiles(scope, streamId).length).toBe(2)
    expect(scope.readMeta(streamId).nav[id0]!.superseded_by).toBe(reservedId)
    expect(asReplay(scope.put(streamId, putArgs({ idempotencyKey: "k1", supersedes: [id0] }))).id).toBe(reservedId)
  })

  // storage-5
  test("after_publish 崩溃：entry 可见但导航缺失；keyed 重试不重复发布；keyless 重试为新消息", () => {
    const scope = open("s5")
    const s1 = scope.registerSession("sess5a", "build")
    const id0 = asStored(scope.put(s1.streamId, putArgs())).id
    faultHook.current = (at) => {
      if (at === "after_publish") throw new Error("crash-after-publish")
    }
    expect(() => scope.put(s1.streamId, putArgs({ idempotencyKey: "k1", supersedes: [id0] }))).toThrow("crash-after-publish")
    faultHook.current = null
    expect(entryFiles(scope, s1.streamId).length).toBe(2)
    expect(scope.readMeta(s1.streamId).nav[id0]?.superseded_by).toBeUndefined()
    const r = asReplay(scope.put(s1.streamId, putArgs({ idempotencyKey: "k1", supersedes: [id0] })))
    expect(entryFiles(scope, s1.streamId).length).toBe(2) // 不重复发布
    expect(scope.readMeta(s1.streamId).nav[id0]!.superseded_by).toBe(r.id)

    // keyless 崩溃后重试：新消息，旧 entry 保留为无导航的合法记录
    const s2 = scope.registerSession("sess5b", "build")
    const id1 = asStored(scope.put(s2.streamId, putArgs())).id
    faultHook.current = (at) => {
      if (at === "after_publish") throw new Error("crash-after-publish")
    }
    expect(() => scope.put(s2.streamId, putArgs({ supersedes: [id1] }))).toThrow("crash-after-publish")
    faultHook.current = null
    expect(scope.readMeta(s2.streamId).nav[id1]?.superseded_by).toBeUndefined()
    const id2 = asStored(scope.put(s2.streamId, putArgs({ supersedes: [id1] }))).id
    expect(id2).not.toBe(id1)
    expect(scope.getById(id1).status).toBe("found")
    expect(scope.readMeta(s2.streamId).nav[id1]!.superseded_by).toBe(id2)
  })

  // storage-6
  test("逻辑 tombstone：getById unavailable 且 entry 文件仍存在（P3）", () => {
    const scope = open("s6")
    const { streamId } = scope.registerSession("sess6", "build")
    const r = asStored(scope.put(streamId, putArgs()))
    expect(scope.getById(r.id).status).toBe("found")
    scope.markTombstone(streamId, r.id, "撤回")
    expect(scope.getById(r.id).status).toBe("unavailable")
    expect(existsSync(join(scope.dir, "streams", streamId, "entries", "e000001.json"))).toBe(true)
  })

  // storage-7
  test("配额：三阶段峰值 + 独立序列化标定 + 手算交叉断言（P17/F1/G1）", () => {
    const dataDir = tempDir()
    const scope = openScopeForRoot({ rootSessionId: "s7", dataDir })
    const mine = scope.registerSession("s7a", "build")
    const other = scope.registerSession("s7b", "build")
    // fixture：他流一条完整记录 + 本流 entries 下非空残留临时文件
    asStored(scope.put(other.streamId, putArgs({ description: "fixture", content: "fixture-content" })))
    writeFileSync(join(scope.dir, "streams", mine.streamId, "entries", ".tmp-residue"), "r".repeat(111))

    const content4096 = "a".repeat(4096)
    const measure = (): { S: number; T: number; E0: number; M0: number } => {
      let S = 0
      let T = 0
      let E0 = 0
      let M0 = 0
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const p = join(d, name)
          const st = statSync(p)
          if (st.isDirectory()) {
            walk(p)
            continue
          }
          if (name.startsWith(".tmp-")) {
            T += st.size
            continue
          }
          const rel = relative(scope.dir, p)
          const parts = rel.split("/")
          if (parts[0] === "streams" && parts[1] === mine.streamId) {
            if (parts[2] === "entries") E0 += st.size
            else if (parts[2] === "metadata.json") M0 += st.size
            else S += st.size
          } else {
            S += st.size
          }
        }
      }
      walk(scope.dir)
      return { S, T, E0, M0 }
    }
    const byteLen = (o: unknown): number => Buffer.byteLength(JSON.stringify(o))
    const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64")
    const inputOf = (supersedes?: string[]): PutInput => ({
      description: "quota",
      content: content4096,
      ...(supersedes ? { supersedes } : {}),
    })
    const fixedWriter = writer("mq") // 与实际 put 相同 writer，保证记录域字节逐域一致
    const recordOf = (seq: number, supersedes: string[] | undefined): BbRecord => ({
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
      ...(supersedes ? { supersedes } : {}),
    })

    // ② 首条事务 oracle（绑定首条前置状态，独立于被测函数）
    const meta1 = scope.readMeta(mine.streamId)
    const pre = measure()
    const rec1 = recordOf(1, undefined)
    const tlv1 = encodeImmutablePayload(inputOf())
    const sha1 = recordHash(tlv1)
    const R1 = byteLen({
      ...meta1,
      high_water: 1,
      idem_pending: { ...meta1.idem_pending, K_a: { seq: 1, payload_b64: b64(tlv1), payload_sha256: sha1, entry_bytes_b64: b64(buildRecordBytes(rec1)) } },
    })
    const C1 = byteLen({
      ...meta1,
      high_water: 1,
      idem: { ...meta1.idem, K_a: { id: rec1.id, payload_b64: b64(tlv1), payload_sha256: sha1 } },
    })
    const E1 = buildRecordBytes(rec1).length
    const P1star = Math.max(pre.S + pre.T + pre.M0 + R1, pre.S + pre.T + R1 + E1, pre.S + pre.T + E1 + R1 + C1)

    // ① 首条 put
    const r1 = asStored(scope.put(mine.streamId, putArgs({ description: "quota", content: content4096, idempotencyKey: "K_a", writer: fixedWriter })))

    // ③ 交叉断言：被测返回值 === 独立 oracle（自标定不能自证，F1）
    expect(E1).toBeGreaterThanOrEqual(4096 + 64)
    expect(r1.peak_commit_bytes).toBe(P1star)

    // ④ quota_bytes = P1* + 1（先改配额——S′ 必须反映第二 put 真实前置状态，含改写后的 scope.json）
    const scopeJsonPath = join(scope.dir, "scope.json")
    const cfg = JSON.parse(readFileSync(scopeJsonPath, "utf8"))
    cfg.quota_bytes = P1star + 1
    writeFileSync(scopeJsonPath, JSON.stringify(cfg))

    // ② 第二事务 oracle（同尺寸 payload、同长度 key K_b、supersedes 导航投影；两字节域不同源）
    const meta2 = scope.readMeta(mine.streamId)
    const post = measure()
    const rec2 = recordOf(2, [r1.id])
    const tlv2 = encodeImmutablePayload(inputOf([r1.id]))
    const sha2 = recordHash(tlv2)
    const R2 = byteLen({
      ...meta2,
      high_water: 2,
      idem_pending: { ...meta2.idem_pending, K_b: { seq: 2, payload_b64: b64(tlv2), payload_sha256: sha2, entry_bytes_b64: b64(buildRecordBytes(rec2)) } },
    })
    const C2 = byteLen({
      ...meta2,
      high_water: 2,
      idem: { ...meta2.idem, K_b: { id: rec2.id, payload_b64: b64(tlv2), payload_sha256: sha2 } },
      idem_pending: meta2.idem_pending,
      nav: { ...meta2.nav, [r1.id]: { ...meta2.nav[r1.id], superseded_by: rec2.id } },
    })
    const E2 = buildRecordBytes(rec2).length
    const P2star = Math.max(post.S + post.T + post.E0 + post.M0 + R2, post.S + post.T + post.E0 + R2 + E2, post.S + post.T + post.E0 + E2 + R2 + C2)
    // 分类互斥与 fixture 归类校验（S′/T′ 严格互斥）
    expect(post.T).toBe(111)
    expect(post.S).toBeGreaterThan(0)
    expect(post.E0).toBe(E1)
    // 对本固定 fixture：P2* > quota_bytes → 第二 put 必越限
    expect(P2star).toBeGreaterThan(P1star + 1)

    // ⑤ 第二 put → quota_exceeded 且文件集合不变
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
    const r2 = scope.put(mine.streamId, putArgs({ description: "quota", content: content4096, supersedes: [r1.id], idempotencyKey: "K_b", writer: fixedWriter }))
    expect(r2).toEqual({ status: "quota_exceeded", used: P2star, quota: P1star + 1 })
    expect(listFiles()).toEqual(before)
  })

  // storage-8
  test("同流 16 个 put：序号连续区间、high_water=16、各自幂等 replay", () => {
    const scope = open("s8")
    const { streamId } = scope.registerSession("sess8", "build")
    const rs: Extract<PutResult, { status: "stored" }>[] = []
    for (let i = 0; i < 16; i++) {
      rs.push(asStored(scope.put(streamId, putArgs({ idempotencyKey: `k${i}` }))))
    }
    expect(rs.map((r) => r.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
    expect(scope.readMeta(streamId).high_water).toBe(16)
    for (let i = 0; i < 16; i++) {
      expect(asReplay(scope.put(streamId, putArgs({ idempotencyKey: `k${i}` }))).id).toBe(rs[i]!.id)
    }
  })

  // storage-9
  test("两个真实子进程同 stream 并发 put：互斥、总数一致、无重复序号（P11）", async () => {
    const dataDir = tempDir()
    const boot = openScopeForRoot({ rootSessionId: "lc-root", dataDir })
    boot.registerSession("lc-session", "lockcheck")
    const a = spawnBun(["bun", "scripts/lockcheck.ts", "put", dataDir, "A"])
    const b = spawnBun(["bun", "scripts/lockcheck.ts", "put", dataDir, "B"])
    const [ra, rb] = await Promise.all([a.exited, b.exited])
    expect(ra).toBe(0)
    expect(rb).toBe(0)
    expect((await a.stderr()).trim()).toBe("")
    expect((await b.stderr()).trim()).toBe("")
    const scope = openScopeForRoot({ rootSessionId: "lc-root", dataDir })
    const { streamId } = scope.resolveSession("lc-session")
    const meta = scope.readMeta(streamId)
    const seqs: number[] = []
    for (let s = 1; s <= meta.high_water; s++) {
      const e = scope.readEntry(streamId, s)
      if (e) seqs.push(e.sequence)
    }
    expect(seqs.length).toBe(100)
    expect(new Set(seqs).size).toBe(100)
    expect(meta.high_water).toBeGreaterThanOrEqual(100)
  }, 60000)

  // storage-10
  test("锁语义（P10）：kill -9 后下一次 withLock 立即成功；持锁存活 → lock_timeout 且不抢占", async () => {
    const dataDir = tempDir()
    const boot = openScopeForRoot({ rootSessionId: "r10", dataDir })
    boot.registerSession("h", "build")
    const holderCode = (heldFile: string): string => `
      const { openScopeForRoot } = await import(${JSON.stringify(STORAGE_TS)});
      const scope = openScopeForRoot({ rootSessionId: "r10", dataDir: ${JSON.stringify(dataDir)} });
      scope.withLock(() => {
        require("node:fs").writeFileSync(${JSON.stringify(heldFile)}, "1");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      });
    `
    const contenderCode = (): string => `
      const { openScopeForRoot } = await import(${JSON.stringify(STORAGE_TS)});
      const scope = openScopeForRoot({ rootSessionId: "r10", dataDir: ${JSON.stringify(dataDir)} });
      const t0 = Date.now();
      try { scope.withLock(() => 1); console.log("acquired " + (Date.now() - t0)); }
      catch (e) { console.log("ERR:" + (e instanceof Error ? e.message : e)); }
    `
    // 场景 1：持锁存活 → 另一子进程等满重试预算抛 lock_timeout，绝不抢占
    const held1 = join(dataDir, "held-1")
    const h1 = spawnBun([], holderCode(held1))
    const dl1 = Date.now() + 10000
    while (!existsSync(held1)) {
      if (Date.now() > dl1) throw new Error("holder never acquired lock")
      await Bun.sleep(5)
    }
    const t0 = Date.now()
    const c1 = spawnBun([], contenderCode())
    await c1.exited
    const out1 = await c1.stdout()
    expect(out1).toContain("ERR:lock_timeout")
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4000) // 250 × 20ms 重试预算
    h1.proc.kill(9)
    await h1.exited
    // 场景 2：kill -9 后内核自动释放 → 下一次 withLock 立即成功（无接管/回收路径）
    const held2 = join(dataDir, "held-2")
    const h2 = spawnBun([], holderCode(held2))
    const dl2 = Date.now() + 10000
    while (!existsSync(held2)) {
      if (Date.now() > dl2) throw new Error("holder2 never acquired lock")
      await Bun.sleep(5)
    }
    h2.proc.kill(9)
    await h2.exited
    const c2 = spawnBun([], contenderCode())
    await c2.exited
    const out2 = await c2.stdout()
    expect(out2).toContain("acquired")
    const ms = Number(out2.trim().split(" ")[1])
    expect(ms).toBeLessThan(1000)
  }, 60000)

  // storage-11
  test("usageBytes() 等于 scope 目录全部文件字节和（P9 口径）", () => {
    const scope = open("s11")
    const s1 = scope.registerSession("sess11", "build")
    scope.put(s1.streamId, putArgs())
    scope.put(s1.streamId, putArgs())
    let sum = 0
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else sum += st.size
      }
    }
    walk(scope.dir)
    expect(scope.usageBytes()).toBe(sum)
  })

  // storage-12
  test("重启归属：close 后新建实例归属不变、session_index 保留、replay 命中、rounds/budget 持久", () => {
    const dataDir = tempDir()
    const scope = openScopeForRoot({ rootSessionId: "r12", dataDir })
    const scopeId = scope.config.scope_id
    const { streamId } = scope.registerSession("sess12", "build")
    const args = putArgs({ idempotencyKey: "k12" })
    const r = asStored(scope.put(streamId, args))
    const meta = scope.readMeta(streamId)
    meta.rounds = { current_round: 7, round_known: true, last_admitted_message_id: "msg-1" }
    meta.budget = { ...meta.budget, round_used: 1 }
    scope.writeMeta(streamId, meta)
    scope.close()
    const again = openScopeForRoot({ rootSessionId: "r12", dataDir })
    expect(again.config.scope_id).toBe(scopeId)
    expect(again.config.session_index["sess12"]!.stream_id).toBe(streamId)
    expect(again.resolveSession("sess12")).toEqual({ scopeId, streamId, isolated: false })
    expect(asReplay(again.put(streamId, args)).id).toBe(r.id)
    const meta2 = again.readMeta(streamId)
    expect(meta2.rounds).toEqual({ current_round: 7, round_known: true, last_admitted_message_id: "msg-1" })
    expect(meta2.budget.round_used).toBe(1)
  })

  // storage-13
  test("根创建竞争：真实子进程 + 冲突报告协议（C1/P11/R4/F2）", async () => {
    const dataDir = tempDir()
    const p = spawnBun(["bun", "scripts/lockcheck.ts", "scope-race-main", dataDir, "sr-root"])
    const rc = await p.exited
    const out = await p.stdout()
    const err = await p.stderr()
    expect(rc).toBe(0)
    expect(out).toContain("scope-race OK")
    expect(err).toBe("")
    // 单 scope
    const idx = JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8"))
    expect(Object.values(idx.scopes).length).toBe(1)
  }, 60000)

  // storage-14
  test("两个子进程对不同新 root 并发打开：两个 scope、index 恰两条映射（C1/P11）", async () => {
    const dataDir = tempDir()
    const mk = (rootId: string): string => `
      const { openScopeForRoot } = await import(${JSON.stringify(STORAGE_TS)});
      const s = openScopeForRoot({ rootSessionId: ${JSON.stringify(rootId)}, dataDir: ${JSON.stringify(dataDir)} });
      console.log(s.config.scope_id);
    `
    const a = spawnBun([], mk("ra"))
    const b = spawnBun([], mk("rb"))
    const [ra, rb] = await Promise.all([a.exited, b.exited])
    expect(ra).toBe(0)
    expect(rb).toBe(0)
    const [oa, ob] = await Promise.all([a.stdout(), b.stdout()])
    const sa = oa.trim().split("\n").pop()!
    const sb = ob.trim().split("\n").pop()!
    expect(sa).not.toBe(sb)
    const idx = JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8"))
    expect(Object.keys(idx.scopes).sort()).toEqual(["ra", "rb"])
    expect(idx.scopes["ra"]).toBe(sa)
    expect(idx.scopes["rb"]).toBe(sb)
    // 互不串写：各 owner-root 归属正确
    const oa1 = JSON.parse(readFileSync(join(dataDir, sa, "owner-root.json"), "utf8"))
    const ob1 = JSON.parse(readFileSync(join(dataDir, sb, "owner-root.json"), "utf8"))
    expect(oa1.rootSessionId).toBe("ra")
    expect(ob1.rootSessionId).toBe("rb")
  }, 60000)

  // storage-15
  test("崩溃恢复：owner-root 存在但 index 未发布 → 重开命中并补发布，不创建第二个 scope（C1）", () => {
    const dataDir = tempDir()
    const scopeId = randomUUID()
    mkdirSync(join(dataDir, scopeId), { recursive: true })
    writeFileSync(
      join(dataDir, scopeId, "owner-root.json"),
      JSON.stringify({ rootSessionId: "r15", created_at: new Date().toISOString() }),
    )
    const scope = openScopeForRoot({ rootSessionId: "r15", dataDir })
    expect(scope.config.scope_id).toBe(scopeId)
    expect(existsSync(join(dataDir, scopeId, "scope.json"))).toBe(true)
    const idx = JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8"))
    expect(idx.scopes["r15"]).toBe(scopeId)
    const again = openScopeForRoot({ rootSessionId: "r15", dataDir })
    expect(again.config.scope_id).toBe(scopeId)
    const scopeDirs = readdirSync(dataDir).filter((n) => statSync(join(dataDir, n)).isDirectory())
    expect(scopeDirs.length).toBe(1)
  })

  // storage-16
  test("observe fsck：2 keyed + 1 keyless 全通过，退出码 0（N1）", async () => {
    const dataDir = tempDir()
    const scope = openScopeForRoot({ rootSessionId: "r16", dataDir })
    const { streamId } = scope.registerSession("sess16", "build")
    asStored(scope.put(streamId, putArgs({ idempotencyKey: "k1", sourceRefs: ["x"] })))
    asStored(scope.put(streamId, putArgs({ idempotencyKey: "k2", kind: "finding" })))
    asStored(scope.put(streamId, putArgs()))
    const p = spawnBun(["bun", OBSERVE_TS, dataDir])
    const rc = await p.exited
    const out = await p.stdout()
    const err = await p.stderr()
    expect(rc).toBe(0)
    expect(out).toContain("entries=3")
    expect(out).toContain("hash_sample=3/3 ok")
    expect(out).not.toContain("FSCK FAIL")
    expect(err).toBe("")
  }, 30000)

  // storage-17
  test("崩溃态可见性四条：keyed/keyless × after_reserve/after_publish（P18/F6）", () => {
    const scope = open("s17")

    // A) keyed + supersedes + after_reserve：未恢复时 nav 无边、无 entry；recover-on-read（fix-1）——
    //    崩溃后不手动 recover，getById 锁内自动恢复并返回 found、导航补齐（storage-17 迁移）
    {
      const { streamId } = scope.registerSession("c1", "build")
      const id0 = asStored(scope.put(streamId, putArgs())).id
      faultHook.current = (at) => {
        if (at === "after_reserve") throw new Error("A-crash")
      }
      expect(() => scope.put(streamId, putArgs({ idempotencyKey: "kA", supersedes: [id0] }))).toThrow("A-crash")
      faultHook.current = null
      const meta = scope.readMeta(streamId)
      expect(meta.nav[id0]?.superseded_by).toBeUndefined()
      expect(entryFiles(scope, streamId).length).toBe(1)
      const crashedId = formatBbId(scope.config.scope_id, streamId, meta.high_water)
      expect(scope.getById(crashedId).status).toBe("found") // 读入口锁内自动恢复
      expect(scope.readMeta(streamId).nav[id0]!.superseded_by).toBe(crashedId)
      expect(entryFiles(scope, streamId).length).toBe(2)
      const r = asReplay(scope.put(streamId, putArgs({ idempotencyKey: "kA", supersedes: [id0] })))
      expect(r.id).toBe(crashedId)
      expect(entryFiles(scope, streamId).length).toBe(2)
      expect(scope.readMeta(streamId).nav[id0]!.superseded_by).toBe(crashedId)
      expect(scope.getById(crashedId).status).toBe("found")
    }
    // B) keyed + after_publish：重试 replay 同 ID 且导航正确（恰一条）
    {
      const { streamId } = scope.registerSession("c2", "build")
      const id0 = asStored(scope.put(streamId, putArgs())).id
      faultHook.current = (at) => {
        if (at === "after_publish") throw new Error("B-crash")
      }
      expect(() => scope.put(streamId, putArgs({ idempotencyKey: "kB", supersedes: [id0] }))).toThrow("B-crash")
      faultHook.current = null
      const r = asReplay(scope.put(streamId, putArgs({ idempotencyKey: "kB", supersedes: [id0] })))
      expect(entryFiles(scope, streamId).length).toBe(2)
      expect(scope.readMeta(streamId).nav[id0]!.superseded_by).toBe(r.id)
    }
    // C) keyless + supersedes + after_reserve：nav 空、无 pending、无 entry、仅空号；重试 = 新消息
    {
      const { streamId } = scope.registerSession("c3", "build")
      const id0 = asStored(scope.put(streamId, putArgs())).id
      faultHook.current = (at) => {
        if (at === "after_reserve") throw new Error("C-crash")
      }
      expect(() => scope.put(streamId, putArgs({ supersedes: [id0] }))).toThrow("C-crash")
      faultHook.current = null
      const meta = scope.readMeta(streamId)
      expect(meta.nav[id0]?.superseded_by).toBeUndefined()
      expect(Object.keys(meta.idem_pending).length).toBe(0)
      expect(entryFiles(scope, streamId).length).toBe(1)
      expect(meta.high_water).toBe(2) // 仅空号
      const r2 = asStored(scope.put(streamId, putArgs({ supersedes: [id0] })))
      expect(r2.sequence).toBe(3) // 新消息新 id，不回退空号
      expect(entryFiles(scope, streamId).length).toBe(2)
    }
    // D) keyless + supersedes + after_publish：nav 目标无边；重试产生新消息、旧 entry 保留为合法记录
    {
      const { streamId } = scope.registerSession("c4", "build")
      const id0 = asStored(scope.put(streamId, putArgs())).id
      faultHook.current = (at) => {
        if (at === "after_publish") throw new Error("D-crash")
      }
      expect(() => scope.put(streamId, putArgs({ supersedes: [id0] }))).toThrow("D-crash")
      faultHook.current = null
      expect(entryFiles(scope, streamId).length).toBe(2)
      expect(scope.readMeta(streamId).nav[id0]?.superseded_by).toBeUndefined()
      const crashedId = formatBbId(scope.config.scope_id, streamId, 2)
      expect(scope.getById(crashedId).status).toBe("found") // 旧 entry 保留为无导航的合法记录
      const r3 = asStored(scope.put(streamId, putArgs({ supersedes: [id0] })))
      expect(r3.sequence).toBe(3)
      expect(entryFiles(scope, streamId).length).toBe(3)
      expect(scope.getById(crashedId).status).toBe("found")
    }
  })
})
