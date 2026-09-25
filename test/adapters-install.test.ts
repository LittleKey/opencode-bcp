// R3：install.sh 跨配置根混装检测（bash 层，spawn 真实脚本 + 隔离 HOME，不动用户配置）。
// 覆盖：全局v1+项目v2→拒；干净根→装；--force→警告后装且不清其他根；全局v2+项目v1→拒；
// M-install：扫描范围与宿主发现等价（HOME/.opencode 仅在祖先链上有效；目标=HOME 同根替换）。
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const SCRIPT = join(import.meta.dir, "..", "scripts", "install.sh")
const DIST_V2 = join(import.meta.dir, "..", "dist", "blackboard-v2.ts")

type Roots = { home: string; target: string; targetParent: string; env?: Record<string, string> }

function makeRoots(
  layout: { v1?: boolean; v2?: boolean; homeOpencode?: "v1" | "v2"; configDir?: "v1" | "v2" },
  opts: { depth?: number } = {},
): Roots {
  const home = mkdtempSync(join(tmpdir(), "bb-inst-home-"))
  const targetParent = mkdtempSync(join(tmpdir(), "bb-inst-target-"))
  // depth：目标嵌套层数（>16 用于验证无静默层数截断）
  let target = join(targetParent, "proj")
  for (let i = 0; i < (opts.depth ?? 0); i++) target = join(target, `lvl${i}`)
  mkdirSync(target, { recursive: true })
  if (layout.v1) {
    mkdirSync(join(home, ".config/opencode/plugin"), { recursive: true })
    writeFileSync(join(home, ".config/opencode/plugin/blackboard.ts"), "// fake global v1\n")
  }
  if (layout.v2) {
    mkdirSync(join(home, ".config/opencode/plugins"), { recursive: true })
    writeFileSync(join(home, ".config/opencode/plugins/blackboard-v2.ts"), "// fake global v2\n")
  }
  if (layout.homeOpencode) {
    // 宿主发现不排除 $HOME/.opencode（discovery.ts:52-69 仅排除 .agents/.claude）
    const sub = layout.homeOpencode === "v1" ? "plugin" : "plugins"
    mkdirSync(join(home, ".opencode", sub), { recursive: true })
    writeFileSync(join(home, ".opencode", sub, layout.homeOpencode === "v1" ? "blackboard.ts" : "blackboard-v2.ts"), "// fake $HOME/.opencode\n")
  }
  const env: Record<string, string> = {}
  if (layout.configDir) {
    // OPENCODE_CONFIG_DIR 覆盖实际全局根（global.ts:77-80）
    const dir = join(home, "custom-cfg")
    const sub = layout.configDir === "v1" ? "plugin" : "plugins"
    mkdirSync(join(dir, sub), { recursive: true })
    writeFileSync(join(dir, sub, layout.configDir === "v1" ? "blackboard.ts" : "blackboard-v2.ts"), "// fake OPENCODE_CONFIG_DIR\n")
    env.OPENCODE_CONFIG_DIR = dir
  }
  return { home, target, targetParent, env: Object.keys(env).length ? env : undefined }
}

async function runInstall(args: string[], roots: Roots): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env: { ...Bun.env, HOME: roots.home, BB_INSTALL_SKIP_BUILD: "1", ...(roots.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
    cwd: join(import.meta.dir, ".."),
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function cleanup(roots: Roots): void {
  rmSync(roots.home, { recursive: true, force: true })
  rmSync(roots.targetParent, { recursive: true, force: true })
}

describe("install.sh 跨配置根 major 冲突（R3）", () => {
  test("全局 v1 已装 + --v2 --project → 拒绝；项目根不写入、全局文件不动", async () => {
    const roots = makeRoots({ v1: true })
    try {
      const r = await runInstall(["--v2", "--project", roots.target], roots)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("另一 major")
      expect(existsSync(join(roots.target, ".opencode/plugins/blackboard-v2.ts"))).toBe(false)
      expect(readFileSync(join(roots.home, ".config/opencode/plugin/blackboard.ts"), "utf8")).toContain("fake global v1")
    } finally {
      cleanup(roots)
    }
  })
  test("全局 v2 已装 + 默认 --project（v1）→ 拒绝", async () => {
    const roots = makeRoots({ v2: true })
    try {
      const r = await runInstall(["--project", roots.target], roots)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("另一 major")
      expect(existsSync(join(roots.target, ".opencode/plugin/blackboard.ts"))).toBe(false)
    } finally {
      cleanup(roots)
    }
  })
  test("干净根 + --v2 --project → 正常安装项目 v2", async () => {
    const roots = makeRoots({})
    try {
      const r = await runInstall(["--v2", "--project", roots.target], roots)
      expect(r.code).toBe(0)
      const installed = join(roots.target, ".opencode/plugins/blackboard-v2.ts")
      expect(existsSync(installed)).toBe(true)
      expect(readFileSync(installed, "utf8")).toEqual(readFileSync(DIST_V2, "utf8"))
    } finally {
      cleanup(roots)
    }
  })
  test("--force 跨根冲突 → 警告后安装，且不自动删除其他根文件", async () => {
    const roots = makeRoots({ v1: true })
    try {
      const r = await runInstall(["--v2", "--force", "--project", roots.target], roots)
      expect(r.code).toBe(0)
      expect(r.stderr).toContain("WARNING")
      expect(existsSync(join(roots.target, ".opencode/plugins/blackboard-v2.ts"))).toBe(true)
      expect(readFileSync(join(roots.home, ".config/opencode/plugin/blackboard.ts"), "utf8")).toContain("fake global v1")
    } finally {
      cleanup(roots)
    }
  })
})

describe("install.sh 扫描边界（N2：与宿主发现范围等价）", () => {
  test("①$HOME/.opencode 有另一 major 但目标不在 HOME 下 → 不误拒（M-install 反例1：宿主从目标向上发现不了该根）", async () => {
    const roots = makeRoots({ homeOpencode: "v1" })
    try {
      const r = await runInstall(["--v2", "--project", roots.target], roots)
      expect(r.code).toBe(0)
      expect(existsSync(join(roots.target, ".opencode/plugins/blackboard-v2.ts"))).toBe(true)
      expect(readFileSync(join(roots.home, ".opencode/plugin/blackboard.ts"), "utf8")).toContain("fake $HOME/.opencode")
    } finally {
      cleanup(roots)
    }
  })
  test("①b $HOME/.opencode 有另一 major 且目标是 HOME 后代 → 拒绝（祖先链覆盖）", async () => {
    const roots = makeRoots({ homeOpencode: "v1" })
    const target = join(roots.home, "work", "proj")
    mkdirSync(target, { recursive: true })
    try {
      const r = await runInstall(["--v2", "--project", target], roots)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(".opencode/plugin/blackboard.ts")
      expect(existsSync(join(target, ".opencode/plugins/blackboard-v2.ts"))).toBe(false)
    } finally {
      cleanup(roots)
    }
  })
  test("①c 目标=HOME 且目标根含另一 major → 同根互斥替换，非跨根冲突（M-install 反例2）", async () => {
    const roots = makeRoots({ homeOpencode: "v1" })
    try {
      const r = await runInstall(["--v2", "--project", roots.home], roots)
      expect(r.code).toBe(0)
      expect(r.stderr).not.toContain("WARNING")
      expect(existsSync(join(roots.home, ".opencode/plugins/blackboard-v2.ts"))).toBe(true)
      expect(existsSync(join(roots.home, ".opencode/plugin/blackboard.ts"))).toBe(false) // 同根清理
    } finally {
      cleanup(roots)
    }
  })
  test("②OPENCODE_CONFIG_DIR 覆盖根装另一 major → 拒绝", async () => {
    const roots = makeRoots({ configDir: "v2" })
    try {
      const r = await runInstall(["--project", roots.target], roots) // 默认装 v1，全局实际根有 v2
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("custom-cfg")
      expect(existsSync(join(roots.target, ".opencode/plugin/blackboard.ts"))).toBe(false)
    } finally {
      cleanup(roots)
    }
  })
  test("③>16 层祖先链上的另一 major → 拒绝（无静默层数截断）", async () => {
    const roots = makeRoots({ v1: true }, { depth: 20 })
    try {
      const r = await runInstall(["--v2", "--project", roots.target], roots)
      expect(r.code).toBe(2) // 冲突在 HOME 全局根，且 20 层深目标仍在链内被扫描
      expect(r.stderr).toContain("另一 major")
    } finally {
      cleanup(roots)
    }
  })
  test("③b 深层目标自身的深层祖先 .opencode 冲突 → 拒绝", async () => {
    const roots = makeRoots({}, { depth: 20 })
    // 在目标上第 18 层祖先放另一 major
    let d = roots.target
    for (let i = 0; i < 18; i++) d = dirname(d)
    mkdirSync(join(d, ".opencode/plugins"), { recursive: true })
    writeFileSync(join(d, ".opencode/plugins/blackboard-v2.ts"), "// deep v2\n")
    try {
      const r = await runInstall(["--project", roots.target], roots)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("另一 major")
    } finally {
      cleanup(roots)
    }
  })
  test("④symlink 别名目标 → 规范化到物理路径，物理祖先冲突被检出", async () => {
    const roots = makeRoots({})
    // 物理布局 targetParent/real/sub；alias → real；目标以 alias 形式传入
    const real = join(roots.targetParent, "real", "sub")
    mkdirSync(real, { recursive: true })
    const alias = join(roots.targetParent, "alias")
    symlinkSync(real, alias)
    // 物理祖先 real 的上层放另一 major
    mkdirSync(join(roots.targetParent, "real", ".opencode/plugins"), { recursive: true })
    writeFileSync(join(roots.targetParent, "real", ".opencode/plugins/blackboard-v2.ts"), "// physical v2\n")
    try {
      const r = await runInstall(["--project", alias], roots) // 相对/别名形态：物理化后检出
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("另一 major")
    } finally {
      cleanup(roots)
    }
  })
  test("④b 不存在的目标目录 → 明确拒绝（exit 3），不静默放行", async () => {
    const roots = makeRoots({})
    try {
      const r = await runInstall(["--v2", "--project", join(roots.targetParent, "no-such-dir")], roots)
      expect(r.code).toBe(3)
      expect(r.stderr).toContain("不是已存在目录")
    } finally {
      cleanup(roots)
    }
  })
})
