import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { normalizeTaskDescription } from "../src/handoff"
import { BlackboardPlugin } from "../src/plugin"
import type { PluginInput } from "@opencode-ai/plugin"

// Exact excerpt from the fresh host's /experimental/tool response, not a generated template.
const original = readFileSync(new URL("./fixtures/task-prose-1.18.31.txt", import.meta.url), "utf8")
test("known host prose is reconciled once while capability and agent catalogue text is preserved", () => {
  const changed = normalizeTaskDescription(original)
  expect(changed).not.toContain("highly detailed")
  expect(changed).not.toContain("outputs should generally be trusted")
  expect(changed).toContain("do not copy their contents")
  expect(changed.slice(changed.indexOf("6. Clearly"))).toBe(original.slice(original.indexOf("6. Clearly")))
  expect(normalizeTaskDescription(changed)).toBe(changed)
  const unknown = original.replace("highly detailed", "different future requirement")
  expect(normalizeTaskDescription(unknown)).toBe(unknown)
})
test("only automatic v1 mode changes the host contract; manual mode and other tools are untouched", async () => {
  for (const autoCapture of [true, false]) {
    const plugin = await BlackboardPlugin({ client: {}, directory: "/tmp" } as PluginInput, { autoCapture })
    const task = { description: original, parameters: {} }
    await plugin["tool.definition"]!({ toolID: "task" }, task)
    expect(task.description.includes("highly detailed")).toBe(!autoCapture)
    const read = { description: original, parameters: {} }
    await plugin["tool.definition"]!({ toolID: "read" }, read)
    expect(read.description).toBe(original)
  }
})
