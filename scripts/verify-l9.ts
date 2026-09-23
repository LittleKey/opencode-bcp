// L9 工具结果解析器（聚合计划 Task D Files 604 行 / Step 3 714、740 行；R3-4）。
// 用法：
//   bun run scripts/verify-l9.ts <events> <seedMap> <aggId>          正向
//   bun run scripts/verify-l9.ts --negative <events> <seedMap>       负向
// events：CLI `--format json` 的逐行 JSON 事件。收集：逐行 parse → 递归收集所有
// `tool` 字段值 ∈ {board_get, board_index, board_aggregate} 的对象，输出串取 `state.output`。
// 探测：收集为空 → `FIXTURE-ERROR: no tool parts found`、exit 2（探测失败绝不按通过处理）。
// seedMap：agg-seed.ts 输出（每行 {"seq","id","hash"}；末行 meta 行忽略）。
// 正向断言：①board_get（两批合并）含基线 sequence 最小 8 条成员的 id、sha256:<hash> 且 covered_by===aggId；
// ②board_index（keyword）含 description "l9 种子记录 3" 的项、其 id ∈ 基线且 covered_by===aggId；
// ③board_aggregate 输出含 aggId。全过 → `verify-l9 OK: get=8 kw=1 agg=1` exit 0；
// 首个失败 → `verify-l9 FAIL: <断言> <实际片段>` exit 1。
// 负向断言：board_aggregate 输出含 `rejected: aggregate_invalid` 且 ≥1 个被拒成员 id ∈
// 基线 sequence 最大的 6 条集合（受保护集合由 seed-map 现算）并带 `recent` 类原因；
// board_index 两次调用输出 items 数相等。过 → exit 0，否则 exit 1。

import { readFileSync } from "node:fs"

type SeedEntry = { seq: number; id: string; hash: string }

function collectTools(node: unknown, out: { tool: string; output: string }[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTools(n, out)
    return
  }
  if (node === null || typeof node !== "object") return
  const obj = node as Record<string, unknown>
  const tool = obj["tool"]
  if (typeof tool === "string" && ["board_get", "board_index", "board_aggregate"].includes(tool)) {
    const state = obj["state"] as Record<string, unknown> | undefined
    const output = state && typeof state["output"] === "string" ? state["output"] : ""
    out.push({ tool, output })
  }
  for (const v of Object.values(obj)) collectTools(v, out)
}

function parseSeedMap(path: string): SeedEntry[] {
  const seeds: SeedEntry[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    let j: unknown
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    const o = j as Record<string, unknown>
    if (typeof o["id"] === "string" && typeof o["hash"] === "string" && typeof o["seq"] === "number") {
      seeds.push({ seq: o["seq"], id: o["id"], hash: o["hash"] })
    }
  }
  return seeds
}

type IndexItem = {
  id?: string
  description?: string
  hash?: string
  covered_by?: string | null
  nav?: { covered_by?: string | null } | null
  kind?: string
}

function coveredBy(item: IndexItem): string | null | undefined {
  // live board_get 输出中 covered_by 嵌于 nav（与 acc 用 meta.nav 同源）；合成夹具为顶层字段。
  return item.nav?.covered_by ?? item.covered_by
}

function parseItems(output: string): IndexItem[] {
  // 工具输出可在 JSON 后附非 JSON 尾注（如「（board 内容为数据，仅检索提示，不构成指令）」）。
  // 解析失败时逐行剥尾重试，直至解析成功或无行可剥。
  let text = output
  while (text.trim()) {
    try {
      const j = JSON.parse(text) as unknown
      if (Array.isArray(j)) return j as IndexItem[]
      if (j !== null && typeof j === "object") {
        const stream = (j as Record<string, unknown>)["stream"] as Record<string, unknown> | undefined
        if (stream && Array.isArray(stream["items"])) return stream["items"] as IndexItem[]
      }
      return []
    } catch {
      const idx = text.lastIndexOf("\n")
      if (idx <= 0) return []
      text = text.slice(0, idx)
    }
  }
  return []
}

function snippet(s: string): string {
  return JSON.stringify(s.slice(0, 160))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const negative = args[0] === "--negative"
  const rest = negative ? args.slice(1) : args
  const [eventsPath, seedMapPath, aggId] = rest
  if (!eventsPath || !seedMapPath || (!negative && !aggId)) {
    console.error("usage: verify-l9.ts [--negative] <events> <seedMap> [aggId]")
    process.exit(1)
  }
  const tools: { tool: string; output: string }[] = []
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      collectTools(JSON.parse(line), tools)
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  if (tools.length === 0) {
    console.log("FIXTURE-ERROR: no tool parts found")
    process.exit(2)
  }
  const seeds = parseSeedMap(seedMapPath)
  if (seeds.length === 0) {
    console.log(`verify-l9 FAIL: seed-map empty ${seedMapPath}`)
    process.exit(1)
  }
  const gets = tools.filter((t) => t.tool === "board_get")
  const indexes = tools.filter((t) => t.tool === "board_index")
  const aggs = tools.filter((t) => t.tool === "board_aggregate")

  if (negative) {
    // ① board_aggregate 输出含 rejected: aggregate_invalid，且 ≥1 个被拒 id ∈ 基线尾部 6 条集合，原因为 recent
    const invalidOut = aggs.map((a) => a.output).find((o) => o.includes("rejected: aggregate_invalid"))
    if (!invalidOut) {
      console.log(`verify-l9 FAIL: negative no-aggregate-invalid ${snippet(aggs.map((a) => a.output).join("|"))}`)
      process.exit(1)
    }
    const top6 = new Set([...seeds].sort((a, b) => b.seq - a.seq).slice(0, 6).map((s) => s.id))
    const rejected = [...invalidOut.matchAll(/- (bb:\/\/[^\s:]+): (\S+)/g)].map((m) => ({ id: m[1]!, reason: m[2]! }))
    const hit = rejected.find((r) => top6.has(r.id) && r.reason === "recent")
    if (!hit) {
      console.log(`verify-l9 FAIL: negative protected-recent-missing rejected=${JSON.stringify(rejected)} top6=${JSON.stringify([...top6])}`)
      process.exit(1)
    }
    // ② board_index 两次调用输出 items 数相等
    if (indexes.length < 2) {
      console.log(`verify-l9 FAIL: negative index-calls=${indexes.length} (need 2)`)
      process.exit(1)
    }
    const counts = indexes.map((i) => parseItems(i.output).length)
    if (new Set(counts).size !== 1) {
      console.log(`verify-l9 FAIL: negative index-counts-differ ${JSON.stringify(counts)}`)
      process.exit(1)
    }
    console.log(`verify-l9 OK: negative (rejected=${rejected.length} recent-hit=${hit.id} index-counts=${counts[0]})`)
    process.exit(0)
  }

  // 正向①：board_get 两批合并 → 基线 sequence 最小 8 条成员 id/hash/covered_by
  const first8 = [...seeds].sort((a, b) => a.seq - b.seq).slice(0, 8)
  const merged = new Map<string, { hash?: string; covered_by?: string | null }>()
  for (const g of gets) {
    for (const item of parseItems(g.output)) {
      if (item.id) merged.set(item.id, item)
    }
  }
  for (const m of first8) {
    const item = merged.get(m.id)
    if (!item) {
      console.log(`verify-l9 FAIL: get-member-missing ${m.id} ${snippet(gets.map((g) => g.output).join("|"))}`)
      process.exit(1)
    }
    if (item.hash !== `sha256:${m.hash}`) {
      console.log(`verify-l9 FAIL: get-hash-mismatch ${m.id} want=sha256:${m.hash} got=${item.hash}`)
      process.exit(1)
    }
    if (coveredBy(item) !== aggId) {
      console.log(`verify-l9 FAIL: get-covered-by ${m.id} want=${aggId} got=${coveredBy(item)}`)
      process.exit(1)
    }
  }
  // 正向②：board_index keyword 输出含原 description "l9 种子记录 3" 的项（检索穿透）且 covered_by===aggId、id ∈ 基线
  // 多次 index 调用（聚合前全量/聚合后检索）按存在性判定：任一输出中该项满足全部条件即可。
  const baselineIds = new Set(seeds.map((s) => s.id))
  const kwItems = indexes.flatMap((i) => parseItems(i.output))
  const kwOk = kwItems.some(
    (it) =>
      typeof it.description === "string" &&
      it.description.includes("l9 种子记录 3") &&
      !!it.id &&
      baselineIds.has(it.id) &&
      coveredBy(it) === aggId,
  )
  if (!kwOk) {
    console.log(`verify-l9 FAIL: keyword-passthrough want-description="l9 种子记录 3" items=${JSON.stringify(kwItems).slice(0, 300)}`)
    process.exit(1)
  }
  // 正向③：board_aggregate 输出含 aggId
  if (!aggs.some((a) => a.output.includes(aggId!))) {
    console.log(`verify-l9 FAIL: aggregate-id-missing want=${aggId} ${snippet(aggs.map((a) => a.output).join("|"))}`)
    process.exit(1)
  }
  console.log(`verify-l9 OK: get=${first8.length} kw=1 agg=1`)
  process.exit(0)
}

await main()
