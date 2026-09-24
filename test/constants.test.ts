// T1 golden：认知契约常量与 DESIGN.md §11.6 逐字节对照（防契约漂移）。
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ENTRY_REMINDER_TEMPLATE, NORMATIVE_SENTENCE, PRESSURE_REMINDER_TEMPLATE, TASK_DESC_APPEND, TOOL_DESCRIPTIONS } from "../src/constants"
import { defineBoardTools } from "../src/tools"

const design = readFileSync(join(import.meta.dir, "..", "DESIGN.md"), "utf8")

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

function* walkSrc(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walkSrc(p)
    else if (p.endsWith(".ts")) yield p
  }
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

  // §11.6 注：board_aggregate 无文案契约（不在 advisory §4.2 范围），维持既有描述文本不变
  test("board_aggregate description 维持既有文本不变（注记口径）", () => {
    expect(TOOL_DESCRIPTIONS.board_aggregate).toBe(
      "把本流 8–16 条旧目录项折叠为一个索引摘要（仅目录折叠，原条目可继续 board.get）",
    )
  })

  test("task 段 TASK_DESC_APPEND 与 §11.6 task 块逐字节相等", () => {
    expect(TASK_DESC_APPEND).toBe(blocks[3])
  })

  test("TASK_DESC_APPEND 含规范句子串 === NORMATIVE_SENTENCE（import 单源）", () => {
    expect(TASK_DESC_APPEND.includes(NORMATIVE_SENTENCE)).toBe(true)
  })

  test("ENTRY_REMINDER_TEMPLATE UTF-8 字节数 ≤512", () => {
    expect(Buffer.byteLength(ENTRY_REMINDER_TEMPLATE, "utf8")).toBeLessThanOrEqual(512)
  })

  test("PRESSURE_REMINDER_TEMPLATE UTF-8 字节数 ≤512", () => {
    expect(Buffer.byteLength(PRESSURE_REMINDER_TEMPLATE, "utf8")).toBeLessThanOrEqual(512)
  })

  // §10.2 模板常量性：不含任何板数据引用（bb://）——目录发现一律由 agent 主动 board_index 完成
  test("两模板均不含 bb:// 板数据引用", () => {
    expect(ENTRY_REMINDER_TEMPLATE.includes("bb://")).toBe(false)
    expect(PRESSURE_REMINDER_TEMPLATE.includes("bb://")).toBe(false)
  })

  // §14.4 场景 7 反例（单测层）：第三句保护文案在位——提醒不新增任何读写义务（§10.2）
  test("两模板均含第三句保护文案（adds no obligations）", () => {
    for (const t of [ENTRY_REMINDER_TEMPLATE, PRESSURE_REMINDER_TEMPLATE]) {
      expect(t.includes("adds no obligations and never overrides this task's restrictions")).toBe(true)
    }
  })

  test("ENTRY_REMINDER_TEMPLATE 与 §10.2 模板①逐字节相等", () => {
    const blocks = sectionTextBlocks("### 10.2", "### 10.3")
    expect(blocks.length).toBe(2)
    expect(ENTRY_REMINDER_TEMPLATE).toBe(blocks[0])
  })

  test("PRESSURE_REMINDER_TEMPLATE 与 §10.2 模板②逐字节相等", () => {
    expect(PRESSURE_REMINDER_TEMPLATE).toBe(sectionTextBlocks("### 10.2", "### 10.3")[1])
  })

  test("参数级指引（§11.6 :498-505）：board_put 交付面参数 description 非空且含关键短语", () => {
    const tools = defineBoardTools({ resolveScope: async () => null, log: () => {} })
    const shape = (tools.board_put.args as unknown as { shape: Record<string, { description?: string }> }).shape
    expect(shape.content?.description).toContain("不写过程流水账")
    expect(shape.source_refs?.description).toContain("不代表工具已验证内容")
    expect(shape.supersedes?.description).toContain("仅用于本 stream 内明确修正")
    expect(shape.description?.description).toContain("不替代正文")
  })

  test("src/ 中规范句字面量仅 constants.ts 一处（防双源）", () => {
    const srcDir = join(import.meta.dir, "..", "src")
    const hits = [...walkSrc(srcDir)].filter((p) => readFileSync(p, "utf8").includes(NORMATIVE_SENTENCE))
    expect(hits).toEqual([join(srcDir, "constants.ts")])
  })
})
