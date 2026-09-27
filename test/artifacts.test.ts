import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defineBoardTools } from "../src/tools"
import { openScopeForRoot } from "../src/storage"
import { ARTIFACT_MAX_BYTES, malformedSha256, type ArtifactBinding } from "../src/artifacts"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bcp-artifacts-")); dirs.push(dir)
  const path = join(dir, "result.txt"); writeFileSync(path, "after\n")
  const scope = openScopeForRoot({ rootSessionId: "s", dataDir: join(dir, "board") })
  const { streamId } = scope.registerSession("s", "fixer")
  const permissions: string[] = []
  const published: { bindings: ArtifactBinding[]; status: "stored" | "replay" }[] = []
  const ctx = { sessionID: "s", messageID: "m", agent: "fixer", directory: dir,
    ask: async (input: { permission: string }) => { permissions.push(input.permission) } }
  const tools = defineBoardTools({ resolveScope: async () => ({ scope, streamId, isolated: false }), log: () => {},
    observePublication: () => (_id, bindings, status) => published.push({ bindings, status }) })
  const put = (refs: string[], extra = {}) => tools.board_put.execute(ctx, { description: "Changed file", content: "Outcome: after. Limits: synthetic.", source_refs: refs, ...extra })
  const get = async (id: string) => JSON.parse((await tools.board_get.execute(ctx, { ids: [id] })).split("\n（")[0]!)[0]
  return { dir, path, scope, streamId, ctx, tools, put, get, permissions, published }
}
describe("local artifact binding", () => {
  test("bare path is retained and hashed; later source edits do not change the retained revision", async () => {
    const f = fixture()
    const result = await f.put([f.path])
    expect(result).toContain("stored")
    const id = result.split(" ")[1]!
    const first = await f.get(id)
    expect(first.artifact_check).toBe("verified_bytes_only")
    expect(first.record.source_refs[0]).toMatch(/^file:.*#sha256=[a-f0-9]{64}$/)
    expect(f.permissions).toEqual(["read"])
    writeFileSync(f.path, "different\n")
    const second = await f.get(id)
    expect(second.artifacts[0].sha256).toBe(createHash("sha256").update("after\n").digest("hex"))
    expect(second.artifact_check).toBe("verified_bytes_only")
    const snapshot = new URL(second.record.source_refs[0]); snapshot.hash = ""
    expect(snapshot.pathname).toEndWith(".txt")
    expect(readFileSync(snapshot, "utf8")).toBe("after\n")
    expect(f.published.length).toBe(1)
  })
  test("provided wrong or truncated hashes reject before publishing", async () => {
    const f = fixture()
    expect(await f.put([f.path + "#sha256=" + "a".repeat(59)])).toContain("artifact_hash_invalid")
    expect(await f.put([f.path + "#sha256=" + "a".repeat(64)])).toContain("artifact_hash_mismatch")
    expect(f.scope.readMeta(f.streamId).high_water).toBe(0)
  })
  test("read denial and missing permission capability do not read or retain a file", async () => {
    const f = fixture()
    const args = { description: "d", content: "c", source_refs: [f.path] }
    expect(await f.tools.board_put.execute({ ...f.ctx, ask: async () => { throw new Error("DENIED") } }, args)).toContain("DENIED")
    expect(await f.tools.board_put.execute({ sessionID: "s", messageID: "m", agent: "fixer" }, args)).toContain("artifact_permission_unavailable")
    expect(f.scope.readMeta(f.streamId).high_water).toBe(0)
  })
  test("external source uses both external_directory and read permission", async () => {
    const f = fixture()
    await f.tools.board_put.execute({ ...f.ctx, directory: join(f.dir, "elsewhere") }, { description: "d", content: "c", source_refs: [f.path] })
    expect(f.permissions).toEqual(["external_directory", "read"])
  })
  test("snapshot tampering is detected; a legacy mutable path is not called verified", async () => {
    const f = fixture()
    const result = await f.put([f.path])
    const id = result.split(" ")[1]!
    const first = await f.get(id)
    const path = new URL(first.record.source_refs[0]); path.hash = ""
    writeFileSync(path, "corrupted")
    expect((await f.get(id)).artifact_check).toBe("incomplete")
    expect((await f.get(id)).artifacts[0].status).toBe("mismatch")
    const legacy = f.scope.put(f.streamId, { writer: { agent: "fixer", session_id: "s", message_id: "old" }, createdRound: null, description: "old", content: "old", sourceRefs: [f.path] })
    if (legacy.status !== "stored") throw new Error("fixture failed")
    expect((await f.get(legacy.id)).artifacts[0].status).toBe("unverified_legacy_reference")
  })
  test("same bytes replay; changed bytes conflict under the same idempotency key", async () => {
    const f = fixture()
    await f.put([f.path], { idempotency_key: "same" })
    expect(await f.put([f.path], { idempotency_key: "same" })).toContain("idempotent replay")
    expect(f.published.map(p => p.status)).toEqual(["stored", "replay"])
    writeFileSync(f.path, "changed")
    expect(await f.put([f.path], { idempotency_key: "same" })).toContain("idempotency_conflict")
  })
  test("oversized artifacts are rejected without a record", async () => {
    const f = fixture(); writeFileSync(f.path, Buffer.alloc(ARTIFACT_MAX_BYTES + 1))
    expect(await f.put([f.path])).toContain("artifact_too_large")
    expect(f.scope.readMeta(f.streamId).high_water).toBe(0)
  })
  test("count, regular-file and quota boundaries cannot publish a partial record", async () => {
    const f = fixture()
    expect(await f.put(Array(9).fill(f.path))).toContain("artifact_count_exceeded")
    expect(await f.put([f.dir])).toContain("artifact_not_regular_file")
    expect(await f.put([join(f.dir, "missing")])).toContain("rejected:")
    f.scope.updateConfig(cfg => ({ ...cfg, quota_bytes: 1 }))
    expect(await f.put([f.path])).toContain("artifact_quota_exceeded")
    expect(f.scope.readMeta(f.streamId).high_water).toBe(0)
  })
  test("remote sources do not trigger filesystem permissions or claim byte verification", async () => {
    const f = fixture()
    const id = (await f.put(["https://example.com/doc"])).split(" ")[1]!
    expect((await f.get(id)).artifact_check).toBeUndefined()
    expect(f.permissions).toEqual([])
  })
  test("missing paths, directories and annotated paths give actionable feedback without guessing a filename", async () => {
    const f = fixture()
    for (const ref of [join(f.dir, "absent.json"), f.dir, f.path + " (sha256: " + "a".repeat(64) + ")"]) {
      const result = await f.put([ref])
      expect(result).toContain("rejected:")
      expect(result).toContain("source_refs")
      expect(result).toContain("content")
      expect(result).toContain("do not append")
    }
    expect(f.scope.readMeta(f.streamId).high_water).toBe(0)
    const withParentheses = join(f.dir, "real (file).txt")
    writeFileSync(withParentheses, "literal filename")
    expect(await f.put([withParentheses])).toContain("stored")
  })
  test("malformed SHA declarations are rejected without guessing unlabelled text", () => {
    expect(malformedSha256("SHA256: " + "a".repeat(59))).toBe("a".repeat(59))
    expect(malformedSha256("SHA-256=`" + "a".repeat(64) + "`")).toBeNull()
    expect(malformedSha256("Use SHA256 automatically, don't type hashes.")).toBeNull()
  })
})
