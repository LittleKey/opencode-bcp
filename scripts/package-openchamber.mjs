#!/usr/bin/env node
// Offline packaging only: never registers an extension or edits OpenCode config.
import * as fs from "node:fs/promises";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFileArchive } from "./build-file-archive.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
export async function packageOpenChamber(target, host, optionsPath) {
  if (!target || !isAbsolute(target) || resolve(target) !== target ||
      !host || !isAbsolute(host)) throw Error("absolute --target and --host required");
  const version = JSON.parse(await fs.readFile(join(host, "package.json"), "utf8")).version;
  // Verified hosts: 2.7.2 (original packaging validation) and 2.7.3 (current
  // installed host, re-verified by the real Git-extension install). Same
  // loader semantics; fail closed on any other version.
  if (version !== "2.7.2" && version !== "2.7.3") throw Error("requires installed OpenChamber 2.7.2 or 2.7.3");
  const parent = dirname(target);
  if (!optionsPath || !isAbsolute(optionsPath) || resolve(optionsPath) !== optionsPath ||
      optionsPath === target || optionsPath.startsWith(target + "/"))
    throw Error("options must be canonical and outside package");
  if (await fs.realpath(dirname(optionsPath)) !== dirname(optionsPath))
    throw Error("options parent must be canonical");
  const optionsParent = await fs.lstat(dirname(optionsPath));
  if (!optionsParent.isDirectory() || optionsParent.uid !== process.getuid() || (optionsParent.mode & 0o077))
    throw Error("options parent must be owner-private");
  if (await fs.realpath(parent) !== parent) throw Error("target parent must be canonical");
  const st = await fs.lstat(parent);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077))
    throw Error("target parent must be owner-private");
  const { checkAncestors, loadPrivateOptions } = await import("../openchamber/plugin/private-options.mjs");
  const helpers = `${loadPrivateOptions.toString()}\n${checkAncestors.toString()}`;
  await checkAncestors(parent, "target");
  await checkAncestors(dirname(optionsPath), "options");
  // Refuse preexisting paths, including symlinks: packaging never reads or copies
  // live operator authority. Operator creates this file only after review.
  try { await fs.lstat(optionsPath); throw Error("options path must not exist while packaging"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
   const bundle = await buildFileArchive();
  const manifest = {
    name: "opencode-bcp-openchamber-local", version: "1.0.0", private: true,
    openchamber: { engines: { openchamber: ">=2.7.2" }, apiVersion: 1,
    contributes: {
      panel: { id: "bcp-file-archive", name: "BCP", icon: "ri-archive-line" },
      opencodePlugin: "plugin",
    } },
  };
  // Actual installed host validation, no mocked or vendored schema.
  // 2.7.2 keeps guests under server/lib; 2.7.3 moved them to build/server/lib.
  const guestsRoot = await fs.stat(join(host, "server/lib/guests")).then(() => "server/lib/guests", () => "build/server/lib/guests");
  const { inspectGuestPackage } = await import(pathToFileURL(join(host, guestsRoot, "catalog.js")));
  await fs.mkdir(target, { mode: 0o700 }); // Exclusive claim; no overwrite.
  await fs.mkdir(join(target, "plugin"), { mode: 0o700 });
  const write = (p, data) => fs.writeFile(join(target, p), data, { mode: 0o600, flag: "wx" });
  await write("package.json", JSON.stringify(manifest, null, 2) + "\n");
  await write("plugin/package.json", JSON.stringify({
    name: "opencode-bcp-file-archive-local", version: "1.0.0", type: "module", exports: "./index.mjs",
  }) + "\n");
  await write("plugin/file-archive.js", bundle);
  await write("plugin/index.mjs", `import plugin from "./file-archive.js";
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
${helpers}
export default { id: plugin.id, async setup(ctx) {
  await plugin.setup({...ctx, options: {
    loadOperatorOptions: async () => {
      const path = ${JSON.stringify(optionsPath)};
      await checkAncestors(dirname(path), "options");
      // The baked path IS the declared operator source: a missing or broken
      // file denies execution. It must never fall back to {} — that would
      // flip a revoked deployment into default mode.
      return await loadPrivateOptions(path);
    }
  }});
} };
`);
  const inspected = await inspectGuestPackage(target, { openchamberVersion: version });
  if (!inspected.ok) throw Error(`host rejected package: ${JSON.stringify(inspected)}`);
  return { target, deliveryRequired: "file", options: optionsPath,
    note: "Not installed. No options file packaged or created; a missing external options file denies bcp_save (this flavor never falls back to default mode — use the Git entry for zero-config default mode). Local Path retains the real package source; ZIP/upload copies it. Both embed the same stable canonical external options path on this host. Keep options/policy/credentials outside every served extension root. Require private ancestors, mode 0600, owner UID and one link; no symlinks. Do not use global Install into OpenCode fallback. No grants or restart performed." };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--target" || args[2] !== "--host" || args[4] !== "--options") {
    console.error("node scripts/package-openchamber.mjs --target /private/new-extension --host /installed/@openchamber/web --options /private/operator/options.json");
    process.exitCode = 1;
  } else packageOpenChamber(args[1], args[3], args[5]).then(x => console.log(JSON.stringify(x, null, 2)))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
