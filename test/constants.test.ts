// T1 golden：认知契约常量与 DESIGN.md v1.6.1 §11.6/§10.2 逐字节对照（防契约漂移）。
// v1.6.0 信号退役：入口模板① golden 已废除，仅保留压力模板②与常驻决策规则文案。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PRESSURE_REMINDER_TEMPLATE, TASK_DESC_APPEND, TOOL_DESCRIPTIONS, AUTO_CAPTURE_INSTRUCTION, AUTO_TASK_DESC_APPEND, AUTO_TOOL_DESCRIPTIONS } from "../src/constants"
import { defineBoardTools } from "../src/tools"
import { STORE_DESCRIPTION } from "../src/message-store"

const design = readFileSync(join(import.meta.dir, "..", "DESIGN.md"), "utf8")

test("reference-first descriptions match their versioned contract", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "docs/catalog-discovery-v1.19.md"), "utf8")
  const blocks = [...doc.matchAll(/```text\n([\s\S]*?)\n```/g)].map(x => x[1])
  expect(blocks).toEqual([AUTO_CAPTURE_INSTRUCTION, AUTO_TOOL_DESCRIPTIONS.board_index])
  expect(AUTO_TOOL_DESCRIPTIONS).not.toHaveProperty("board_put")
})

test("unchanged public-source and task descriptions retain their versioned contract", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "docs/public-source-v1.17.md"), "utf8")
  expect([...doc.matchAll(/```text\n([\s\S]*?)\n```/g)].map(x => x[1]).slice(1)).toEqual([STORE_DESCRIPTION, AUTO_TASK_DESC_APPEND])
})

/** 提取 [startHeader, endHeader) 区间内全部 ```text 围栏块，按文档顺序返回 */
function sectionTextBlocks(startHeader: string, endHeader: string): string[] {
  const lines = design.split("\n")
  const start = lines.findIndex((l) => l.startsWith(startHeader))
  const end = lines.findIndex((l) => l.startsWith(endHeader))
  if (start < 0 || end < 0 || start >= end) throw new Error(`DESIGN.md ${startHeader}/${endHeader} 定位失败`)
  const blocks: string[] = []
  for (let i = start; i < end; i++) {
    if (!lines[i].startsWith("```text")) continue
    const content: string[] = []
    for (i++; i < end && !lines[i].startsWith("```"); i++) content.push(lines[i])
    blocks.push(content.join("\n"))
  }
  return blocks
}

function section116Blocks(): string[] {
  return sectionTextBlocks("### 11.6", "### 11.7")
}

describe("认知契约常量 golden（DESIGN §11.6）", () => {
  const blocks = section116Blocks()
  test("§11.6 含四个 code block（board_put/board_get/board_index/task）", () => {
    expect(blocks.length).toBe(4)
  })

  test("board_put description 逐字节相等", () => {
    expect(TOOL_DESCRIPTIONS.board_put).toBe(blocks[0])
  })

  test("board_get description 逐字节相等", () => {
    expect(TOOL_DESCRIPTIONS.board_get).toBe(blocks[1])
  })

  test("board_index description 逐字节相等", () => {
    expect(TOOL_DESCRIPTIONS.board_index).toBe(blocks[2])
  })

  // §11.6 注：board_aggregate 无文案契约（不在 §11.6 文案契约范围）；v1.21.0 批量下限 8→4，描述文本同步；英文简洁描述——短码含义在报错输出（tools.ts AGG_REASON_EXPLANATIONS）而非描述；拒绝句仅限定 aggregate_invalid 分支（配额/未注册/参数错误不走该格式，见 oracle 复评 CONCERNS 修正 1）
  test("board_aggregate description（英文简洁版，拒绝句限定 aggregate_invalid）逐字相等", () => {
    expect(TOOL_DESCRIPTIONS.board_aggregate).toBe(
      "Fold 4–16 older catalog entries of this stream into one index summary (catalog folding only; original entries remain readable via board.get). For aggregate_invalid, inspect member reasons. Retry after the relevant conditions change; update navigation_body if members change.",
    )
  })

  test("task 段 TASK_DESC_APPEND 与 §11.6 task 块逐字节相等", () => {
    expect(TASK_DESC_APPEND).toBe(blocks[3])
  })

  test("PRESSURE_REMINDER_TEMPLATE UTF-8 字节数 ≤512", () => {
    expect(Buffer.byteLength(PRESSURE_REMINDER_TEMPLATE, "utf8")).toBeLessThanOrEqual(512)
  })

  // §10.2 模板常量性：不含任何板数据引用（bb://）——目录发现一律由 agent 主动 board_index 完成
  test("压力模板不含 bb:// 板数据引用", () => {
    expect(PRESSURE_REMINDER_TEMPLATE.includes("bb://")).toBe(false)
  })

  // §10.2 模板约束：第三句保护文案在位——提醒不新增任何读写义务（提醒不覆盖任务限制）
  test("压力模板含第三句保护文案（adds no obligations）", () => {
    expect(PRESSURE_REMINDER_TEMPLATE.includes("adds no obligations and never overrides this task's restrictions")).toBe(true)
  })

  test("PRESSURE_REMINDER_TEMPLATE 与 §10.2 模板②逐字节相等", () => {
    expect(PRESSURE_REMINDER_TEMPLATE).toBe(sectionTextBlocks("### 10.2", "### 10.3")[1])
  })

  test("参数级指引（§11.6）：board_put 交付面参数 description 非空且含关键短语", () => {
    const tools = defineBoardTools({ resolveScope: async () => null, log: () => {} })
    const shape = (tools.board_put.args as unknown as { shape: Record<string, { description?: string }> }).shape
    expect(shape.content?.description).toContain("不写过程流水账")
    expect(shape.source_refs?.description).toContain("不代表工具已验证内容")
    expect(shape.supersedes?.description).toContain("仅用于本 stream 内明确修正")
    expect(shape.description?.description).toContain("不替代正文")
  })
})
