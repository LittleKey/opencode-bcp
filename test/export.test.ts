// Round 9 §3/§6：board_export —— 逐字节导出、ACL 复用 board_get 路径、限额与原子发布。
import { afterEach, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { openScopeForRoot, type Scope } from "../src/storage"
import { defineBoardTools } from "../src/tools"
import { parseBbId } from "../src/ids"
import { EXPORT_DESCRIPTION } from "../src/constants"
import { BlackboardPlugin } from "../src/plugin"
import type { PluginInput } from "@opencode-ai/plugin"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bcp-exp-")); dirs.push(dir)
  const project = join(dir, "project"); mkdirSync(project)
  const scope = openScopeForRoot({ rootSessionId: "root", dataDir: join(dir, "data") })
  const session = scope.registerSession("s1", "build")
  let registered = true
  const logs: Record<string, unknown>[] = []
  const tools = defineBoardTools({ resolveScope: async () => (registered ? { scope, streamId: session.streamId, isolated: false } : null), log: l => logs.push(l) })
  const put = (content: string) => {
    const r = scope.put(session.streamId, { writer: { agent: "build", session_id: "s1", message_id: "m1" }, createdRound: 1, description: "exported record", content })
    if (r.status !== "stored") throw Error(`put failed: ${JSON.stringify(r)}`)
    const bytes = entryBytes(scope, session.streamId, parseBbId(r.id).seq)
    return { id: r.id, sha256: sha256(bytes), bytes }
  }
  const ctx = (over: Record<string, unknown> = {}) =>
    ({ sessionID: "s1", agent: "build", messageID: "m1", directory: project, ask: async () => {}, ...over }) as never
  const exportRun = (records: { id: string; sha256: string }[], over: Record<string, unknown> = {}) => tools.board_export.execute(ctx(over), { records })
  return { dir, project, scope, session, logs, put, exportRun, setRegistered: (v: boolean) => { registered = v }, tools }
}

function entryBytes(scope: Scope, streamId: string, seq: number): Buffer {
  const name = `e${String(seq).padStart(6, "0")}.json`
  return readFileSync(join(scope.dir, "streams", streamId, "entries", name))
}
const exportsDirOf = (project: string) => join(project, ".opencode", "bcp", "exports")
const listFiles = (project: string) => (existsSync(exportsDirOf(project)) ? readdirSync(exportsDirOf(project)) : [])

test("exports verbatim bytes with lean output; any permitted agent may call; tool is registered", async () => {
  const f = fixture()
  const record = f.put("Answer: 42\nLimits: sample only.")
  const result = JSON.parse(await f.exportRun([{ id: record.id, sha256: `sha256:${record.sha256}` }])) as
    { files: { relpath: string; sha256: string; bytes: number }[]; totalBytes: number }
  const parsed = parseBbId(record.id)
  expect(result.files).toHaveLength(1)
  const file = result.files[0]!
  expect(file.relpath).toBe(`.opencode/bcp/exports/${parsed.scopeId}-${parsed.streamId}-e${String(parsed.seq).padStart(6, "0")}.json`)
  expect(file.sha256).toBe(record.sha256) // 裸 64 位十六进制
  expect(file.bytes).toBe(record.bytes.length)
  expect(result.totalBytes).toBe(record.bytes.length)
  expect(readFileSync(join(f.project, file.relpath)).toString("hex")).toBe(record.bytes.toString("hex")) // 逐字节一致
  expect(JSON.stringify(result)).not.toContain("Answer: 42") // 成功输出不回显正文
  expect((statSync(join(f.project, file.relpath)).mode & 0o777)).toBe(0o600)
  expect((statSync(exportsDirOf(f.project)).mode & 0o777)).toBe(0o700)
  expect(f.logs.some(l => l.ev === "exported")).toBe(true)
  // 无 agent 名单：不同 agent 的已注册会话同样可导出（export 测试 1）。
  const other = JSON.parse(await f.exportRun([{ id: record.id, sha256: `sha256:${record.sha256}` }], { agent: "reviewer" })) as { files: unknown[] }
  expect(other.files).toHaveLength(1)
  const plugin = await BlackboardPlugin({ directory: f.project, client: {} } as unknown as PluginInput, { dataDir: f.dir })
  expect(Object.keys(plugin.tool!)).toContain("board_export")
  expect(plugin.tool!.board_export!.description).toBe(EXPORT_DESCRIPTION)
})

test("argument limits: 1-8 records per call; unknown keys rejected (directory is not an argument)", async () => {
  const f = fixture()
  const record = f.put("content")
  await expect(f.exportRun([])).rejects.toThrow()
  await expect(f.exportRun(Array.from({ length: 9 }, () => ({ id: record.id, sha256: `sha256:${record.sha256}` })))).rejects.toThrow()
  const tools = f.tools.board_export as unknown as { execute: (ctx: unknown, args: unknown) => Promise<string> }
  await expect(tools.execute({ directory: f.project, sessionID: "s1", agent: "build", messageID: "m1", ask: async () => {} } as never,
    { records: [{ id: record.id, sha256: `sha256:${record.sha256}` }], directory: "/tmp/elsewhere" })).rejects.toThrow()
})

test("same id deduplicates; same id with conflicting hashes is an explicit error", async () => {
  const f = fixture()
  const record = f.put("content")
  const result = JSON.parse(await f.exportRun([
    { id: record.id, sha256: `sha256:${record.sha256}` }, { id: record.id, sha256: `sha256:${record.sha256}` },
  ])) as { files: unknown[]; totalBytes: number }
  expect(result.files).toHaveLength(1)
  await expect(f.exportRun([
    { id: record.id, sha256: `sha256:${record.sha256}` }, { id: record.id, sha256: `sha256:${"0".repeat(64)}` },
  ])).resolves.toBe(`rejected: conflicting_hash ${record.id}`)
})

test("ACL reuses the board_get path: unregistered, cross-scope forbidden and hidden are never bypassed", async () => {
  const f = fixture()
  const record = f.put("content")
  f.setRegistered(false)
  await expect(f.exportRun([{ id: record.id, sha256: `sha256:${record.sha256}` }])).resolves.toBe("rejected: unregistered_session")
  f.setRegistered(true)
  const foreign = openScopeForRoot({ rootSessionId: "other-root", dataDir: join(f.dir, "data") })
  const foreignSession = foreign.registerSession("f1", "build")
  const fr = foreign.put(foreignSession.streamId, { writer: { agent: "build", session_id: "f1", message_id: "m1" }, createdRound: 1, description: "foreign", content: "foreign content" })
  if (fr.status !== "stored") throw Error("fixture")
  await expect(f.exportRun([{ id: fr.id, sha256: `sha256:${sha256(entryBytes(foreign, foreignSession.streamId, parseBbId(fr.id).seq))}` }]))
    .resolves.toBe(`rejected: forbidden ${fr.id}`)
  // 同 scope 隔离流（councillor）对普通会话 hidden —— 不可经导出绕过，且不落任何文件。
  const iso = f.scope.registerSession("c1", "councillor-x")
  const ir = f.scope.put(iso.streamId, { writer: { agent: "councillor-x", session_id: "c1", message_id: "m1" }, createdRound: 1, description: "hidden", content: "hidden content" })
  if (ir.status !== "stored") throw Error("fixture")
  await expect(f.exportRun([{ id: ir.id, sha256: `sha256:${sha256(entryBytes(f.scope, iso.streamId, parseBbId(ir.id).seq))}` }]))
    .resolves.toBe(`rejected: not_found ${ir.id}`)
  expect(listFiles(f.project)).toEqual([])
})

test("malformed ids and hashes, hash mismatch and internal id mismatch are explicit failures", async () => {
  const f = fixture()
  const record = f.put("content")
  await expect(f.exportRun([{ id: "not-a-bb-id", sha256: `sha256:${record.sha256}` }])).resolves.toBe("rejected: malformed_id not-a-bb-id")
  await expect(f.exportRun([{ id: record.id, sha256: record.sha256 }])).resolves.toBe(`rejected: malformed_hash ${record.id}`)
  await expect(f.exportRun([{ id: record.id, sha256: `sha256:${"0".repeat(64)}` }])).resolves.toBe(`rejected: hash_mismatch ${record.id}`)
  // 篡改 entry 内部 id 后哈希自洽：内部 ID 一致性拒绝。
  const seq = parseBbId(record.id).seq
  const path = join(f.scope.dir, "streams", f.session.streamId, "entries", `e${String(seq).padStart(6, "0")}.json`)
  const tampered = JSON.parse(readFileSync(path, "utf8")) as { id: string }
  const other = parseBbId(record.id)
  tampered.id = `bb://${other.scopeId}/${other.streamId}/e${String(seq + 5).padStart(6, "0")}`
  writeFileSync(path, JSON.stringify(tampered))
  const tBytes = readFileSync(path)
  await expect(f.exportRun([{ id: record.id, sha256: `sha256:${sha256(tBytes)}` }])).resolves.toBe(`rejected: record_id_mismatch ${record.id}`)
  expect(listFiles(f.project)).toEqual([])
})

test("oversize single record and cumulative total are rejected before publishing", async () => {
  const f = fixture()
  // 累计：3 条各 ~200KiB（单条 <256KiB 上限）→ 总量超 512KiB。
  const entries = ["x", "y", "z"].map(c => c.repeat(200_000)).map(content => {
    const r = f.scope.put(f.session.streamId, { writer: { agent: "build", session_id: "s1", message_id: "m1" }, createdRound: 1, description: "d", content })
    if (r.status !== "stored") throw Error("fixture")
    return { id: r.id, sha256: `sha256:${sha256(entryBytes(f.scope, f.session.streamId, parseBbId(r.id).seq))}` }
  })
  await expect(f.exportRun(entries)).resolves.toBe("rejected: total_oversize")
  expect(listFiles(f.project)).toEqual([])
  // 单条超限：合法 put 受 256KiB 内容上限保护，这里直接构造超 512KiB 的 entry 文件。
  const big = entries[0]!
  const seq = parseBbId(big.id).seq
  const path = join(f.scope.dir, "streams", f.session.streamId, "entries", `e${String(seq).padStart(6, "0")}.json`)
  const huge = JSON.parse(readFileSync(path, "utf8")) as { content: string }
  huge.content = "v".repeat(600 * 1024)
  writeFileSync(path, JSON.stringify(huge))
  const hBytes = readFileSync(path)
  const outcome = await f.exportRun([{ id: big.id, sha256: `sha256:${sha256(hBytes)}` }])
  expect(outcome).toMatch(/^rejected: (record_oversize|unavailable)/)
  expect(listFiles(f.project)).toEqual([])
})

test("symlinks in the .opencode chain are refused; permission denial and mid-batch failure leave no temps", async () => {
  const f = fixture()
  const a = f.put("record a content"), b = f.put("record b content")
  // .opencode 为符号链接 → 拒绝。
  const evil = join(f.dir, "evil"); mkdirSync(evil)
  symlinkSync(evil, join(f.project, ".opencode"))
  await expect(f.exportRun([{ id: a.id, sha256: `sha256:${a.sha256}` }])).resolves.toBe("rejected: unsafe_path")
  rmSync(join(f.project, ".opencode"))
  // exports 为符号链接 → 拒绝。
  mkdirSync(join(f.project, ".opencode", "bcp"), { recursive: true })
  symlinkSync(evil, join(f.project, ".opencode", "bcp", "exports"))
  await expect(f.exportRun([{ id: a.id, sha256: `sha256:${a.sha256}` }])).resolves.toBe("rejected: unsafe_path")
  rmSync(join(f.project, ".opencode"), { recursive: true, force: true })
  // ctx.ask 拒绝 → 不写任何文件。
  await expect(f.exportRun([{ id: a.id, sha256: `sha256:${a.sha256}` }], { ask: async () => { throw Error("denied") } }))
    .resolves.toBe("rejected: export_permission_not_granted")
  expect(listFiles(f.project)).toEqual([])
  // 中途失败：第二条目标同名不同内容 → 第一条已发布文件可留存，且无 .tmp 残留。
  const seqB = parseBbId(b.id).seq
  const nameB = `${parseBbId(b.id).scopeId}-${parseBbId(b.id).streamId}-e${String(seqB).padStart(6, "0")}.json`
  mkdirSync(exportsDirOf(f.project), { recursive: true })
  writeFileSync(join(exportsDirOf(f.project), nameB), "conflicting existing bytes")
  await expect(f.exportRun([{ id: a.id, sha256: `sha256:${a.sha256}` }, { id: b.id, sha256: `sha256:${b.sha256}` }]))
    .resolves.toBe(`rejected: clobber_conflict .opencode/bcp/exports/${nameB}`)
  expect(listFiles(f.project).filter(n => n.startsWith(".tmp-"))).toEqual([])
  expect(listFiles(f.project).sort()).toContain(nameB)
})

test("same-name same-bytes export is reused, never rewritten; special files are not clobbered", async () => {
  const f = fixture()
  const a = f.put("stable content")
  const first = JSON.parse(await f.exportRun([{ id: a.id, sha256: `sha256:${a.sha256}` }])) as { files: { relpath: string }[] }
  const target = join(f.project, first.files[0]!.relpath)
  const before = statSync(target)
  const second = JSON.parse(await f.exportRun([{ id: a.id, sha256: `sha256:${a.sha256}` }])) as { files: { relpath: string }[] }
  expect(second.files[0]!.relpath).toBe(first.files[0]!.relpath)
  expect(statSync(target).mtimeMs).toBe(before.mtimeMs) // 复用而非重写
  // 目标路径是目录（特殊文件）→ 拒绝覆盖。
  const b = f.put("second content")
  const seqB = parseBbId(b.id).seq
  const nameB = `${parseBbId(b.id).scopeId}-${parseBbId(b.id).streamId}-e${String(seqB).padStart(6, "0")}.json`
  mkdirSync(join(exportsDirOf(f.project), nameB))
  await expect(f.exportRun([{ id: b.id, sha256: `sha256:${b.sha256}` }])).resolves.toBe(`rejected: clobber_conflict .opencode/bcp/exports/${nameB}`)
  expect(lstatSync(join(exportsDirOf(f.project), nameB)).isDirectory()).toBe(true)
})
