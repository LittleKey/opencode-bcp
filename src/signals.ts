// 词法信号判定引擎（DESIGN v1.4.6 §10.4 :314-374，S+ 词法识别协议）。
// 纯函数、机械匹配、不做语义猜测；规范句为协议字面量，import 单源（§11.7 I5）。
import { NORMATIVE_SENTENCE } from "./constants"

/** 行首列 0 连续反引号长度 */
function backtickRun(line: string): number {
  let n = 0
  while (line[n] === "`") n++
  return n
}

/**
 * §10.4 入口信号①②判定：
 * A1 反引号围栏（列 0 ≥3 反引号开启，N 宽只被列 0 ≥N 反引号行闭合——长含短；未闭合余文全属围栏内）；
 * A2 有限拒绝（有效协议区域中列 0 以 `~~~` 开头 → 完整扫描后①②均 false，不提前返回）；
 * A3 列 0 `>` 行整行排除（不贡献信号、不识别围栏开闭、其内 ~~~ 不参与 A2）；
 * ① = 有效协议区域出现 ≥1 个 `bb://` 子串（存在性，裸 scheme 命中，缩进代码/行内代码/HTML 注释/带前导空格引用延续行不排除）；
 * ② = 整行精确等于 NORMATIVE_SENTENCE（区分大小写；LF/CRLF 分隔、\r 随分隔符移除；
 *     行尾空白仅 U+0020/U+0009；不裁剪行首；NBSP 等不允许；零其他归一化）。
 */
export function detectSignals(prompt: string): { s1: boolean; s2: boolean } {
  let s1 = false
  let s2 = false
  let a2Reject = false
  let fence = 0 // 当前反引号围栏宽度；0 = 围栏外
  // 行分隔仅 LF 与 CRLF：\r 只随 \n 一起移除，孤立 \r 属行内容（oracle：句后孤立 \r → ②=false）
  for (const line of prompt.split(/\r\n|\n/)) {
    if (fence > 0) {
      // 围栏内：仅检查列 0 ≥N 反引号闭合行（长含短），其余一切行不参与任何匹配
      if (backtickRun(line) >= fence) fence = 0
      continue
    }
    if (line.startsWith(">")) continue // A3：列 0 `>` 行整行排除（也不识别围栏开闭）
    const run = backtickRun(line)
    if (run >= 3) {
      fence = run // A1：开启围栏，本行属围栏机制行，非内容行
      continue
    }
    if (line.startsWith("~~~")) a2Reject = true // A2：仅登记，完整扫描后才生效
    if (line.includes("bb://")) s1 = true
    if (line.replace(/[ \t]+$/, "") === NORMATIVE_SENTENCE) s2 = true
  }
  if (a2Reject) return { s1: false, s2: false }
  return { s1, s2 }
}
