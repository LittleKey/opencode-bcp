// Host-only, read-only evidence inspection. Not a model tool or a completion gate.
import type { Scope } from "./storage"
import { resolveAuthz, refPolicy } from "./permissions"
import { parseBbId } from "./ids"
import { inspectArtifacts } from "./artifacts"
import { createHash } from "node:crypto"
import { publicReply } from "./reply"
import type { Writer } from "./schema"

export const DELIVERY_BRIDGE = Symbol.for("opencode.bcp.delivery.v1")
export type HostMessage = { info: { id: string; sessionID: string; role: string; parentID?: string; agent?: string; finish?: string; time?: { created?: number; completed?: number }; error?: unknown; summary?: boolean; tools?: Record<string, boolean> }; parts?: { id?: string; type: string; text?: string; synthetic?: boolean; ignored?: boolean; time?: { start?: number; end?: number }; callID?: string; tool?: string; state?: { status?: string; time?: { start?: number; end?: number } } }[] }
export type DeliveryRequest = {
  callerSessionID: string; taskID: string; generation?: number; terminalRevision?: number
  state: string; inputMessageID?: string; terminalMessageID?: string
}
export type DeliveryHost = {
  scopeFor: (sessionID: string) => Promise<Scope | null>
  parentFor: (sessionID: string) => Promise<string | null>
  message: (sessionID: string, messageID: string) => Promise<HostMessage | null>
  capture?: (sessionID: string, messageID: string) => Promise<{ status: string; id?: string; reason?: string }>
  canReadResult?: (sessionID: string) => Promise<boolean>
  currentResult?: (sessionID: string, inputMessageID: string) => boolean
}
export type ResultReference = { id: string; description: string; text_sha256: string; bytes: number; writer: Writer; input_message_id: string; source_errors: string[] }
export function deliveryUnknown(request: DeliveryRequest, reason: string): {
  schema_version: number; execution: { task_id: string; generation: number | null; terminal_revision: number | null; state: string }
  association: string; reason: string; candidates: unknown[]; coverage: string; applicability: string; result_reference?: ResultReference
} {
  return { schema_version: 1, execution: { task_id: request.taskID, generation: request.generation ?? null,
    terminal_revision: request.terminalRevision ?? null, state: request.state },
    association: "unconfirmed", reason, candidates: [] as unknown[], coverage: "not_evaluated", applicability: "not_evaluated" }
}

export async function inspectDelivery(request: DeliveryRequest, host: DeliveryHost) {
  const unknown = (reason: string) => deliveryUnknown(request, reason)
  const scope = await host.scopeFor(request.callerSessionID)
  if (!scope) return unknown("caller_unavailable")
  const auth = resolveAuthz(scope, { sessionId: request.callerSessionID, agent: "" })
  if (!auth.registered || await host.parentFor(request.taskID) !== request.callerSessionID) return unknown("unverified_owner")
  if (request.state !== "completed" || !request.inputMessageID || !request.terminalMessageID) return unknown("no_terminal_identity")
  const terminal = await host.message(request.taskID, request.terminalMessageID)
  const input = await host.message(request.taskID, request.inputMessageID)
  if (!terminal || terminal.info.id !== request.terminalMessageID || terminal.info.sessionID !== request.taskID ||
      terminal.info.role !== "assistant" || terminal.info.parentID !== request.inputMessageID ||
      !input || input.info.id !== request.inputMessageID || input.info.sessionID !== request.taskID || input.info.role !== "user") return unknown("message_identity_unavailable")
  // IDs in author text are candidates, never an assertion of delivery or acceptance.
  const text = (terminal.parts ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("\n")
  let capture = await host.capture?.(request.taskID, request.terminalMessageID)
  if (capture?.id && refPolicy(auth, parseBbId(capture.id)) !== "ok") capture = { status: "unconfirmed", reason: "capture_not_accessible" }
  const ids = [...new Set([...(capture?.id ? [capture.id] : []), ...(text.match(/bb:\/\/[0-9a-f-]+\/[0-9a-f-]+\/e\d+/gi) ?? [])])]
  const candidates: unknown[] = []
  let resultReference: ResultReference | undefined
  const reply = publicReply(terminal)
  // Do not infer exact terminal coverage from current_input or an arbitrary mentioned record.
  // Multiple text parts have different native renderers; leave those presentations unchanged.
  const exactSinglePart = terminal.parts?.filter(p => p.type === "text").length === 1 && reply?.kind === "final"
  const messages = new Map<string, Promise<HostMessage | null>>()
  for (const id of ids.slice(0, 8)) {
    let parsed: ReturnType<typeof parseBbId>
    try { parsed = parseBbId(id) } catch { candidates.push({ id, readability: "not_found" }); continue }
    const policy = refPolicy(auth, parsed)
    if (policy !== "ok") { candidates.push({ id, readability: policy === "hidden" ? "not_found" : "forbidden" }); continue }
    const found = scope.getById(id)
    if (found.status !== "found") { candidates.push({ id, readability: found.status }); continue }
    const record = found.record
    if (exactSinglePart && host.currentResult?.(request.taskID, request.inputMessageID) && capture?.id === id && ["stored", "replay"].includes(capture.status) &&
        record.writer.session_id === request.taskID && record.writer.message_id === request.terminalMessageID &&
        record.writer.agent === terminal.info.agent && record.origin?.kind === "host_final" &&
        record.origin.input_message_id === request.inputMessageID && record.content === reply.content &&
        record.origin.text_sha256 === createHash("sha256").update(reply.content).digest("hex")) {
      resultReference = { id, description: record.description, writer: record.writer,
        input_message_id: request.inputMessageID, text_sha256: record.origin.text_sha256,
        bytes: Buffer.byteLength(reply.content), source_errors: record.origin.source_errors ?? [] }
    }
    let origin = "other_author"
    if (record.writer.session_id === request.taskID) {
      const key = record.writer.message_id
      if (!messages.has(key)) messages.set(key, host.message(request.taskID, key))
      const message = await messages.get(key)!
      origin = message?.info.id === key && message.info.sessionID === request.taskID && message.info.role === "assistant" && message.info.parentID
        ? message.info.parentID === request.inputMessageID ? "current_input" : "prior_input" : "unconfirmed"
    }
    const inspectedRefs = (record.source_refs ?? []).slice(0, 16)
    const artifacts = inspectArtifacts(scope, parsed.streamId, inspectedRefs)
    const sources = inspectedRefs.map(ref => {
      const artifact = artifacts.find(a => a.ref === ref)
      if (artifact) return { ref, check: artifact.status, ...("sha256" in artifact ? { sha256: artifact.sha256 } : {}) }
      if (ref.startsWith("bb://")) {
        try {
          const p = parseBbId(ref); const access = refPolicy(auth, p)
          return { ref, check: access === "hidden" ? "not_found" : access === "forbidden" ? "forbidden" : scope.getById(ref).status === "found" ? "record_readable_not_traversed" : "unavailable" }
        } catch { return { ref, check: "unavailable" } }
      }
      return { ref, check: "external_unchecked" }
    })
    const nav = scope.readMeta(parsed.streamId).nav[id]
    const visibleEdge = (edge?: string) => {
      try { return edge && refPolicy(auth, parseBbId(edge)) === "ok" ? edge : null } catch { return null }
    }
    candidates.push({ id, readability: "found", record_hash: `sha256:${found.hash}`, origin,
      writer: record.writer, sources, sources_truncated: (record.source_refs?.length ?? 0) > 16,
      version_check: sources.length ? "per_source_only" : "no_artifact_reference",
      superseded_by: visibleEdge(nav?.superseded_by), covered_by: visibleEdge(nav?.covered_by) })
  }
  if (resultReference) {
    try { if (!await host.canReadResult?.(request.callerSessionID) || !host.currentResult?.(request.taskID, request.inputMessageID)) resultReference = undefined }
    catch { resultReference = undefined }
  }
  return { ...unknown("candidate_references_only"), association: "host_message_identity",
    execution: { ...unknown("").execution, input_message_id: request.inputMessageID, terminal_message_id: request.terminalMessageID },
    candidates, truncated: ids.length > 8, ...(capture ? { capture } : {}), ...(resultReference ? { result_reference: resultReference } : {}) }
}
