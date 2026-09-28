// Route observed author sources, never infer dependencies or synthesize another author's result.
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { inspectArtifacts } from "./artifacts"
import { parseBbId } from "./ids"
import { refPolicy, resolveAuthz } from "./permissions"
import type { Scope } from "./storage"
import type { BbRecord } from "./schema"

// Replace the known v1 host's conflicting prose, not lifecycle rules or the dynamic agent list.
const TASK_PROSE = [
  ["3. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result. The output includes a task_id you can reuse later to continue the same subagent session.",
    "3. The child returns its original result and host reference. Forward that reference to dependent specialists. Give the user a short outcome and original-source links instead of recreating the report. The returned task_id supports relevant continuations."],
  ["4. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session (which continues with its previous messages and tool outputs). When starting fresh, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.",
    "4. Fresh sessions have no prior context. Supply objective, allowed scope, readable source IDs or paths, new delta and acceptance questions. Tell the agent to read the sources; do not copy their contents. Ask for a concise result with evidence and limits, not the artifact's full text. Use task_id for same-objective continuations."],
  ["5. The agent's outputs should generally be trusted",
    "5. Check exact sources, versions and limits before relying on an author's conclusion. Retained text is not semantic acceptance."],
] as const

export function normalizeTaskDescription(description: string) {
  if (!TASK_PROSE.every(([before]) => description.includes(before))) return description
  for (const [before, after] of TASK_PROSE) description = description.replace(before, after)
  return description
}

export function sourceHandoff(scope: Scope, session: string, prompt: string, recent: readonly string[], currentPublications: readonly string[] = [], recipient?: string) {
  const auth = resolveAuthz(scope, { sessionId: session, agent: "" })
  if (!auth.registered) return { prompt, references: [] as string[], removedBytes: 0 }
  const references: string[] = [], facts: { id: string; path: string; snapshot: string }[] = []
  let removedBytes = 0
  const records: { id: string; parsed: ReturnType<typeof parseBbId>; record: BbRecord }[] = []
  for (const id of [...new Set(recent)].slice(-8)) {
    let parsed: ReturnType<typeof parseBbId>
    try { parsed = parseBbId(id) } catch { continue }
    if (refPolicy(auth, parsed) !== "ok") continue
    const found = scope.getById(id)
    if (found.status !== "found" || !found.record.origin) continue
    records.push({ id, parsed, record: found.record })
  }
  // A late repair or re-read must not promote an older author message above a newer version.
  const completed = (r: typeof records[number]) => r.record.origin!.message_completed_at ?? Date.parse(r.record.created_at)
  records.sort((a, b) => completed(b) - completed(a) ||
    (a.record.stream_id === b.record.stream_id ? b.record.sequence - a.record.sequence : a.id.localeCompare(b.id)))
  for (const { id, parsed, record } of records) {
    // Explicit read-only review sources are not author artifacts for a fresh review.
    for (const binding of record.origin!.file_bindings?.slice(0, 8) ?? []) {
      if (facts.length >= 8) break
      if (!binding.native_edit || !prompt.includes(binding.path) || facts.some(f => f.path === binding.path)) continue
      if (!record.source_refs?.includes(binding.ref)) continue
      const checked = inspectArtifacts(scope, parsed.streamId, [binding.ref])[0]
      if (checked?.status !== "verified") continue
      references.push(id)
      facts.push({ id, path: binding.path, snapshot: binding.ref })
      // Exact copy only. Keep hashes, deltas, questions and surrounding instructions unchanged.
      if (checked.bytes === undefined || checked.bytes > 65536 || checked.bytes < 256) continue
      const url = new URL(binding.ref); url.hash = ""
      let bytes: Buffer
      try { bytes = readFileSync(fileURLToPath(url)) } catch { continue }
      if (bytes.length > 65536 || createHash("sha256").update(bytes).digest("hex") !== checked.sha256) continue
      const body = bytes.toString("utf8").trimEnd()
      if (body.length < 128 || !prompt.includes(body)) continue
      const replacement = `[Read the exact artifact via ${id}: ${binding.ref}]`
      const count = prompt.split(body).length - 1
      prompt = prompt.split(body).join(replacement)
      removedBytes += Math.max(0, Buffer.byteLength(body) - Buffer.byteLength(replacement)) * count
    }
  }
  if (facts.length) {
    const suffix = "\n\n<bcp_author_sources>\n" + JSON.stringify(facts) +
      "\nRead the author record to check conclusions, limits and retained versions. These are retained versions, not a claim about current working files. Preserve full references; artifact bytes do not establish acceptance.\n</bcp_author_sources>"
    if (!prompt.includes(suffix)) prompt += suffix
  }
  // Only an existing artifact author receives related read-only findings automatically.
  // A fresh independent reviewer never receives another reviewer's verdict this way.
  const ownedPaths = new Set(records.filter(r => r.record.writer.session_id === recipient)
    .flatMap(r => r.record.origin!.file_bindings ?? []).filter(b => b.native_edit && prompt.includes(b.path)).map(b => b.path))
  const findings = records.filter(r => r.record.writer.session_id !== recipient &&
    r.record.origin!.file_bindings?.some(b => !b.native_edit && ownedPaths.has(b.path) &&
      r.record.source_refs?.includes(b.ref) && inspectArtifacts(scope, r.parsed.streamId, [b.ref])[0]?.status === "verified"))
    .slice(0, 4).map(r => r.id)
  if (findings.length) {
    references.push(...findings)
    const suffix = "\n\n<bcp_author_feedback>\n" + JSON.stringify(findings) +
      "\nThese original read-only findings cite a file you authored. Read the records and their versions before revising; they are not proof about a newer file. Preserve their limits rather than relying on a dispatcher's restatement.\n</bcp_author_feedback>"
    if (!prompt.includes(suffix)) prompt += suffix
  }
  const decisions: string[] = []
  for (const id of [...new Set(currentPublications)].slice(-4)) {
    let parsed: ReturnType<typeof parseBbId>
    try { parsed = parseBbId(id) } catch { continue }
    if (refPolicy(auth, parsed) !== "ok") continue
    const found = scope.getById(id)
    if (found.status !== "found" || found.record.kind !== "decision" || found.record.writer.session_id !== session) continue
    decisions.push(id); references.push(id)
  }
  if (decisions.length) {
    const suffix = "\n\n<bcp_input_decisions>\n" + JSON.stringify(decisions) +
      "\nThe dispatcher published these decisions during the current input. Read the original decisions and limits before relying on them; relevance and acceptance are not inferred. Do not replace them with the dispatcher's paraphrase.\n</bcp_input_decisions>"
    if (!prompt.includes(suffix)) prompt += suffix
  }
  return { prompt, references: [...new Set(references)], removedBytes }
}
