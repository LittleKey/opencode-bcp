// Shared harness for the install/build maintenance suites: real filesystem
// fixtures (mkdtemp), real script spawns, isolated HOME/PATH, fake host
// executables. Test-isolated — never touches the developer's real
// ~/.config/opencode or the global opencode binary.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const REPO = join(import.meta.dir, "..")
export const INSTALL = join(REPO, "scripts", "install.sh")
export const UNINSTALL = join(REPO, "scripts", "uninstall.sh")
export const BUNDLE = join(REPO, "dist", "blackboard.ts")
// Optional live version probe; its location must be supplied by the caller,
// rather than relying on an earlier workstation's disposable /tmp directory.
export const REAL_V2_BIN = Bun.env.BCP_TEST_V2_BIN ?? ""

/** Build the dual bundle once per process if dist/blackboard.ts is absent. */
export function ensureBundle(): string {
  if (!existsSync(BUNDLE)) {
    const p = Bun.spawnSync(["bash", join(REPO, "scripts", "build.sh")], { cwd: REPO, stdout: "pipe", stderr: "pipe" })
    if (p.exitCode !== 0) throw new Error(`scripts/build.sh failed: ${p.stderr.toString()}`)
  }
  return BUNDLE
}

export interface Sandbox {
  base: string
  home: string
  proj: string // existing project dir for --project
  bin: string // fake host executables dir (prepended to PATH)
  env(overrides?: Record<string, string | undefined>): Record<string, string>
  cleanup(): void
}

/** Isolated HOME + project + bin dir. Pins XDG/OPENCODE_CONFIG_DIR so the
 *  developer's real config root can never leak into the scan. */
export function makeSandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), "bcp-inst-"))
  const home = join(base, "home")
  const proj = join(base, "proj")
  const bin = join(base, "bin")
  mkdirSync(home, { recursive: true })
  mkdirSync(proj, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const env = (overrides: Record<string, string | undefined> = {}): Record<string, string> => {
    const inherited = Object.fromEntries(
      Object.entries(Bun.env).filter(([key, value]) => !key.startsWith("OPENCODE_") && value !== undefined),
    ) as Record<string, string>
    const out: Record<string, string> = {
      ...inherited,
      HOME: home,
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
      BB_INSTALL_SKIP_BUILD: "1",
      // pin the global-root resolution chain away from the real machine
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      OPENCODE_DB: join(home, ".local", "share", "opencode", "opencode.db"),
      OPENCODE_CONFIG_DIR: "",
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete out[k]
      else out[k] = v
    }
    return out
  }
  return {
    base,
    home,
    proj,
    bin,
    env,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

/** PATH containing only pinned coreutils (no `opencode` anywhere). */
export function minimalPathEnv(sb: Sandbox, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const core = join(sb.base, "coreutils-bin")
  mkdirSync(core, { recursive: true })
  const tools = [
    "bash", "sh", "mktemp", "sha256sum", "cut", "sort", "date", "dirname", "basename",
    "mkdir", "rmdir", "cp", "mv", "rm", "ls", "wc", "tr", "head", "cat", "chmod", "sed",
    "touch", "env", "pwd",
  ]
  for (const t of tools) {
    const resolved = Bun.which(t)
    if (!resolved) continue
    try {
      symlinkSync(resolved, join(core, t))
    } catch {
      /* already linked */
    }
  }
  return sb.env({ PATH: core, ...overrides })
}

export function writeFakeHost(
  bin: string,
  versionOutput: string,
  opts: { exitCode?: number; executable?: boolean; name?: string } = {},
): string {
  const exe = join(bin, opts.name ?? "opencode")
  writeFileSync(exe, `#!/usr/bin/env bash\ncat <<'BCP_EOF'\n${versionOutput}\nBCP_EOF\nexit ${opts.exitCode ?? 0}\n`)
  if (opts.executable !== false) chmodSync(exe, 0o755)
  return exe
}

/** Pre-2.0.0 managed v1 entry (provenance marker included). */
export function writeLegacyV1(root: string): string {
  const dir = join(root, "plugin")
  mkdirSync(dir, { recursive: true })
  const f = join(dir, "blackboard.ts")
  writeFileSync(f, "// opencode-bcp v1 managed install (pre-2.0.0)\nexport const BlackboardPlugin = async () => ({})\n")
  return f
}

export function writeLegacyV1Js(root: string): string {
  const dir = join(root, "plugin")
  mkdirSync(dir, { recursive: true })
  const f = join(dir, "blackboard.js")
  writeFileSync(f, "// opencode-bcp v1 managed install (legacy .js)\nexports.BlackboardPlugin = async () => ({})\n")
  return f
}

/** Pre-2.0.0 managed v2 entry (provenance marker included). */
export function writeLegacyV2(root: string): string {
  const dir = join(root, "plugins")
  mkdirSync(dir, { recursive: true })
  const f = join(dir, "blackboard-v2.ts")
  writeFileSync(f, '// opencode-bcp v2 managed install (pre-2.0.0)\nexport const BlackboardV2Plugin = { id: "opencode-bcp", setup: async () => {} }\n')
  return f
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export async function runScript(script: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(["bash", script, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    cwd: REPO,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

export function sha256File(file: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex")
}

/** "--adopt <file>=<sha256>" args authorizing exactly this file's current bytes. */
export function adoptArgs(file: string): string[] {
  return ["--adopt", `${file}=${sha256File(file)}`]
}

/**
 * Materialize the only pre-2.0.0 release artifact whose exact bytes are
 * recoverable (the v1 bundle installed by the v1.20.0-era installer, kept in
 * git at harness/live-agg/.opencode/plugin/blackboard.ts). Used to exercise
 * the known-release-digest migration path without --adopt.
 */
export function gitLegacyV1File(outPath: string): string {
  const p = Bun.spawnSync(["git", "-C", REPO, "show", "HEAD:harness/live-agg/.opencode/plugin/blackboard.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (p.exitCode !== 0 || p.stdout.length === 0) {
    throw new Error(`cannot recover known legacy v1 bytes from git: ${p.stderr.toString()}`)
  }
  mkdirSync(join(outPath, ".."), { recursive: true })
  writeFileSync(outPath, p.stdout)
  return outPath
}
