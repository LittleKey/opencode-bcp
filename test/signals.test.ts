import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { detectSignals } from "../src/signals"
import { NORMATIVE_SENTENCE } from "../src/constants"

const SENT = NORMATIVE_SENTENCE
const N1_NEGATION = "Do not publish anything or return board IDs. Answer only in this task."

// §11.8 五段式推荐模板：从 DESIGN.md 逐字提取（oracle M1：原手写版 Task 节重复、缺 Artifact/Return 段）
const DESIGN_LINES = readFileSync(join(import.meta.dir, "..", "DESIGN.md"), "utf8").split("\n")
const FIVE_PART_TEMPLATE = (() => {
  const start = DESIGN_LINES.findIndex((l) => l.startsWith("### 11.8"))
  if (start < 0) throw new Error("DESIGN.md §11.8 定位失败")
  for (let i = start; i < DESIGN_LINES.length; i++) {
    if (!DESIGN_LINES[i]!.startsWith("```text")) continue
    const buf: string[] = []
    for (i++; i < DESIGN_LINES.length && !DESIGN_LINES[i]!.startsWith("```"); i++) buf.push(DESIGN_LINES[i]!)
    return buf.join("\n")
  }
  throw new Error("DESIGN.md §11.8 模板块缺失")
})()

describe("signals §10.4 C 判定示例", () => {
  // C.① 推荐格式正例：五段式 → 必读 + 发布双信号（合并注入，但检测两信号分别成立）
  test("C① 五段式推荐模板 → s1=true 且 s2=true（合并判定）", () => {
    const r = detectSignals(FIVE_PART_TEMPLATE)
    expect(r.s1).toBe(true)
    expect(r.s2).toBe(true)
  })

  test("C① 无标题中文正文含 bb:// → s1=true（标题与语言不参与门控）", () => {
    const r = detectSignals("请先阅读 bb://b3f2a1c0/e000001 再动手，完成后发布结论。")
    expect(r.s1).toBe(true)
    expect(r.s2).toBe(false)
  })

  // C.② 否定句反例：即便含 publish / board ID 字样也无发布信号
  test("C② N1 否定句 → s2=false", () => {
    const r = detectSignals(N1_NEGATION)
    expect(r.s2).toBe(false)
    expect(r.s1).toBe(false)
  })

  // C.③ 跨节反转（S+）：bb:// 只在 Acceptance: 节、Required board inputs: 空 → ①=true
  test("C③ bb:// 仅出现在 Acceptance: 节、必读节为空 → s1=true（节限定废除反转）", () => {
    const r = detectSignals(
      ["Required board inputs:", "", "Task: analyze only.", "Acceptance: read bb://b3f2a1c0/e000009 first."].join("\n"),
    )
    expect(r.s1).toBe(true)
    expect(r.s2).toBe(false)
  })

  // C.④ 边界：外层 4 反引号内嵌 3 反引号模板 → 内层不闭合外层，整体属围栏内 → 零信号
  test("C④ 外层 ```` 内嵌 ``` → 围栏内整体零信号", () => {
    const r = detectSignals(["````", "```", "bb://b3f2a1c0/e000001", SENT, "```", "````", "done"].join("\n"))
    expect(r.s1).toBe(false)
    expect(r.s2).toBe(false)
  })

  // C.⑤ 豁免与撤销对照：`> ~~~` 豁免 → ②成立；顶层 ~~~ → A2 撤销
  test("C⑤ 规范句后出现 `> ~~~`（引用行内波浪线）→ s2=true", () => {
    const r = detectSignals([SENT, "> ~~~"].join("\n"))
    expect(r.s2).toBe(true)
    expect(r.s1).toBe(false)
  })

  test("C⑤ 同一 `~~~` 不带 > 前缀在围栏外 → A2 命中，已发现的信号被撤销", () => {
    const r = detectSignals([SENT, "~~~"].join("\n"))
    expect(r.s1).toBe(false)
    expect(r.s2).toBe(false)
  })
})

describe("signals §10.4 D 边界样例表（:361-374 逐行）", () => {
  // 行1：中文标题或无标题，普通行含 bb:// → ①=true
  test("D1 中文标题普通行含 bb:// → s1=true；s2=false", () => {
    const r = detectSignals(["# 重构存储层", "请先读 bb://b3f2a1c0/e000001。"].join("\n"))
    expect(r.s1).toBe(true)
    expect(r.s2).toBe(false)
  })

  // 行2：只有裸 bb://、无完整 ID → ①=true；不是有效 ID 校验
  test("D2 裸 bb:// 无完整 ID → s1=true", () => {
    const r = detectSignals("bb://")
    expect(r.s1).toBe(true)
    expect(r.s2).toBe(false)
  })

  // 行3：规范句独立一行，无标题、无 ID → ①=false，②=true
  test("D3 规范句独立一行无标题无 ID → s1=false 且 s2=true", () => {
    const r = detectSignals(SENT)
    expect(r.s1).toBe(false)
    expect(r.s2).toBe(true)
  })

  // 行4：规范句整行位于有效协议区域任意位置，且前文说只分析不执行 → ②=true（已知上下文误报）
  test("D4 前文『只分析不执行』不影响任意位置的规范句 → s2=true（已知上下文误报）", () => {
    const r = detectSignals(
      ["只分析，不执行任何写操作。", "Some analysis preamble.", "", SENT, "", "Deliver a short report."].join("\n"),
    )
    expect(r.s2).toBe(true)
    expect(r.s1).toBe(false)
  })

  // 行5：原 N1 否定句，或规范句带前缀/外层引号/前导空格/项目符号 → ②=false
  test("D5 N1 否定句与四种加前缀形状 → s2 均为 false", () => {
    for (const line of [
      N1_NEGATION,
      `Please: ${SENT}`, // 前缀
      `"${SENT}"`, // 外层引号
      ` ${SENT}`, // 前导空格
      `- ${SENT}`, // 项目符号
    ]) {
      const r = detectSignals(line)
      expect(r.s2).toBe(false)
    }
  })

  // 行6：规范句改大小写、翻译、改标点、物理折行 → ②=false
  test("D6 改大小写/翻译/改标点/物理折行 → s2 均为 false", () => {
    for (const variant of [
      SENT.toUpperCase(), // 改大小写
      "如果有可复用的发现，请发布它们并返回板 ID。", // 翻译
      "If there are reusable findings, publish them and return their board IDs!", // 改标点
      "If there are reusable findings,\npublish them and return their board IDs.", // 物理折行
    ]) {
      const r = detectSignals(variant)
      expect(r.s2).toBe(false)
    }
  })

  // 行7：规范句仅增加允许的行尾空白 → ②=true
  test("D7 仅行尾允许空白（SPACE/TAB，含多枚）→ s2=true", () => {
    expect(detectSignals(SENT + " ").s2).toBe(true)
    expect(detectSignals(SENT + "\t").s2).toBe(true)
    expect(detectSignals(SENT + " \t ").s2).toBe(true)
  })

  // 行8：bb:// 出现在缩进代码、行内代码、HTML 注释、带前导空格的引用延续行 → ①=true
  test("D8 缩进代码/行内代码/HTML 注释/带空格引用延续行中的 bb:// → s1=true", () => {
    expect(detectSignals("    bb://b3f2a1c0/e000001").s1).toBe(true) // 缩进代码
    expect(detectSignals("see `bb://b3f2a1c0/e000001` for context").s1).toBe(true) // 行内代码
    expect(detectSignals("<!-- bb://b3f2a1c0/e000001 -->").s1).toBe(true) // HTML 注释
    expect(detectSignals("  > quoted continuation bb://b3f2a1c0/e000001").s1).toBe(true) // 带前导空格引用延续行
  })

  // 行9：列 0 `>` 行中包含任一标记 → 该行不贡献信号
  test("D9 列 0 > 行内的 bb:// 与规范句 → s1=false 且 s2=false", () => {
    const r = detectSignals(["> bb://b3f2a1c0/e000001", `> ${SENT}`].join("\n"))
    expect(r.s1).toBe(false)
    expect(r.s2).toBe(false)
  })

  // 行10：N 长反引号围栏包含更短反引号行；外层未闭合 → 内部及未闭合余文不贡献信号
  test("D10 N 长围栏含更短反引号行 + 外层未闭合余文 → s1=false 且 s2=false", () => {
    // 4 反引号围栏未闭合：内层 ``` 不闭合（长含短），其后余文全部属围栏内
    const r = detectSignals(
      ["````", "```", "bb://b3f2a1c0/e000001", "```", SENT, "trailing content bb://tail"].join("\n"),
    )
    expect(r.s1).toBe(false)
    expect(r.s2).toBe(false)
  })

  // 行11：已找到两个信号，后面出现有效列 0 `~~~` → ①②最终均=false（完整扫描语义）；③不受影响
  test("D11 双信号在前、后置顶层 ~~~ 撤销 → s1=false 且 s2=false（完整扫描不提前返回）", () => {
    const revoked = detectSignals([FIVE_PART_TEMPLATE, "", "~~~"].join("\n"))
    expect(revoked.s1).toBe(false)
    expect(revoked.s2).toBe(false)
    // ~~~ 之后的信号同样不成立（先 ~~~ 后信号也必须被撤销 → 证明扫完全文）
    const late = detectSignals(["~~~", "later bb://x", SENT].join("\n"))
    expect(late.s1).toBe(false)
    expect(late.s2).toBe(false)
  })

  // 行12：`~~~` 只位于反引号围栏内或列 0 `>` 行内 → 不造成全局拒绝
  test("D12 ~~~ 在围栏内或 > 行内 → 不拒绝，信号成立", () => {
    const inFence = detectSignals([SENT, "```", "~~~", "```"].join("\n"))
    expect(inFence.s2).toBe(true)
    expect(inFence.s1).toBe(false)
    const inQuote = detectSignals([SENT, "> ~~~"].join("\n"))
    expect(inQuote.s2).toBe(true)
    expect(inQuote.s1).toBe(false)
  })

  // 行13：重复任意旧保留标题（含 Required board inputs: 多次出现）→ 不再抑制任何信号
  test("D13 重复保留标题不抑制 → s1=true 且 s2=true", () => {
    const r = detectSignals(
      [
        "Required board inputs:",
        "bb://b3f2a1c0/e000001",
        "Required board inputs:",
        "bb://b3f2a1c0/e000002",
        "Required board inputs:",
        SENT,
      ].join("\n"),
    )
    expect(r.s1).toBe(true)
    expect(r.s2).toBe(true)
  })

  // 行14：同一任务同时命中①② → 两个信号各自独立成立（合并注入不得掩盖单信号检测失败）
  test("D14 同一任务同时命中①② → s1=true 且 s2=true 各自独立", () => {
    const r = detectSignals(["Read bb://b3f2a1c0/e000003 before coding.", "", SENT].join("\n"))
    expect(r.s1).toBe(true)
    expect(r.s2).toBe(true)
  })
})

describe("signals oracle 终审推导补充", () => {
  test("规范句前导 SPACE/TAB/NBSP → s2=false", () => {
    expect(detectSignals(" " + SENT).s2).toBe(false)
    expect(detectSignals("\t" + SENT).s2).toBe(false)
    expect(detectSignals("\u00A0" + SENT).s2).toBe(false)
  })

  test("规范句后孤立 \\r（无 LF，非分隔符）→ s2=false", () => {
    const r = detectSignals(SENT + "\r")
    expect(r.s2).toBe(false)
    expect(r.s1).toBe(false)
  })

  test("句内物理折行 → s2=false（规范句不跨物理行匹配）", () => {
    expect(detectSignals("If there are reusable findings, publish them\r\nand return their board IDs.").s2).toBe(false)
  })

  test("CRLF 行分隔 → s2=true（\\r 随分隔符移除，不视为行尾空白）", () => {
    const r = detectSignals("Some task preamble.\r\n" + SENT + "\r\nDeliverable follows.\r\n")
    expect(r.s2).toBe(true)
    expect(r.s1).toBe(false)
  })

  test("行尾 SPACE 与 TAB（各一枚、CRLF 前）→ s2=true", () => {
    expect(detectSignals(SENT + " \r\n").s2).toBe(true)
    expect(detectSignals(SENT + "\t\r\n").s2).toBe(true)
  })

  test("混合形态回归：bb:// 在围栏外引用行排除、围栏内屏蔽、A2 撤销优先于一切信号", () => {
    // bb:// 出现在列 0 > 行与未闭合围栏内 → 均不贡献；随后顶层 ~~~ 撤销（即便此前无信号）
    const r = detectSignals(["> bb://quoted", "````", "bb://infence", "~~~"].join("\n"))
    expect(r.s1).toBe(false)
    expect(r.s2).toBe(false)
  })
})
