import { lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

export interface WorkLayout {
  projectRoot: string;
  taskRoot: string;
  reports: string;
  archive: string;
  scratch: string;
}

function component(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error("Unsafe work-layout identifier");
  }
  return value;
}

// The caller supplies a trusted actual worktree root, not a discovery hint.
// This rejects existing symlinks; it does not defeat hostile same-UID races.
function directory(path: string, create = false): void {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Work-layout path must be a non-symlink directory");
  }
}

export function resolveWorkLayout(projectRoot: string, taskId: string, runId: string): WorkLayout {
  if (!isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot) {
    throw new Error("Expected a canonical absolute trusted project root");
  }
  let ancestor = parse(projectRoot).root;
  directory(ancestor);
  for (const part of projectRoot.slice(ancestor.length).split("/").filter(Boolean)) {
    ancestor = join(ancestor, part);
    directory(ancestor);
  }
  const taskRoot = join(projectRoot, ".opencode", "work", component(taskId));
  return {
    projectRoot,
    taskRoot,
    reports: join(taskRoot, "reports"),
    archive: join(taskRoot, "archive"),
    scratch: join(taskRoot, "scratch", component(runId)),
  };
}

/** Claim a new task atomically; reuse requires an explicit same-task decision. */
export function initializeWorkLayout(
  projectRoot: string,
  taskId: string,
  runId: string,
  options: { reuseExistingTask?: boolean } = {},
): WorkLayout {
  const layout = resolveWorkLayout(projectRoot, taskId, runId);
  directory(join(projectRoot, ".opencode"), true);
  directory(join(projectRoot, ".opencode", "work"), true);
  try {
    mkdirSync(layout.taskRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !options.reuseExistingTask) throw error;
  }
  directory(layout.taskRoot);
  // Archive creation and lock ownership belong exclusively to the archive core.
  try {
    directory(layout.archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  directory(layout.reports, true);
  directory(join(layout.taskRoot, "scratch"), true);
  directory(layout.scratch, true);
  return layout;
}
