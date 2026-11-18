import { dlopen, FFIType } from "bun:ffi"
import { constants as C, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { acquireLock } from "./lock"

export type HandoffBinding = { taskId: string; taskRoot: string; allowArchive: true; sharedReadersApproved: true }
export type HandoffOrigin = { kind: "session-snapshot"; sessionId: string; messageId: string; agent: string; createdAt: number; completedAt: number; finish: "stop" }
export type HandoffRecord = { origin: HandoffOrigin; observedAt: number; texts: Array<{ ordinal: number; text: string }> }
// Read-only compatibility for already committed metadata and index navigation.
// Historical submitted content is never accepted by archiveHandoff.
type HistoricalSubmittedOrigin = { kind: "submitted-content"; sessionId: string; messageId: string; toolCallId: string; agent: string }
type StoredOrigin = HandoffOrigin | HistoricalSubmittedOrigin
type Part = { ordinal: number; file: string; bytes: number; hash: string }
type Meta = { schema: "bcp.handoff.v1"; taskId: string; origin: StoredOrigin; observedAt: number; algorithm: "sha256-ordered-manifest-v1"; version: string; fullhash: string; bytes: number; parts: Part[] }
const queues = new Map<string, Promise<void>>()
const libc = dlopen("libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  renameat2: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
})
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const component = (s: string) => "id-" + Buffer.from(s, "utf8").toString("hex")
const originKey = (o: StoredOrigin) => component(JSON.stringify([o.kind, o.messageId, o.kind === "submitted-content" ? o.toolCallId : null]))
const validString = (s: unknown): s is string => typeof s === "string" && s.length > 0 && Buffer.from(s).toString("utf8") === s
function safe(path: string, kind: "directory" | "file") {
  const s = lstatSync(path)
  if (s.isSymbolicLink() || (kind === "directory" ? !s.isDirectory() : !s.isFile())) throw new Error("archive_unsafe_path")
}
function ancestors(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("archive_invalid_root")
  for (let p = path;; p = dirname(p)) {
    safe(p, "directory")
    if (p === dirname(p)) break
  }
}
function directory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  safe(path, "directory")
}
function syncDir(path: string) {
  const fd = openSync(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function write(path: string, data: string) {
  const fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, data, "utf8"); fsyncSync(fd) } finally { closeSync(fd) }
}
function read(path: string) {
  safe(path, "file")
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW)
  try { return readFileSync(fd) } finally { closeSync(fd) }
}
function digest(parts: Part[]) { return hash(JSON.stringify(parts)) }
const keys = (o: object, expected: string[]) => Object.keys(o).sort().join(",") === expected.sort().join(",")
function validStoredOrigin(o: StoredOrigin): boolean {
  if (!o || typeof o !== "object" || ![o.sessionId, o.messageId, o.agent].every(validString)) return false
  if (o.kind === "submitted-content") return keys(o, ["kind", "sessionId", "messageId", "toolCallId", "agent"]) && validString(o.toolCallId)
  return o.kind === "session-snapshot" && keys(o, ["kind", "sessionId", "messageId", "agent", "createdAt", "completedAt", "finish"]) &&
    Number.isFinite(o.createdAt) && o.createdAt >= 0 && Number.isFinite(o.completedAt) && o.completedAt >= o.createdAt && o.finish === "stop"
}
const stableOrigin = (o: HandoffOrigin): HandoffOrigin =>
  ({ kind: o.kind, sessionId: o.sessionId, messageId: o.messageId, agent: o.agent, createdAt: o.createdAt, completedAt: o.completedAt, finish: o.finish })
const stableStoredOrigin = (o: StoredOrigin) => o.kind === "submitted-content"
  ? { kind: o.kind, sessionId: o.sessionId, messageId: o.messageId, toolCallId: o.toolCallId, agent: o.agent }
  : { kind: o.kind, sessionId: o.sessionId, messageId: o.messageId, agent: o.agent, createdAt: o.createdAt, completedAt: o.completedAt, finish: o.finish }
function verify(path: string, root: string, taskId: string): Meta | undefined {
  safe(path, "directory")
  if (!existsSync(join(path, "meta.json"))) return
  let m: Meta
  try { m = JSON.parse(read(join(path, "meta.json")).toString("utf8")) } catch { return }
  if (!m || typeof m !== "object" || !keys(m, ["schema", "taskId", "origin", "observedAt", "algorithm", "version", "fullhash", "bytes", "parts"])) return
  if (m.schema !== "bcp.handoff.v1" || m.algorithm !== "sha256-ordered-manifest-v1" || m.taskId !== taskId ||
    !validString(m.taskId) || !validStoredOrigin(m.origin) ||
    !Number.isFinite(m.observedAt) || m.observedAt < 0 || !Array.isArray(m.parts) || !m.parts.length) return
  if (typeof m.version !== "string" || !/^[a-f0-9]{64}$/.test(m.version) || path !== join(root, component(m.origin.sessionId), originKey(m.origin), m.version)) return
  let ordinal = -1
  for (const [i, p] of m.parts.entries()) {
    if (!p || typeof p !== "object" || !keys(p, ["ordinal", "file", "bytes", "hash"]) || !Number.isSafeInteger(p.ordinal) || p.ordinal <= ordinal ||
      p.file !== (m.parts.length === 1 ? "body.txt" : `part-${i + 1}.txt`) || !Number.isSafeInteger(p.bytes) || p.bytes < 0 || !/^[a-f0-9]{64}$/.test(p.hash)) return
    ordinal = p.ordinal
    if (!existsSync(join(path, p.file))) return
    const body = read(join(path, p.file))
    if (body.length !== p.bytes || hash(body) !== p.hash) return
  }
  if (m.fullhash !== digest(m.parts) || m.version !== m.fullhash || m.bytes !== m.parts.reduce((n, p) => n + p.bytes, 0)) return
  if (readdirSync(path).sort().join(",") !== ["meta.json", ...m.parts.map(p => p.file)].sort().join(",")) return
  return m
}
type IndexRow = { schema: "bcp.handoff-index.v1"; origin: StoredOrigin; observedAt: number; version: string; path: string }
const manifestPath = (m: { origin: StoredOrigin; version: string }) => `${component(m.origin.sessionId)}/${originKey(m.origin)}/${m.version}/meta.json`
const indexRow = (m: Pick<Meta, "origin" | "observedAt" | "version">): IndexRow => ({ schema: "bcp.handoff-index.v1", origin: stableStoredOrigin(m.origin), observedAt: m.observedAt, version: m.version, path: manifestPath(m) })
const encodeRow = (row: IndexRow) => JSON.stringify(row)
  .replace(/[<>&`\[\]()\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n"
// Only index bytes are scanned on valid ordinary saves, never historical bodies.
// Unrelated crash-committed omissions may remain until their exact duplicate
// is saved or an invalid/missing index triggers a verified full rebuild.
function membership(index: string): Set<string> | undefined {
  if (!existsSync(index)) return
  const bytes = read(index)
  const text = bytes.toString("utf8")
  if (!Buffer.from(text).equals(bytes) || (text !== "" && !text.endsWith("\n"))) return
  const paths = new Set<string>()
  for (const line of text === "" ? [] : text.slice(0, -1).split("\n")) {
    let row: IndexRow
    try { row = JSON.parse(line) } catch { return }
    if (!row || typeof row !== "object" || !keys(row, ["schema", "origin", "observedAt", "version", "path"]) ||
      row.schema !== "bcp.handoff-index.v1" || !validStoredOrigin(row.origin) ||
      !Number.isFinite(row.observedAt) || row.observedAt < 0 || typeof row.version !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.version) || row.path !== manifestPath(row) ||
      line + "\n" !== encodeRow(indexRow(row)) || paths.has(row.path)) return
    paths.add(row.path)
  }
  return paths
}
function rebuild(root: string, taskId: string, tmp: string) {
  const records: Meta[] = []
  for (const s of readdirSync(root)) {
    if (!/^id-(?:[a-f0-9]{2})+$/.test(s)) continue
    safe(join(root, s), "directory")
    for (const m of readdirSync(join(root, s))) {
      if (!/^id-(?:[a-f0-9]{2})+$/.test(m)) continue
      safe(join(root, s, m), "directory")
      for (const v of readdirSync(join(root, s, m))) {
        if (!/^[a-f0-9]{64}$/.test(v)) continue
        const record = verify(join(root, s, m, v), root, taskId)
        if (record) records.push(record)
      }
    }
  }
   records.sort((a, b) => b.observedAt - a.observedAt || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0))
   const text = records.map(m => encodeRow(indexRow(m))).join("")
   const index = join(root, "index.jsonl")
  if (existsSync(index)) safe(index, "file")
  try { write(tmp, text); renameSync(tmp, index); syncDir(root) } finally { rmSync(tmp, { force: true }) }
}
function updateIndex(root: string, taskId: string, tmp: string, meta: Meta) {
  const index = join(root, "index.jsonl")
  const paths = membership(index)
  if (!paths) { rebuild(root, taskId, tmp); return }
  if (paths.has(manifestPath(meta))) return
  const fd = openSync(index, C.O_WRONLY | C.O_APPEND | C.O_NOFOLLOW)
  try { writeFileSync(fd, encodeRow(indexRow(meta)), "utf8"); fsyncSync(fd) } finally { closeSync(fd) }
}

/** Pure local persistence only. No retention/deletion/backfill or permission service.
 * The trusted caller supplies an authorized taskRoot and source evidence.
 * recheck must revalidate live authorization in-lock.
 * Assumes trusted task-root ownership: checks reject symlinks, not hostile concurrent
 * same-UID directory replacement. fsync is best effort filesystem durability, not a
 * cross-file transaction or power-loss guarantee. */
export async function archiveHandoff(binding: HandoffBinding, record: HandoffRecord, options?: { signal?: AbortSignal; recheck?: () => boolean | Promise<boolean>; authorizeWrites?: (paths: readonly string[]) => void | Promise<void> }): Promise<{ status: "stored" | "duplicate" | "skipped"; reason?: string; path?: string; body?: string; version?: string; indexStale?: true }> {
  const skip = (reason: string) => ({ status: "skipped" as const, reason })
  if (binding?.allowArchive !== true || binding?.sharedReadersApproved !== true) return skip("permission")
  if (options?.signal?.aborted) return skip("cancelled")
  if (!record || !Array.isArray(record.texts) || !record.texts.length || record.texts.some(p => !p || typeof p.text !== "string" || p.text.includes("<!-- bcp:no-store -->"))) return skip("no-store-or-no-text")
  if (!validString(binding.taskId) || record.origin?.kind !== "session-snapshot" || !validStoredOrigin(record.origin) ||
    !Number.isFinite(record.observedAt) || record.observedAt < 0 || record.texts.some((p, i) =>
      !Number.isSafeInteger(p.ordinal) || p.ordinal < 0 || (i > 0 && p.ordinal <= record.texts[i - 1]!.ordinal) || Buffer.from(p.text).toString("utf8") !== p.text)) return skip("invalid")
  // Capture the approved value before yielding to queues or a caller's recheck.
  binding = { ...binding }
  record = { ...record, origin: stableOrigin(record.origin), texts: record.texts.map(p => ({ ...p })) }
  ancestors(binding.taskRoot)
  // Allocate the exact write set before authorization or queueing. These same
  // names are used below; authorization never runs while holding the OS lock.
  const lock = join(binding.taskRoot, ".archive.lock")
  const root = join(binding.taskRoot, "archive")
  const parts = record.texts.map((p, i) => ({ ordinal: p.ordinal, file: record.texts.length === 1 ? "body.txt" : `part-${i + 1}.txt`, bytes: Buffer.byteLength(p.text), hash: hash(p.text) }))
  const version = digest(parts)
  const session = join(root, component(record.origin.sessionId))
  const message = join(session, originKey(record.origin))
  const target = join(message, version)
  const pending = join(message, `.pending-${randomUUID()}`)
  const indexTmp = join(root, `.index-${randomUUID()}`)
  const writes = [
    lock, root, session, message, pending,
    ...parts.map(p => join(pending, p.file)), join(pending, "meta.json"),
    target, ...parts.map(p => join(target, p.file)), join(target, "meta.json"),
     indexTmp, join(root, "index.jsonl"),
  ]
  await options?.authorizeWrites?.(Object.freeze(writes))
  if (options?.signal?.aborted) return skip("cancelled")
  const prior = queues.get(binding.taskRoot) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(r => { release = r })
  queues.set(binding.taskRoot, current)
  await prior
  let fd: number | undefined
  let locked = false
  try {
    ancestors(binding.taskRoot)
    fd = openSync(lock, C.O_RDWR | C.O_CREAT | C.O_NOFOLLOW, 0o600)
    safe(lock, "file")
    await acquireLock(() => libc.symbols.flock(fd!, 2 | 4))
    locked = true
    if (options?.signal?.aborted) return skip("cancelled")
    if (options?.recheck && await options.recheck() !== true) return skip("recheck")
    if (options?.signal?.aborted) return skip("cancelled")
    ancestors(binding.taskRoot)
    // The permanent lock inode also carries the root's persistent task identity.
    // An unbound nonempty legacy archive cannot be safely adopted implicitly.
    const identity = read(lock).toString("utf8")
    const expectedIdentity = JSON.stringify({ schema: "bcp.handoff-root.v1", taskId: binding.taskId }) + "\n"
    if (identity !== "" && identity !== expectedIdentity) throw new Error("archive_task_root_conflict")
    if (identity === "") {
      if (existsSync(root)) {
        safe(root, "directory")
        if (readdirSync(root).length) throw new Error("archive_unbound_existing_root")
      }
      writeFileSync(fd, expectedIdentity, "utf8")
      fsyncSync(fd)
      syncDir(binding.taskRoot)
    }
    directory(root)
    const meta: Meta = { schema: "bcp.handoff.v1", taskId: binding.taskId, origin: record.origin, observedAt: record.observedAt, algorithm: "sha256-ordered-manifest-v1", version, fullhash: version, bytes: parts.reduce((n, p) => n + p.bytes, 0), parts }
    directory(session)
    directory(message)
    // A received occurrence is immutable; different bytes are not a revision.
    // Pending directories are not committed records; every version-shaped
    // directory must validate before it can establish or confirm that identity.
    let persisted = meta
    for (const entry of readdirSync(message)) {
      if (!/^[a-f0-9]{64}$/.test(entry)) {
        if (entry.startsWith(".pending-")) continue
        throw new Error("archive_message_invalid_record")
      }
      const prior = verify(join(message, entry), root, binding.taskId)
      if (!prior) throw new Error("archive_message_invalid_record")
       if (JSON.stringify(stableStoredOrigin(prior.origin)) !== JSON.stringify(meta.origin)) throw new Error("archive_message_identity_conflict")
       if (prior.version !== meta.version) throw new Error("archive_conflict")
       persisted = prior
    }
    let status: "stored" | "duplicate" = "stored"
    let indexStale = false
    if (existsSync(target)) {
      status = "duplicate"
    } else {
      const tmp = pending
      directory(tmp)
      try {
        parts.forEach((p, i) => write(join(tmp, p.file), record.texts[i]!.text))
        write(join(tmp, "meta.json"), JSON.stringify(meta, null, 2) + "\n")
        syncDir(tmp)
        if (options?.signal?.aborted) return skip("cancelled")
        if (options?.recheck && await options.recheck() !== true) return skip("recheck")
        if (options?.signal?.aborted) return skip("cancelled")
        if (libc.symbols.renameat2(-100, Buffer.from(tmp + "\0"), -100, Buffer.from(target + "\0"), 1) !== 0) throw new Error("archive_publish_conflict")
        // The immutable record is already visible; do not report a failed write
        // (and invite an unsafe resubmission) if subsequent durability work fails.
        try { syncDir(message) } catch { indexStale = true }
      } finally { rmSync(tmp, { recursive: true, force: true }) }
    }
    const result = { status, path: join(target, "meta.json"), ...(parts.length === 1 ? { body: join(target, "body.txt") } : {}), version }
    try { updateIndex(root, binding.taskId, indexTmp, persisted) } catch { return { ...result, indexStale: true } }
    return indexStale ? { ...result, indexStale: true } : result
  } finally {
    if (fd !== undefined) { if (locked) libc.symbols.flock(fd, 8); closeSync(fd) }
    release()
    if (queues.get(binding.taskRoot) === current) queues.delete(binding.taskRoot)
  }
}
