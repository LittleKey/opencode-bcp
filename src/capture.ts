// Preserve one completed author reply without asking the model to publish it again.
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Scope } from "./storage"
import type { HostMessage } from "./delivery"
import { validatePutInput, type RecordKind, type Writer } from "./schema"
import type { EditEvidence } from "./edit-evidence"
import { prepareArtifacts, retainArtifacts, type FileAccess } from "./artifacts"
import { publicReply, replyKey, type StageBoundary } from "./reply"
import { NO_STORE, STORE, publicationMarker, maskPublicationMarkers } from "./markers"

export { NO_STORE, STORE } from "./markers"
// Only an explicit standalone top-level marker authorizes publication, not prose or code.
export function captureRequested(content: string): boolean {
  return publicationMarker(content).requested
}
export type CaptureResult = { status: "stored" | "replay" | "skipped" | "unconfirmed"; id?: string; reason?: string }
export type PermissionRule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }
// OpenCode's wildcard rules match the entire value; '*' includes path separators.
function permissionRule(rules: PermissionRule[], permission: string, pattern = "*") {
  const matches = (value: string, glob: string) => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(value)
  return rules.findLast(rule => matches(permission, rule.permission) && matches(pattern, rule.pattern))
}
export function permissionAction(rules: PermissionRule[], permission: string, pattern = "*") {
  return permissionRule(rules, permission, pattern)?.action ?? "ask"
}
export function publicationAllowed(rules: PermissionRule[], tools: Record<string, boolean> = {}, automatic = true) {
  if (tools.board_put === false || tools.board_store === false) return false
  if (!automatic) return permissionAction(rules, "board_put") === "allow"
  if (permissionAction(rules, "board_store") !== "allow") return false
  // A new explicit grant can override a generic deny, but cannot erase a legacy publication ban.
  const legacy = permissionRule(rules, "board_put")
  return !legacy || legacy.permission === "*" || legacy.action === "allow"
}
export type CaptureHost = {
  resolve: (session: string) => Promise<{ scope: Scope; streamId: string; agent: string | null } | null>
  message: (session: string, id: string) => Promise<HostMessage | null>
  current: (session: string, input: string) => boolean
  authorize: (session: string, agent: string, input: HostMessage) => Promise<FileAccess | null>
  edits?: (session: string, input: string) => { revision: number; paths: string[]; unknownPath: boolean } | undefined
  evidence?: (session: string, input: string, completed: number, access: FileAccess, stage?: StageBoundary) => Promise<EditEvidence>
}
export type StoreRequest = { requestedBy: Writer; description: string; kind?: RecordKind }

export async function captureFinal(session: string, messageID: string, host: CaptureHost, request?: StoreRequest): Promise<CaptureResult> {
  const unknown = (reason: string): CaptureResult => ({ status: "unconfirmed", reason })
  try {
    const resolved = await host.resolve(session)
    if (!resolved?.agent) return unknown("author_unavailable")
    const terminal = await host.message(session, messageID)
    const info = terminal?.info
    const reply = terminal && publicReply(terminal, Boolean(request))
    if (!info || info.id !== messageID || info.sessionID !== session || info.role !== "assistant" ||
        !reply || !info.parentID ||
        (!request && info.agent && info.agent !== resolved.agent) || (request && !info.agent) ||
        terminal.parts?.some(part => part.type === "tool" && part.state?.status !== "completed" && part.state?.status !== "error")) return unknown("not_completed_author_reply")
    const input = await host.message(session, info.parentID)
    if (!input || input.info.id !== info.parentID || input.info.sessionID !== session || input.info.role !== "user") return unknown("input_unavailable")
    const content = reply.content
    if (content.includes(NO_STORE) || input.parts?.some(p => p.type === "text" && p.text?.includes(NO_STORE))) return { status: "skipped", reason: "publication_restricted" }
    if (!content.trim()) return unknown("empty_final")
    const textHash = createHash("sha256").update(content).digest("hex")
    const { scope, streamId } = resolved
    const agent = request ? info.agent! : resolved.agent
    const key = replyKey(session, messageID, reply.kind)
    const originKind = reply.kind === "stage" ? "host_stage" : "host_final"
    // A retained result is stable across retries/restarts: never re-snapshot mutable source files.
    const existing = scope.withLock(() => {
      scope.recoverPending(streamId)
      const id = scope.readMeta(streamId).idem[key]?.id
      return id ? scope.getById(id) : null
    })
    if (existing?.status === "found") {
      const r = existing.record
      return r.origin?.kind === originKind && r.origin.text_sha256 === textHash && r.origin.input_message_id === info.parentID &&
        JSON.stringify(r.origin.stage_boundary) === JSON.stringify(reply.boundary) &&
        r.writer.session_id === session && r.writer.message_id === messageID && r.writer.agent === agent
          ? { status: "replay", id: r.id } : unknown("capture_conflict")
    }
    if (!request && !captureRequested(content)) return { status: "skipped", reason: "capture_not_requested" }
    if (!request && !host.current(session, info.parentID)) return unknown("input_not_current")
    const access = await host.authorize(session, agent, input)
    if (!access) return { status: "skipped", reason: "publication_not_authorized" }
    const body = maskPublicationMarkers(content)
    const firstLine = body.split(/\r?\n/).find(line => line.trim()) ?? "Final reply"
    const description = request?.description ?? publicationMarker(content).description ?? [...`[${agent}] ${firstLine.trim()}`].slice(0, 80).join("")
    const invalid = validatePutInput({ description, content, ...(request?.kind ? { kind: request.kind } : {}) })
    if (invalid.length) return unknown(invalid.map(e => e.code).join(","))
    // Host-observed edits belong to this input, not arbitrary paths mentioned in prose.
    const edits = host.edits?.(session, info.parentID)
    const explicit = body.match(/(?:file:\/\/[^\s<>"`（），。；、]+|bb:\/\/[0-9a-f-]+\/[0-9a-f-]+\/e\d+)/gi)?.map(r => r.replace(/[),.;]+$/, "")) ?? []
    const evidence = await host.evidence?.(session, info.parentID, reply.completed, access, reply.boundary)
    const evidenceErrors = evidence?.errors ?? (request ? ["edit_evidence_unavailable: no historical edit journal"] : [])
    const nativeRefs = evidence || request ? [] : (edits?.paths ?? []).map(p => pathToFileURL(p).href)
    const explicitRefs = explicit.filter(ref => {
      if (!ref.startsWith("file://")) return true
      try {
        const uri = new URL(ref), path = fileURLToPath(uri)
        if (!evidence?.paths.includes(path)) return true
        if (uri.hash && !evidence.bindings.some(b => b.path === path && new URL(b.ref).hash === uri.hash))
          evidenceErrors.push("source_version_conflict: " + ref)
        return false
      } catch { return true }
    })
    const refs = [...new Set([...(evidence?.bindings.map(b => b.ref) ?? []), ...nativeRefs, ...explicitRefs])]
    const sourceRefs = refs.slice(0, 16)
    const errors: string[] = [...evidenceErrors, ...(refs.length > 16 ? ["source_reference_limit: only first 16 inspected"] : [])]
    if (edits?.unknownPath) errors.push("native_edit_paths_unavailable: only known paths can be snapshotted")
    let prepared: Awaited<ReturnType<typeof prepareArtifacts>> = []
    for (const [index, ref] of sourceRefs.entries()) {
      try {
        if (evidence?.bindings.some(b => b.ref === ref)) continue
        if (request && ref.startsWith("file://") && !/#sha256=[0-9a-f]{64}$/i.test(ref)) {
          errors.push("historical_source_version_unavailable: " + ref)
          continue
        }
        if (prepared.length + (evidence?.bindings.length ?? 0) >= 8 && ref.startsWith("file://")) throw Error("artifact_count_exceeded: maximum 8 local references")
        prepared.push(...(await prepareArtifacts([ref], access)).map(a => ({ ...a, index })))
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
    }
    if (!request && !host.current(session, info.parentID)) return unknown("input_changed_during_capture")
    if (!request && edits && host.edits?.(session, info.parentID)?.revision !== edits.revision) return unknown("edits_changed_during_capture")
    if (request) {
      const latest = await host.message(session, messageID)
      if (!latest || latest.info.parentID !== info.parentID || latest.info.agent !== info.agent ||
          JSON.stringify(publicReply(latest, true)) !== JSON.stringify(reply)) return unknown("message_changed_during_capture")
    }
    return scope.withLock(() => {
      // Concurrent event/bridge calls converge on the first capture, even when files changed meanwhile.
      scope.recoverPending(streamId)
      const id = scope.readMeta(streamId).idem[key]?.id
      if (id) {
        const found = scope.getById(id)
        return found.status === "found" && found.record.origin?.text_sha256 === textHash && found.record.writer.message_id === messageID
          ? { status: "replay", id } : unknown("capture_conflict")
      }
      let retainedRefs = sourceRefs
      let bindings: { path: string; ref: string; native_edit?: true }[] = [...(evidence?.bindings.filter(b => sourceRefs.includes(b.ref)) ?? [])]
      try {
        const retained = retainArtifacts(scope, streamId, sourceRefs, prepared)
        retainedRefs = retained.sourceRefs ?? []
        bindings.push(...retained.bindings.map(b => ({ path: b.path, ref: pathToFileURL(b.snapshot).href + "#sha256=" + b.sha256,
          ...(prepared.some(a => a.path === b.path && nativeRefs.includes(sourceRefs[a.index]!)) ? { native_edit: true as const } : {}) })))
      }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
      const meta = scope.readMeta(streamId)
      const result = scope.put(streamId, { writer: { agent, session_id: session, message_id: messageID },
        createdRound: meta.rounds.round_known ? meta.rounds.current_round : null, description, content,
        ...(request?.kind ? { kind: request.kind } : {}),
        sourceRefs: retainedRefs, idempotencyKey: key,
        origin: { kind: originKind, input_message_id: info.parentID!, text_sha256: textHash, message_completed_at: reply.completed,
          ...(reply.boundary ? { stage_boundary: reply.boundary } : {}),
          ...(request ? { requested_by: request.requestedBy } : {}),
          ...(bindings.length ? { file_bindings: bindings } : {}), ...(errors.length ? { source_errors: errors } : {}) } })
      if (result.status === "stored" || result.status === "replay") return { status: result.status, id: result.id }
      return unknown(result.status)
    })
  } catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
}
