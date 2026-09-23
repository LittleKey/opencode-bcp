// G2 parent 补写编排协议 —— 派发前/后检查脚本（计划 Task 3；DESIGN §10.5；
// 协议文档：docs/orchestrator/parent-repair-protocol.md）。
// 用法：bun run scripts/parent-repair-check.ts --file <input.json>（或 stdin JSON）。
// dry-run 语义：只读检查——不派发、不写板；preflight 不要求 published_record_id 存在。
// 模式与退出码：
//   preflight  —— 派发前：仅执行 A 阶段（C1/C2/C5/C3a），不读板；A 全 PASS → rc=0；任一 FAIL/UNVERIFIABLE → rc=1。
//   postflight —— 补写后：A+B 全部执行；published_record_id 必填；A+B 全 PASS → rc=0；任一 FAIL/UNVERIFIABLE → rc=1。

import { openScopeById, type Scope } from "../src/storage"
import { parseBbId } from "../src/ids"
import type { BbRecord } from "../src/schema"

export type RepairCheckMode = "preflight" | "postflight"

/** 检查输入（最小受信输入；每字段来源与观察时点由调用方声明）。 */
export type RepairCheckInput = {
  mode: RepairCheckMode
  /** child session 所属 scope（调用方经 scope-index.json 解析后传入；仅 postflight 需要；脚本不跨 scope 枚举） */
  scope?: { scope_id: string; data_dir?: string }
  original_execution: { child_session: string; child_agent: string; target_ref: string }
  parent: { session: string; agent: string }
  dispatch_proof: { explicit_agent_given: boolean; agent_param: string; at: string }
  lifecycle: { terminal: boolean; reused: boolean; observed_via: string; at: string }
  authorization: { scope_member: boolean; board_permission_ok: boolean }
  published_record_id?: string
}

export type CheckId = "C1" | "C2" | "C3a" | "C3b" | "C4" | "C5" | "C6"
export type Verdict = "PASS" | "FAIL" | "UNVERIFIABLE"
export type CheckResult = { id: CheckId; verdict: Verdict; detail: string }
export type CheckReport = { mode: RepairCheckMode; results: CheckResult[]; exit_code: 0 | 1 }

/** C4/C6 归一化：去首尾空白 + 连续空白折叠为单个空格（协议文档 §5）。 */
export function normalizeTargetRef(s: string): string {
  return s.trim().replace(/\s+/g, " ")
}

type Rec = Record<string, unknown>
function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function checkC6(
  scopeId: string | undefined,
  dataDir: string | undefined,
  targetRef: string | undefined,
  parentSession: string | undefined,
  record: BbRecord | undefined,
): CheckResult {
  const gaps: string[] = []
  if (targetRef === undefined) gaps.push("target_ref 缺失")
  if (parentSession === undefined) gaps.push("parent.session 缺失")
  if (scopeId === undefined) gaps.push("scope.scope_id 缺失（child session 所属 scope 由调用方解析后传入）")
  if (gaps.length > 0) return { id: "C6", verdict: "UNVERIFIABLE", detail: gaps.join("; ") }

  let scope: Scope
  try {
    scope = openScopeById(scopeId!, dataDir === undefined ? undefined : { dataDir })
  } catch (e) {
    return { id: "C6", verdict: "UNVERIFIABLE", detail: `scope 无法打开: ${msg(e)}` }
  }
  // stream 枚举 = scope.json.session_index[*].stream_id 去重集合（不是 scope-index.json——那只是 root session → scope 映射）
  let streamIds: string[]
  try {
    const cfg = scope.config
    streamIds = [
      ...new Set(
        Object.values(cfg.session_index ?? {})
          .map((e) => asStr((e as Rec | undefined)?.["stream_id"]))
          .filter((s): s is string => s !== undefined),
      ),
    ]
  } catch (e) {
    return { id: "C6", verdict: "UNVERIFIABLE", detail: `scope.json/session_index 不可读: ${msg(e)}` }
  }
  if (streamIds.length === 0) {
    return { id: "C6", verdict: "UNVERIFIABLE", detail: "scope.json.session_index 为空——stream 枚举为空集，覆盖不完整" }
  }
  if (record !== undefined && !streamIds.includes(record.stream_id)) {
    return {
      id: "C6",
      verdict: "UNVERIFIABLE",
      detail: `声称补写记录所在 stream ${record.stream_id} 不在 session_index 注册集合——枚举覆盖不完整`,
    }
  }

  // 范围 = publication_for 归一化后 === target_ref ∪ source_refs/related 包含 target_ref；遍历按 high_water 全量扫完
  const violations: string[] = []
  const readGaps: string[] = []
  let matched = 0
  scope.withLock(() => {
    for (const sid of streamIds) {
      let highWater: number
      try {
        highWater = scope.readMeta(sid).high_water
      } catch (e) {
        readGaps.push(`stream ${sid} metadata.json 不可读: ${msg(e)}`)
        continue
      }
      for (let seq = 1; seq <= highWater; seq++) {
        let rec: BbRecord | null
        try {
          rec = scope.readEntry(sid, seq)
        } catch (e) {
          readGaps.push(`stream ${sid} entry e${String(seq).padStart(6, "0")} 不可读: ${msg(e)}`)
          continue
        }
        if (rec === null) continue // 合法序号空洞（失败预留），不当计数、不报错
        if (!inQueryRange(rec, targetRef!)) continue
        matched++
        if (rec.writer.session_id === parentSession!) {
          violations.push(`${rec.id} writer.session_id=${rec.writer.session_id} === parent.session（代写）`)
        }
      }
    }
  })
  if (violations.length > 0) {
    return {
      id: "C6",
      verdict: "FAIL",
      detail: `范围内（target_ref=${targetRef}，streams=${streamIds.length}，匹配 ${matched} 条）发现 parent 代写记录: ${violations.join("; ")}`,
    }
  }
  if (readGaps.length > 0) {
    return { id: "C6", verdict: "UNVERIFIABLE", detail: `遍历未完成（缺口清单）: ${readGaps.join("; ")}` }
  }
  return {
    id: "C6",
    verdict: "PASS",
    detail: `已枚举 session_index 去重 stream ${streamIds.length} 条、按 high_water 全量扫完（匹配 ${matched} 条），范围内无 parent 代写`,
  }
}

function inQueryRange(rec: BbRecord, target: string): boolean {
  const t = normalizeTargetRef(target)
  if (rec.publication_for !== undefined && normalizeTargetRef(rec.publication_for) === t) return true
  for (const r of rec.source_refs ?? []) if (normalizeTargetRef(r) === t) return true
  for (const r of rec.related ?? []) if (normalizeTargetRef(r) === t) return true
  return false
}

export function runChecks(raw: unknown): CheckReport {
  const input = asRec(raw)
  const mode = input === undefined ? undefined : asStr(input["mode"])
  if (mode !== "preflight" && mode !== "postflight") {
    throw new Error(`mode 必须为 "preflight" | "postflight"，得到 ${JSON.stringify(mode ?? null)}`)
  }
  const post = mode === "postflight"
  const oe = input === undefined ? undefined : asRec(input["original_execution"])
  const childSession = oe === undefined ? undefined : asStr(oe["child_session"])
  const childAgent = oe === undefined ? undefined : asStr(oe["child_agent"])
  const targetRef = oe === undefined ? undefined : asStr(oe["target_ref"])
  const parent = input === undefined ? undefined : asRec(input["parent"])
  const parentSession = parent === undefined ? undefined : asStr(parent["session"])
  const dp = input === undefined ? undefined : asRec(input["dispatch_proof"])
  const explicitGiven = dp === undefined ? undefined : asBool(dp["explicit_agent_given"])
  const agentParam = dp === undefined ? undefined : asStr(dp["agent_param"])
  const lc = input === undefined ? undefined : asRec(input["lifecycle"])
  const terminal = lc === undefined ? undefined : asBool(lc["terminal"])
  const reused = lc === undefined ? undefined : asBool(lc["reused"])
  const observedVia = lc === undefined ? undefined : asStr(lc["observed_via"])
  const lcAt = lc === undefined ? undefined : asStr(lc["at"])
  const az = input === undefined ? undefined : asRec(input["authorization"])
  const scopeMember = az === undefined ? undefined : asBool(az["scope_member"])
  const boardPerm = az === undefined ? undefined : asBool(az["board_permission_ok"])

  const results: CheckResult[] = []

  // C1 已终结：original_execution 与 lifecycle 完整且 terminal===true（缺字段→UNVERIFIABLE，不得假 PASS）
  if (
    childSession === undefined ||
    childAgent === undefined ||
    targetRef === undefined ||
    terminal === undefined ||
    reused === undefined ||
    observedVia === undefined ||
    lcAt === undefined
  ) {
    results.push({
      id: "C1",
      verdict: "UNVERIFIABLE",
      detail:
        "original_execution（child_session/child_agent/target_ref）或 lifecycle（terminal/reused/observed_via/at）字段缺失——证据不完整不得假 PASS",
    })
  } else if (terminal !== true) {
    results.push({ id: "C1", verdict: "FAIL", detail: `lifecycle.terminal=false（observed_via=${observedVia} @${lcAt}）——child 未终结，不得介入` })
  } else {
    results.push({ id: "C1", verdict: "PASS", detail: `child=${childSession}/${childAgent} 已终结（observed_via=${observedVia} @${lcAt}）` })
  }

  // C2 未复用
  if (reused === undefined) {
    results.push({ id: "C2", verdict: "UNVERIFIABLE", detail: "lifecycle.reused 缺失" })
  } else if (reused) {
    results.push({ id: "C2", verdict: "FAIL", detail: "lifecycle.reused=true——child 会话身份已被复用" })
  } else {
    results.push({ id: "C2", verdict: "PASS", detail: "未复用" })
  }

  // C5 显式传原 agent（不回退默认 agent）
  if (explicitGiven === undefined || agentParam === undefined || childAgent === undefined) {
    results.push({ id: "C5", verdict: "UNVERIFIABLE", detail: "dispatch_proof（explicit_agent_given/agent_param）或 child_agent 缺失" })
  } else if (!explicitGiven) {
    results.push({
      id: "C5",
      verdict: "FAIL",
      detail: `explicit_agent_given=false——派发参数未显式传原 agent（即使默认 agent 恰为 ${childAgent} 也不允许回退 defaultInfo()）`,
    })
  } else if (agentParam === "") {
    results.push({ id: "C5", verdict: "FAIL", detail: "agent_param 为空串——等同省略 agent" })
  } else if (agentParam !== childAgent) {
    results.push({ id: "C5", verdict: "FAIL", detail: `agent_param=${agentParam} ≠ child_agent=${childAgent}` })
  } else {
    results.push({ id: "C5", verdict: "PASS", detail: `显式传原 agent=${agentParam}` })
  }

  // C3a 派发前权限确认
  if (scopeMember === undefined || boardPerm === undefined) {
    results.push({ id: "C3a", verdict: "UNVERIFIABLE", detail: "authorization.scope_member / board_permission_ok 缺失——派发前权限确认结果不完整" })
  } else if (scopeMember && boardPerm) {
    results.push({ id: "C3a", verdict: "PASS", detail: "scope 成员资格 ∧ board 权限已确认" })
  } else {
    results.push({ id: "C3a", verdict: "FAIL", detail: `scope_member=${scopeMember} board_permission_ok=${boardPerm}` })
  }

  if (!post) {
    return { mode, results, exit_code: results.every((r) => r.verdict === "PASS") ? 0 : 1 }
  }

  // ---- B 阶段（仅 postflight，读板）----
  const scopeField = input === undefined ? undefined : asRec(input["scope"])
  const scopeId = scopeField === undefined ? undefined : asStr(scopeField["scope_id"])
  const dataDir = scopeField === undefined ? undefined : asStr(scopeField["data_dir"])
  const recordId = input === undefined ? undefined : asStr(input["published_record_id"])

  // 解析声称的补写记录（C3b/C4 共用；C6 仅用其 stream 做枚举覆盖一致性检查）
  let record: BbRecord | undefined
  const resolveGaps: string[] = []
  if (recordId === undefined) {
    resolveGaps.push("published_record_id 缺失（postflight 必填）")
  } else {
    let parsed: ReturnType<typeof parseBbId> | undefined
    try {
      parsed = parseBbId(recordId)
    } catch {
      resolveGaps.push(`published_record_id 无法解析: ${recordId}`)
    }
    if (parsed !== undefined) {
      if (scopeId === undefined) {
        resolveGaps.push("scope.scope_id 缺失（postflight 必填）")
      } else if (parsed.scopeId !== scopeId) {
        resolveGaps.push(`published_record_id 属 scope ${parsed.scopeId}，≠ 输入 scope ${scopeId}（脚本不跨 scope 查询）`)
      } else {
        const { streamId, seq } = parsed
        try {
          const scope = openScopeById(scopeId, dataDir === undefined ? undefined : { dataDir })
          record = scope.withLock(() => scope.readEntry(streamId, seq)) ?? undefined
          if (record === undefined) resolveGaps.push(`声称的补写记录不存在: ${recordId}`)
        } catch (e) {
          resolveGaps.push(`board 读取失败: ${msg(e)}`)
        }
      }
    }
  }
  const gapText = resolveGaps.join("; ")

  // C3b 原作者确认：记录 writer === child
  if (record === undefined) {
    results.push({ id: "C3b", verdict: "UNVERIFIABLE", detail: gapText === "" ? "记录不可读" : gapText })
  } else if (childSession !== undefined && childAgent !== undefined && record.writer.session_id === childSession && record.writer.agent === childAgent) {
    results.push({ id: "C3b", verdict: "PASS", detail: `${record.id} writer=${record.writer.session_id}/${record.writer.agent} === 原作者` })
  } else {
    results.push({
      id: "C3b",
      verdict: "FAIL",
      detail: `${record.id} writer=${record.writer.session_id}/${record.writer.agent} ≠ 原作者 ${childSession ?? "?"}/${childAgent ?? "?"}`,
    })
  }

  // C4 目标一致：publication_for 归一化后 === target_ref
  if (record === undefined) {
    results.push({ id: "C4", verdict: "UNVERIFIABLE", detail: gapText === "" ? "记录不可读" : gapText })
  } else if (targetRef === undefined) {
    results.push({ id: "C4", verdict: "UNVERIFIABLE", detail: "target_ref 缺失" })
  } else if (record.publication_for === undefined) {
    results.push({ id: "C4", verdict: "FAIL", detail: `${record.id} 缺 publication_for——补写记录必须标 publication_for` })
  } else if (normalizeTargetRef(record.publication_for) === normalizeTargetRef(targetRef)) {
    results.push({ id: "C4", verdict: "PASS", detail: `publication_for 归一化后 === target_ref（${normalizeTargetRef(targetRef)}）` })
  } else {
    results.push({ id: "C4", verdict: "FAIL", detail: `publication_for=${record.publication_for} 归一化后 ≠ target_ref=${targetRef}` })
  }

  // C6 不代写（跨流枚举查询，见协议文档 §4）
  results.push(checkC6(scopeId, dataDir, targetRef, parentSession, record))

  return { mode, results, exit_code: results.every((r) => r.verdict === "PASS") ? 0 : 1 }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const fi = argv.indexOf("--file")
  let rawText: string
  try {
    rawText = fi >= 0 && argv[fi + 1] !== undefined ? await Bun.file(argv[fi + 1]!).text() : await Bun.stdin.text()
  } catch (e) {
    console.error(`ERROR: 读取输入失败: ${msg(e)}`)
    return 1
  }
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch (e) {
    console.error(`ERROR: 输入 JSON 不可解析: ${msg(e)}`)
    return 1
  }
  try {
    const rep = runChecks(raw)
    console.log(`mode=${rep.mode}`)
    for (const r of rep.results) console.log(`${r.id} ${r.verdict} ${r.detail}`)
    if (rep.mode === "preflight") console.log("B 阶段未执行（preflight 只读输入，不读板；published_record_id 不要求）")
    console.log(`exit=${rep.exit_code}`)
    return rep.exit_code
  } catch (e) {
    console.error(`ERROR: ${msg(e)}`)
    return 1
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code))
}
