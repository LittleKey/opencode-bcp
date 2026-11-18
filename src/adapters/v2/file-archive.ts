import { relative, isAbsolute, join, resolve } from "node:path"
import { OpenCode } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { archiveHandoff, type HandoffRecord } from "../../archive"
import { readOperatorPolicy } from "./handoff-source"

export const saveInput = z.object({
  sessionId: z.string().min(1).max(512),
  messageId: z.string().min(1).max(512).optional(),
}).strict()
export type ArchiveTaskScope = {
  taskId: string
  taskRoot: string
  callerSessionId: string
  projectId: string
  directory: string
  allowArchive: true
  sharedReadersApproved: true
}
export type FileArchiveOptions = {
  enabled: true
  /** Operator-only connection; never accepted from a tool argument. Loopback only. */
  connection: { baseUrl: string; headers?: Record<string, string>; serverPid: number }
  taskScopes: ArchiveTaskScope[]
  /** Live operator policy covering retention, revocation, and ALL actual file readers.
   * A scope declaration alone is not this evidence. Called again under the archive lock.
   */
  /** JSON deployment: absolute operator-owned 0600 file outside writable workspace.
   * Schema bcp.operator-handoff-policy.v1; grants match taskId/taskRoot/
   * callerSessionId/agent/sourceSessionId and explicitly set authorized:true,
   * noStore:false, sharedReadersApproved:true, expiresAt: epoch milliseconds.
   * Removing/expiring a grant revokes it; no global defaults or inheritance.
   */
  policyFile?: string
  policy?: (input: {
    scope: Readonly<ArchiveTaskScope>; caller: Readonly<{ sessionId: string; agent: string }>
    sourceSessionId: string; signal: AbortSignal
  }) => Promise<{ authorized: true; noStore: false; sharedReadersApproved: true }>
}
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x)
const fail = (reason: string): never => { throw new Error(reason) }
const string = (x: unknown): x is string => typeof x === "string" && x.length > 0
const time = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0

/** Project only public text, never serialize/hash private content or metadata. */
export function projectSnapshot(value: unknown, sessionId: string, observedAt: number): HandoffRecord {
  if (!object(value) || value.type !== "assistant" || !string(value.id) ||
    !string(value.agent) || !object(value.time) || !time(value.time.created)) return fail("partial")
  if (!time(value.time.completed)) return fail("pending")
  if (value.error != null || value.finish !== "stop") return fail("partial")
  if (!Array.isArray(value.content) || value.content.length > 256) return fail("partial")
  let bytes = 0
  const texts: HandoffRecord["texts"] = []
  value.content.forEach((part, ordinal) => {
    if (!object(part) || typeof part.type !== "string") return fail("partial")
    if (part.type !== "text") return
    if (typeof part.text !== "string" || Buffer.from(part.text).toString("utf8") !== part.text) return fail("partial")
    bytes += Buffer.byteLength(part.text)
    if (bytes > 8 * 1024 * 1024) return fail("partial")
    texts.push({ ordinal, text: part.text })
  })
  if (!texts.some(p => p.text.length > 0)) return fail("no_text")
  return {
    origin: { kind: "session-snapshot", sessionId, messageId: value.id, agent: value.agent,
      createdAt: value.time.created, completedAt: value.time.completed, finish: "stop" },
    observedAt, texts,
  }
}

/** Public SDK transport with cumulative REAL response-byte budget and no redirects. */
export function boundedArchiveFetch(baseUrl: string, signal: AbortSignal): typeof fetch {
  const base = new URL(baseUrl)
  let total = 0
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).origin !== base.origin) return fail("denied")
    const response = await fetch(request, { signal, redirect: "error" })
    if (!response.body) return response
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        signal.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > 32 * 1024 * 1024) return fail("partial")
        chunks.push(next.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers })
  }) as typeof fetch
}

const description = "Save an authorized own-session or direct-child stored assistant stop reply snapshot. Pass sessionId and optionally an exact messageId; otherwise only the latest assistant reply is considered, without fallback. In-flight replies cannot be saved. Reuse returned exact paths with the next task. No automatic capture."
export const FileArchiveV2Plugin: Plugin.Plugin = {
  id: "opencode-bcp-file-archive",
  setup: async ctx => {
    const raw: unknown = ctx.options
    // A stable schema even when unconfigured/revoked; execute fails closed.
    await ctx.tool.transform(editor => {
      editor.add({
        name: "bcp_save", description, input: saveInput, options: { codemode: false },
        execute: async (input: unknown, tctx: ToolContext) => {
          const parsed = saveInput.safeParse(input)
          if (!parsed.success) return { content: JSON.stringify({ status: "denied", reason: "invalid_input" }) }
          if (!object(raw) || raw.enabled !== true || !object(raw.connection) ||
            !Array.isArray(raw.taskScopes) || raw.taskScopes.length > 128 ||
            (typeof raw.policy !== "function" && typeof raw.policyFile !== "string") ||
            typeof ctx.permission?.assert !== "function")
            return { content: JSON.stringify({ status: "denied", reason: "trusted_configuration_required" }) }
          const options = raw as unknown as FileArchiveOptions
          const ac = new AbortController()
          const abort = () => ac.abort()
          tctx.signal.addEventListener("abort", abort, { once: true })
          if (tctx.signal.aborted) ac.abort()
          let timer = setTimeout(abort, 5000)
          const signal = ac.signal
          let reason = "denied"
          let permissionFailure: unknown
          let permissionPin: string | undefined
          let archiveStarted = false
          // RPC/plugin policy APIs have no cancellation parameter. Stop waiting on
          // abort; they may finish later, but can never publish after this call.
          const bounded = <T,>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
            const stop = () => reject(Error("partial"))
            if (signal.aborted) { stop(); return }
            signal.addEventListener("abort", stop, { once: true })
            work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop))
          })
          const assertPermission = async (input: Parameters<typeof ctx.permission.assert>[0]) => {
            // Human approval time is not a network/lock deadline. No assert is
            // called under the archive lock; cancellation remains live.
            clearTimeout(timer)
            try { await bounded(ctx.permission.assert(input)) }
            catch (error) { permissionFailure = error; throw error }
            finally { timer = setTimeout(abort, 5000) }
          }
          try {
            const url = new URL(options.connection.baseUrl)
            if (!["127.0.0.1", "[::1]"].includes(url.hostname) ||
              url.protocol !== "http:" || url.username || url.password || url.search || url.hash ||
              url.pathname !== "/" || !Number.isSafeInteger(options.connection.serverPid)) return fail("denied")
            const matches = options.taskScopes.filter(s => s.callerSessionId === tctx.sessionID)
            if (matches.length !== 1) return fail("denied")
            const scope = Object.freeze({ ...matches[0]! })
            if (scope.allowArchive !== true || scope.sharedReadersApproved !== true ||
              ![scope.taskId, scope.taskRoot, scope.projectId, scope.directory].every(string) ||
              !isAbsolute(scope.directory) || scope.directory !== resolve(scope.directory) ||
              scope.taskRoot !== join(scope.directory, ".opencode", "work", scope.taskId) ||
              !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(scope.taskId)) return fail("denied")
            if (options.policyFile) {
              const rel = relative(scope.directory, options.policyFile)
              if (!isAbsolute(options.policyFile) || (!rel.startsWith("../") && rel !== ".."))
                return fail("denied")
            }
            const client = OpenCode.make({ baseUrl: url.href, headers: options.connection.headers,
              fetch: boundedArchiveFetch(url.href, signal) })
            const req = { signal }
            const sourceSessionId = parsed.data.sessionId
            const authority = async (prompt = false) => {
              signal.throwIfAborted()
              if (options.enabled !== true || !options.taskScopes.some(s =>
                JSON.stringify(s) === JSON.stringify(scope))) return fail("denied")
              const server = await client.server.info(req)
              if (server.pid !== options.connection.serverPid) return fail("denied")
              const local = await bounded(ctx.session.get({ sessionID: tctx.sessionID }))
              const caller = await client.session.get({ sessionID: tctx.sessionID }, req)
              if (!local || local.id !== tctx.sessionID || caller.id !== tctx.sessionID ||
                local.projectID !== scope.projectId || caller.projectID !== scope.projectId ||
                local.location.directory !== scope.directory || caller.location.directory !== scope.directory ||
                ctx.location.directory !== scope.directory || caller.fork || local.fork) return fail("denied")
              const profiles: unknown = await bounded(ctx.agent.list())
              const rows = Array.isArray(profiles) ? profiles :
                object(profiles) && Array.isArray(profiles.data) ? profiles.data : []
              const profile = rows.filter((p: unknown) => object(p) && p.id === tctx.agent)
              if (profile.length !== 1 || !object(profile[0]) || !Array.isArray(profile[0].permissions) ||
                (local.permissions !== undefined && !Array.isArray(local.permissions))) return fail("denied")
              const rules = JSON.stringify([profile[0].permissions, local.permissions ?? []])
              if (permissionPin === undefined) permissionPin = rules
              else if (permissionPin !== rules) return fail("denied")
              if (sourceSessionId !== tctx.sessionID) {
                const child = await client.session.get({ sessionID: sourceSessionId }, req)
                if (child.id !== sourceSessionId || child.parentID !== tctx.sessionID || child.fork ||
                  child.projectID !== scope.projectId || child.location.directory !== scope.directory) return fail("denied")
              }
              const policy = options.policy
                ? await bounded(options.policy({ scope, caller: { sessionId: tctx.sessionID, agent: tctx.agent },
                  sourceSessionId, signal }))
                : readOperatorPolicy(options.policyFile!, {
                  taskId: scope.taskId, taskRoot: scope.taskRoot, callerSessionId: tctx.sessionID,
                  agent: tctx.agent, sourceSessionId,
                }) ? { authorized: true, noStore: false, sharedReadersApproved: true } : null
              if (!policy || policy.authorized !== true || policy.noStore !== false ||
                policy.sharedReadersApproved !== true) return fail("denied")
              for (const action of prompt ? ["read", "bcp_save"] : []) {
                await assertPermission({
                  sessionID: tctx.sessionID, agent: tctx.agent,
                  source: { type: "tool", messageID: tctx.messageID, id: tctx.id },
                  action, resources: action === "read" ? [sourceSessionId] : [scope.taskRoot],
                  save: [], metadata: { directory: scope.directory },
                })
              }
              signal.throwIfAborted()
            }
            const idle = async () => {
              // An exact, already committed reply can be saved while execution
              // continues; projection still rejects the current in-flight reply.
              if (parsed.data.messageId !== undefined) return
              const active = await client.session.active(req)
              if (!object(active) || Object.hasOwn(active, sourceSessionId)) return fail("pending")
            }
            await authority(true)
            await idle()
            let record: HandoffRecord
            if (parsed.data.messageId !== undefined) {
              const value = await client.session.message.get({
                sessionID: sourceSessionId, messageID: parsed.data.messageId,
              }, req)
              if (!object(value) || value.id !== parsed.data.messageId) return fail("source_changed")
              record = projectSnapshot(value, sourceSessionId, Date.now())
            } else {
              const page = await client.message.list({ sessionID: sourceSessionId, type: "assistant", order: "desc", limit: 1 }, req)
              if (!page || !Array.isArray(page.data) || page.data.length > 1) return fail("partial")
              if (!page.data.length) return fail("no_text")
              record = projectSnapshot(page.data[0], sourceSessionId, Date.now())
            }
            const pinned = JSON.stringify(record)
            archiveStarted = true
            const result = await archiveHandoff(scope, record, { signal,
              authorizeWrites: async paths => {
                const resources = paths.map(path => {
                  if (!isAbsolute(path) || path !== resolve(path)) return fail("denied")
                  const rel = relative(scope.directory, path)
                  const taskRelative = relative(scope.taskRoot, path)
                  if (!rel || rel.startsWith("..") || isAbsolute(rel) ||
                    taskRelative.startsWith("..") || isAbsolute(taskRelative)) return fail("denied")
                  return rel
                })
                  await assertPermission({
                    sessionID: tctx.sessionID, agent: tctx.agent,
                    source: { type: "tool", messageID: tctx.messageID, id: tctx.id },
                    action: "edit", resources, save: [], metadata: { directory: scope.directory },
                  })
              },
              recheck: async () => {
              try {
                await authority()
                if (record.origin.kind === "session-snapshot") {
                  try {
                    const fresh = projectSnapshot(await client.session.message.get({
                      sessionID: sourceSessionId, messageID: record.origin.messageId,
                    }, req), sourceSessionId, record.observedAt)
                    if (JSON.stringify(fresh) !== pinned) return fail("source_changed")
                  } catch { return fail("source_changed") }
                  await idle()
                }
                signal.throwIfAborted()
                return true
              } catch (error) {
                if (permissionFailure !== undefined) throw permissionFailure
                reason = error instanceof Error && ["pending", "source_changed"].includes(error.message) ? error.message : "denied"
                return false
              }
            } })
            const safe = (path?: string) => {
              if (!path) return undefined
              const rel = relative(scope.directory, path)
              if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined
              return rel
            }
            return { content: JSON.stringify({ status: result.status === "stored" ? "saved" :
              result.status === "duplicate" ? "already_saved" : result.reason === "recheck" ? reason : "partial",
              path: safe(result.path), body: safe(result.body), version: result.version,
              ...(result.indexStale ? { index_stale: true } : {}) }) }
          } catch (error) {
            // Native permission rejections must propagate; never leak private errors.
            if (permissionFailure !== undefined) throw permissionFailure
            const status = error instanceof Error && ["pending", "partial", "no_text", "source_changed"].includes(error.message)
              ? error.message : error instanceof Error && /^archive_(conflict|message_identity_conflict)$/.test(error.message)
                ? "source_changed" : error instanceof Error && error.message.startsWith("archive_")
                  ? "partial" : signal.aborted || archiveStarted ? "partial" : "denied"
            return { content: JSON.stringify({ status, reason: signal.aborted ? "cancelled_or_timeout" : status }) }
          } finally {
            clearTimeout(timer)
            tctx.signal.removeEventListener("abort", abort)
            ac.abort()
          }
        },
      })
    })
  },
}
