// G2 parent 补写协议检查脚本 dry-run 用例（计划 Task 3；p-rep-1…p-rep-10）。
// 脚本本身只读；fixture 用真实存储结构（scope.json.session_index + entries）搭建，随用例清理。

import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openScopeForRoot, type Scope } from "../src/storage"
import { runChecks, type CheckReport, type RepairCheckInput } from "../scripts/parent-repair-check"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TARGET = "task:fix-login#m42"

/** 合规基线输入（postflight 全 PASS 形态；各负例只覆写违规字段）。 */
function baseInput(over: Partial<RepairCheckInput> = {}): RepairCheckInput {
  return {
    mode: "postflight",
    original_execution: { child_session: "child-s1", child_agent: "build", target_ref: TARGET },
    parent: { session: "parent-root", agent: "orchestrator" },
    dispatch_proof: { explicit_agent_given: true, agent_param: "build", at: "2026-09-23T10:00:00Z" },
    lifecycle: { terminal: true, reused: false, observed_via: "session.get", at: "2026-09-23T10:00:00Z" },
    authorization: { scope_member: true, board_permission_ok: true },
    ...over,
  }
}

function makeScope(): Scope {
  const scope = openScopeForRoot({
    rootSessionId: "root-" + Math.random().toString(36).slice(2, 10),
    dataDir: mkdtempSync(join(tmpdir(), "bb-prep-")),
  })
  dirs.push(scope.dir)
  return scope
}

/** 以指定 writer 身份直接写一条补写记录（绕过工具层，fixture 用）。 */
function writeAs(
  scope: Scope,
  streamId: string,
  opts: { pubFor?: string; sessionId?: string; agent?: string } = {},
): string {
  const r = scope.put(streamId, {
    writer: { agent: opts.agent ?? "build", session_id: opts.sessionId ?? "child-s1", message_id: "cm1" },
    createdRound: null,
    description: "补写记录",
    content: "补写内容",
    ...(opts.pubFor !== undefined ? { publicationFor: opts.pubFor } : {}),
  })
  if (r.status !== "stored") throw new Error(`put failed: ${JSON.stringify(r)}`)
  return r.id
}

function verdictOf(rep: CheckReport, id: CheckReport["results"][number]["id"]): CheckReport["results"][number] {
  const r = rep.results.find((x) => x.id === id)
  if (r === undefined) throw new Error(`missing check ${id} in report`)
  return r
}

/** CLI 冒烟：写 fixture 文件 → bun run 脚本 → 返回退出码（验证 --file 与 rc 语义）。 */
function runCli(input: unknown): number {
  const dir = mkdtempSync(join(tmpdir(), "bb-prep-cli-"))
  dirs.push(dir)
  const f = join(dir, "input.json")
  writeFileSync(f, JSON.stringify(input))
  const p = Bun.spawnSync([process.execPath, "run", "scripts/parent-repair-check.ts", "--file", f], {
    cwd: join(import.meta.dir, ".."),
  })
  return p.exitCode ?? 1
}

describe("parent-repair", () => {
  // p-rep-1
  test("preflight 全合规（无任何记录、无 published_record_id）→ A 全 PASS、rc=0", () => {
    makeScope() // 板存在但 preflight 不读板——证明 A 阶段不依赖记录
    const rep = runChecks(baseInput({ mode: "preflight" }))
    expect(rep.mode).toBe("preflight")
    expect(rep.results.map((r) => r.id)).toEqual(["C1", "C2", "C5", "C3a"])
    expect(rep.results.every((r) => r.verdict === "PASS")).toBe(true)
    expect(rep.exit_code).toBe(0)
    expect(runCli(baseInput({ mode: "preflight" }))).toBe(0)
  })

  // p-rep-2
  test("postflight 全合规 → A+B 全 PASS、rc=0", () => {
    const scope = makeScope()
    const { streamId } = scope.registerSession("child-s1", "build")
    // publication_for 带多余空白：归一化后与 target_ref 相等（验证归一化函数）
    const id = writeAs(scope, streamId, { pubFor: `  ${TARGET}  ` })
    const rep = runChecks(
      baseInput({ scope: { scope_id: scope.scopeId, data_dir: scope.rootDir }, published_record_id: id }),
    )
    expect(rep.mode).toBe("postflight")
    expect(rep.results.map((r) => r.id)).toEqual(["C1", "C2", "C5", "C3a", "C3b", "C4", "C6"])
    expect(rep.results.every((r) => r.verdict === "PASS")).toBe(true)
    expect(rep.exit_code).toBe(0)
  })

  // p-rep-3
  test("lifecycle 缺失 → C1/C2 UNVERIFIABLE、rc=1（不得假 PASS）", () => {
    const { lifecycle: _lc, ...rest } = baseInput()
    const rep = runChecks(rest)
    expect(verdictOf(rep, "C1").verdict).toBe("UNVERIFIABLE")
    expect(verdictOf(rep, "C2").verdict).toBe("UNVERIFIABLE")
    expect(rep.exit_code).toBe(1)
  })

  // p-rep-4
  test("terminal=false → C1 FAIL、rc=1", () => {
    const rep = runChecks(
      baseInput({ lifecycle: { terminal: false, reused: false, observed_via: "session.get", at: "2026-09-23T10:00:00Z" } }),
    )
    expect(verdictOf(rep, "C1")).toMatchObject({ verdict: "FAIL" })
    expect(rep.exit_code).toBe(1)
    expect(runCli(baseInput({ lifecycle: { terminal: false, reused: false, observed_via: "s", at: "t" } }))).toBe(1)
  })

  // p-rep-5
  test("reused=true → C2 FAIL、rc=1（C1 不受影响）", () => {
    const rep = runChecks(
      baseInput({ lifecycle: { terminal: true, reused: true, observed_via: "session.get", at: "2026-09-23T10:00:00Z" } }),
    )
    expect(verdictOf(rep, "C2")).toMatchObject({ verdict: "FAIL" })
    expect(verdictOf(rep, "C1").verdict).toBe("PASS")
    expect(rep.exit_code).toBe(1)
  })

  // p-rep-6
  test("explicit_agent_given=false → C5 FAIL、rc=1（默认 agent 恰为原 agent 也不允许）", () => {
    const rep = runChecks(
      baseInput({ dispatch_proof: { explicit_agent_given: false, agent_param: "build", at: "2026-09-23T10:00:00Z" } }),
    )
    expect(verdictOf(rep, "C5")).toMatchObject({ verdict: "FAIL" })
    expect(rep.exit_code).toBe(1)
  })

  // p-rep-7
  test("authorization 缺 scope_member → C3a UNVERIFIABLE、rc=1", () => {
    const rep = runChecks({ ...baseInput(), authorization: { board_permission_ok: true } })
    expect(verdictOf(rep, "C3a").verdict).toBe("UNVERIFIABLE")
    expect(rep.exit_code).toBe(1)
  })

  // p-rep-8
  test("记录 writer 为第三方 session（≠child ≠parent）→ C3b FAIL、rc=1", () => {
    const scope = makeScope()
    const { streamId } = scope.registerSession("temp-s9", "build")
    const id = writeAs(scope, streamId, { pubFor: TARGET, sessionId: "temp-s9", agent: "build" })
    const rep = runChecks(
      baseInput({ scope: { scope_id: scope.scopeId, data_dir: scope.rootDir }, published_record_id: id }),
    )
    expect(verdictOf(rep, "C3b")).toMatchObject({ verdict: "FAIL" })
    expect(rep.exit_code).toBe(1)
  })

  // p-rep-9
  test("publication_for 与 target_ref 不一致 → C4 FAIL、rc=1", () => {
    const scope = makeScope()
    const { streamId } = scope.registerSession("child-s1", "build")
    const id = writeAs(scope, streamId, { pubFor: "other:target#m1" })
    const rep = runChecks(
      baseInput({ scope: { scope_id: scope.scopeId, data_dir: scope.rootDir }, published_record_id: id }),
    )
    expect(verdictOf(rep, "C4")).toMatchObject({ verdict: "FAIL" })
    expect(rep.exit_code).toBe(1)
  })

  // p-rep-10
  test("C6 跨流枚举：选中记录合规但范围内另一条已注册 stream 存在 parent 代写 → C6 FAIL、rc=1", () => {
    const scope = makeScope()
    const { streamId: childStream } = scope.registerSession("child-s1", "build")
    const { streamId: otherStream } = scope.registerSession("colleague-s2", "build")
    const childId = writeAs(scope, childStream, { pubFor: TARGET })
    // parent 代写记录放在另一条已注册 stream——只有按 session_index 全量枚举才能发现
    writeAs(scope, otherStream, { pubFor: TARGET, sessionId: "parent-root", agent: "orchestrator" })
    const rep = runChecks(
      baseInput({ scope: { scope_id: scope.scopeId, data_dir: scope.rootDir }, published_record_id: childId }),
    )
    expect(verdictOf(rep, "C3b").verdict).toBe("PASS")
    expect(verdictOf(rep, "C4").verdict).toBe("PASS")
    expect(verdictOf(rep, "C6")).toMatchObject({ verdict: "FAIL" })
    // 其余检查全 PASS 也不能 rc=0
    expect(rep.results.filter((r) => r.id !== "C6").every((r) => r.verdict === "PASS")).toBe(true)
    expect(rep.exit_code).toBe(1)
  })
})
