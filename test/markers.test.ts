import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { publicationMarker, maskPublicationMarkers, STORE, NO_STORE } from "../src/markers"
import { captureFinal, type CaptureHost } from "../src/capture"
import { openScopeForRoot } from "../src/storage"
import { publicReply } from "../src/reply"
import type { HostMessage } from "../src/delivery"
import { searchRecords } from "../src/search"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
function fixture(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "bcp-marker-")); dirs.push(dir)
  const scope = openScopeForRoot({ rootSessionId: "s", dataDir: dir })
  const stream = scope.registerSession("s", "fixer").streamId
  const input: HostMessage = { info: { id: "u", sessionID: "s", role: "user" }, parts: [{ type: "text", text: "work" }] }
  const message: HostMessage = { info: { id: "a", sessionID: "s", role: "assistant", parentID: "u", agent: "fixer", finish: "stop", time: { completed: 1 } }, parts: [{ type: "text", text }] }
  const host: CaptureHost = { resolve: async () => ({ scope, streamId: stream, agent: "fixer" }), current: () => true,
    message: async (_s, id) => id === "a" ? message : input, authorize: async () => ({ directory: dir }) }
  return { scope, stream, input, message, host }
}
test("old and titled markers share top-level grammar; entities and title normalization are deterministic", () => {
  expect(publicationMarker(STORE)).toEqual({ requested: true })
  expect(publicationMarker('Result\n<!--  bcp:store\tdescription=" A &quot;B&quot; &amp; C &lt;D&gt; &apos;x&apos; "  -->\r\n'))
    .toEqual({ requested: true, description: 'A "B" & C <D> \'x\'' })
  expect(publicationMarker(`Result\n<!-- bcp:store description="${"界😀".repeat(60)}" -->`).description).toBe("界😀".repeat(40))
  expect(publicationMarker('<!-- bcp:store description=" " -->')).toEqual({ requested: true })
  expect(publicationMarker('<!-- bcp:store description="x\u0000y" -->')).toEqual({ requested: true })
  expect(publicationMarker(`${STORE}\n<!-- bcp:store description="first" -->\n<!-- bcp:store description="second" -->`).description).toBe("first")
})
test("quoted, indented, fenced, HTML code and malformed attributes cannot authorize capture", () => {
  const m = '<!-- bcp:store description="Result" -->'
  for (const text of ["> " + m, "    " + m, "\t" + m, "inline " + m, "```html\n" + m + "\n```", "~~~\n" + m,
    "<pre>\n" + m + "\n</pre>", '<!-- bcp:store description=x -->', "<!-- bcp:store description='x' -->",
    '<!-- bcp:store description="x" kind="review" -->', '<!-- bcp:store description="x" description="y" -->',
    '<!-- bcp:store description="x\ny" -->', '<!-- bcp:store description="x --> y" -->'])
    expect(publicationMarker(text).requested).toBe(false)
})
test("protocol masking preserves original offsets, rejects invisible-only public replies and avoids title search pollution", async () => {
  const marker = '<!-- bcp:store description="hiddenMetadata file:///never/read/me.txt" -->'
  const f = fixture("Visible result\n" + marker)
  expect(maskPublicationMarkers(f.message.parts![0]!.text!).length).toBe(f.message.parts![0]!.text!.length)
  const result = await captureFinal("s", "a", f.host)
  expect(result.status).toBe("stored")
  const rec = f.scope.readEntry(f.stream, 1)!
  expect(rec.content).toBe(f.message.parts![0]!.text!)
  expect(rec.description).toBe("hiddenMetadata file:///never/read/me.txt")
  expect(rec.source_refs ?? []).toEqual([])
  expect(searchRecords(f.scope, { query: "hiddenMetadata", caller: { sessionId: "s", agent: "fixer" } }).items).toEqual([])
  expect(searchRecords(f.scope, { query: "Visible", caller: { sessionId: "s", agent: "fixer" } }).items[0]!.snippet.text).toContain("Visible")
  for (const content of [marker, '<!-- bcp:store unknown="x" -->', '<!-- bcp:store\ndescription="x" -->']) {
    f.message.parts = [{ type: "text", text: content }]
    expect(publicReply(f.message, true)).toBeUndefined()
  }
})
test("explicit store title and durable replay take precedence without rewriting the source", async () => {
  const f = fixture('Original result\n<!-- bcp:store description="Author title" -->')
  const first = await captureFinal("s", "a", f.host, { description: "Explicit title", requestedBy: { agent: "fixer", session_id: "s", message_id: "tool" } })
  expect(first.status).toBe("stored")
  expect((await captureFinal("s", "a", f.host)).status).toBe("replay")
  expect(f.scope.readEntry(f.stream, 1)!.description).toBe("Explicit title")
  expect(f.scope.readMeta(f.stream).high_water).toBe(1)
})
test("title fallback, publication prohibition and permission gates still apply", async () => {
  const f = fixture('<!-- bcp:store description=" " -->\n  Actual outcome')
  await captureFinal("s", "a", f.host)
  expect(f.scope.readEntry(f.stream, 1)!.description).toBe("[fixer] Actual outcome")
  for (const mode of ["input", "final", "permission"]) {
    const other = fixture('Result\n<!-- bcp:store description="Good title" -->')
    if (mode === "input") other.input.parts![0]!.text += NO_STORE
    if (mode === "final") other.message.parts![0]!.text += NO_STORE
    if (mode === "permission") other.host.authorize = async () => null
    expect((await captureFinal("s", "a", other.host)).status).toBe("skipped")
    expect(other.scope.readMeta(other.stream).high_water).toBe(0)
  }
})
