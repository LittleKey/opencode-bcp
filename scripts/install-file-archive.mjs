#!/usr/bin/env node
// Dedicated V2 runtime profile. Never merges configuration or grants authority.
import { lstat, realpath, readFile, mkdir, writeFile, copyFile, rename, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const usage = "node scripts/install-file-archive.mjs --target /absolute/new-profile --project /absolute/worktree --port 4096 [--options /absolute/operator-options.json]";
// Also embedded in the installed wrapper: check the opened inode, not a path
// checked before opening. Bound reads even if a writer grows the file.
async function loadPrivateOptions(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    const limit = 1024 * 1024;
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) throw Error("options must be owner-private regular file");
    if (stat.size > limit) throw Error("options exceeds byte limit");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await fd.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw Error("options exceeds byte limit");
    const options = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!options || Array.isArray(options) || typeof options !== "object") throw Error("options must be an object");
    return options;
  } finally {
    await fd.close();
  }
}
async function checkAncestors(start, label) {
  for (let dir = start;; dir = dirname(dir)) {
    const st = await lstat(dir);
    if (!st.isDirectory() || (st.uid !== 0 && st.uid !== process.getuid()) ||
        ((st.mode & 0o022) && !(st.uid === 0 && (st.mode & 0o1000)))) {
      throw Error(`untrusted ${label} ancestor: ${dir}`);
    }
    if (dirname(dir) === dir) break;
  }
}
export async function install(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--target", "--project", "--options", "--port"].includes(args[i]) || !args[i + 1] || flags[args[i]]) throw Error(usage);
    flags[args[i]] = args[i + 1];
  }
  for (const key of ["--target", "--project"]) if (!flags[key] || !isAbsolute(flags[key]) || resolve(flags[key]) !== flags[key]) throw Error(usage);
  const target = flags["--target"];
  const port = Number(flags["--port"]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error(usage);
  const project = await realpath(flags["--project"]);
  if (project !== flags["--project"]) throw Error("project must be canonical");
  if (!(await lstat(project)).isDirectory()) throw Error("project must be a directory");
  const projectStat = await lstat(project);
  if (projectStat.uid !== process.getuid() || (projectStat.mode & 0o077)) throw Error("project must be owner-private");
  await checkAncestors(project, "project");
  if (target === project || target.startsWith(project + "/")) throw Error("target must be outside project");
  const exists = async p => { try { await lstat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
  if (await exists(target)) throw Error("target already exists; refusing unowned configuration");
  if (await realpath(dirname(target)) !== dirname(target)) throw Error("target parent must be canonical");
  // Trusted owner-private parent; ancestor integrity excludes other-user writers.
  // This does not isolate a hostile process running under the same UID.
  const parent = await lstat(dirname(target));
  if (parent.uid !== process.getuid() || !parent.isDirectory() || (parent.mode & 0o077)) throw Error("target parent must be owner-private");
  await checkAncestors(dirname(target), "target");
  // Task data under .opencode/work is not plugin discovery.
  for (let dir = project;; dir = dirname(dir)) {
    for (const name of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc", ".opencode/plugin", ".opencode/plugins", ".opencode/tool", ".opencode/tools"]) {
      if (await exists(join(dir, name))) throw Error(`conflicting discovery path: ${join(dir, name)}`);
    }
    if (dirname(dir) === dir) break;
  }
  let options = {};
  if (flags["--options"]) {
    const p = flags["--options"];
    if (!isAbsolute(p) || await realpath(p) !== p || p === project || p.startsWith(project + "/")) throw Error("options must be canonical and outside project");
    await checkAncestors(dirname(p), "options");
    options = await loadPrivateOptions(p);
  }
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const bundle = join(repo, "dist/file-archive/file-archive.js");
  await readFile(bundle); // Build first; no package manager or network during installation.
  // mkdir claims the final name exclusively. A failed stage is deliberately not
  // deleted or rolled back; it has no registered config until the final rename.
  await mkdir(target, { mode: 0o700 });
  for (const dir of ["home", "config/opencode", "data", "cache", "state", "tmp", "package"]) await mkdir(join(target, dir), { recursive: true, mode: 0o700 });
  await copyFile(bundle, join(target, "package/file-archive.js"));
  await writeFile(join(target, "options.json"), JSON.stringify(options, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(target, "options.example.json"), JSON.stringify({
    enabled: true, connection: { baseUrl: "http://127.0.0.1:PORT", serverPid: 0 },
    taskScopes: [], policyFile: "/absolute/operator-private/policy.json",
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(target, "package/package.json"), JSON.stringify({
    name: "opencode-bcp-file-archive-local", version: "1.0.0", type: "module", exports: "./index.mjs",
  }) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(target, "package/index.mjs"), `import plugin from "./file-archive.js";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
${loadPrivateOptions.toString()}
export default { id: plugin.id, async setup(ctx) {
  await plugin.setup({...ctx, options: {
    loadOperatorOptions: async () => loadPrivateOptions(new URL("../options.json", import.meta.url))
  }});
} };
`, { mode: 0o600, flag: "wx" });
  const config = JSON.stringify({ plugin: [pathToFileURL(join(target, "package")).href] }, null, 2) + "\n";
  await writeFile(join(target, "config/opencode/opencode.json.stage"), config, { mode: 0o600, flag: "wx" });
  await rename(join(target, "config/opencode/opencode.json.stage"), join(target, "config/opencode/opencode.json"));
  const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
  const env = { HOME: join(target, "home"), XDG_CONFIG_HOME: join(target, "config"), XDG_DATA_HOME: join(target, "data"), XDG_CACHE_HOME: join(target, "cache"), XDG_STATE_HOME: join(target, "state"), TMPDIR: join(target, "tmp") };
  const prefix = `cd ${quote(project)} && env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR ${Object.entries(env).map(([k,v]) => `${k}=${quote(v)}`).join(" ")} OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_DISABLE_MODELS_FETCH=true opencode`;
  const command = `${prefix} --server http://127.0.0.1:${port}`;
  await writeFile(join(target, "serve.txt"), `${prefix} serve --service --hostname 127.0.0.1 --port ${port}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(join(target, "launch.txt"), command + "\n", { mode: 0o600, flag: "wx" });
   return { target, command, authority: "No grants created. Start the explicit loopback service using serve.txt, then connect using launch.txt. Supply reviewed options.json, live host pin, exact task/session scope, external operator policy and native permissions. Options are securely reloaded on each call. Discovery conflicts must be resolved by the operator before installation." };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
