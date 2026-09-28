// Exact-message repair. The caller selects a source; only the host determines its author/body.
import { z } from "zod"
import { captureFinal, NO_STORE, type CaptureHost } from "./capture"
import { resolveAuthz } from "./permissions"
import { KINDS, validatePutInput } from "./schema"
import type { HostMessage } from "./delivery"
import type { BoardToolContext, BoardToolDef } from "./tools"
import { publicReply, replyKey } from "./reply"

export const STORE_DESCRIPTION = "Retain existing user-readable public replies, not reasoning, tool arguments or an unwritten report. First express conclusions, evidence and limits publicly; store only an earlier completed reply/stage with settled tools. Reuse its record, or action=list to discover real message IDs; never invent IDs. Omit session_id for your session; use the actual child task_id for another agent. Then action=store with message_id and a short title, no body/author. Task metadata also supplies terminal_message_id. Ordinary final answers use automatic retention; do not call dummy tools just to create a stage. Before dependent dispatch, retain a new public decision as kind=decision; pass full references and require board_get. Host verifies author, permissions and historical edits; storage is not acceptance."
const PUBLIC_REPLY_HINT = "No eligible public source is available in this response. Conclusions must first appear in a user-readable reply, with evidence and limits, not only in reasoning, tool arguments or a title. Complete that reply normally; ordinary final answers are retained automatically when permitted. For an earlier completed stage, use action=list after its tools settle. Do not invent IDs, repeatedly retry an unfinished message, or call dummy tools to manufacture completion."
const argsSchema = z.object({
  action: z.enum(["list", "store"]),
  session_id: z.string().optional().describe("Omit for your current session. For another agent use its actual task_id/session ID, never an alias such as ses_main."),
  message_id: z.string().optional().describe("Real host message ID returned by action=list or task metadata; required for store. Never invent an ID or use a transcript label."),
  description: z.string().optional().describe("Short discovery title required for store; no body. Existing records keep their original metadata."),
  kind: z.enum(KINDS).optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict()
export type StoreHost = CaptureHost & {
  messages: (session: string, limit: number) => Promise<HostMessage[]>
  authorizeCaller: (ctx: BoardToolContext) => Promise<boolean>
  stored?: (session: string, id: string) => void | Promise<void>
}
export function messageStore(host: StoreHost): BoardToolDef {
  return { args: argsSchema, execute: async (ctx, raw) => {
    try {
      const args = argsSchema.parse(raw)
      const caller = await host.resolve(ctx.sessionID)
      if (!caller?.agent || !await host.authorizeCaller(ctx)) return JSON.stringify({ status: "rejected", reason: "publication_not_authorized" })
      const auth = resolveAuthz(caller.scope, { sessionId: ctx.sessionID, agent: caller.agent })
      const session = args.session_id ?? ctx.sessionID
      // Inspect registration/visibility BEFORE any source message API call; no cross-scope discovery.
      const source = caller.scope.config.session_index[session]
      if (!source || !auth.canRead(source.stream_id)) return JSON.stringify({ status: "not_found", reason: "source_not_found_or_not_visible",
        next_call: { action: "list" }, hint: "For your own messages omit session_id. For another agent use its actual task_id/session ID. Never guess an ID or substitute a different source for an inaccessible one." })
      const discovery = { action: "list", ...(args.session_id ? { session_id: session } : {}) }
      if (args.action === "list") {
        const messages = await host.messages(session, Math.min(200, args.limit * 10))
        const replies = messages.filter(m => m.info.sessionID === session && publicReply(m, true))
          .slice(-args.limit).map(m => {
            const text = (m.parts ?? []).filter(p => p.type === "text" && !p.synthetic && !p.ignored).map(p => p.text ?? "").join("\n")
            const reply = publicReply(m, true)!
            const id = caller.scope.readMeta(source.stream_id).idem[replyKey(session, m.info.id, reply.kind)]?.id
            return { message_id: m.info.id, input_message_id: m.info.parentID, author: m.info.agent ?? null,
              completed_at: reply.completed, message_type: reply.kind, preview: [...text].slice(0, 160).join(""),
              publication_restricted: text.includes(NO_STORE), ...(id ? { record_id: id } : {}) }
          })
        return JSON.stringify({ status: "listed", session_id: session, replies, inspected_messages: messages.length, window: "at most 200 recent messages; not an exhaustive history",
          ...(!replies.length ? { hint: PUBLIC_REPLY_HINT } : {}),
          other_sessions: Object.entries(caller.scope.config.session_index).filter(([sid, s]) => sid !== session && auth.canRead(s.stream_id))
            .slice(-20).map(([session_id, s]) => ({ session_id, agent: s.agent })) })
      }
      if (!args.message_id) return JSON.stringify({ status: "rejected", reason: "message_id_required", next_call: discovery })
      const invalid = validatePutInput({ description: args.description, content: "validated after host fetch", kind: args.kind })
      if (invalid.length) return JSON.stringify({ status: "rejected", reason: invalid.map(e => e.code).join(",") })
      // Author publication restrictions apply even when the requester is a different agent.
      const message = await host.message(session, args.message_id)
      if (!message) return JSON.stringify({ status: "not_found", reason: "message_not_found", next_call: discovery,
        hint: "Use an exact message_id returned by discovery or task metadata, never a placeholder. If the intended report is not public yet, write the public reply first; a title is not its content." })
      const input = message?.info.parentID && await host.message(session, message.info.parentID)
      if (!message?.info.agent || !input || !await host.authorize(session, message.info.agent, input))
        return JSON.stringify({ status: "rejected", reason: "source_publication_not_authorized" })
      const result = await captureFinal(session, args.message_id, host, { description: args.description!, kind: args.kind,
        requestedBy: { agent: caller.agent, session_id: ctx.sessionID, message_id: ctx.messageID } })
      if (!result.id) return JSON.stringify({ ...result, ...(result.reason === "not_completed_author_reply" ? { hint: PUBLIC_REPLY_HINT } : {}) })
      for (const target of new Set([ctx.sessionID, session])) await host.stored?.(target, result.id)
      const found = caller.scope.getById(result.id)
      return JSON.stringify({ ...result, ...(found.status === "found" ? { writer: found.record.writer,
        source_refs: found.record.source_refs ?? [], source_errors: found.record.origin?.source_errors ?? [] } : {}) })
    } catch (error) { return JSON.stringify({ status: "unconfirmed", reason: String(error) }) }
  } }
}
