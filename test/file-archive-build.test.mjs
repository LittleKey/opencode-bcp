import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildFileArchive } from "../scripts/build-file-archive.mjs";

test("packaging builds current source independently of cached dist", async () => {
  const bundle = await buildFileArchive();
  assert.match(bundle.toString(), /bcp_save/);
  assert.match(bundle.toString(), /file-archive/);
  for (const script of ["install-file-archive.mjs", "package-openchamber.mjs"]) {
    const source = await readFile(new URL(`../scripts/${script}`, import.meta.url), "utf8");
    assert.match(source, /await buildFileArchive\(\)/);
    assert.doesNotMatch(source, /dist\/file-archive\/file-archive\.js/);
  }
});

test("each invocation cleans its own stage and failed builds never return cached bytes", async () => {
  const root = await mkdtemp(join(homedir(), ".bcp-build-test-"));
  try {
    // Isolated copy exercises the unmodified production helper with a controlled
    // build script, not PATH mutation (Bun may resolve its own executable).
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "dist/file-archive"), { recursive: true });
    await writeFile(join(root, "dist/file-archive/file-archive.js"), "stale");
    await copyFile(new URL("../scripts/build-file-archive.mjs", import.meta.url),
      join(root, "scripts/build-file-archive.mjs"));
    const { buildFileArchive: isolatedBuild } =
      await import(pathToFileURL(join(root, "scripts/build-file-archive.mjs")).href);
    const script = join(root, "scripts/build-file-archive.sh");
    await writeFile(script, '#!/bin/bash\nprintf fresh > "$1/file-archive.js"\n');
    assert.equal((await isolatedBuild()).toString(), "fresh");
    assert.deepEqual(await readdir(join(root, "dist")), ["file-archive"]);
    // Even a partial output followed by failure must not be returned.
    await writeFile(script, '#!/bin/bash\nprintf partial > "$1/file-archive.js"\nexit 42\n');
    await assert.rejects(isolatedBuild(), /Command failed/);
    assert.deepEqual(await readdir(join(root, "dist")), ["file-archive"]);
    assert.equal(await readFile(join(root, "dist/file-archive/file-archive.js"), "utf8"), "stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
