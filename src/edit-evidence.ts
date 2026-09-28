// Durable local edit evidence, not board publication or a task lifecycle registry.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { atomicWrite, type Scope } from "./storage"
import { authorizeArtifactPath, inspectArtifacts, prepareArtifacts, retainArtifacts, type Artifact, type FileAccess } from "./artifacts"
import type { StageBoundary } from "./reply"

type ObservedFile = { path: string; ref?: string; error?: string }
type Observation = { call: string; started_at?: number; observed_at: number; files: ObservedFile[]; errors: string[]; pending?: true }
type Journal = { input: string; observations: Observation[]; overflow?: true }
export type EditEvidence = { paths: string[]; bindings: { path: string; ref: string; native_edit: true }[]; errors: string[] }
const file = (scope: Scope, stream: string, input: string) => join(scope.dir, "streams", stream, "edits", createHash("sha256").update(input).digest("hex") + ".json")
function read(scope: Scope, stream: string, input: string): Journal | undefined {
  const path = file(scope, stream, input)
  if (!existsSync(path)) return undefined
  const journal = JSON.parse(readFileSync(path, "utf8")) as Journal
  if (journal.input !== input || !Array.isArray(journal.observations) || journal.observations.length > 256) throw Error("edit_journal_invalid")
  return journal
}
function write(scope: Scope, stream: string, journal: Journal) {
  const text = JSON.stringify(journal)
  if (scope.usageBytes() + Buffer.byteLength(text) > scope.config.quota_bytes) throw Error("edit_evidence_quota_exceeded")
  mkdirSync(dirname(file(scope, stream, journal.input)), { recursive: true, mode: 0o700 })
  atomicWrite(file(scope, stream, journal.input), text, 0o600)
}
export function beginEditObservation(scope: Scope, stream: string, input: string, call: string, now = Date.now) {
  scope.withLock(() => {
    const journal = read(scope, stream, input) ?? { input, observations: [] }
    if (journal.observations.some(r => r.call === call)) return
    if (journal.observations.length >= 256) journal.overflow = true
    else journal.observations.push({ call, observed_at: now(), files: [], errors: [], pending: true })
    write(scope, stream, journal)
  })
}
// A missing observation must not let an earlier snapshot masquerade as the new result.
// The empty sentinel is independent of a failed full-journal rewrite (for example quota exhaustion).
export function invalidateEditEvidence(scope: Scope, stream: string, input: string) {
  const target = file(scope, stream, input) + ".incomplete"
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  writeFileSync(target, "", { mode: 0o600 })
}

export async function observeEdits(scope: Scope, stream: string, input: string, call: string, paths: string[], access: FileAccess, current: () => boolean, now = Date.now, unknownPaths = false) {
  if (!current()) return
  if (scope.withLock(() => read(scope, stream, input)?.observations.some(row => row.call === call && !row.pending))) return
  const files: ObservedFile[] = [], prepared: Artifact[] = [], errors: string[] = []
  if (!paths.length || unknownPaths) errors.push("native_edit_paths_unavailable")
  if (paths.length > 8) errors.push("native_edit_path_limit: only first 8 observed")
  for (const path of [...new Set(paths)].slice(0, 8)) {
    try {
      const artifact = (await prepareArtifacts([pathToFileURL(path).href], access))[0]!
      prepared.push({ ...artifact, index: files.length })
      files.push({ path: artifact.path })
    } catch (error) { files.push({ path, error: String(error) }) }
  }
  if (!current()) return
  scope.withLock(() => {
    if (!current()) return
    const journal = read(scope, stream, input) ?? { input, observations: [] }
    const index = journal.observations.findIndex(row => row.call === call)
    if (index >= 0 && !journal.observations[index]!.pending) return
    if (index < 0 && journal.observations.length >= 256) {
      journal.overflow = true
      write(scope, stream, journal)
      return
    }
    const refs = files.map(f => pathToFileURL(f.path).href)
    // Reserve metadata room as well as artifact bytes; the enclosing scope lock covers both.
    const metadataReserve = Buffer.byteLength(JSON.stringify({ call, files, errors })) + files.length * 1024 + 1024
    if (scope.usageBytes() + metadataReserve > scope.config.quota_bytes) throw Error("edit_evidence_quota_exceeded")
    const retained = retainArtifacts(scope, stream, refs, prepared)
    for (const a of prepared) files[a.index]!.ref = retained.sourceRefs![a.index]
    const row = { call, observed_at: now(), ...(index >= 0 ? { started_at: journal.observations[index]!.observed_at } : {}), files, errors }
    if (index < 0) journal.observations.push(row)
    else journal.observations[index] = row
    write(scope, stream, journal)
  })
}

export async function editEvidence(scope: Scope, stream: string, input: string, completed: number, access: FileAccess, stage?: StageBoundary): Promise<EditEvidence> {
  const journal = scope.withLock(() => read(scope, stream, input))
  if (!journal) return { paths: [], bindings: [], errors: ["edit_evidence_unavailable: no historical edit journal"] }
  const latest = new Map<string, ObservedFile>(), errors: string[] = []
  let pending = existsSync(file(scope, stream, input) + ".incomplete")
  let observations = journal.observations
  if (stage) {
    const calls = stage.tools.filter(t => ["write", "edit", "apply_patch"].includes(t.tool)).map(t => t.call)
    const indices = calls.map(call => observations.findIndex(row => row.call === call))
    if (indices.some(index => index < 0)) return { paths: [], bindings: [], errors: ["stage_edit_evidence_missing"] }
    // Tool completion precedes the after-hook in this host. Select the observed causal prefix,
    // not today's files or the timestamp of a later model response.
    if (indices.length) observations = observations.slice(0, Math.max(...indices) + 1)
    completed = indices.length ? Infinity : stage.created
  }
  for (const row of [...observations].sort((a, b) => a.observed_at - b.observed_at)) {
    if (row.observed_at > completed) {
      if (row.started_at !== undefined && row.started_at <= completed) pending = true
      continue
    }
    if (row.pending) pending = true
    errors.push(...row.errors)
    for (const f of row.files) latest.set(f.path, f)
  }
  if (journal.overflow) errors.push("edit_evidence_limit: operation history incomplete")
  if (pending || journal.overflow) return { paths: [...latest.keys()], bindings: [], errors: [...errors, "edit_evidence_incomplete: do not substitute an earlier snapshot"] }
  const bindings: EditEvidence["bindings"] = []
  for (const [path, f] of latest) {
    if (bindings.length >= 8) { errors.push("artifact_count_exceeded: only first 8 bound"); break }
    if (f.error || !f.ref) { errors.push(`${path}: ${f.error ?? "edit_snapshot_missing"}`); continue }
    try {
      await authorizeArtifactPath(path, access)
      if (inspectArtifacts(scope, stream, [f.ref])[0]?.status !== "verified") throw Error("edit_snapshot_unavailable_or_corrupt")
      bindings.push({ path, ref: f.ref, native_edit: true })
    } catch (error) { errors.push(`${path}: ${String(error)}`) }
  }
  return { paths: [...latest.keys()], bindings, errors: [...new Set(errors)] }
}
