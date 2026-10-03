// Builder CLI + release artifact coherence for BCP 2.0.0: one dual-entry
// bundle, machine-readable release manifest, no runtime host-SDK dependency,
// package/release version alignment.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { BUNDLE, REPO, ensureBundle } from "./install-helpers"

const RELEASE = join(REPO, "dist", "release.json")
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"))

describe("scripts/build.sh: builder CLI and artifacts", () => {
  const bundle = ensureBundle()

  test("builds the single dual-entry bundle + release manifest", () => {
    expect(existsSync(bundle)).toBe(true)
    expect(existsSync(RELEASE)).toBe(true)
    // superseded pre-2.0.0 artifacts must not resurface
    expect(existsSync(join(REPO, "dist", "blackboard-v2.ts"))).toBe(false)
    expect(existsSync(join(REPO, "dist", "plugin.js"))).toBe(false)
  })

  test("package version is 2.0.0 and stays private/unpublished", () => {
    expect(PKG.version).toBe("2.0.0")
    expect(PKG.private).toBe(true)
    expect(PKG.name).toBe("opencode-bcp")
  })

  test("release manifest is machine-readable and coherently versioned", () => {
    const rel = JSON.parse(readFileSync(RELEASE, "utf8"))
    expect(rel.version).toBe(PKG.version)
    expect(rel.private).toBe(true)
    expect(rel.entryShape).toEqual({ id: "opencode-bcp", server: "v1", setup: "v2" })
    expect(rel.compatibility.v1.minimum).toBe("1.18.29")
    expect(rel.compatibility.v1.tested).toBe("1.18.33")
    expect(rel.compatibility.v2.minimum).toBe("2.0.20")
    expect(rel.compatibility.v2.tested).toBe("2.0.20")
    expect(rel.compatibility.discoveryPath).toContain("plugin/blackboard.ts")
    expect(rel.artifactSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rel.artifactBytes).toBe(statSync(bundle).size)
  })

  test("bundle carries provenance banner and no runtime @opencode/* import", () => {
    const src = readFileSync(bundle, "utf8")
    expect(src).toContain("@opencode-bcp-generated v2.0.0 dual-entry bundle")
    expect(src).toContain("server=v1 >=1.18.29")
    expect(src).not.toMatch(/from\s+["']@opencode/)
    // both entry implementations must be reachable in the single artifact
    expect(src).toContain("BlackboardPlugin")
    expect(src).toContain("BlackboardV2Plugin")
  })

  test("devDependencies: v2 host SDK pinned at tested 2.0.20, v1 SDK preserved", () => {
    expect(PKG.devDependencies["@opencode/plugin"]).toBe("2.0.20")
    expect(PKG.devDependencies["@opencode-ai/plugin"]).toBe("^1.18.31")
    const lock = readFileSync(join(REPO, "bun.lock"), "utf8")
    expect(lock).toContain('"@opencode/plugin": "2.0.20"')
  })
})
