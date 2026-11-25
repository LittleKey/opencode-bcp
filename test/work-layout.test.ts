import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeWorkLayout, resolveWorkLayout } from "../src/work-layout";

function fixture(check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "bcp-layout-"));
  try { check(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("task work layout", () => {
  test("claims once, explicitly reuses, and leaves archive creation to core", () => fixture(root => {
    const first = initializeWorkLayout(root, "task-1", "run-1");
    expect(existsSync(first.reports)).toBe(true);
    expect(existsSync(first.scratch)).toBe(true);
    expect(existsSync(first.archive)).toBe(false);
    expect(() => initializeWorkLayout(root, "task-1", "run-2")).toThrow();
    const reused = initializeWorkLayout(root, "task-1", "run-2", { reuseExistingTask: true });
    expect(reused.taskRoot).toBe(first.taskRoot);
    expect(reused.scratch).not.toBe(first.scratch);
  }));
  test("rejects traversal, descriptions, and noncanonical roots", () => fixture(root => {
    for (const id of ["..", "../escape", "/absolute", "a/b", "a.b", "task title", "", "é"]) {
      expect(() => resolveWorkLayout(root, id, "run")).toThrow();
      expect(() => resolveWorkLayout(root, "task", id)).toThrow();
    }
    expect(() => resolveWorkLayout(`${root}/..`, "task", "run")).toThrow();
    expect(() => resolveWorkLayout(".", "task", "run")).toThrow();
  }));
  test("rejects symlink ancestors and existing task children", () => fixture(root => {
    mkdirSync(join(root, "actual"));
    symlinkSync(join(root, "actual"), join(root, "alias"));
    expect(() => resolveWorkLayout(join(root, "alias"), "task", "run")).toThrow();
    const layout = initializeWorkLayout(root, "task", "run");
    symlinkSync(join(root, "actual"), layout.archive);
    expect(() => initializeWorkLayout(root, "task", "next", { reuseExistingTask: true })).toThrow();
  }));
  test("rejects a symlink at the work directory", () => fixture(root => {
    mkdirSync(join(root, ".opencode"));
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, ".opencode", "work"));
    expect(() => initializeWorkLayout(root, "task", "run")).toThrow();
  }));
});
