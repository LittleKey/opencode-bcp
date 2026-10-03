// Manifest, idempotence, rollback, and ownership-checked uninstall for the
// BCP 2.0.0 installer. All fixtures are real filesystem under mkdtemp; the
// developer machine's real opencode config/storage is never touched.
//
// Owner remediation (2026-09-30): mutation happens ONLY inside the
// installation root; rollback must preserve symlink topology, not just bytes.
import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  BUNDLE,
  INSTALL,
  UNINSTALL,
  adoptArgs,
  ensureBundle,
  makeSandbox,
  runScript,
  sha256File,
  writeFakeHost,
  writeLegacyV1,
  writeLegacyV1Js,
  writeLegacyV2,
  type Sandbox,
} from "./install-helpers"

function globalRoot(sb: Sandbox): string {
  return join(sb.home, ".config", "opencode")
}
function canonicalOf(sb: Sandbox, root?: string): string {
  return join(root ?? sb.proj, ".opencode", "plugin", "blackboard.ts")
}
function manifestOf(sb: Sandbox, root?: string): string {
  return join(root ?? sb.proj, ".opencode", "bcp-install.json")
}
async function install(sb: Sandbox, args: string[], env?: Record<string, string | undefined>) {
  return runScript(INSTALL, args, sb.env(env))
}
async function uninstall(sb: Sandbox, args: string[] = []) {
  return runScript(UNINSTALL, args, sb.env())
}
function releaseVersion(): string {
  return JSON.parse(readFileSync(join(import.meta.dir, "..", "dist", "release.json"), "utf8")).version
}

describe("install.sh: machine-readable manifest", () => {
  test("manifest records version, host, sha256, entry shape, compatibility floors", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "opencode v2.0.20")
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      const m = JSON.parse(readFileSync(manifestOf(sb), "utf8"))
      expect(m.schema).toBe("opencode-bcp.install/1")
      expect(m.name).toBe("opencode-bcp")
      // version coherence with the built release manifest (the 2.0.0 candidate
      // version itself is asserted in install-build.test.ts)
      expect(m.version).toBe(releaseVersion())
      expect(m.host.family).toBe("v2")
      expect(m.host.version).toBe("2.0.20")
      expect(m.file).toBe("plugin/blackboard.ts")
      expect(m.artifactSha256).toBe(sha256File(canonicalOf(sb)))
      expect(m.entryShape).toEqual({ id: "opencode-bcp", server: "v1", setup: "v2" })
      // documented v1 dual-entry floor distinct from the tested host, and the
      // v2 installation floor is 2.0.20 (not the earlier adapter declaration)
      expect(m.requirements.v1).toContain("1.18.29")
      expect(m.requirements.v1).toContain("1.18.33")
      expect(m.requirements.v2).toContain("2.0.20")
      expect(m.requirements.v2).not.toContain("2.0.16")
      expect(Array.isArray(m.migrated)).toBe(true)
    } finally {
      sb.cleanup()
    }
  })
})

describe("install.sh: idempotence & managed replace", () => {
  test("second identical install is a no-op: exit 0, file untouched, no migration", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33")
      expect((await install(sb, ["--project", sb.proj])).code).toBe(0)
      const before = statSync(canonicalOf(sb))
      const r = await install(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("already installed")
      const after = statSync(canonicalOf(sb))
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(after.ino).toBe(before.ino)
    } finally {
      sb.cleanup()
    }
  })

  test("changed bundle (--artifact) over manifested install → managed replace, manifest updated", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33")
      expect((await install(sb, ["--project", sb.proj])).code).toBe(0)
      const oldSha = sha256File(canonicalOf(sb))
      const bumped = join(sb.base, "bumped-bundle.ts")
      writeFileSync(bumped, readFileSync(BUNDLE, "utf8") + "\n// bumped build variant\n")
      const newSha = sha256File(bumped)
      expect(newSha).not.toBe(oldSha)
      const r = await install(sb, ["--project", sb.proj, "--artifact", bumped])
      expect(r.code).toBe(0)
      expect(sha256File(canonicalOf(sb))).toBe(newSha)
      const m = JSON.parse(readFileSync(manifestOf(sb), "utf8"))
      expect(m.artifactSha256).toBe(newSha)
      expect(m.migrated).toHaveLength(1)
      expect(m.migrated[0].sha256).toBe(oldSha)
      expect(r.stdout).toContain("migrated: 1")
    } finally {
      sb.cleanup()
    }
  })

  test("user-modified canonical → reinstall AND uninstall refuse (exit 2), file preserved", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33")
      expect((await install(sb, ["--project", sb.proj])).code).toBe(0)
      writeFileSync(canonicalOf(sb), readFileSync(canonicalOf(sb), "utf8") + "\n// user patch\n")
      const ri = await install(sb, ["--project", sb.proj])
      expect(ri.code).toBe(2)
      expect(ri.stderr).toContain("user-modified")
      const ru = await uninstall(sb, ["--project", sb.proj])
      expect(ru.code).toBe(2)
      expect(ru.stderr).toContain("user-modified")
      expect(readFileSync(canonicalOf(sb), "utf8")).toContain("// user patch")
    } finally {
      sb.cleanup()
    }
  })
})

describe("install.sh: transactional rollback (fault injection)", () => {
  const legacyContent = "// opencode-bcp v1 managed install (pre-2.0.0)\nexport const BlackboardPlugin = async () => ({})\n"

  /** Legacy entry sits at the INSTALLATION root (mutation scope), adopted via
   *  its exact digest. Rollback must restore it byte-identically and leave no
   *  canonical/manifest/stage leftovers. */
  async function rollbackCase(sb: Sandbox, fault: string, opts: { dirsMayRemain?: boolean } = {}) {
    writeFakeHost(sb.bin, "1.18.33")
    const legacy = writeLegacyV1(join(sb.proj, ".opencode"))
    writeFileSync(legacy, legacyContent)
    const r = await install(sb, ["--project", sb.proj, "--artifact", ensureBundle(), ...adoptArgs(legacy)], {
      BCP_INSTALL_FAULT: fault,
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`injected test fault reached: ${fault}`)
    // original state restored byte-identically (the legacy entry sits at the
    // canonical name, so the restored file is the LEGACY bytes, never a
    // partial install)
    expect(readFileSync(legacy, "utf8")).toBe(legacyContent)
    expect(readFileSync(canonicalOf(sb), "utf8")).toBe(legacyContent)
    // no partial install, no stage leftovers
    expect(existsSync(manifestOf(sb))).toBe(false)
    const pluginDir = join(sb.proj, ".opencode", "plugin")
    if (existsSync(pluginDir)) {
      const leftovers = Array.from(new Bun.Glob("blackboard.ts.tmp.*").scanSync({ cwd: pluginDir }))
      expect(leftovers).toEqual([])
    }
    if (!opts.dirsMayRemain) {
      // dirs created only for staging may remain, but plugin/ existed already
      // as the fixture home — only assert nothing else appeared
      expect(existsSync(join(sb.proj, ".opencode", "plugins"))).toBe(false)
    }
  }

  test("fault after-backup → nothing removed", async () => {
    const sb = makeSandbox()
    try {
      await rollbackCase(sb, "after-backup")
    } finally {
      sb.cleanup()
    }
  })

  test("fault after-removals → legacy restored byte-identical, no canonical/manifest", async () => {
    const sb = makeSandbox()
    try {
      await rollbackCase(sb, "after-removals")
    } finally {
      sb.cleanup()
    }
  })

  test("fault before-manifest → canonical removed again, legacy restored", async () => {
    const sb = makeSandbox()
    try {
      await rollbackCase(sb, "before-manifest", { dirsMayRemain: true })
    } finally {
      sb.cleanup()
    }
  })

  test("fault after-removals → symlinked legacy entry restored AS a symlink (link topology preserved)", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33")
      const referent = join(sb.base, "user-blackboard-source.ts")
      writeFileSync(referent, legacyContent)
      const pluginDir = join(sb.proj, ".opencode", "plugin")
      mkdirSync(pluginDir, { recursive: true })
      const legacy = join(pluginDir, "blackboard.ts")
      symlinkSync(referent, legacy)
      const r = await install(sb, ["--project", sb.proj, "--artifact", ensureBundle(), ...adoptArgs(legacy)], {
        BCP_INSTALL_FAULT: "after-removals",
      })
      expect(r.code).toBe(1)
      // byte safety AND topology: the entry is again the same symlink
      expect(readFileSync(referent, "utf8")).toBe(legacyContent)
      expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
      expect(readlinkSync(legacy)).toBe(referent)
      expect(readFileSync(legacy, "utf8")).toBe(legacyContent)
      expect(existsSync(manifestOf(sb))).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("upgrade fault before-manifest → previous canonical + manifest restored byte-identically", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33")
      expect((await install(sb, ["--project", sb.proj, "--artifact", ensureBundle()])).code).toBe(0)
      const oldCanon = readFileSync(canonicalOf(sb))
      const oldManifest = readFileSync(manifestOf(sb), "utf8")
      const bumped = join(sb.base, "bumped-bundle.ts")
      writeFileSync(bumped, readFileSync(BUNDLE, "utf8") + "\n// bumped build variant\n")
      const r = await install(sb, ["--project", sb.proj, "--artifact", bumped], { BCP_INSTALL_FAULT: "before-manifest" })
      expect(r.code).toBe(1)
      // rollback of a REPLACE restores the exact previous canonical bytes and
      // the exact previous manifest (the old entry stayed present until the
      // atomic replacement, and rollback puts it back)
      expect(readFileSync(canonicalOf(sb))).toEqual(oldCanon)
      expect(readFileSync(manifestOf(sb), "utf8")).toBe(oldManifest)
    } finally {
      sb.cleanup()
    }
  })
})

describe("uninstall.sh: ownership-checked removal", () => {
  test("manifested install → canonical + manifest removed; unrelated files and storage data preserved", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33")
      expect((await install(sb, ["--project", sb.proj])).code).toBe(0)
      const other = join(sb.proj, ".opencode", "plugin", "unrelated.ts")
      writeFileSync(other, "// keep me\n")
      const data = join(sb.home, ".cache", "opencode", "blackboard", "v1", "entries", "e1.json")
      mkdirSync(join(data, ".."), { recursive: true })
      writeFileSync(data, "{}")
      const r = await uninstall(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(existsSync(canonicalOf(sb))).toBe(false)
      expect(existsSync(manifestOf(sb))).toBe(false)
      expect(readFileSync(other, "utf8")).toContain("keep me")
      expect(readFileSync(data, "utf8")).toBe("{}")
      expect(r.stdout).toContain("storage kept")
    } finally {
      sb.cleanup()
    }
  })

  test("project uninstall removes ONLY installation-root entries; legacy in other roots is reported but untouched", async () => {
    const sb = makeSandbox()
    try {
      const legacyGlobal = writeLegacyV1(globalRoot(sb))
      const legacyGlobalJs = writeLegacyV1Js(globalRoot(sb))
      const legacyGlobalV2 = writeLegacyV2(globalRoot(sb))
      const legacyProj = writeLegacyV1(join(sb.proj, ".opencode"))
      const other = join(globalRoot(sb), "plugin", "unrelated.ts")
      writeFileSync(other, "// keep me\n")
      // a target project is NOT authorization to remove a plugin other
      // projects may use: only proj/.opencode is mutated
      const r = await uninstall(sb, ["--project", sb.proj, ...adoptArgs(legacyProj)])
      expect(r.code).toBe(0)
      expect(existsSync(legacyProj)).toBe(false)
      expect(existsSync(legacyGlobal)).toBe(true)
      expect(existsSync(legacyGlobalJs)).toBe(true)
      expect(existsSync(legacyGlobalV2)).toBe(true)
      expect(existsSync(other)).toBe(true)
      expect(r.stdout).toContain("present elsewhere (untouched)")
      expect(r.stdout).toContain(legacyGlobal)
      // explicit uninstall at the global root handles those entries
      const g = await uninstall(sb, [
        ...adoptArgs(legacyGlobal),
        ...adoptArgs(legacyGlobalJs),
        ...adoptArgs(legacyGlobalV2),
      ])
      expect(g.code).toBe(0)
      expect(existsSync(legacyGlobal)).toBe(false)
      expect(existsSync(legacyGlobalJs)).toBe(false)
      expect(existsSync(legacyGlobalV2)).toBe(false)
      expect(existsSync(other)).toBe(true)
    } finally {
      sb.cleanup()
    }
  })

  test("legacy file matching no known release digest → refuse exit 2, nothing removed; --adopt of the exact digest authorizes removal", async () => {
    const sb = makeSandbox()
    try {
      const legacy = writeLegacyV1(join(sb.proj, ".opencode"))
      writeFileSync(legacy, "// someone hijacked this filename\n")
      const r = await uninstall(sb, ["--project", sb.proj])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("matches no known release digest")
      expect(existsSync(legacy)).toBe(true)
      const a = await uninstall(sb, ["--project", sb.proj, ...adoptArgs(legacy)])
      expect(a.code).toBe(0)
      expect(existsSync(legacy)).toBe(false)
    } finally {
      sb.cleanup()
    }
  })

  test("uninstall --adopt with a mismatching digest → refused", async () => {
    const sb = makeSandbox()
    try {
      const legacy = writeLegacyV1(join(sb.proj, ".opencode"))
      const r = await uninstall(sb, ["--project", sb.proj, "--adopt", `${legacy}=${"0".repeat(64)}`])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("--adopt digest mismatch")
      expect(existsSync(legacy)).toBe(true)
    } finally {
      sb.cleanup()
    }
  })

  test("nothing installed → exit 0 no-op", async () => {
    const sb = makeSandbox()
    try {
      const r = await uninstall(sb, [])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("not installed")
    } finally {
      sb.cleanup()
    }
  })

  test("uninstall twice → second run is a clean no-op", async () => {
    const sb = makeSandbox()
    try {
      writeFakeHost(sb.bin, "1.18.33")
      expect((await install(sb, ["--project", sb.proj])).code).toBe(0)
      expect((await uninstall(sb, ["--project", sb.proj])).code).toBe(0)
      const r = await uninstall(sb, ["--project", sb.proj])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("not installed")
    } finally {
      sb.cleanup()
    }
  })
})
