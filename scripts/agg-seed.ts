// live 种子夹具（聚合计划 Task D Interfaces 612–618 行；按 orchestrator 指派随 Task A 先行创建）。
// 用法：bun run scripts/agg-seed.ts <sessionId> <count> [dataDir]
// 定位：扫描 <dataDir || bbV1Root()>/scope-index.json 找已注册 sessionId 的 scope → openScopeById + resolveSession
// 行为（withLock）：写 meta.rounds={current_round:45,round_known:true,last_admitted_message_id:"agg-seed"} →
//   put <count> 条（description=`l9 种子记录 <n>`、content 自包含说明；writer=session_index 的 agent/session、
//   message_id=`agg-seed-<n>`、created_round=45）→ 写 meta.rounds.current_round=49（age=4>2 过 fence；
//   受信验收夹具直接写轮次，不经过 chat.message 路径）。
// 输出契约：每行 `{"seq":N,"id":"bb://…","hash":"<该条 entry 的 sha256 hex>"}`（hash 供 verify-l9 基线绑定
// 成员原 hash，M-C2）；末行 `{"meta":"<本流 metadata.json 绝对路径>"}`；exit 0。
// 编号约定：种子 description 从 1 编号（"l9 种子记录 1..<count>"，seq=high_water+1..）；L9-1 的会话首条
// 记录（"l9 会话首条记录"，seq 1）不属于种子命名空间、不参与成员选择、不在本基线内。

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { bbV1Root, openScopeById, type Scope } from "../src/storage"

function findScopeBySession(dataDir: string | undefined, sessionId: string): { scope: Scope; streamId: string; agent: string } {
  const root = dataDir ?? bbV1Root()
  const indexPath = join(root, "scope-index.json")
  if (!existsSync(indexPath)) throw new Error(`scope-index not found: ${indexPath}`)
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { scopes: Record<string, string> }
  for (const scopeId of Object.values(index.scopes)) {
    const scope = openScopeById(scopeId, { dataDir: root })
    const entry = scope.config.session_index[sessionId]
    if (entry) return { scope, streamId: entry.stream_id, agent: entry.agent }
  }
  throw new Error(`unknown_session: ${sessionId}`)
}

async function main(): Promise<void> {
  const [sessionId, countArg, dataDir] = process.argv.slice(2)
  const count = Number(countArg)
  if (!sessionId || !Number.isInteger(count) || count < 1) {
    console.error("usage: bun run scripts/agg-seed.ts <sessionId> <count> [dataDir]")
    process.exit(1)
  }
  const { scope, streamId, agent } = findScopeBySession(dataDir, sessionId)
  const written: { seq: number; id: string; hash: string }[] = []
  scope.withLock(() => {
    const meta = scope.readMeta(streamId)
    meta.rounds = { current_round: 45, round_known: true, last_admitted_message_id: "agg-seed" }
    scope.writeMeta(streamId, meta)
    for (let n = 1; n <= count; n++) {
      const r = scope.put(streamId, {
        writer: { agent, session_id: sessionId, message_id: `agg-seed-${n}` },
        createdRound: 45,
        description: `l9 种子记录 ${n}`,
        content: `l9 种子记录 ${n}：一段自包含说明，可独立阅读，不依赖其他条目；供聚合成员选择与关键词检索断言使用。`,
      })
      if (r.status !== "stored") {
        console.error(`agg-seed put failed at n=${n}: ${JSON.stringify(r)}`)
        process.exit(1)
      }
      written.push({ seq: r.sequence, id: r.id, hash: r.hash })
    }
    const after = scope.readMeta(streamId)
    after.rounds = { ...after.rounds, current_round: 49 }
    scope.writeMeta(streamId, after)
  })
  for (const w of written) console.log(JSON.stringify(w))
  console.log(JSON.stringify({ meta: join(scope.dir, "streams", streamId, "metadata.json") }))
}

await main()
