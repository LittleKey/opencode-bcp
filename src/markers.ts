// One grammar for publication intent and non-content protocol metadata.
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
    if (!description && title && !/[\u0000-\u001f\u007f]/.test(title)) description = [...title].slice(0, 80).join("")
  }
  return { requested, ...(description ? { description } : {}) }
}

// Mask even malformed protocol comments: invisible attributes are not a public body.
// Keep UTF-16 offsets and line endings, so search excerpts still point into the original.
export function maskPublicationMarkers(content: string): string {
  return content.replace(/<!--\s*bcp:(?:store|no-store)\b[\s\S]*?-->/g, m => m.replace(/[^\r\n]/g, " "))
}
