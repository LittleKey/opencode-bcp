// Local source binding: authorized bytes -> retained snapshot -> checked reference.
import { createHash } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Scope } from "./storage"

export const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024
export type FileAccess = {
  directory?: string
  ask?: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>
}
export type Artifact = { index: number; path: string; bytes: Buffer; sha256: string }
export type ArtifactBinding = { path: string; snapshot: string; sha256: string; bytes: number }
export function artifactSourceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string } | null)?.code
  if (code !== "ENOENT" && code !== "ENOTDIR" && message !== "artifact_not_regular_file") return message
  return message + ". source_refs: use exact readable regular-file paths or file:// URIs; do not append hash notes or commentary. Describe missing files and directories in content, and omit those entries from source_refs. An empty source_refs is valid for a blocked result with no readable artifact."
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const extension = (path: string) => /^\.[a-z0-9]{1,10}$/i.test(extname(path)) ? extname(path).toLowerCase() : ""

function localRef(ref: string): { path: string; expected?: string } | null {
  if (!ref.startsWith("file://") && !isAbsolute(ref) && !ref.startsWith("~/")) return null
  const split = ref.indexOf("#")
  const base = split < 0 ? ref : ref.slice(0, split)
  const fragment = split < 0 ? "" : ref.slice(split + 1)
  if (fragment && !/^sha256=[0-9a-f]{64}$/i.test(fragment)) throw new Error("artifact_hash_invalid: use #sha256=<64 hex digits>")
  const path = base.startsWith("file://") ? fileURLToPath(base) : base.startsWith("~/") ? join(homedir(), base.slice(2)) : base
  return { path, ...(fragment ? { expected: fragment.slice(7).toLowerCase() } : {}) }
}

function readBounded(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error("artifact_not_regular_file")
    if (stat.size > ARTIFACT_MAX_BYTES) throw new Error("artifact_too_large: maximum 4 MiB")
    const bytes = Buffer.alloc(Math.min(stat.size + 1, ARTIFACT_MAX_BYTES + 1))
    let used = 0
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null)
      if (!n) break
      used += n
    }
    if (used > stat.size || fstatSync(fd).size !== stat.size) throw new Error("artifact_changed_during_read")
    return bytes.subarray(0, used)
  } finally { closeSync(fd) }
}

export async function prepareArtifacts(refs: string[] | undefined, ctx: FileAccess): Promise<Artifact[]> {
  const out: Artifact[] = []
  for (const [index, ref] of (refs ?? []).entries()) {
    const local = localRef(ref)
    if (!local) continue
    if (out.length >= 8) throw new Error("artifact_count_exceeded: maximum 8 local references")
    if (!ctx.ask || !ctx.directory) throw new Error("artifact_permission_unavailable: host cannot authorize local snapshots")
    const authorize = async (path: string) => {
      const rel = relative(ctx.directory!, path)
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        await ctx.ask!({ permission: "external_directory", patterns: [dirname(path) + "/*"], always: [], metadata: { path } })
      }
      await ctx.ask!({ permission: "read", patterns: [path], always: [], metadata: { path, purpose: "board artifact snapshot" } })
    }
    await authorize(local.path)
    const path = realpathSync(local.path)
    if (path !== local.path) await authorize(path)
    const bytes = readBounded(path)
    const sha256 = hash(bytes)
    if (local.expected && local.expected !== sha256) throw new Error("artifact_hash_mismatch: " + local.path)
    out.push({ index, path, bytes, sha256 })
  }
  return out
}

// Caller holds the existing scope lock. Snapshots count toward the scope quota.
export function retainArtifacts(scope: Scope, streamId: string, refs: string[] | undefined, artifacts: Artifact[]) {
  const sourceRefs = refs?.slice()
  const bindings: ArtifactBinding[] = []
  const dir = join(scope.dir, "streams", streamId, "artifacts")
  const pending = new Map<string, Artifact>()
  for (const artifact of artifacts) {
    const snapshot = join(dir, artifact.sha256 + extension(artifact.path))
    if (existsSync(snapshot)) {
      if (hash(readBounded(snapshot)) !== artifact.sha256) throw new Error("artifact_snapshot_corrupt: " + snapshot)
    } else pending.set(snapshot, artifact)
    sourceRefs![artifact.index] = pathToFileURL(snapshot).href + "#sha256=" + artifact.sha256
    bindings.push({ path: artifact.path, snapshot, sha256: artifact.sha256, bytes: artifact.bytes.length })
  }
  const extra = [...pending.values()].reduce((n, a) => n + a.bytes.length, 0)
  if (extra && scope.usageBytes() + extra > scope.config.quota_bytes) throw new Error("artifact_quota_exceeded")
  if (pending.size) mkdirSync(dir, { recursive: true })
  for (const [path, artifact] of pending) writeFileSync(path, artifact.bytes, { flag: "wx", mode: 0o600 })
  return { sourceRefs, bindings }
}

export function inspectArtifacts(scope: Scope, streamId: string, refs: string[] | undefined) {
  return (refs ?? []).flatMap(ref => {
    let local: ReturnType<typeof localRef>
    try { local = localRef(ref) } catch { return [{ ref, status: "invalid" }] }
    if (!local) return []
    const expectedPath = local.expected && join(scope.dir, "streams", streamId, "artifacts", local.expected + extension(local.path))
    // Only BCP-owned, same-record-stream snapshots can be checked without a new file permission.
    if (!expectedPath || resolve(local.path) !== expectedPath) return [{ ref, status: "unverified_legacy_reference" }]
    try {
      const bytes = readBounded(expectedPath)
      const actual = hash(bytes)
      return [{ ref, status: actual === local.expected ? "verified" : "mismatch", sha256: actual, bytes: bytes.length }]
    } catch { return [{ ref, status: "unavailable" }] }
  })
}

export function malformedSha256(text: string): string | null {
  const pattern = /\bsha[-_ ]?256\b\s*[:=：]\s*[`"'*]*([A-Za-z0-9]+)/gi
  for (const match of text.matchAll(pattern)) if (!/^[0-9a-f]{64}$/i.test(match[1]!)) return match[1]!
  return null
}
