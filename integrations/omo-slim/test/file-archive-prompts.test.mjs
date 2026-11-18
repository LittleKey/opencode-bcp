import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(new URL("../file-archive-prompts.example.md", import.meta.url), "utf8");
const handoff = template.split("## Claude orchestratorPrompt template\n")[1]
  .split("## Explicit delivery opt-out preparation")[0];

test("file archive handoff uses reader-accessible exact-version files, not board retrieval/export", () => {
  assert.match(handoff, /accessible ASCII project-relative evidence paths to exact-version files, with their source and the task/);
  assert.match(handoff, /Resolve paths from Claude's project cwd/);
  assert.match(handoff, /different worktree does not automatically share files/);
  assert.match(handoff, /read the referenced text files, or the manifest and relevant parts for multipart results/);
  assert.match(handoff, /Use direct file reads, not export workflows/);
  // The handoff must not introduce board retrieval/export instructions.
  assert.equal((handoff.match(/board_get/g) ?? []).length, 0);
  assert.equal((handoff.match(/board_export/g) ?? []).length, 0);
  assert.match(handoff, /cite files used and disclose unavailable or incomplete evidence/);
});

test("repository examples grant no new permissions, calls or automatic export fallback", () => {
  assert.match(template, /^# Repository templates only — not installed configuration/);
  assert.match(handoff, /No wrapper\/guard permission changes, automatic aliases\/copies\/exports, or Claude\ncalls are authorized/);
  assert.match(handoff, /Report inaccessible evidence as a gap/);
  assert.match(handoff, /do not expand permissions or automatically copy\/export files to repair a read failure/);
});
