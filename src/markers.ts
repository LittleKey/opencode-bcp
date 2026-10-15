// One grammar for publication intent and non-content protocol metadata.
import { truncateDescription } from "./schema"

export const NO_STORE = "<!-- bcp:no-store -->"
export const STORE = "<!-- bcp:store -->"
const entities: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" }

export function publicationMarker(content: string): { requested: boolean; description?: string } {
  let fence: { char: string; length: number } | undefined, htmlCode = false, requested = false
  let description: string | undefined
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*<(pre|code)(\s|>)/i.test(line)) htmlCode = true
    if (htmlCode) { if (/<\/(pre|code)>/i.test(line)) htmlCode = false; continue }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (f) {
      if (!fence) fence = { char: f[1]![0]!, length: f[1]!.length }
      else if (f[1]![0] === fence.char && f[1]!.length >= fence.length && !f[2]!.trim()) fence = undefined
      continue
    }
    if (fence) continue
    const marker = /^<!--[ \t]+bcp:store(?:[ \t]+description="([^"\r\n]*)")?[ \t]+-->[ \t]*$/.exec(line)
    if (!marker || marker[1]?.includes("-->")) continue
    requested = true
    const title = marker[1]?.replace(/&(quot|amp|lt|gt|apos);/g, (_, name: string) => entities[name]!).trim()
    if (!description && title && !/[\u0000-\u001f\u007f]/.test(title)) description = truncateDescription(title)
  }
  return { requested, ...(description ? { description } : {}) }
}

// Mask even malformed protocol comments: invisible attributes are not a public body.
// Keep UTF-16 offsets and line endings, so search excerpts still point into the original.
export function maskPublicationMarkers(content: string): string {
  return content.replace(/<!--\s*bcp:(?:store|no-store)\b[\s\S]*?-->/g, m => m.replace(/[^\r\n]/g, " "))
}

// ACP display copy (round 11): drop ONLY lines the parser recognizes as valid top-level
// store markers; marker examples inside fences or html code blocks stay untouched.
// Line endings normalize to \n; callers treat this as the wrapper-facing copy, never the record body.
export function stripTopLevelStoreMarkers(content: string): string {
  const kept: string[] = []
  let fence: { char: string; length: number } | undefined, htmlCode = false
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*<(pre|code)(\s|>)/i.test(line)) htmlCode = true
    if (htmlCode) { kept.push(line); if (/<\/(pre|code)>/i.test(line)) htmlCode = false; continue }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (f) {
      kept.push(line)
      if (!fence) fence = { char: f[1]![0]!, length: f[1]!.length }
      else if (f[1]![0] === fence.char && f[1]!.length >= fence.length && !f[2]!.trim()) fence = undefined
      continue
    }
    if (fence) { kept.push(line); continue }
    const marker = /^<!--[ \t]+bcp:store(?:[ \t]+description="([^"\r\n]*)")?[ \t]+-->[ \t]*$/.exec(line)
    if (marker && !marker[1]?.includes("-->")) continue // exactly the lines publicationMarker recognizes
    kept.push(line)
  }
  return kept.join("\n")
}
