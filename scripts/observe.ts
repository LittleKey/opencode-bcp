// 观测 / fsck（计划 Task 2 Step 6 + Task D Step 0 + Task E Step 1）：
//   bun run scripts/observe.ts [dataDir] [--recover] [--projection <metaAbsPath> <outFile>]
// 遍历 bbV1Root()（或给定 dataDir）下每个 scope 目录（独立于 scope-index，直接 readdir）。
// 记录域：entry JSON 可解析、文件名序号 === record.sequence、recordHash(文件字节) 可稳定计算。
// 幂等域：meta.idem[key] 目标记录重建 TLV 后 sha256 === payload_sha256。
// 聚合域（Task D Step 0 / E Step 1，I7）：
//   covered_by 双向一致性——正向：nav[id].covered_by=S → S 存在、kind==="index_summary"、
//   S.members 含 {id,hash} 且 hash===recordHash(entry 字节)（members 哈希全量，无采样）；
//   反向：每个 S.members 条目 → nav[m.id].covered_by===S.id；
//   agg_pending：非 null 且未带 --recover → FAIL；--recover 先锁内 recover（fix-8：D 先 E 复核）。
// 任一失败 → 打印 "FSCK FAIL: <reason>" 并以退出码 1 结束。

import { join } from "node:path"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { bbV1Root, openScopeById } from "../src/storage"
import { parseEntryFileName, parseBbId } from "../src/ids"
import { encodeImmutablePayload, recordHash, type BbRecord } from "../src/schema"

const argv = process.argv.slice(2)
const recoverMode = argv.includes("--recover")
const projIdx = argv.indexOf("--projection")
const projMeta = projIdx >= 0 ? argv[projIdx + 1] : undefined
const projOut = projIdx >= 0 ? argv[projIdx + 2] : undefined
const projSlots = projIdx >= 0 ? new Set([projIdx, projIdx + 1, projIdx + 2]) : new Set<number>()
const positional = argv.filter((a, i) => !a.startsWith("--") && !projSlots.has(i))
const root = positional[0] ?? bbV1Root()

let failed = false
function fail(reason: string): void {
  console.error(`FSCK FAIL: ${reason}`)
  failed = true
}

// --projection（I8）：仅输出聚合相关投影 {nav, high_water, tombstoned}（排除 rounds/budget/idem/created_at——
// 新业务 run 会合法改变轮次与预算，不得参与 before/after 比较）与 entries 全量 {seq: recordHash(entryBytes)}。
if (projIdx >= 0) {
  if (!projMeta || !projOut || !existsSync(projMeta)) {
    console.error(`PROJ-FAIL: metadata missing: ${projMeta}`)
    process.exit(1)
  }
  const meta = JSON.parse(readFileSync(projMeta, "utf8")) as {
    nav: unknown
    high_water: number
    tombstoned: unknown
  }
  const entriesDir = join(projMeta, "..", "entries")
  const entries: Record<string, string> = {}
  for (const en of existsSync(entriesDir) ? readdirSync(entriesDir) : []) {
    const seq = parseEntryFileName(en)
    if (seq === null) continue
    entries[String(seq)] = recordHash(new Uint8Array(readFileSync(join(entriesDir, en))))
  }
  mkdirSync(join(projOut, ".."), { recursive: true })
  writeFileSync(projOut, JSON.stringify({ nav: meta.nav, high_water: meta.high_water, tombstoned: meta.tombstoned, entries }))
  process.exit(0)
}

let recovered = 0

for (const name of readdirSync(root)) {
  const scopeDir = join(root, name)
  if (!statSync(scopeDir).isDirectory()) continue
  const scopeJsonPath = join(scopeDir, "scope.json")
  if (!existsSync(scopeJsonPath)) {
    fail(`scope ${name}: scope.json missing`)
    continue
  }
  const cfg = JSON.parse(readFileSync(scopeJsonPath, "utf8")) as {
    scope_id: string
    quota_bytes: number
    pins: string[]
  }
  // fix-8（D Step 0 先行）：--recover 遍历每个 stream，锁内调用 Scope.recover
  if (recoverMode) {
    const scope = openScopeById(cfg.scope_id, { dataDir: root })
    const streamsDir0 = join(scopeDir, "streams")
    for (const streamId of existsSync(streamsDir0) ? readdirSync(streamsDir0) : []) {
      scope.withLock(() => {
        const before = scope.readMeta(streamId)
        if ((before.agg_pending ?? null) !== null) {
          scope.recover(streamId)
          recovered++
        }
      })
    }
  }
  const streamsDir = join(scopeDir, "streams")
  const streamNames = existsSync(streamsDir) ? readdirSync(streamsDir) : []
  let entriesTotal = 0
  let tombstones = 0
  const streamLines: string[] = []
  for (const streamId of streamNames) {
    const streamDir = join(streamsDir, streamId)
    const metaPath = join(streamDir, "metadata.json")
    if (!existsSync(metaPath)) {
      fail(`stream ${streamId}: metadata.json missing`)
      continue
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      high_water: number
      nav: Record<string, { superseded_by?: unknown; covered_by?: string | null }>
      tombstoned: Record<string, string>
      idem: Record<string, { id: string; payload_b64: string; payload_sha256: string }>
      agg_pending?: unknown
    }
    tombstones += Object.keys(meta.tombstoned).length
    const entriesDir = join(streamDir, "entries")
    if (!existsSync(entriesDir)) {
      fail(`stream ${streamId}: entries dir missing`)
      continue
    }
    const entryNames = readdirSync(entriesDir).filter((n) => !n.startsWith(".tmp-"))
    const seqs: number[] = []
    for (const en of entryNames) {
      const seq = parseEntryFileName(en)
      if (seq === null) fail(`stream ${streamId}: unexpected file ${en} in entries/`)
      else seqs.push(seq)
    }
    seqs.sort((a, b) => a - b)
    const maxFileSeq = seqs.length > 0 ? seqs[seqs.length - 1]! : 0
    if (maxFileSeq > meta.high_water) {
      fail(`stream ${streamId}: max_file_seq ${maxFileSeq} > high_water ${meta.high_water}`)
    }
    const gaps = maxFileSeq - seqs.length
    entriesTotal += seqs.length

    // 全量载入（聚合域校验需要 members 哈希全量；记录域抽验仍 ≤50 条）
    const recs = new Map<number, BbRecord>()
    const bytesOf = new Map<number, Uint8Array>()
    let verified = 0
    for (const seq of seqs) {
      const p = join(entriesDir, `e${String(seq).padStart(6, "0")}.json`)
      let bytes: Uint8Array
      let rec: BbRecord
      try {
        bytes = new Uint8Array(readFileSync(p))
        rec = JSON.parse(new TextDecoder().decode(bytes)) as BbRecord
      } catch (e) {
        fail(`stream ${streamId}: entry ${seq} not parseable JSON (${e instanceof Error ? e.message : e})`)
        continue
      }
      if (rec.sequence !== seq) {
        fail(`stream ${streamId}: entry ${seq} filename/sequence mismatch (${rec.sequence})`)
        continue
      }
      recordHash(bytes) // 可稳定计算即通过
      recs.set(seq, rec)
      bytesOf.set(seq, bytes)
      if (verified < 50) verified++
    }

    // 聚合域（Task D Step 0 / E Step 1）：covered 双向一致 + members 哈希全量 + agg_pending
    const failedEdges = new Set<string>()
    let covered = 0
    const recBySeq = (id: string): BbRecord | undefined => {
      try {
        return recs.get(parseBbId(id).seq)
      } catch {
        return undefined
      }
    }
    for (const [id, edge] of Object.entries(meta.nav)) {
      const cb = edge?.covered_by ?? null
      if (!cb) continue
      covered++
      const summary = recBySeq(cb)
      const member = recBySeq(id)
      if (!summary || summary.kind !== "index_summary" || !member) {
        fail(`stream ${streamId}: covered edge orphan ${id}`)
        failedEdges.add(id)
        continue
      }
      const m = summary.members?.find((x) => x.id === id)
      const bytes = member ? bytesOf.get(parseBbId(id).seq) : undefined
      if (!m || !bytes || recordHash(bytes) !== m.hash) {
        fail(`stream ${streamId}: covered edge mismatch ${id}`)
        failedEdges.add(id)
      }
    }
    for (const rec of recs.values()) {
      if (rec.kind !== "index_summary" || !rec.members) continue
      for (const m of rec.members) {
        let seq = -1
        try {
          seq = parseBbId(m.id).seq
        } catch {
          fail(`stream ${streamId}: covered edge reverse-missing ${m.id}`)
          failedEdges.add(m.id)
          continue
        }
        if (meta.nav[m.id]?.covered_by !== rec.id) {
          fail(`stream ${streamId}: covered edge reverse-missing ${m.id}`)
          failedEdges.add(m.id)
        }
        const bytes = bytesOf.get(seq)
        if (!bytes || recordHash(bytes) !== m.hash) {
          fail(`stream ${streamId}: covered edge mismatch ${m.id}`)
          failedEdges.add(m.id)
        }
      }
    }
    const aggPending = (meta.agg_pending ?? null) !== null
    if (aggPending && !recoverMode) {
      fail(`agg_pending unrecovered ${streamId}`)
    }

    // 幂等域校验（全量 idem 键）
    for (const [key, entry] of Object.entries(meta.idem)) {
      let target: { scopeId: string; streamId: string; seq: number }
      try {
        target = parseBbId(entry.id)
      } catch {
        fail(`stream ${streamId}: idem[${key}] malformed id ${entry.id}`)
        continue
      }
      if (target.scopeId !== cfg.scope_id || target.streamId !== streamId) {
        fail(`stream ${streamId}: idem[${key}] id ${entry.id} cross-stream`)
        continue
      }
      const p = join(entriesDir, `e${String(target.seq).padStart(6, "0")}.json`)
      if (!existsSync(p)) {
        fail(`stream ${streamId}: idem[${key}] target entry missing`)
        continue
      }
      try {
        const rec = JSON.parse(new TextDecoder().decode(readFileSync(p))) as BbRecord
        const input = {
          description: rec.description,
          content: rec.content,
          ...(rec.kind !== undefined ? { kind: rec.kind } : {}),
          ...(rec.source_refs !== undefined ? { source_refs: rec.source_refs } : {}),
          ...(rec.related !== undefined ? { related: rec.related } : {}),
          ...(rec.supersedes !== undefined ? { supersedes: rec.supersedes } : {}),
          ...(rec.publication_for !== undefined ? { publication_for: rec.publication_for } : {}),
        }
        const sha = recordHash(encodeImmutablePayload(input))
        if (sha !== entry.payload_sha256) {
          fail(`stream ${streamId}: idem[${key}] payload hash mismatch`)
        }
      } catch (e) {
        fail(`stream ${streamId}: idem[${key}] rebuild failed (${e instanceof Error ? e.message : e})`)
      }
    }

    streamLines.push(
      `  stream ${streamId.slice(0, 6)}…: high_water=${meta.high_water} max_file_seq=${maxFileSeq} gaps=${gaps} hash_sample=${verified}/${seqs.length} ${verified === seqs.length ? "ok" : "FAIL"}`,
    )
    streamLines.push(
      `  aggregate: covered=${covered} members_mismatch=${failedEdges.size} unrecovered=${aggPending ? 1 : 0}`,
    )
  }
  console.log(
    `scope ${cfg.scope_id.slice(0, 6)}…: streams=${streamNames.length} entries=${entriesTotal} usage=${fmtBytes(dirUsage(scopeDir))}/${fmtBytes(cfg.quota_bytes)} pins=${cfg.pins.length} tombstones=${tombstones}`,
  )
  for (const line of streamLines) console.log(line)
}

if (recoverMode) console.log(`recovered ${recovered} aggregate`)
process.exit(failed ? 1 : 0)

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KiB`
  return `${n}B`
}

function dirUsage(dir: string): number {
  let total = 0
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else total += st.size
    }
  }
  walk(dir)
  return total
}
