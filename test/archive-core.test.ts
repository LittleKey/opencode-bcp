import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { archiveHandoff, type HandoffBinding, type HandoffRecord } from "../src/archive"
import { acquireLock } from "../src/archive/lock"

const base = resolve(".opencode/test-artifacts")
mkdirSync(base, { recursive: true })
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(base, "archive-core-"))
  roots.push(root)
  const binding: HandoffBinding = { taskId: "task", taskRoot: root, allowArchive: true, sharedReadersApproved: true }
  const record: HandoffRecord = {
    origin: { kind: "session-snapshot", sessionId: "../session", messageId: "../message", agent: "writer", createdAt: 100, completedAt: 120, finish: "stop" },
    observedAt: 123,
    texts: [{ ordinal: 0, text: " \r\n原文 <description>unchanged</description>\nno-store discussion\n" }],
  }
  return { root, binding, record }
}
test("exact UTF-8, meta/body paths, complete hash and observation-independent duplicates", async () => {
  const { root, binding, record } = fixture()
  const stored = await archiveHandoff(binding, record)
  expect(stored.status).toBe("stored")
  expect(stored.path).toBe(join(dirname(stored.body!), "meta.json"))
  expect(stored.version).toMatch(/^[a-f0-9]{64}$/)
  expect(readFileSync(stored.body!, "utf8")).toBe(record.texts[0]!.text)
  const before = readFileSync(stored.path!, "utf8")
  expect((await archiveHandoff(binding, { ...record, observedAt: 999 })).status).toBe("duplicate")
  expect(readFileSync(stored.path!, "utf8")).toBe(before)
  expect(JSON.parse(before).schema).toBe("bcp.handoff.v1")
  const index = readFileSync(join(root, "archive/index.md"), "utf8")
  expect(index).not.toContain("description")
  expect(index).not.toContain("discussion")
  await expect(archiveHandoff(binding, { ...record, texts: [{ ordinal: 0, text: "revision" }] })).rejects.toThrow("archive_conflict")
  await expect(archiveHandoff(binding, { ...record, origin: { ...record.origin, agent: "other" } })).rejects.toThrow("archive_message_identity_conflict")
  expect(readFileSync(stored.body!, "utf8")).toBe(record.texts[0]!.text)
})
test("submitted content is rejected before authorization or any writes", async () => {
  const { root, binding, record } = fixture()
  const submitted = { ...record, origin: { kind: "submitted-content", sessionId: record.origin.sessionId, messageId: record.origin.messageId, toolCallId: "../call", agent: "writer" } }
  let authorized = false
  expect(await archiveHandoff(binding, submitted as unknown as HandoffRecord, {
    authorizeWrites: () => { authorized = true },
  })).toEqual({ status: "skipped", reason: "invalid" })
  expect(authorized).toBe(false)
  expect(readdirSync(root)).toEqual([])
  await archiveHandoff(binding, record)
  await expect(archiveHandoff(binding, { ...record, origin: { ...record.origin, completedAt: 121 } } as HandoffRecord)).rejects.toThrow("archive_message_identity_conflict")
})
test("historical submitted metadata remains navigable without permitting new writes", async () => {
  const { root, binding, record } = fixture()
  const snapshot = await archiveHandoff(binding, record)
  const meta = JSON.parse(readFileSync(snapshot.path!, "utf8"))
  const origin = { kind: "submitted-content", sessionId: record.origin.sessionId, messageId: record.origin.messageId, toolCallId: "../call", agent: "writer" }
  const key = "id-" + Buffer.from(JSON.stringify([origin.kind, origin.messageId, origin.toolCallId])).toString("hex")
  const historical = join(dirname(dirname(dirname(snapshot.path!))), key, snapshot.version!)
  mkdirSync(historical, { recursive: true })
  const metadata = JSON.stringify({ ...meta, origin })
  writeFileSync(join(historical, "meta.json"), metadata)
  writeFileSync(join(historical, "body.txt"), record.texts[0]!.text)
  expect((await archiveHandoff(binding, record)).status).toBe("duplicate")
  const index = readFileSync(join(root, "archive/index.md"), "utf8")
  const entries = index.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
  expect(entries).toHaveLength(2)
  const entry = entries.find(entry => entry.origin.kind === "submitted-content")
  expect(entry.origin).toEqual(origin)
  expect(join(root, "archive", entry.path)).toBe(join(historical, "meta.json"))
  expect(readFileSync(join(historical, "meta.json"), "utf8")).toBe(metadata)
  expect(await archiveHandoff(binding, { ...record, origin } as unknown as HandoffRecord)).toEqual({ status: "skipped", reason: "invalid" })
})
test("permission, invalid evidence, no-store and cancellation skip before any writes", async () => {
  const { root, binding, record } = fixture()
  expect((await archiveHandoff({ ...binding, allowArchive: false } as unknown as HandoffBinding, record)).status).toBe("skipped")
  expect((await archiveHandoff({ ...binding, sharedReadersApproved: false } as unknown as HandoffBinding, record)).reason).toBe("permission")
  expect((await archiveHandoff(binding, { ...record, origin: { ...record.origin, finish: "length" } } as unknown as HandoffRecord)).reason).toBe("invalid")
  expect((await archiveHandoff(binding, { ...record, texts: [...record.texts, { ordinal: 1, text: "before <!-- bcp:no-store --> after" }] })).status).toBe("skipped")
  expect((await archiveHandoff(binding, record, { signal: AbortSignal.abort() })).reason).toBe("cancelled")
  for (const ordinal of [-1, 0.5, NaN]) expect((await archiveHandoff(binding, { ...record, texts: [{ ordinal, text: "x" }] })).reason).toBe("invalid")
  expect((await archiveHandoff(binding, { ...record, texts: [{ ordinal: 1, text: "x" }, { ordinal: 1, text: "y" }] })).reason).toBe("invalid")
  expect(readdirSync(root)).toEqual([])
})
test("multipart ordered manifest and concurrent calls serialize recheck", async () => {
  const { root, binding, record } = fixture()
  record.texts.push({ ordinal: 2, text: "\n第二段" })
  let active = 0
  const options = { recheck: async () => { expect(active++).toBe(0); await Bun.sleep(5); active--; return true } }
  const results = await Promise.all(Array.from({ length: 8 }, () => archiveHandoff(binding, record, options)))
  expect(results.filter(r => r.status === "stored")).toHaveLength(1)
  expect(results.filter(r => r.status === "duplicate")).toHaveLength(7)
  expect(results[0]!.body).toBeUndefined()
  const meta = JSON.parse(readFileSync(results[0]!.path!, "utf8"))
  expect(meta.parts.map((p: { ordinal: number }) => p.ordinal)).toEqual([0, 2])
  expect(readFileSync(join(dirname(results[0]!.path!), "part-2.txt"), "utf8")).toBe("\n第二段")
  expect(readFileSync(join(root, "archive/index.md"), "utf8").split("\n").filter(x => x.startsWith("{"))).toHaveLength(1)
})
test("in-lock recheck denies before directories and precommit recheck removes staging", async () => {
  const { root, binding, record } = fixture()
  expect((await archiveHandoff(binding, record, { recheck: () => false })).reason).toBe("recheck")
  expect(readdirSync(root)).toEqual([".archive.lock"])
  let calls = 0
  expect((await archiveHandoff(binding, record, { recheck: () => ++calls === 1 })).reason).toBe("recheck")
  expect(calls).toBe(2)
  expect((await archiveHandoff(binding, record)).status).toBe("stored")
})
test("abort during asynchronous precommit recheck never publishes", async () => {
  const { root, binding, record } = fixture()
  const controller = new AbortController()
  let calls = 0
  const result = await archiveHandoff(binding, record, { signal: controller.signal, recheck: async () => {
    if (++calls === 2) controller.abort()
    return true
  } })
  expect(result.reason).toBe("cancelled")
  const session = join(root, "archive", readdirSync(join(root, "archive"))[0]!)
  const message = join(session, readdirSync(session)[0]!)
  expect(readdirSync(message)).toEqual([])
})
test("tampered body or extra metadata fails closed", async () => {
  for (const body of [true, false]) {
    const { binding, record } = fixture()
    const stored = await archiveHandoff(binding, record)
    if (body) writeFileSync(stored.body!, "tampered")
    else {
      const meta = JSON.parse(readFileSync(stored.path!, "utf8"))
      meta.description = "forged"
      writeFileSync(stored.path!, JSON.stringify(meta))
    }
    await expect(archiveHandoff(binding, record)).rejects.toThrow("archive_message_invalid_record")
  }
})
test("symlink root, archive, lock and body are rejected", async () => {
  for (const target of ["archive", ".archive.lock"]) {
    const { root, binding, record } = fixture()
    symlinkSync(base, join(root, target))
    await expect(archiveHandoff(binding, record)).rejects.toThrow()
  }
  const { root, binding, record } = fixture()
  symlinkSync(base, join(root, "alias"))
  await expect(archiveHandoff({ ...binding, taskRoot: join(root, "alias") }, record)).rejects.toThrow()
  const stored = await archiveHandoff(binding, record)
  rmSync(stored.body!)
  symlinkSync(stored.path!, stored.body!)
  await expect(archiveHandoff(binding, record)).rejects.toThrow()
})
test("OS lock serializes independent processes and preserves all records", async () => {
  const { root, binding, record } = fixture()
  const module = resolve("src/archive/index.ts")
  const children = Array.from({ length: 4 }, (_, i) => {
    const code = `import {archiveHandoff} from ${JSON.stringify(module)}; await archiveHandoff(${JSON.stringify(binding)},${JSON.stringify({ ...record, origin: { ...record.origin, messageId: `process-${i}` } })}, {recheck: async()=>{await Bun.sleep(15); return true}})`
    return Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" })
  })
  for (const child of children) {
    const error = await new Response(child.stderr).text()
    expect({ exit: await child.exited, error }).toEqual({ exit: 0, error: "" })
  }
  expect(readFileSync(join(root, "archive/index.md"), "utf8").split("\n").filter(x => x.startsWith("{"))).toHaveLength(4)
})
test("hostile identities stay in an encoded fenced source block", async () => {
  const { root, binding, record } = fixture()
  const agent = '[x](https://evil.invalid)<img src=x>``` \u202e\u0001'
  expect((await archiveHandoff(binding, { ...record, origin: { ...record.origin, agent } })).status).toBe("stored")
  const index = readFileSync(join(root, "archive/index.md"), "utf8")
  expect(index.match(/```/g)).toHaveLength(2)
  expect(index).not.toContain("<img")
  expect(index).not.toContain("[x](")
  expect(index).not.toContain("\u202e")
  expect(JSON.parse(index.split("\n").find(s => s.startsWith("{"))!).origin.agent).toBe(agent)
})
test("persistent root task identity rejects different tasks and legacy roots", async () => {
  const { root, binding, record } = fixture()
  await archiveHandoff(binding, record)
  const before = readFileSync(join(root, "archive/index.md"), "utf8")
  await expect(archiveHandoff({ ...binding, taskId: "other" }, record)).rejects.toThrow("archive_task_root_conflict")
  expect(readFileSync(join(root, "archive/index.md"), "utf8")).toBe(before)
  for (const bound of [false, true]) {
    const f = fixture()
    mkdirSync(join(f.root, "archive"))
    writeFileSync(join(f.root, "archive", "index.md"), "legacy")
    if (bound) writeFileSync(join(f.root, ".archive.lock"), JSON.stringify({ schema: "bcp.delivery-root.v1", taskId: f.binding.taskId }) + "\n")
    await expect(archiveHandoff(f.binding, f.record)).rejects.toThrow(bound ? "archive_task_root_conflict" : "archive_unbound_existing_root")
    expect(readFileSync(join(f.root, "archive/index.md"), "utf8")).toBe("legacy")
  }
})
test("post-publication index failure reports stored/indexStale and retries repair", async () => {
  const { root, binding, record } = fixture()
  await archiveHandoff(binding, record)
  rmSync(join(root, "archive/index.md"))
  mkdirSync(join(root, "archive/index.md"))
  const next = { ...record, origin: { ...record.origin, messageId: "second" } }
  const result = await archiveHandoff(binding, next)
  expect(result.status).toBe("stored")
  expect(result.indexStale).toBe(true)
  expect(readFileSync(result.body!, "utf8")).toBe(record.texts[0]!.text)
  rmSync(join(root, "archive/index.md"), { recursive: true })
  const retry = await archiveHandoff(binding, next)
  expect(retry.status).toBe("duplicate")
  expect(retry.indexStale).toBeUndefined()
})
test("permanent lock syscall failure is bounded and successful retry works", async () => {
  let calls = 0
  await expect(acquireLock(() => { calls++; return -1 }, 20)).rejects.toThrow("archive_lock_timeout_or_error")
  expect(calls).toBeGreaterThan(1)
  let retries = 0
  await acquireLock(() => retries++ < 1 ? -1 : 0, 100)
  expect(retries).toBe(2)
})
test("write authorization rejects before even creating the lock", async () => {
  const { root, binding, record } = fixture()
  await expect(archiveHandoff(binding, record, { authorizeWrites: async paths => {
    expect(paths).toContain(join(root, ".archive.lock"))
    expect(readdirSync(root)).toEqual([])
    throw new Error("write_denied")
  } })).rejects.toThrow("write_denied")
  expect(readdirSync(root)).toEqual([])
  const controller = new AbortController()
  expect((await archiveHandoff(binding, record, { signal: controller.signal, authorizeWrites: () => controller.abort() })).reason).toBe("cancelled")
  expect(readdirSync(root)).toEqual([])
})
test("authorization enumerates the actual final and unique staging/index paths", async () => {
  const { root, binding, record } = fixture()
  record.texts.push({ ordinal: 3, text: "second" })
  let authorized: readonly string[] = []
  let checks = 0
  const result = await archiveHandoff(binding, record, {
    authorizeWrites: async paths => {
      expect(readdirSync(root)).toEqual([])
      expect(Object.isFrozen(paths)).toBe(true)
      expect(paths.every(p => isAbsolute(p) && p.startsWith(root + "/"))).toBe(true)
      expect(new Set(paths).size).toBe(paths.length)
      authorized = paths
    },
    recheck: () => {
      if (++checks === 2) {
        const pending = authorized.find(p => /\/\.pending-[^/]+$/.test(p))!
        expect(readdirSync(pending).sort()).toEqual(["meta.json", "part-1.txt", "part-2.txt"])
        expect(authorized).toContain(join(pending, "meta.json"))
        expect(authorized).toContain(join(pending, "part-1.txt"))
        expect(authorized).toContain(join(pending, "part-2.txt"))
      }
      return true
    },
  })
  expect(result.status).toBe("stored")
  expect(authorized).toContain(result.path!)
  expect(authorized).toContain(dirname(result.path!))
  expect(authorized).toContain(join(dirname(result.path!), "part-1.txt"))
  expect(authorized).toContain(join(dirname(result.path!), "part-2.txt"))
  const indexTemp = authorized.find(p => /\/\.index-[^/]+$/.test(p))!
  expect(indexTemp).toBeDefined()
  expect(authorized).toContain(join(root, "archive/index.md"))
  expect(readdirSync(join(root, "archive")).filter(p => p.startsWith(".index-"))).toEqual([])
  expect(authorized).toHaveLength(14)
})
