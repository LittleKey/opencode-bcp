// BCP 2.0.0 dual-entry install semantics (adapted R3/N2 regression set).
// Single canonical managed file <root>/plugin/blackboard.ts serves BOTH host
// majors. Scope rule (owner remediation 2026-09-30): files are mutated ONLY
// inside the installation root; BCP files in other host-discoverable roots
// are collisions — refuse BEFORE mutating and report the paths. Ownership of
// unmanifested legacy entries requires an exact known release digest or an
// explicit --adopt of that exact digest; a name or substring marker proves
// nothing.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  BUNDLE,
  INSTALL,
  UNINSTALL,
  adoptArgs,
  gitLegacyV1File,
  makeSandbox,
  runScript,
  sha256File,
  writeFakeHost,
  writeLegacyV1,
  writeLegacyV2,
  type Sandbox,
} from "./install-helpers"

function globalRoot(sb: Sandbox): string {
  return join(sb.home, ".config", "opencode")
}

function hostV1(sb: Sandbox): void {
  writeFakeHost(sb.bin, "1.18.33")
}
function hostV2(sb: Sandbox): void {
  writeFakeHost(sb.bin, "opencode v2.0.20")
}

async function install(sb: Sandbox, args: string[], env?: Record<string, string | undefined>) {
  return runScript(INSTALL, args, sb.env(env))
}

function expectCanonical(sb: Sandbox, root?: string): string {
  const f = join(root ?? sb.proj, ".opencode", "plugin", "blackboard.ts")
  expect(existsSync(f)).toBe(true)
  expect(readFileSync(f, "utf8")).toEqual(readFileSync(BUNDLE, "utf8"))
  return f
}

describe("install.sh: canonical single-file dual entry (adapted R3)", () => {
  test("clean project root + v1 host 1.18.33 → canonical at plugin/, no plugins/ dir", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expectCanonical(sb)
      expect(existsSync(join(sb.proj, ".opencode", "plugins"))).toBe(false)
      expect(existsSync(join(sb.proj, ".opencode", "bcp-install.json"))).toBe(true)
      expect(r.stderr).not.toContain("ERROR")
    } finally {
      sb.cleanup()
    }
  })

  test("clean project root + v2 host 2.0.20 (real output format) → SAME canonical path", async () => {
    const sb = makeSandbox()
    try {
      hostV2(sb)
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expectCanonical(sb) // one file serves both majors — no plugins/blackboard-v2.ts
      expect(existsSync(join(sb.proj, ".opencode", "plugins"))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("unrelated files are preserved, storage note printed", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const other = join(sb.proj, ".opencode", "plugin", "other-plugin.ts")
      mkdirSync(join(sb.proj, ".opencode", "plugin"), { recursive: true })
      writeFileSync(other, "// someone else's plugin\n")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(readFileSync(other, "utf8")).toContain("someone else's plugin")
      expect(r.stdout).toContain("storage data untouched")
    } finally {
      sb.cleanup()
    }
  })
})

describe("install.sh: scope — collisions outside the installation root refuse before mutation", () => {
  test("global legacy v1 entry + project install → REFUSED exit 2, global file untouched, nothing installed", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const legacy = writeLegacyV1(globalRoot(sb))
      const bytes = readFileSync(legacy, "utf8")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("OUTSIDE the installation root")
      expect(r.stderr).toContain(legacy)
      // pre-existing file is never touched by the project install
      expect(readFileSync(legacy, "utf8")).toBe(bytes)
      expect(existsSync(join(sb.proj, ".opencode", "plugin", "blackboard.ts"))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("global legacy v1+v2 entries + project install → refused with BOTH paths listed", async () => {
    const sb = makeSandbox()
    try {
      hostV2(sb)
      const legacyV1 = writeLegacyV1(globalRoot(sb))
      const legacyV2 = writeLegacyV2(globalRoot(sb))
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(legacyV1)
      expect(r.stderr).toContain(legacyV2)
      expect(existsSync(legacyV1)).toBe(true)
      expect(existsSync(legacyV2)).toBe(true)
    } finally {
      sb.cleanup()
    }
  })

  test("explicit install AT the root with the collision (global) migrates the legacy entries", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const legacyV1 = writeLegacyV1(globalRoot(sb))
      const legacyV2 = writeLegacyV2(globalRoot(sb))
      // project install still refuses...
      const refused = await install(sb, ["--project", sb.proj])
      expect(refused.code).toBe(2)
      // ...so the user installs explicitly at the global root, adopting the
      // exact digests after verifying the files are theirs. Global mode makes
      // the global root itself the installation root, so its legacy entries
      // are inside the mutation scope.
      const r = await install(sb, [...adoptArgs(legacyV1), ...adoptArgs(legacyV2)])
      expect(r.code).toBe(0)
      // the v1 fixture sits at the canonical name: replaced in place there
      expect(readFileSync(legacyV1, "utf8")).toEqual(readFileSync(BUNDLE, "utf8"))
      expect(existsSync(legacyV2)).toBe(false)
      expect(existsSync(join(globalRoot(sb), "plugin", "blackboard.ts"))).toBe(true)
      const manifest = JSON.parse(readFileSync(join(globalRoot(sb), "bcp-install.json"), "utf8"))
      expect(manifest.migrated.map((m: { file: string }) => m.file)).toContain("plugin/blackboard.ts")
      expect(manifest.migrated).toHaveLength(2)
      // now the original project install still sees a manifested global install
      // and refuses — clearing that root explicitly is a separate step
      const p = await install(sb, ["--project", sb.proj])
      expect(p.code).toBe(2)
    } finally {
      sb.cleanup()
    }
  })

  test("global manifested install + project install → refused; global install stays intact", async () => {
    const sb = makeSandbox()
    try {
      hostV2(sb)
      const g = await install(sb, [])
      expect(g.code).toBe(0)
      const gCanon = join(globalRoot(sb), "plugin", "blackboard.ts")
      const gManifest = join(globalRoot(sb), "bcp-install.json")
      expect(existsSync(gCanon)).toBe(true)
      const p = await install(sb, ["--project", sb.proj])
      expect(p.code).toBe(2)
      expect(p.stderr).toContain("OUTSIDE the installation root")
      expect(p.stderr).toContain(gCanon)
      expect(existsSync(gCanon)).toBe(true)
      expect(existsSync(gManifest)).toBe(true)
      expect(existsSync(join(sb.proj, ".opencode", "plugin", "blackboard.ts"))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("after uninstalling the global install, the project install proceeds", async () => {
    const sb = makeSandbox()
    try {
      hostV2(sb)
      expect((await install(sb, [])).code).toBe(0)
      expect((await install(sb, ["--project", sb.proj])).code).toBe(2)
      const u = await runScript(UNINSTALL, [], sb.env())
      expect(u.code).toBe(0)
      const p = await install(sb, ["--project", sb.proj])
      expect(p.code).toBe(0)
      expectCanonical(sb)
    } finally {
      sb.cleanup()
    }
  })

  test("$HOME/.opencode legacy with target UNDER HOME → ancestor collision refused, legacy untouched", async () => {
    const sb = makeSandbox()
    try {
      hostV2(sb)
      const legacy = writeLegacyV1(join(sb.home, ".opencode"))
      const bytes = readFileSync(legacy, "utf8")
      const target = join(sb.home, "work", "proj")
      mkdirSync(target, { recursive: true })
      const r = await install(sb, ["--project", target])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("OUTSIDE the installation root")
      expect(r.stderr).toContain(legacy)
      expect(readFileSync(legacy, "utf8")).toBe(bytes)
      expect(existsSync(join(target, ".opencode", "plugin", "blackboard.ts"))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("ancestor .opencode collision at depth (17 levels up) → refused with the ancestor path", async () => {
    const sb = makeSandbox()
    try {
      hostV2(sb)
      let target = sb.proj
      for (let i = 0; i < 20; i++) {
        target = join(target, `lvl${i}`)
      }
      mkdirSync(target, { recursive: true })
      // true ancestor of target: 17 chain levels deep (2 levels up from lvl19)
      let ancestor = sb.proj
      for (let i = 0; i <= 17; i++) {
        ancestor = join(ancestor, `lvl${i}`)
      }
      const legacy = writeLegacyV1(join(ancestor, ".opencode"))
      const r = await install(sb, ["--project", target])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(legacy)
      expect(existsSync(legacy)).toBe(true)
    } finally {
      sb.cleanup()
    }
  })

  test("legacy at the global root + deep project target → refused (no depth truncation in the scan)", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      writeLegacyV1(globalRoot(sb))
      let target = sb.proj
      for (let i = 0; i < 20; i++) {
        target = join(target, `lvl${i}`)
      }
      mkdirSync(target, { recursive: true })
      const r = await install(sb, ["--project", target])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(join(globalRoot(sb), "plugin", "blackboard.ts"))
      expect(existsSync(join(globalRoot(sb), "plugin", "blackboard.ts"))).toBe(true)
    } finally {
      sb.cleanup()
    }
  })

  test("OPENCODE_CONFIG_DIR overrides the global root; a legacy entry there is a collision, handled by an explicit install at that root", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const cfg = join(sb.home, "custom-cfg")
      const legacy = writeLegacyV1(cfg)
      const r = await install(sb, ["--project", sb.proj], { OPENCODE_CONFIG_DIR: cfg })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(legacy)
      expect(existsSync(legacy)).toBe(true)
      // explicit install at that root migrates it: global mode makes cfg itself
      // the installation root, so cfg/plugin/blackboard.ts is in mutation scope
      const g = await install(sb, adoptArgs(legacy), { OPENCODE_CONFIG_DIR: cfg })
      expect(g.code).toBe(0)
      // the legacy fixture sits at the canonical name: replaced in place there
      expect(existsSync(join(cfg, "plugin", "blackboard.ts"))).toBe(true)
      expect(readFileSync(join(cfg, "plugin", "blackboard.ts"), "utf8")).toEqual(readFileSync(BUNDLE, "utf8"))
      const manifest = JSON.parse(readFileSync(join(cfg, "bcp-install.json"), "utf8"))
      expect(manifest.migrated[0].root).toBe(cfg)
      // a subsequent project install still collides with the manifested
      // custom global root and refuses — per scope rules
      const p = await install(sb, ["--project", sb.proj], { OPENCODE_CONFIG_DIR: cfg })
      expect(p.code).toBe(2)
    } finally {
      sb.cleanup()
    }
  })

  test("$HOME/.opencode legacy with target NOT under HOME → host cannot discover it: no refusal, untouched", async () => {
    const sb = makeSandbox()
    try {
      hostV2(sb)
      const legacy = writeLegacyV1(join(sb.home, ".opencode")) // $HOME/.opencode/plugin/blackboard.ts
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(readFileSync(legacy, "utf8")).toContain("pre-2.0.0")
      expectCanonical(sb)
    } finally {
      sb.cleanup()
    }
  })

  test("unmanaged blackboard* plugin OUTSIDE the installation root is not ours to police: install proceeds", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const dir = join(globalRoot(sb), "plugins")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "blackboard-experimental.ts"), "// user experiment\n")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(readFileSync(join(dir, "blackboard-experimental.ts"), "utf8")).toContain("user experiment")
      expectCanonical(sb)
    } finally {
      sb.cleanup()
    }
  })
})

describe("install.sh: legacy ownership by exact digest (markers are not ownership)", () => {
  test("user file at managed name at the INSTALLATION ROOT (marker + user behavior) → refused, bytes preserved; exact --adopt migrates", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const f = join(sb.proj, ".opencode", "plugin", "blackboard.ts")
      mkdirSync(join(sb.proj, ".opencode", "plugin"), { recursive: true })
      const userBytes =
        "// User-added behavior must not be silently lost\nexport default function BlackboardPlugin() { return { custom: true }; }\n"
      writeFileSync(f, userBytes)
      const digest = sha256File(f)
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("matches no known release digest")
      expect(r.stderr).toContain(sha256File(f))
      expect(readFileSync(f, "utf8")).toBe(userBytes) // never overwritten
      expect(existsSync(join(sb.proj, ".opencode", "bcp-install.json"))).toBe(false)
      // adoption must be of THAT exact digest
      const wrong = await install(sb, ["--project", sb.proj, "--adopt", `${f}=${"0".repeat(64)}`])
      expect(wrong.code).toBe(2)
      expect(readFileSync(f, "utf8")).toBe(userBytes)
      const ok = await install(sb, ["--project", sb.proj, ...adoptArgs(f)])
      expect(ok.code).toBe(0)
      // f sits at the canonical name: the legacy entry is replaced there
      expectCanonical(sb)
      const manifest = JSON.parse(readFileSync(join(sb.proj, ".opencode", "bcp-install.json"), "utf8"))
      expect(manifest.migrated[0].sha256).toBe(digest)
    } finally {
      sb.cleanup()
    }
  })

  test("known legacy release digest (v1 bundle recoverable from git) migrates WITHOUT --adopt", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const legacy = gitLegacyV1File(join(globalRoot(sb), "plugin", "blackboard.ts"))
      const digest = sha256File(legacy)
      const r = await install(sb, []) // global install: target root = global root
      expect(r.code).toBe(0)
      // the legacy file sits at the canonical name: replaced in place
      const canonical = join(globalRoot(sb), "plugin", "blackboard.ts")
      expect(existsSync(canonical)).toBe(true)
      expect(readFileSync(canonical, "utf8")).toEqual(readFileSync(BUNDLE, "utf8"))
      const manifest = JSON.parse(readFileSync(join(globalRoot(sb), "bcp-install.json"), "utf8"))
      expect(manifest.migrated[0].sha256).toBe(digest)
      expect(r.stdout).toContain("migrated: 1")
    } finally {
      sb.cleanup()
    }
  })

  test("markerless file at managed name at the installation root → refused with guidance", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const foreign = join(sb.proj, ".opencode", "plugin", "blackboard.ts")
      mkdirSync(join(sb.proj, ".opencode", "plugin"), { recursive: true })
      writeFileSync(foreign, "// user's own blackboard project — not ours\n")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("matches no known release digest")
      expect(readFileSync(foreign, "utf8")).toContain("user's own blackboard project")
      expect(existsSync(join(sb.proj, ".opencode", "plugin", "blackboard.ts"))).toBe(true)
    } finally {
      sb.cleanup()
    }
  })

  test("target = HOME with $HOME/.opencode managed entries → same-root replacement via adoption, single canonical", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const legacyV1 = writeLegacyV1(join(sb.home, ".opencode"))
      const legacyV2 = writeLegacyV2(join(sb.home, ".opencode"))
      const r = await install(sb, ["--project", sb.home, ...adoptArgs(legacyV1), ...adoptArgs(legacyV2)])
      expect(r.code).toBe(0)
      expect(r.stderr).not.toContain("ERROR")
      expectCanonical(sb, sb.home)
      expect(existsSync(join(sb.home, ".opencode", "plugins", "blackboard-v2.ts"))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("unmanaged conflicting blackboard* file at the installation root → refuse exit 2", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const dir = join(sb.proj, ".opencode", "plugins")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "blackboard-experimental.ts"), "// user experiment\n")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("unmanaged conflicting plugin file")
      expect(existsSync(join(dir, "blackboard-experimental.ts"))).toBe(true)
    } finally {
      sb.cleanup()
    }
  })
})

describe("install.sh: usage/CLI", () => {
  test("symlink alias project path → physical canonicalization; canonical lands on the physical root", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const real = join(sb.base, "real", "sub")
      mkdirSync(real, { recursive: true })
      const alias = join(sb.base, "alias")
      symlinkSync(real, alias)
      const r = await install(sb, ["--project", alias])
      expect(r.code).toBe(0)
      const canonical = join(real, ".opencode", "plugin", "blackboard.ts")
      expect(existsSync(canonical)).toBe(true)
      expect(readFileSync(canonical, "utf8")).toEqual(readFileSync(BUNDLE, "utf8"))
    } finally {
      sb.cleanup()
    }
  })

  test("missing --project directory → exit 3, explicit message", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const r = await install(sb, ["--project", join(sb.base, "no-such-dir")])
      expect(r.code).toBe(3)
      expect(r.stderr).toContain("not an existing directory")
    } finally {
      sb.cleanup()
    }
  })

  test("unknown flag → exit 2 usage", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const r = await install(sb, ["--v2"])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("unknown argument: --v2")
    } finally {
      sb.cleanup()
    }
  })

  test("--adopt without a digest separator or with non-hex digest → exit 2", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const bad1 = await install(sb, ["--project", sb.proj, "--adopt", "just-a-path"])
      expect(bad1.code).toBe(2)
      expect(bad1.stderr).toContain("--adopt expects <file>=<sha256>")
      const bad2 = await install(sb, ["--project", sb.proj, "--adopt", `/tmp/x=${"zz".repeat(32)}`])
      expect(bad2.code).toBe(2)
      expect(bad2.stderr).toContain("64 lowercase hex")
    } finally {
      sb.cleanup()
    }
  })
})

describe("install.sh: installation-root housekeeping", () => {
  test("crashed atomic-write leftover (blackboard.ts.tmp.*) is cleaned, not refused", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      const dir = join(sb.proj, ".opencode", "plugin")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "blackboard.ts.tmp.4711"), "partial copy garbage\n")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(existsSync(join(dir, "blackboard.ts.tmp.4711"))).toBe(false)
      expectCanonical(sb)
    } finally {
      sb.cleanup()
    }
  })

  test("stale manifest without canonical file → cleaned silently", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      mkdirSync(join(sb.proj, ".opencode"), { recursive: true })
      writeFileSync(join(sb.proj, ".opencode", "bcp-install.json"), '{"artifactSha256": "' + "a".repeat(64) + '"}')
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expectCanonical(sb)
    } finally {
      sb.cleanup()
    }
  })

  test("idempotent reinstall: already up to date → exit 0, no churn", async () => {
    const sb = makeSandbox()
    try {
      hostV1(sb)
      expect((await install(sb, ["--project", sb.proj])).code).toBe(0)
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("already installed")
      expectCanonical(sb)
    } finally {
      sb.cleanup()
    }
  })
})
