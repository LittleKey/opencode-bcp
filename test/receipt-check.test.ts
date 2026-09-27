import { expect, test } from "bun:test"
import { ReceiptCheck } from "../src/receipt-check"

const result = (c: ReceiptCheck, m = "final", input = "u") => c.finish("s", m, input)?.status
const publish = (c: ReceiptCheck, id: string, paths: string[], status: "stored" | "replay" = "stored") =>
  c.published("s", c.capture("s"), id, paths, status)

test("only a subsequent snapshot of the edited path clears the mechanical gap", () => {
  const c = new ReceiptCheck(); c.begin("s", "u"); c.changed("s", ["/A"])
  expect(result(c)).toBe("missing_handoff")
  expect(c.finish("s", "final", "u")).toBeNull()
  publish(c, "unrelated", ["/B"])
  expect(result(c, "f2")).toBe("manual_version_check")
  publish(c, "matching", ["/A"])
  expect(result(c, "f3")).toBe("known_edits_snapshotted")
  c.changed("s", ["/A"])
  expect(result(c, "f4")).toBe("missing_handoff")
})

test("replay cannot turn an old receipt into proof of a new edit", () => {
  const c = new ReceiptCheck(); c.begin("s", "u")
  publish(c, "old", ["/A"]); c.changed("s", ["/A"])
  publish(c, "old", ["/A"], "replay")
  expect(result(c)).toBe("manual_version_check")
})

test("separate publications can cover separate edits but never an intervening edit", () => {
  const c = new ReceiptCheck(); c.begin("s", "u")
  c.changed("s", ["/A"]); publish(c, "a", ["/A"])
  c.changed("s", ["/B"]); publish(c, "b", ["/B"])
  expect(result(c)).toBe("known_edits_snapshotted")
  c.changed("s", ["/A"]); publish(c, "again-b", ["/B"])
  expect(result(c, "f2")).toBe("manual_version_check")
})

test("publication awaiting permission cannot cover edits made after it started", () => {
  const c = new ReceiptCheck(); c.begin("s", "u"); c.changed("s", ["/A"])
  const captured = c.capture("s")
  c.changed("s", ["/A"])
  c.published("s", captured, "late", ["/A"], "stored")
  expect(result(c)).toBe("missing_handoff")
})

test("new admitted input isolates observations and stale callbacks or finals cannot clear it", () => {
  const c = new ReceiptCheck(); c.begin("s", "u"); c.changed("s", ["/A"])
  const captured = c.capture("s")
  c.begin("s", "u2"); c.changed("s", ["/A"])
  c.published("s", captured, "old-run", ["/A"], "stored")
  expect(c.finish("s", "old-final", "u")).toBeNull()
  expect(result(c, "new-final", "u2")).toBe("missing_handoff")
})

test("duplicate admission preserves observations; unrelated or restarted sessions are unknown", () => {
  const c = new ReceiptCheck(); c.begin("s", "u"); c.changed("s", ["/A"]); c.begin("s", "u")
  expect(result(c)).toBe("missing_handoff")
  expect(c.finish("other", "f", "u")).toBeNull()
  c.forget("s")
  expect(c.finish("s", "f2", "u")).toBeNull()
  c.begin("s", "u"); expect(result(c, "f3")).toBe("unconfirmed")
})

test("read-only publication or reuse is observed conservatively without a false missing alarm", () => {
  const c = new ReceiptCheck(); c.begin("s", "u")
  expect(result(c)).toBe("unconfirmed")
  publish(c, "review", ["/A"])
  expect(result(c, "f2")).toBe("publication_observed")
  c.begin("s", "reuse")
  publish(c, "review", ["/A"], "replay")
  expect(result(c, "f3", "reuse")).toBe("unconfirmed")
})

test("unknown edit paths and missing parent identity never produce verified coverage", () => {
  const c = new ReceiptCheck(); c.begin("s", "u"); c.changed("s", [])
  publish(c, "some", ["/A"])
  expect(result(c)).toBe("manual_version_check")
  expect(c.finish("s", "no-parent")).toBeNull()
})

test("only host-observed assistant messages belonging to the current input can capture publication", () => {
  const c = new ReceiptCheck(); c.begin("s", "u")
  expect(c.capture("s", "unseen")).toBeUndefined()
  c.assistant("s", "old-assistant", "old-input")
  expect(c.capture("s", "old-assistant")).toBeUndefined()
  c.assistant("s", "current-assistant", "u")
  expect(c.capture("s", "current-assistant")).toBeDefined()
  c.begin("s", "u2")
  expect(c.capture("s", "current-assistant")).toBeUndefined()
})

test("non-adjacent duplicate final events are not reported a second time", () => {
  const c = new ReceiptCheck(); c.begin("s", "u"); c.changed("s", ["/A"])
  expect(result(c, "f1")).toBe("missing_handoff")
  publish(c, "new", ["/A"])
  expect(result(c, "f2")).toBe("known_edits_snapshotted")
  expect(c.finish("s", "f1", "u")).toBeNull()
})
