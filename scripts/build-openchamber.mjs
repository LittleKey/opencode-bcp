import { readFile, writeFile } from "node:fs/promises";
import { buildFileArchive } from "./build-file-archive.mjs";

const target = new URL("../openchamber/plugin/file-archive.js", import.meta.url);
const bundle = await buildFileArchive();
if (process.argv.includes("--check")) {
  if (!bundle.equals(await readFile(target))) throw Error("OpenChamber bundle stale; run bun run build:openchamber");
} else {
  await writeFile(target, bundle);
}
