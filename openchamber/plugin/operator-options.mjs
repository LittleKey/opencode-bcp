import { realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAncestors, loadPrivateOptions } from "./private-options.mjs";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const within = (root, path) => {
  const rel = relative(root, path);
  return !rel || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
};

export async function loadOperatorOptions() {
  const path = process.env.BCP_OPERATOR_OPTIONS;
  // Absence of the operator source is reported as undefined — the only value
  // that can enable default mode. Nothing parsed from a declared file can
  // produce undefined, so a declared source can never flip to default mode.
  if (!path) return undefined;
  if (!isAbsolute(path) || resolve(path) !== path ||
      within(packageRoot, path) || await realpath(path) !== path)
    throw Error("options must be canonical and outside extension package");
  await checkAncestors(dirname(path), "options");
  const parent = await lstat(dirname(path));
  if (parent.uid !== process.getuid() || (parent.mode & 0o077))
    throw Error("options parent must be owner-private");
  const options = await loadPrivateOptions(path);
  // A declared explicit off switch: {"enabled":false} stays a declared source
  // (never default mode) and denies execution in the adapter.
  if (options.enabled === false) return options;
  if (!Array.isArray(options.taskScopes)) throw Error("taskScopes required");
  if (typeof options.policyFile !== "string" || !isAbsolute(options.policyFile) ||
      resolve(options.policyFile) !== options.policyFile || within(packageRoot, options.policyFile))
    throw Error("policy must be canonical and outside extension package");
  for (const scope of options.taskScopes) {
    if (!scope || typeof scope.directory !== "string" || !isAbsolute(scope.directory) ||
        await realpath(scope.directory) !== scope.directory || within(scope.directory, path) ||
        within(scope.directory, options.policyFile))
      throw Error("options must be outside task trees");
  }
  return options;
}
