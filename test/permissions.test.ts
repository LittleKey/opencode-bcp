import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openScopeForRoot, openScopeById, type Scope } from "../src/storage"
import { resolveAuthz, refPolicy, isPinned } from "../src/permissions"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bb-perm-"))
  dirs.push(d)
  return d
}
function open(root: string): Scope {
  return openScopeForRoot({ rootSessionId: root, dataDir: tempDir() })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("permissions", () => {
  // perm-1
  test("同 scope 两个普通会话：canWrite 仅 own，canRead 双方流均 true", () => {
    const scope = open("p1")
    const s1 = scope.registerSession("s1", "build")
    const s2 = scope.registerSession("s2", "build")
    const a1 = resolveAuthz(scope, { sessionId: "s1", agent: "build" })
    const a2 = resolveAuthz(scope, { sessionId: "s2", agent: "build" })
    expect(a1.registered).toBe(true)
    expect(a1.ownStreamId).toBe(s1.streamId)
    expect(a1.canWrite(s1.streamId)).toBe(true)
    expect(a1.canWrite(s2.streamId)).toBe(false)
    expect(a1.canRead(s1.streamId)).toBe(true)
    expect(a1.canRead(s2.streamId)).toBe(true)
    expect(a2.canWrite(s2.streamId)).toBe(true)
    expect(a2.canWrite(s1.streamId)).toBe(false)
    expect(a2.canRead(s1.streamId)).toBe(true)
  })

  // perm-2
  test("councillor-x 前缀命中隔离名单：他人不可见，隔离会话可见自己", () => {
    const scope = open("p2")
    const normal = scope.registerSession("n1", "build")
    const iso = scope.registerSession("c1", "councillor-x")
    expect(scope.resolveSession("c1").isolated).toBe(true)
    const aN = resolveAuthz(scope, { sessionId: "n1", agent: "build" })
    expect(aN.listableStreams.map((s) => s.streamId)).not.toContain(iso.streamId)
    expect(aN.canRead(iso.streamId)).toBe(false)
    const aI = resolveAuthz(scope, { sessionId: "c1", agent: "councillor-x" })
    expect(aI.isolated).toBe(true)
    expect(aI.listableStreams.map((s) => s.streamId)).toContain(iso.streamId) // 隔离会话可见自己
    expect(aI.canRead(iso.streamId)).toBe(true)
    // 隔离会话可见普通流（隔离只隐藏隔离流，不反向隐藏普通流）
    expect(aI.canRead(normal.streamId)).toBe(true)
  })

  // perm-3
  test("未注册会话：registered:false、listableStreams 空、canRead/canWrite 恒 false（C2-①）", () => {
    const scope = open("p3")
    const s1 = scope.registerSession("s1", "build")
    const a = resolveAuthz(scope, { sessionId: "ghost", agent: "build" })
    expect(a.registered).toBe(false)
    expect(a.ownStreamId).toBe(null)
    expect(a.listableStreams).toEqual([])
    expect(a.canRead(s1.streamId)).toBe(false)
    expect(a.canWrite(s1.streamId)).toBe(false)
    expect(a.canRead("any-stream")).toBe(false)
    expect(a.canWrite("any-stream")).toBe(false)
  })

  // perm-4
  test("直接改 scope.json pins 后 isPinned === true", () => {
    const scope = open("p4")
    const s1 = scope.registerSession("s1", "build")
    const r = scope.put(s1.streamId, {
      writer: { agent: "build", session_id: "s1", message_id: "m1" },
      createdRound: null,
      description: "被引用的记录",
      content: "c",
    })
    if (r.status !== "stored") throw new Error(`put failed: ${JSON.stringify(r)}`)
    const scopeJsonPath = join(scope.dir, "scope.json")
    const cfg = JSON.parse(readFileSync(scopeJsonPath, "utf8"))
    cfg.pins.push(r.id)
    writeFileSync(scopeJsonPath, JSON.stringify(cfg))
    const cfg2 = scope.config
    expect(isPinned(cfg2, r.id)).toBe(true)
    expect(isPinned(cfg2, "bb://x/y/e000001")).toBe(false)
  })

  // perm-5
  test("refPolicy：同 scope 隔离流 → hidden；跨 scope → forbidden（C2-③）", () => {
    const dataDir = tempDir()
    const a = openScopeForRoot({ rootSessionId: "p5a", dataDir })
    const b = openScopeForRoot({ rootSessionId: "p5b", dataDir })
    a.registerSession("n1", "build")
    a.registerSession("c1", "councillor")
    const aAuthz = resolveAuthz(a, { sessionId: "n1", agent: "build" })
    const isoStream = a.config.session_index["c1"]!.stream_id
    expect(refPolicy(aAuthz, { scopeId: a.config.scope_id, streamId: isoStream })).toBe("hidden")
    expect(refPolicy(aAuthz, { scopeId: b.config.scope_id, streamId: "whatever" })).toBe("forbidden")
    expect(refPolicy(aAuthz, { scopeId: a.config.scope_id, streamId: aAuthz.ownStreamId! })).toBe("ok")
  })
})
