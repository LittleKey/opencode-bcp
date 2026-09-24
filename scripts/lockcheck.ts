// 并发真实性检查（P11：同进程 Promise.all 不构成并发）。
// 用法：
//   bun run scripts/lockcheck.ts put <dataDir> <tag>
//   bun run scripts/lockcheck.ts scope-race <dataDir> <rootId> [pause]
//   bun run scripts/lockcheck.ts scope-race-main <dataDir> <rootId>
//   bun run scripts/lockcheck.ts aggregateRace <dataDir>
//   bun run scripts/lockcheck.ts agg-race-writer|agg-race-contest|agg-race-read <dataDir>   # 内部 worker

import { mkdirSync, writeFileSync, existsSync } from "node:fs"

async function putWorker(dataDir: string, tag: string): Promise<void> {
  const { openScopeForRoot } = await import("../src/storage")
  const scope = openScopeForRoot({ rootSessionId: "lc-root", dataDir })
  const { streamId } = scope.resolveSession("lc-session")
  for (let i = 0; i < 50; i++) {
    const r = scope.put(streamId, {
      writer: { agent: "lockcheck", session_id: "lc-session", message_id: `${tag}-${i}` },
      createdRound: null,
      description: `lockcheck ${tag} ${i}`,
      content: `并发压力写入 ${tag}-${i}`,
      idempotencyKey: `lc-${tag}-${i}`,
    })
    if (r.status !== "stored" && r.status !== "replay") {
      console.error(`put failed: ${JSON.stringify(r)}`)
      process.exit(2)
    }
  }
}

function pauseSync(dataDir: string): void {
  writeFileSync(`${dataDir}/pause-A`, "1")
  const deadline = Date.now() + 10000
  const buf = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(`${dataDir}/resume-A`)) {
    if (Date.now() > deadline) process.exit(3)
    Atomics.wait(buf, 0, 0, 5)
  }
}

async function scopeRaceWorker(dataDir: string, rootId: string, pause: string[] | undefined): Promise<void> {
  const { openScopeForRoot } = await import("../src/storage")
  try {
    const scope = openScopeForRoot({
      rootSessionId: rootId,
      dataDir,
      raceProbe: pause ? { afterIndexMiss: () => pauseSync(dataDir) } : undefined,
    })
    console.log(JSON.stringify({ rootId, attempt: "ok", scopeId: scope.config.scope_id }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith("lock_timeout")) {
      console.log(JSON.stringify({ rootId, attempt: "lock_contention_observed" }))
    } else {
      console.error(`scope-race worker error: ${msg}`)
      process.exit(1)
    }
  }
}

function lastLine(s: string): string {
  const lines = s.trim().split("\n")
  return lines[lines.length - 1] ?? ""
}

// ---- aggregateRace（fix-7；协议 I2 修正版）：两进程同作者同流竞争同一把 scope 锁 ----

const RACE_ROOT = "agg-race-root"
const RACE_AUTHOR = { agent: "build", session_id: "race-author" }
const AGG_RACE_SEEDS = 22 // seq1..16 老化可聚合 + seq17..22 recent6 尾部
const RACE_BATCH_A = Array.from({ length: 8 }, (_, i) => i + 1)       // seq1..8
const RACE_BATCH_B = Array.from({ length: 8 }, (_, i) => i + 7)       // seq7..14（共享 7/8）
const RACE_SHARED = [7, 8]

function raceCallWriter(): { agent: string; session_id: string; message_id: string } {
  return { ...RACE_AUTHOR, message_id: "agg-race-call" }
}

async function aggregateRaceWriter(dataDir: string): Promise<void> {
  const { openScopeForRoot, faultHook } = await import("../src/storage")
  const { formatBbId } = await import("../src/ids")
  const scope = openScopeForRoot({ rootSessionId: RACE_ROOT, dataDir })
  const { streamId } = scope.resolveSession(RACE_AUTHOR.session_id)
  const memberIds = RACE_BATCH_A.map((seq) => formatBbId(scope.config.scope_id, streamId, seq))
  if (process.env.AGG_FAULT === "publish") {
    faultHook.current = (at) => {
      if (at === "agg_after_publish") {
        console.log("paused_after_publish") // 该信号 = 已确认持锁（fault 点位于提交临界区内）
        pauseSync(dataDir)
      }
    }
  }
  const r = scope.aggregate(streamId, {
    writer: raceCallWriter(),
    memberIds,
    description: "aggregateRace 摘要",
    navigationBody: "# aggregateRace 导航",
  })
  console.log(JSON.stringify({ attempt: "initial", ...r }))
}

async function aggregateRaceContest(dataDir: string): Promise<void> {
  const { openScopeForRoot } = await import("../src/storage")
  const { formatBbId } = await import("../src/ids")
  const scope = openScopeForRoot({ rootSessionId: RACE_ROOT, dataDir })
  const { streamId } = scope.resolveSession(RACE_AUTHOR.session_id)
  const memberIds = RACE_BATCH_B.map((seq) => formatBbId(scope.config.scope_id, streamId, seq))
  try {
    const r = scope.aggregate(streamId, {
      writer: raceCallWriter(),
      memberIds,
      description: "aggregateRace 摘要",
      navigationBody: "# aggregateRace 导航",
    })
    console.log(JSON.stringify({ attempt: "retry", ...r }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith("lock_timeout")) {
      console.log("contest_lock_contention_observed")
      return
    }
    console.error(`agg-race contest error: ${msg}`)
    process.exit(1)
  }
}

async function aggregateRaceRead(dataDir: string): Promise<void> {
  const { openScopeForRoot } = await import("../src/storage")
  const { listIndex, snapshotCounts } = await import("../src/indexing")
  const { formatBbId } = await import("../src/ids")
  const scope = openScopeForRoot({ rootSessionId: RACE_ROOT, dataDir })
  const { streamId } = scope.resolveSession(RACE_AUTHOR.session_id)
  const caller = { sessionId: RACE_AUTHOR.session_id, agent: RACE_AUTHOR.agent }
  try {
    // 与生产 board_index/plugin transform 相同的组合方式：单一外层 withLock 包裹全部组成读取（I2）
    const out = scope.withLock(() => {
      const members = RACE_SHARED.map((seq) => {
        const id = formatBbId(scope.config.scope_id, streamId, seq)
        const g = scope.getById(id)
        return { id, status: g.status, covered_by: g.status === "found" ? (scope.readMeta(streamId).nav[g.record.id]?.covered_by ?? null) : null }
      })
      const rounds = scope.readMeta(streamId).rounds
      const counts = snapshotCounts(scope, streamId, caller, rounds.round_known ? rounds.current_round : null)
      const listed = listIndex(scope, streamId, { caller })
      return { members, counts, items: listed.items.length }
    })
    console.log(JSON.stringify({ attempt: "retry", read: "covered", ...out }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith("lock_timeout")) {
      console.log("read_lock_contention_observed")
      return
    }
    console.error(`agg-race read error: ${msg}`)
    process.exit(1)
  }
}

async function aggregateRaceMain(dataDir: string): Promise<void> {
  const repoRoot = new URL("..", import.meta.url).pathname
  function fail(why: string): never {
    console.error(`aggregateRace FAIL: ${why}`)
    process.exit(1)
  }
  mkdirSync(dataDir, { recursive: true })
  // 父进程准备：同作者同流 + 16 老化 + 6 近期尾部 + rounds=49
  const { openScopeForRoot } = await import("../src/storage")
  const { formatBbId } = await import("../src/ids")
  const scope = openScopeForRoot({ rootSessionId: RACE_ROOT, dataDir })
  const { streamId } = scope.registerSession(RACE_AUTHOR.session_id, RACE_AUTHOR.agent)
  for (let i = 1; i <= AGG_RACE_SEEDS; i++) {
    const r = scope.put(streamId, {
      writer: { ...RACE_AUTHOR, message_id: `agg-race-seed-${i}` },
      createdRound: 10,
      description: `race 记录 ${i}`,
      content: `race 内容 ${i}`,
    })
    if (r.status !== "stored") fail(`seed put failed: ${JSON.stringify(r)}`)
  }
  scope.withLock(() => {
    const meta = scope.readMeta(streamId)
    meta.rounds = { current_round: 49, round_known: true, last_admitted_message_id: meta.rounds.last_admitted_message_id }
    scope.writeMeta(streamId, meta)
  })

  // 1) 带 AGG_FAULT=publish 的 writer：等 pause-A（fault 点已入临界区 = 确认持锁）
  const a = Bun.spawn(["bun", "scripts/lockcheck.ts", "agg-race-writer", dataDir], {
    stdout: "pipe", stderr: "pipe", cwd: repoRoot, env: { ...process.env, AGG_FAULT: "publish" },
  })
  const pauseDeadline = Date.now() + 15000
  while (!existsSync(`${dataDir}/pause-A`)) {
    if (Date.now() > pauseDeadline) fail("writer never paused")
    await Bun.sleep(5)
  }

  // 2) 两个挑战者首轮：均预期锁冲突（R3-1：同一套有限重试锁，不预设谁先超时）
  const b1 = Bun.spawn(["bun", "scripts/lockcheck.ts", "agg-race-contest", dataDir], { stdout: "pipe", stderr: "pipe", cwd: repoRoot })
  const b2 = Bun.spawn(["bun", "scripts/lockcheck.ts", "agg-race-read", dataDir], { stdout: "pipe", stderr: "pipe", cwd: repoRoot })
  const rc1 = await b1.exited
  const out1 = await new Response(b1.stdout).text()
  const rc2 = await b2.exited
  const out2 = await new Response(b2.stdout).text()
  if (rc1 !== 0 || !out1.includes("contest_lock_contention_observed")) fail("contest first attempt did not observe lock contention")
  if (rc2 !== 0 || !out2.includes("read_lock_contention_observed")) fail("read first attempt did not observe lock contention")

  // 3) 收到两份冲突报告 → 释放 writer（绝不等待成功读取/成功聚合）
  writeFileSync(`${dataDir}/resume-A`, "1")
  const rcA = await a.exited
  const outA = await new Response(a.stdout).text()
  if (rcA !== 0) fail(`writer exited rc=${rcA}: ${await new Response(a.stderr).text()}`)

  // 4) 重启两 worker 重试（首轮进程已退出，无残留竞争在途）
  const c1 = Bun.spawn(["bun", "scripts/lockcheck.ts", "agg-race-contest", dataDir], { stdout: "pipe", stderr: "pipe", cwd: repoRoot })
  const c2 = Bun.spawn(["bun", "scripts/lockcheck.ts", "agg-race-read", dataDir], { stdout: "pipe", stderr: "pipe", cwd: repoRoot })
  const rc3 = await c1.exited
  const out3 = await new Response(c1.stdout).text()
  const rc4 = await c2.exited
  const out4 = await new Response(c2.stdout).text()
  if (rc3 !== 0 || rc4 !== 0) fail(`retry workers exited rc=${rc3}/${rc4}`)

  type RaceResult = { status: string; id?: string; errors?: { id: string; reason: string }[] }
  let writerResult: RaceResult
  let contestResult: RaceResult
  try {
    writerResult = JSON.parse(lastLine(outA))
    contestResult = JSON.parse(lastLine(out3))
  } catch {
    fail(`unparsable worker output: ${JSON.stringify({ outA, out3 })}`)
  }
  // 恰一个 aggregated；败者 invalid 且 reasons 含 already_covered（非 lock_timeout）
  const statuses = [writerResult.status, contestResult.status]
  if (statuses.filter((s) => s === "aggregated").length !== 1) fail(`exactly one aggregated expected, got ${statuses.join("/")}`)
  const loser = writerResult.status === "aggregated" ? contestResult : writerResult
  const reasons = (loser.errors ?? []).map((e) => e.reason)
  if (loser.status !== "invalid" || !reasons.includes("already_covered")) fail(`loser must be invalid+already_covered, got ${loser.status}:${reasons.join(",")}`)
  const winnerId = (writerResult.status === "aggregated" ? writerResult : contestResult).id!

  // 无双重覆盖：summary.members ⇄ nav.covered_by 双向一致（observe fsck 同款）
  const meta = scope.readMeta(streamId)
  const win = scope.getById(winnerId)
  if (win.status !== "found") fail(`winner summary not found: ${winnerId}`)
  const memberIds = (win.record.members ?? []).map((m) => m.id)
  for (const mid of memberIds) {
    if (meta.nav[mid]?.covered_by !== winnerId) fail(`member edge missing: ${mid}`)
  }
  const edges = Object.entries(meta.nav).filter(([, v]) => v.covered_by !== undefined)
  if (edges.length !== memberIds.length) fail(`edge count ${edges.length} != members ${memberIds.length}`)
  for (const [mid, v] of edges) {
    if (v.covered_by !== winnerId || !memberIds.includes(mid)) fail(`orphan edge: ${mid}`)
  }

  // readWorker：covered 终态 + 组合计数与父进程事后独立全量计算一致（I1/I2）
  const readResult = JSON.parse(lastLine(out4)) as {
    members: { id: string; status: string; covered_by: string | null }[]
    counts: Record<string, number>
    items: number
  }
  for (const m of readResult.members) {
    if (m.status !== "found" || m.covered_by !== winnerId) fail(`shared member not covered终态: ${JSON.stringify(m)}`)
  }
  const { classifyEligibility } = await import("../src/eligibility")
  const { recentKnowledgeIds } = await import("../src/indexing")
  const rounds = meta.rounds
  const currentRound = rounds.round_known ? rounds.current_round : null
  const recentIds = recentKnowledgeIds(scope, streamId)
  const expected = { knowledge_total: 0, visible_items: 0, index_summary_count: 0, new_since_last_shown: 0, eligible: 0, protected: 0, unknown_round: 0, description_bytes: 0 }
  for (let seq = 1; seq <= meta.high_water; seq++) {
    const rec = scope.readEntry(streamId, seq)
    if (!rec) continue
    const id = formatBbId(scope.config.scope_id, streamId, seq)
    if (meta.tombstoned[id] !== undefined) continue
    expected.knowledge_total++
    if (rec.kind === "index_summary") expected.index_summary_count++
    if (meta.nav[id]?.covered_by === undefined) {
      // Task B 折叠口径：covered 项不占可见目录、不计 description 字节（counts 无 keyword）
      expected.visible_items++
      expected.description_bytes += Buffer.byteLength(rec.description, "utf8")
    }
    // §10.7 废除字段的读侧遗留容忍（读时归一化旧账本）：新账本无此字段 → 该遗留计数器恒 0 自然休眠
    if (rec.sequence > ((meta.budget as { last_shown_seq?: number }).last_shown_seq ?? Number.MAX_SAFE_INTEGER)) expected.new_since_last_shown++
    const cls = classifyEligibility(rec, { cfg: scope.config, meta, currentRound, recentIds, callerSessionId: RACE_AUTHOR.session_id, callerAgent: RACE_AUTHOR.agent })
    if (cls.status === "eligible") expected.eligible++
    else if (cls.status === "protected") expected.protected++
    else expected.unknown_round++
  }
  for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
    if (readResult.counts[k] !== expected[k]) fail(`counts mismatch on ${k}: readWorker=${readResult.counts[k]} parent=${expected[k]}`)
  }
  // readWorker items = listIndex（compact 折叠后可见数）
  if (readResult.items !== expected.visible_items) fail(`items mismatch: readWorker=${readResult.items} parent=${expected.visible_items}`)

  console.log(`aggregateRace OK: exactly one aggregated, loser explicit invalid, no double coverage, both first-attempts contested, mid-publish read consistent`)
}


async function scopeRaceMain(dataDir: string, rootId: string): Promise<void> {
  const repoRoot = new URL("..", import.meta.url).pathname
  mkdirSync(dataDir, { recursive: true })
  const a = Bun.spawn(["bun", "scripts/lockcheck.ts", "scope-race", dataDir, rootId, "pause"], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: repoRoot,
  })
  const deadline = Date.now() + 10000
  while (!existsSync(`${dataDir}/pause-A`)) {
    if (Date.now() > deadline) {
      console.error("scope-race FAIL: A never paused")
      process.exit(4)
    }
    await Bun.sleep(5)
  }
  const b1 = Bun.spawn(["bun", "scripts/lockcheck.ts", "scope-race", dataDir, rootId], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: repoRoot,
  })
  const rc1 = await b1.exited
  const out1 = await new Response(b1.stdout).text()
  if (rc1 !== 0 || !lastLine(out1).includes("lock_contention_observed")) {
    console.error("scope-race FAIL: first attempt must report lock contention")
    process.exit(5)
  }
  writeFileSync(`${dataDir}/resume-A`, "1")
  const outA = await new Response(a.stdout).text()
  const rcA = await a.exited
  const b2 = Bun.spawn(["bun", "scripts/lockcheck.ts", "scope-race", dataDir, rootId], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: repoRoot,
  })
  const rc2 = await b2.exited
  const out2 = await new Response(b2.stdout).text()
  const jA = JSON.parse(lastLine(outA))
  const j2 = JSON.parse(lastLine(out2))
  if (rcA !== 0 || rc2 !== 0 || jA.attempt !== "ok" || j2.attempt !== "ok") {
    console.error("scope-race FAIL: workers did not complete")
    process.exit(6)
  }
  if (jA.scopeId !== j2.scopeId) {
    console.error(`scope-race FAIL: two scopes ${jA.scopeId} vs ${j2.scopeId}`)
    process.exit(7)
  }
  console.log(`scope-race OK: contention reported once, single scope ${jA.scopeId}`)
}

async function main(): Promise<void> {
  const [cmd, dataDir, tag] = process.argv.slice(2)
  if (cmd === "put" && dataDir && tag) {
    await putWorker(dataDir, tag)
  } else if (cmd === "scope-race" && dataDir && tag) {
    await scopeRaceWorker(dataDir, tag, process.argv.slice(5))
  } else if (cmd === "scope-race-main" && dataDir && tag) {
    await scopeRaceMain(dataDir, tag)
  } else if (cmd === "aggregateRace" && dataDir) {
    await aggregateRaceMain(dataDir)
  } else if (cmd === "agg-race-writer" && dataDir) {
    await aggregateRaceWriter(dataDir)
  } else if (cmd === "agg-race-contest" && dataDir) {
    await aggregateRaceContest(dataDir)
  } else if (cmd === "agg-race-read" && dataDir) {
    await aggregateRaceRead(dataDir)
  } else {
    console.error("usage: lockcheck.ts put <dataDir> <tag> | scope-race <dataDir> <rootId> [pause] | scope-race-main <dataDir> <rootId> | aggregateRace <dataDir>")
    process.exit(1)
  }
}

await main()
