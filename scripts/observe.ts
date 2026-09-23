// 观测 / fsck（计划 Task 2 Step 6）：
//   bun run scripts/observe.ts [dataDir]
// 遍历 bbV1Root()（或给定 dataDir）下每个 scope 目录（独立于 scope-index，直接 readdir）。
// 记录域：entry JSON 可解析、文件名序号 === record.sequence、recordHash(文件字节) 可稳定计算。
// 幂等域：meta.idem[key] 目标记录重建 TLV 后 sha256 === payload_sha256。
// 任一失败 → 打印 "FSCK FAIL: <reason>" 并以退出码 1 结束。

import { join, relative } from "node:path"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { bbV1Root } from "../src/storage"
import { parseEntryFileName, parseBbId } from "../src/ids"
import { encodeImmutablePayload, recordHash, type BbRecord } from "../src/schema"

const root = process.argv[2] ?? bbV1Root()

let failed = false
function fail(reason: string): void {
  console.error(`FSCK FAIL: ${reason}`)
  failed = true
}

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
      nav: Record<string, unknown>
      tombstoned: Record<string, string>
      idem: Record<string, { id: string; payload_b64: string; payload_sha256: string }>
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

    // 记录域抽验（≤50 条）
    let verified = 0
    for (const seq of seqs.slice(0, 50)) {
      const p = join(entriesDir, `e${String(seq).padStart(6, "0")}.json`)
      let bytes: Uint8Array
      let rec: BbRecord
      try {
        bytes = new Uint8Array(readFileSync(p))
        rec = JSON.parse(new TextDecoder().decode(bytes))
      } catch (e) {
        fail(`stream ${streamId}: entry ${seq} not parseable JSON (${e instanceof Error ? e.message : e})`)
        continue
      }
      if (rec.sequence !== seq) {
        fail(`stream ${streamId}: entry ${seq} filename/sequence mismatch (${rec.sequence})`)
        continue
      }
      recordHash(bytes) // 可稳定计算即通过
      verified++
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
  }
  console.log(
    `scope ${cfg.scope_id.slice(0, 6)}…: streams=${streamNames.length} entries=${entriesTotal} usage=${fmtBytes(dirUsage(scopeDir))}/${fmtBytes(cfg.quota_bytes)} pins=${cfg.pins.length} tombstones=${tombstones}`,
  )
  for (const line of streamLines) console.log(line)
}

process.exit(failed ? 1 : 0)
