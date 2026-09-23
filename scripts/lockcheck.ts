// 并发真实性检查（P11：同进程 Promise.all 不构成并发）。
// 用法：
//   bun run scripts/lockcheck.ts put <dataDir> <tag>
//   bun run scripts/lockcheck.ts scope-race <dataDir> <rootId> [pause]
//   bun run scripts/lockcheck.ts scope-race-main <dataDir> <rootId>

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
  } else {
    console.error("usage: lockcheck.ts put <dataDir> <tag> | scope-race <dataDir> <rootId> [pause] | scope-race-main <dataDir> <rootId>")
    process.exit(1)
  }
}

await main()
