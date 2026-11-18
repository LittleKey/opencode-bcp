import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("static orchestrator appendix describes file handoff without naming a tool", () => {
  const text = readFileSync(new URL("../integrations/omo-slim/file-archive-prompts.example.md", import.meta.url), "utf8");
  const appendix = text.split("## Orchestrator append (two sentences)")[1]!.split("## Claude")[0]!;
  expect(appendix).toContain(".opencode/work/<task-id>/");
  expect(appendix).toContain("exact-version file paths");
  expect(appendix).toContain("normal dispatch");
  expect(appendix).not.toMatch(/bcp:store|bcp_save|board_export|completed public final/);
  expect(text).toContain("No wrapper/guard permission changes");
});
