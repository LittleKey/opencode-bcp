import { test, expect } from "bun:test"
import { projectSnapshot } from "../src/adapters/v2/file-archive"
const message = () => ({ id: "m", type: "assistant", agent: "a",
  time: { created: 100, completed: 101 }, finish: "stop",
  content: [{ type: "reasoning", text: "private" }, { type: "text", text: " \n" },
    { type: "tool" }, { type: "text", text: "" }] })
test("production projection preserves mixed-part ordinals and exact whitespace without private fields", () => {
  const result = projectSnapshot(message(), "child", 1)
  expect(result.texts).toEqual([{ ordinal: 1, text: " \n" }, { ordinal: 3, text: "" }])
  expect(JSON.stringify(result)).not.toContain("private")
})
test("latest incomplete or failed message is rejected, never replaced by an older stop", () => {
  expect(() => projectSnapshot({ ...message(), time: { created: 1 } }, "child", 1)).toThrow("pending")
  for (const finish of ["length", "tool-calls", "content-filter", "error", undefined])
    expect(() => projectSnapshot({ ...message(), finish }, "child", 1)).toThrow("partial")
  expect(() => projectSnapshot({ ...message(), error: {} }, "child", 1)).toThrow("partial")
})
test("empty text and malformed UTF8 rejected; no timestamp reordering", () => {
  expect(() => projectSnapshot({ ...message(), content: [{ type: "text", text: "" }] }, "c", 1)).toThrow("no_text")
  expect(() => projectSnapshot({ ...message(), content: [{ type: "text", text: "\ud800" }] }, "c", 1)).toThrow("partial")
  expect(projectSnapshot(message(), "c", 1).origin.messageId).toBe("m")
})
