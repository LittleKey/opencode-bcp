// Always build current sources into an exclusive staging directory. Never trust
// a preexisting dist bundle; failed builds cannot fall back to stale bytes.
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
export async function buildFileArchive() {
  const dist = join(repo, "dist");
  await mkdir(dist, { recursive: true });
  const stage = await mkdtemp(join(dist, ".file-archive-stage-"));
  try {
    execFileSync("bash", [join(repo, "scripts/build-file-archive.sh"), stage], {
      cwd: repo, stdio: ["ignore", "pipe", "pipe"],
    });
    return await readFile(join(stage, "file-archive.js"));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
