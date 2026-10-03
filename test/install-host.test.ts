// Install-time host detection and compatibility gate:
//   v1 requires >= 1.18.29 (the documented dual-entry floor; tested host
//   1.18.33), v2 requires >= 2.0.20 (tested 2.0.20). The earlier 2.0.16
//   adapter declaration is not evidence for this implementation, so 2.0.16
//   hosts are refused. Detection accepts --host v1|v2 keywords, an explicit
//   executable path, or PATH probe. Malformed/absent hosts refuse (exit 2)
//   before any mutation.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BUNDLE,
  INSTALL,
  REAL_V2_BIN,
  ensureBundle,
  makeSandbox,
  minimalPathEnv,
  runScript,
  writeFakeHost,
  type Sandbox,
} from "./install-helpers"

async function install(sb: Sandbox, args: string[], env?: Record<string, string | undefined>) {
  return runScript(INSTALL, args, sb.env(env))
}

describe("install.sh: version gates", () => {
  test("v1 1.18.29 (exact floor) → accepted", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.29")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(existsSync(join(sb.proj, ".opencode", "plugin", "blackboard.ts"))).toBe(true)
    } finally {
      sb.cleanup()
    }
  })

  test("v1 1.18.28 → refused with the 1.18.29 floor named", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.28")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("unsupported host")
      expect(r.stderr).toContain("1.18.29")
      expect(existsSync(join(sb.proj, ".opencode"))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("v1 1.18.33 (tested version) → accepted", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("host: v1 1.18.33")
    } finally {
      sb.cleanup()
    }
  })

  test("v2 2.0.20 in real output format → accepted", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode v2.0.20")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("host: v2 2.0.20")
    } finally {
      sb.cleanup()
    }
  })

  test("v2 2.0.15 → refused with the 2.0.20 floor named", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode v2.0.15")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("2.0.20")
    } finally {
      sb.cleanup()
    }
  })

  test("v2 2.0.16 (old adapter declaration) → refused: not evidence for the new implementation", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode v2.0.16")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("unsupported host: v2 2.0.16 < 2.0.20")
      expect(existsSync(join(sb.proj, ".opencode"))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("v2 2.0.19 → refused with the 2.0.20 floor named", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode v2.0.19")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("2.0.20")
    } finally {
      sb.cleanup()
    }
  })

  test("v0.x / v3 host majors → refused", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode v3.1.4")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("unsupported host major '3'")
    } finally {
      sb.cleanup()
    }
  })
})

describe("install.sh: malformed / missing hosts", () => {
  test("garbage version output → refused (cannot parse version)", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode version tomorrow, probably")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("cannot parse version")
    } finally {
      sb.cleanup()
    }
  })

  test("empty version output → refused", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("cannot parse version")
    } finally {
      sb.cleanup()
    }
  })

  test("host executable exits non-zero → refused", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33", { exitCode: 1 })
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("cannot parse version")
    } finally {
      sb.cleanup()
    }
  })

  test("--host path that is not executable → refused", async () => {
    const sb = makeSandbox()
    try {
      const notExe = writeFakeHost(sb.bin, "1.18.33", { executable: false, name: "not-opencode" })
      const r = await install(sb, ["--project", sb.proj, "--host", notExe])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("not found or not executable")
    } finally {
      sb.cleanup()
    }
  })

  test("no opencode on PATH and no --host → refused with guidance, nothing written", async () => {
    const sb = makeSandbox()
    try {
      const r = await runScript(INSTALL, ["--project", sb.proj], minimalPathEnv(sb))
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("no host detected")
      expect(r.stderr).toContain("--host")
      expect(existsSync(join(sb.proj, ".opencode"))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })
})

describe("install.sh: --host selection", () => {
  test("--host v2 keyword + v2 fake on PATH → accepted", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode v2.0.20")
      const r = await install(sb, ["--host", "v2", "--project", sb.proj])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("host: v2 2.0.20")
    } finally {
      sb.cleanup()
    }
  })

  test("--host v1 keyword but PATH opencode is v2 → refused (family mismatch)", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode v2.0.20")
      const r = await install(sb, ["--host", "v1", "--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("family v2")
    } finally {
      sb.cleanup()
    }
  })

  test("--host <explicit executable path> → parsed from that binary", async () => {
    const sb = makeSandbox()
    try {
      const exe = writeFakeHost(sb.bin, "1.18.33", { name: "pinned-opencode" })
      // PATH deliberately has NO opencode: the explicit path is the only host
      const r = await runScript(INSTALL, ["--project", sb.proj, "--host", exe], minimalPathEnv(sb))
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("host: v1 1.18.33")
      expect(r.stdout).toContain(exe)
    } finally {
      sb.cleanup()
    }
  })

  const liveV2Test = REAL_V2_BIN ? test : test.skip
  liveV2Test("explicit real v2 binary parses 'opencode v2.0.20' and installs into the sandbox only", async () => {
    expect(existsSync(REAL_V2_BIN)).toBe(true)
    const sb = makeSandbox()
    try {
      const r = await runScript(INSTALL, ["--project", sb.proj, "--host", REAL_V2_BIN], sb.env())
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("host: v2 2.0.20")
      expect(readFileSync(join(sb.proj, ".opencode", "plugin", "blackboard.ts"), "utf8")).toEqual(
        readFileSync(ensureBundle(), "utf8"),
      )
    } finally {
      sb.cleanup()
    }
  })

  test("dual bundle loads on a bare runtime and exposes exactly the official dual surface", async () => {
    const bundle = ensureBundle()
    const proc = Bun.spawnSync(["bun", "-e", `const m = await import(${JSON.stringify(bundle)}); const d = m.default;
      if (d.id !== "opencode-bcp") throw new Error("bad id: " + d.id);
      if (typeof d.server !== "function") throw new Error("server entry missing");
      if (typeof d.setup !== "function") throw new Error("setup entry missing");
      console.log("dual-surface-ok")`], { stdout: "pipe", stderr: "pipe" })
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("dual-surface-ok")
  })
})
