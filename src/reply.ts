import type { HostMessage } from "./delivery"
import { maskPublicationMarkers } from "./markers"

export type StageBoundary = {
  created: number
  texts: { id: string; end: number }[]
  tools: { call: string; tool: string; status: string; end: number }[]
}
// A completed model response can still have running tools. Stage storage requires both fences.
export function publicReply(message: HostMessage, stages = false) {
  const { info, parts = [] } = message
  if (info.role !== "assistant" || !info.time?.completed || info.error || info.summary || !info.parentID) return
  const texts = parts.filter(p => p.type === "text" && !p.synthetic && !p.ignored)
  const content = texts.map(p => p.text ?? "").join("\n")
  const tools = parts.filter(p => p.type === "tool")
  // A protocol marker alone is invisible to the user and is not a public result.
  if (!maskPublicationMarkers(content).trim() ||
      tools.some(p => !["completed", "error"].includes(p.state?.status ?? ""))) return
  if (info.finish === "stop") return { kind: "final" as const, content, completed: info.time.completed }
  if (!stages || info.finish !== "tool-calls" || !info.time.created || !tools.length ||
      texts.some(p => !p.id || !p.time?.end) || tools.some(p => !p.callID || !p.tool || !p.state?.time?.end)) return
  const boundary: StageBoundary = { created: info.time.created,
    texts: texts.map(p => ({ id: p.id!, end: p.time!.end! })),
    tools: tools.map(p => ({ call: p.callID!, tool: p.tool!, status: p.state!.status!, end: p.state!.time!.end! })) }
  return { kind: "stage" as const, content, boundary,
    completed: Math.max(info.time.completed, ...boundary.texts.map(p => p.end), ...boundary.tools.map(p => p.end)) }
}
export const replyKey = (session: string, message: string, kind: "final" | "stage") => `bcp:${kind}:${session}:${message}`
