// Phase B 存储层（计划 Task 2 Step 4；DESIGN §3/§5/§6）。
// 并发模型：单一事务 put（reserve → publish → commit），全程内核 flock（bun:ffi，P10）。
// 同主机假设：内核 flock 只保护同一主机的并发进程（DESIGN §13.1 A4）。

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname, relative } from "node:path"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  openSync,
  closeSync,
} from "node:fs"
import { dlopen, FFIType } from "bun:ffi"
import {
  encodeImmutablePayload,
  payloadBytesEqual,
  buildRecordBytes,
  recordHash,
  type BbRecord,
  type PutInput,
  type RecordKind,
  type Writer,
} from "./schema"
import { entryFileName, formatBbId, parseBbId, parseEntryFileName } from "./ids"
import { isIsolatedAgent } from "./permissions"

export const DEFAULT_QUOTA_BYTES = 536870912 // 512 MiB
export const LOCK_RETRY_MS = 20
export const LOCK_RETRY_MAX = 250 // 锁为内核 flock，无陈旧回收常量（P10）

export type ScopeConfig = {
  scope_id: string
  created_at: string
  session_index: Record<string, { stream_id: string; agent: string; isolated: boolean }>
  quota_bytes: number
  pins: string[]
}

export type BudgetLedger = {
  round_id: string | null
  round_known: boolean
  round_used: number
  seen_requests: string[]
  snapshot_version: string | null
  prompted_set_hashes: string[]
  initial_fulfilled: boolean
  last_shown_seq: number
}

export type StreamMeta = {
  stream_id: string
  session_ids: string[]
  high_water: number
  created_at: string
  nav: Record<string, { superseded_by?: string; covered_by?: string }>
  tombstoned: Record<string, string>
  rounds: { current_round: number; round_known: boolean; last_admitted_message_id: string | null }
  budget: BudgetLedger
  idem: Record<string, { id: string; payload_b64: string; payload_sha256: string }>
  idem_pending: Record<string, {
    seq: number
    payload_b64: string
    payload_sha256: string
    entry_bytes_b64: string
  }>
}

export type PutArgs = {
  writer: Writer
  createdRound: number | null
  kind?: RecordKind
  description: string
  content: string
  sourceRefs?: string[]
  related?: string[]
  supersedes?: string[]
  publicationFor?: string
  idempotencyKey?: string
}

export type PutResult =
  | { status: "stored"; id: string; hash: string; sequence: number; peak_commit_bytes: number }
  | { status: "replay"; id: string; hash: string }
  | { status: "conflict"; existingId: string }
  | { status: "quota_exceeded"; used: number; quota: number }

export type FaultPoint = "after_reserve" | "after_publish"
/** 测试故障注入点（仅测试使用）。ESM 导入绑定不可再赋值，故以 holder 对象导出：`faultHook.current = fn` */
export const faultHook: { current: ((at: FaultPoint) => void) | null } = { current: null }

export function bbV1Root(): string {
  return join(homedir(), ".cache/opencode/blackboard/v1")
}

// ---- 内核 flock（bun:ffi dlopen libc；P10：进程死亡自动释放，无接管/回收路径） ----

const LOCK_EX = 2
const LOCK_UN = 1
const LOCK_NB = 4

let flockFn: ((fd: number, op: number) => number) | null | undefined
function getFlock(): ((fd: number, op: number) => number) | null {
  if (flockFn !== undefined) return flockFn
  try {
    const lib = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    flockFn = lib.symbols.flock
  } catch {
    flockFn = null
  }
  return flockFn
}

/** 进程内可重入计数（跨实例，按锁文件路径）：同进程嵌套直接执行，避免自锁 */
const heldLocks = new Map<string, number>()

function withFileLock<T>(lockPath: string, fn: () => T): T {
  const depth = heldLocks.get(lockPath) ?? 0
  if (depth > 0) {
    heldLocks.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      heldLocks.set(lockPath, depth)
    }
  }
  const flock = getFlock()
  if (!flock) throw new Error("lock_unavailable: kernel flock unavailable via bun:ffi/libc")
  const fd = openSync(lockPath, "a+")
  try {
    let attempts = 0
    for (;;) {
      if (flock(fd, LOCK_EX | LOCK_NB) === 0) break
      attempts++
      if (attempts >= LOCK_RETRY_MAX) throw new Error(`lock_timeout: ${lockPath}`)
      Bun.sleepSync(LOCK_RETRY_MS)
    }
    heldLocks.set(lockPath, 1)
    try {
      return fn()
    } finally {
      heldLocks.delete(lockPath)
      flock(fd, LOCK_UN)
    }
  } finally {
    closeSync(fd)
  }
}

// ---- 文件原子性 ----

function atomicWrite(path: string, data: Uint8Array | string): void {
  const tmp = join(dirname(path), `.tmp-${randomUUID()}`)
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

function bytesToB64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64")
}
function b64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"))
}

function newStreamMeta(streamId: string, sessionId: string): StreamMeta {
  return {
    stream_id: streamId,
    session_ids: [sessionId],
    high_water: 0,
    created_at: new Date().toISOString(),
    nav: {},
    tombstoned: {},
    rounds: { current_round: 0, round_known: false, last_admitted_message_id: null },
    budget: {
      round_id: null,
      round_known: false,
      round_used: 0,
      seen_requests: [],
      snapshot_version: null,
      prompted_set_hashes: [],
      initial_fulfilled: false,
      last_shown_seq: 0,
    },
    idem: {},
    idem_pending: {},
  }
}

export class Scope {
  readonly dir: string
  readonly rootDir: string
  readonly scopeId: string

  constructor(dir: string, rootDir: string, scopeId: string) {
    this.dir = dir
    this.rootDir = rootDir
    this.scopeId = scopeId
  }

  get config(): ScopeConfig {
    return JSON.parse(readFileSync(join(this.dir, "scope.json"), "utf8"))
  }

  get lockPath(): string {
    return join(this.dir, ".lock")
  }

  withLock<T>(fn: () => T): T {
    return withFileLock(this.lockPath, fn)
  }

  close(): void {
    // 释放进程内句柄与可重入计数；重开 = 以同 dataDir 新建实例
    heldLocks.delete(this.lockPath)
  }

  private writeConfig(cfg: ScopeConfig): void {
    atomicWrite(join(this.dir, "scope.json"), JSON.stringify(cfg))
  }

  private metaPath(streamId: string): string {
    return join(this.dir, "streams", streamId, "metadata.json")
  }

  private entriesDir(streamId: string): string {
    return join(this.dir, "streams", streamId, "entries")
  }

  private entryPath(streamId: string, seq: number): string {
    return join(this.entriesDir(streamId), entryFileName(seq))
  }

  readMeta(streamId: string): StreamMeta {
    return JSON.parse(readFileSync(this.metaPath(streamId), "utf8"))
  }

  writeMeta(streamId: string, meta: StreamMeta): void {
    atomicWrite(this.metaPath(streamId), JSON.stringify(meta))
  }

  registerSession(sessionId: string, agent: string): { scopeId: string; streamId: string } {
    return this.withLock(() => {
      const cfg = this.config
      const existing = cfg.session_index[sessionId]
      if (existing) return { scopeId: cfg.scope_id, streamId: existing.stream_id }
      const streamId = randomUUID()
      mkdirSync(this.entriesDir(streamId), { recursive: true })
      this.writeMeta(streamId, newStreamMeta(streamId, sessionId))
      cfg.session_index[sessionId] = {
        stream_id: streamId,
        agent,
        isolated: isIsolatedAgent(agent),
      }
      this.writeConfig(cfg)
      return { scopeId: cfg.scope_id, streamId }
    })
  }

  resolveSession(sessionId: string): { scopeId: string; streamId: string; isolated: boolean } {
    const cfg = this.config
    const e = cfg.session_index[sessionId]
    if (!e) throw new Error(`unknown_session: ${sessionId}`)
    return { scopeId: cfg.scope_id, streamId: e.stream_id, isolated: e.isolated }
  }

  readEntry(streamId: string, seq: number): BbRecord | null {
    const p = this.entryPath(streamId, seq)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, "utf8"))
  }

  /**
   * 配额核算的分文件测量（P17/F1）：完整枚举 scope 内全部文件并严格互斥分类。
   * S=与本事务无关文件；E0=本流既有 entries；T=残留 .tmp-*；M0=本流 metadata st_size。
   */
  private measureQuotaParts(streamId: string): { S: number; E0: number; T: number; M0: number } {
    let S = 0
    let E0 = 0
    let T = 0
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
        const rel = relative(this.dir, p)
        const parts = rel.split("/")
        if (parts[0] === "streams" && parts[1] === streamId) {
          if (parts[2] === "entries") E0 += st.size
          else if (parts[2] === "metadata.json") M0 += st.size
          else S += st.size
        } else {
          S += st.size
        }
      }
    }
    walk(this.dir)
    return { S, E0, T, M0 }
  }

  /** usageBytes：scope 目录实际磁盘占用（du 语义：entries + metadata + scope.json + owner-root + 残留临时文件） */
  usageBytes(): number {
    let total = 0
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else total += st.size
      }
    }
    walk(this.dir)
    return total
  }

  /** 单一事务 put（Step 4）：全部步骤在一次 withLock 内、锁内先 recoverPending 并重读最新 meta */
  put(streamId: string, args: PutArgs): PutResult {
    return this.withLock(() => {
      this.recoverPending(streamId)
      const meta = this.readMeta(streamId)
      const input: PutInput = {
        description: args.description,
        content: args.content,
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.sourceRefs !== undefined ? { source_refs: args.sourceRefs } : {}),
        ...(args.related !== undefined ? { related: args.related } : {}),
        ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
        ...(args.publicationFor !== undefined ? { publication_for: args.publicationFor } : {}),
      }
      const tlv = encodeImmutablePayload(input)
      const sha = recordHash(tlv)
      const key = args.idempotencyKey

      // ① 幂等预检：idem/idem_pending 命中 → sha256 快速筛选 → TLV 字节精确相等判定（P15）
      if (key !== undefined) {
        const hit = meta.idem[key] ?? meta.idem_pending[key]
        if (hit) {
          if (sha !== hit.payload_sha256) return { status: "conflict", existingId: hit.id }
          if (!payloadBytesEqual(b64ToBytes(hit.payload_b64), tlv)) {
            return { status: "conflict", existingId: hit.id }
          }
          const { seq } = parseBbId(hit.id)
          const entryBytes = new Uint8Array(readFileSync(this.entryPath(streamId, seq)))
          return { status: "replay", id: hit.id, hash: recordHash(entryBytes) }
        }
      }

      // ② 配额预检（P17/F1/G1）：R/C 两态独立序列化实测字节；三阶段峰值 = max
      const seq = meta.high_water + 1
      const id = formatBbId(this.scopeId, streamId, seq)
      const record: BbRecord = {
        schema_version: 1,
        id,
        scope_id: this.scopeId,
        stream_id: streamId,
        sequence: seq,
        writer: args.writer,
        created_at: new Date().toISOString(),
        created_round: args.createdRound,
        description: args.description,
        content: args.content,
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.sourceRefs !== undefined ? { source_refs: args.sourceRefs } : {}),
        ...(args.related !== undefined ? { related: args.related } : {}),
        ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
        ...(args.publicationFor !== undefined ? { publication_for: args.publicationFor } : {}),
      }
      const entryBytes = buildRecordBytes(record)
      const entryB64 = bytesToB64(entryBytes)

      const reserveMeta: StreamMeta = {
        ...meta,
        high_water: seq,
        ...(key !== undefined
          ? {
              idem_pending: {
                ...meta.idem_pending,
                [key]: { seq, payload_b64: bytesToB64(tlv), payload_sha256: sha, entry_bytes_b64: entryB64 },
              },
            }
          : {}),
      }
      // reserve 态不写 nav（P18：nav 任何时点不指向未发布记录）
      const commitMeta: StreamMeta = { ...reserveMeta }
      if (key !== undefined) {
        commitMeta.idem = { ...commitMeta.idem, [key]: { id, payload_b64: bytesToB64(tlv), payload_sha256: sha } }
        const pend = { ...commitMeta.idem_pending }
        delete pend[key]
        commitMeta.idem_pending = pend
      }
      for (const target of args.supersedes ?? []) {
        commitMeta.nav = { ...commitMeta.nav, [target]: { ...commitMeta.nav[target], superseded_by: id } }
      }
      const R = Buffer.byteLength(JSON.stringify(reserveMeta))
      const C = Buffer.byteLength(JSON.stringify(commitMeta))
      const parts = this.measureQuotaParts(streamId)
      const E1 = entryBytes.length
      const reserve = parts.S + parts.E0 + parts.T + parts.M0 + R
      const publish = parts.S + parts.E0 + parts.T + R + E1
      const commit = parts.S + parts.E0 + parts.T + E1 + R + C
      const peak = Math.max(reserve, publish, commit)
      const quota = this.config.quota_bytes
      if (peak >= quota) return { status: "quota_exceeded", used: peak, quota }

      // ③ reserve：预留序号 + 幂等 pending（一次原子 writeMeta）→ 故障点
      this.writeMeta(streamId, reserveMeta)
      faultHook.current?.("after_reserve")
      // ④ publish：entry 原子落盘（.tmp-* → rename）→ 故障点
      atomicWrite(this.entryPath(streamId, seq), entryBytes)
      faultHook.current?.("after_publish")
      // ⑤ commit：同一次原子 writeMeta 写 idem、删 pending、补 nav 投影
      this.writeMeta(streamId, commitMeta)
      return { status: "stored", id, hash: recordHash(entryBytes), sequence: seq, peak_commit_bytes: peak }
    })
  }

  /** 崩溃恢复（P18/F6）：pending → entry（缺失则从 entry_bytes_b64 重建）→ idem 正式化 → 补齐全量 nav 投影 */
  recoverPending(streamId: string): void {
    this.withLock(() => {
      const metaPath = this.metaPath(streamId)
      if (!existsSync(metaPath)) return
      const meta = this.readMeta(streamId)
      const keys = Object.keys(meta.idem_pending)
      if (keys.length === 0) return
      for (const key of keys) {
        const pend = meta.idem_pending[key]!
        const entryPath = this.entryPath(streamId, pend.seq)
        let entryBytes: Uint8Array
        if (existsSync(entryPath)) {
          entryBytes = new Uint8Array(readFileSync(entryPath))
        } else {
          entryBytes = b64ToBytes(pend.entry_bytes_b64)
          atomicWrite(entryPath, entryBytes)
        }
        const id = formatBbId(this.scopeId, streamId, pend.seq)
        meta.idem[key] = { id, payload_b64: pend.payload_b64, payload_sha256: pend.payload_sha256 }
        delete meta.idem_pending[key]
        const rec = JSON.parse(new TextDecoder().decode(entryBytes)) as BbRecord
        for (const target of rec.supersedes ?? []) {
          meta.nav = { ...meta.nav, [target]: { ...meta.nav[target], superseded_by: id } }
        }
      }
      this.writeMeta(streamId, meta)
    })
  }

  getById(
    bbId: string,
  ): { status: "found"; record: BbRecord; hash: string } | { status: "unavailable" } | { status: "not_found" } {
    let parsed: ReturnType<typeof parseBbId>
    try {
      parsed = parseBbId(bbId)
    } catch {
      return { status: "not_found" }
    }
    if (parsed.scopeId !== this.scopeId) return { status: "not_found" }
    const metaPath = this.metaPath(parsed.streamId)
    if (!existsSync(metaPath)) return { status: "not_found" }
    const entryPath = this.entryPath(parsed.streamId, parsed.seq)
    if (!existsSync(entryPath)) return { status: "not_found" }
    const meta = this.readMeta(parsed.streamId)
    if (meta.tombstoned[bbId] !== undefined) return { status: "unavailable" }
    const bytes = new Uint8Array(readFileSync(entryPath))
    return { status: "found", record: JSON.parse(new TextDecoder().decode(bytes)), hash: recordHash(bytes) }
  }

  /** 仅逻辑 tombstone：写 meta.tombstoned，entry 文件永不删除（P3：无物理删除） */
  markTombstone(streamId: string, bbId: string, reason: string): void {
    this.withLock(() => {
      const meta = this.readMeta(streamId)
      meta.tombstoned[bbId] = `${reason}@${new Date().toISOString()}`
      this.writeMeta(streamId, meta)
    })
  }
}

function writeDefaultScopeConfig(scopeJsonPath: string, scopeId: string, quotaBytes?: number): void {
  const cfg: ScopeConfig = {
    scope_id: scopeId,
    created_at: new Date().toISOString(),
    session_index: {},
    quota_bytes: quotaBytes ?? DEFAULT_QUOTA_BYTES,
    pins: [],
  }
  atomicWrite(scopeJsonPath, JSON.stringify(cfg))
}

/**
 * 按 root 会话归属打开（或创建）scope（C1/P10）：
 * 读取-判定-创建-更新全程持 <root>/scope-index.lock 根级 flock；崩溃恢复：扫描
 * owner-root.json.rootSessionId 匹配但 index 未发布的条目并补发布映射。
 */
export function openScopeForRoot(opts: {
  rootSessionId: string
  dataDir?: string
  quotaBytes?: number
  raceProbe?: { afterIndexMiss: () => void }
}): Scope {
  const root = opts.dataDir ?? bbV1Root()
  mkdirSync(root, { recursive: true })
  return withFileLock(join(root, "scope-index.lock"), () => {
    const indexPath = join(root, "scope-index.json")
    const index: { scopes: Record<string, string> } = existsSync(indexPath)
      ? JSON.parse(readFileSync(indexPath, "utf8"))
      : { scopes: {} }

    // 崩溃恢复（C1）：owner-root.json 存在但 index 未发布 → 补发布
    if (!index.scopes[opts.rootSessionId]) {
      for (const name of readdirSync(root)) {
        const dir = join(root, name)
        if (!statSync(dir).isDirectory()) continue
        const ownerPath = join(dir, "owner-root.json")
        if (!existsSync(ownerPath)) continue
        let owner: { rootSessionId?: string }
        try {
          owner = JSON.parse(readFileSync(ownerPath, "utf8"))
        } catch {
          continue
        }
        if (owner.rootSessionId !== opts.rootSessionId) continue
        const scopeJsonPath = join(dir, "scope.json")
        if (!existsSync(scopeJsonPath)) writeDefaultScopeConfig(scopeJsonPath, name, opts.quotaBytes)
        index.scopes[opts.rootSessionId] = name
        atomicWrite(indexPath, JSON.stringify(index))
        break
      }
    }

    const mapped = index.scopes[opts.rootSessionId]
    if (mapped) return openScopeById(mapped, { dataDir: root })

    // 根锁持有中、index 未命中后的同步测试交错点（父级 F2：Atomics.wait/同步自旋，无 Promise）
    opts.raceProbe?.afterIndexMiss()

    // 创建新 scope：先落盘 owner-root.json（可恢复的 root 身份），再写 scope.json，最后原子写回 index
    const scopeId = randomUUID()
    const dir = join(root, scopeId)
    mkdirSync(dir, { recursive: true })
    atomicWrite(join(dir, "owner-root.json"), JSON.stringify({ rootSessionId: opts.rootSessionId, created_at: new Date().toISOString() }))
    writeDefaultScopeConfig(join(dir, "scope.json"), scopeId, opts.quotaBytes)
    index.scopes[opts.rootSessionId] = scopeId
    atomicWrite(indexPath, JSON.stringify(index))
    return new Scope(dir, root, scopeId)
  })
}

export function openScopeById(scopeId: string, opts?: { dataDir?: string }): Scope {
  const root = opts?.dataDir ?? bbV1Root()
  const dir = join(root, scopeId)
  if (!existsSync(join(dir, "scope.json"))) throw new Error(`unknown_scope: ${scopeId}`)
  return new Scope(dir, root, scopeId)
}
