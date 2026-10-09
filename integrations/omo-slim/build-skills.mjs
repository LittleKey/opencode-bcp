#!/usr/bin/env node
// integrations/omo-slim — deterministic skills-tree generator.
//
// Phase 1 "restore upstream defaults" (plan upstream-defaults-20261006):
// oh-my-opencode-slim registers its packaged skills IN-PROCESS from the plugin
// artifact's own src/skills/<name>/SKILL.md (CUSTOM_SKILLS registry /
// buildBundledSkillInfos). The staged artifact carries src/skills/** verbatim,
// so stock skills need NO local copies — a same-named file copy under the
// config skills root would only SHADOW the in-process registration and drift
// from the executing code. Skills are NOT appendable (no host/plugin mechanism
// extends a packaged SKILL.md), so the only auditable way to carry a local
// delta is a full file copy: pinned stock bytes + one small anchored patch
// from skill-overrides/<name>.json.
//
// Output (deterministic — same inputs produce byte-identical bytes; no
// timestamps, sorted keys):
//   <outDir>/skills/<name>/...      generated tree (patched + personal only)
//   <outDir>/build-manifest.json    provenance: verified stock files, applied
//                                   patch ops (find/replace digests), copied
//                                   personal files, complete output inventory
//
// Upstream stays the execution owner: generated patched copies change only
// what the host serves the model from the skills root; plugin-embedded
// behavior (e.g. the deepwork hook's bundled activation prompt) stays stock.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

export class BuildRefusal extends Error {
  constructor(report) {
    super(`skills build refused (nothing written):\n${report.map((l) => `  - ${l}`).join("\n")}`);
    this.name = "BuildRefusal";
    this.code = 2;
    this.report = report;
  }
}

export const STOCK_PACKAGE_NAME = "oh-my-opencode-slim";
export const STOCK_SKILLS_REL = "src/skills";

// Stock-packaged skills served by the plugin artifact's in-process
// registration — NEVER copied into a generated tree (a same-name file copy
// would shadow the registration). stage.mjs refuses to stage any of these
// names from a skills input (STOCK_INHERITED_SKILLS guard there).
export const STOCK_INHERITED_SKILLS = ["clonedeps", "reflect", "simplify", "verification-planning", "worktrees"];

// Stock-packaged skills with deliberate local deltas (skill-overrides/<name>.json).
export const PATCHED_SKILLS = ["codemap", "deepwork", "oh-my-opencode-slim"];

// Packaged by stock but NOT registered in-process (legacy 2.x leftover):
// excluded everywhere, like the inherited set.
export const STOCK_UNREGISTERED_SKILLS = ["loop-engineering"];

// Every top-level skill name this generator must NOT take from the personal
// source directory.
export const EXCLUDED_PERSONAL_SKILLS =
  [...STOCK_INHERITED_SKILLS, ...PATCHED_SKILLS, ...STOCK_UNREGISTERED_SKILLS].sort();

// Pinned stock bytes: sha256 of every file this generator reads or verifies.
// Any upstream drift (or version bump) refuses generation — re-pin
// consciously after re-diffing skill-overrides/*.json against the new bytes.
const STOCK_SKILL_SHA256 = {
  "clonedeps/README.md": "b1a701f9459a7c25cdc55178d04844ad707ecaa4d0bf48801e3da42a3c9f46b4",
  "clonedeps/SKILL.md": "8e7a0ef28cccd2c54a6e091f470d41c6be3a0ef3a0e9414d06912b3a4d845a48",
  "clonedeps/codemap.md": "25329a65dcafdd4108be1a6b993489a2a2ff91e7561ca1b2fa3b4c064b695fcd",
  "codemap/README.md": "fab8e2159592b290b5615f2b234082f5c1d4283a538df9f9542afa841c76fa0b",
  "codemap/SKILL.md": "9f389bcf1a409a3a20d0564fcf284344021eb9576c6b3fd990337c38da41fdbe",
  "codemap/codemap.md": "eb16c36c04ef8a927b7391565ac5e18c210ac2e3bbff2b803159f9c71cd55f6b",
  "codemap/scripts/codemap.mjs": "a6e59ec16f7b7e5de185a9cf35933c23e94dfaab3389a99eed66a7ece3c1fdb5",
  "codemap/scripts/codemap.test.ts": "bd94813c7545a1fe0fa46f2c8967cb7b3d8531b78e7ff313d923cabad996d569",
  "deepwork/SKILL.md": "0d98fb3402c0c59e018b60de3304caa664c69b0692af2eb6929c7ed54506cfa2",
  "oh-my-opencode-slim/SKILL.md": "802b1899aeece1431549110fbef112438332aa71394a00bf11397e7be0f5af06",
  "reflect/SKILL.md": "3e7edc3d65599b3d0ec7ceea768f086be734ce6edcea9cc7a7166986ae227dbb",
  "simplify/README.md": "30e479208ff37a348388284f434fde6b9ca9cbf704c56f21781b6175021cc7ad",
  "simplify/SKILL.md": "29e126c20e8310fad21bd0db5fe4225c88538aa8585b1efbc9726a684643cf10",
  "simplify/codemap.md": "e8659ed4db1cbbf5b814d172db35306c172f88ef24c34abbe8c53ae62cc75281",
  "verification-planning/SKILL.md": "7d2f4db38901c82a2884284805ebe4105b813933ba5cdca572acfed5b92e83c5",
  "worktrees/SKILL.md": "09c9b694ff3450e96d078ff687f25dae6238202972fdc62a6769605531bc22f6",
};

// Each supported release has its own lock and audited override selection.
// Only deepwork changed in 3.0.3; the other fifteen relevant files are identical.
const STOCK_RELEASES = {
  "3.0.1": { files: STOCK_SKILL_SHA256, overrides: {} },
  "3.0.3": {
    files: { ...STOCK_SKILL_SHA256, "deepwork/SKILL.md": "8c19f0533810a693a3437929343acabc70f79f74cb757c78c253cb353f1fe0a9" },
    overrides: { deepwork: "3.0.3/deepwork.json" },
  },
};
export const STOCK_PACKAGE_VERSIONS = Object.keys(STOCK_RELEASES);

const sha256Bytes = (buf) => createHash("sha256").update(buf).digest("hex");

// Sorted relative file list of a directory tree (files only).
function listFilesRel(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const rel of listFilesRel(join(dir, entry.name))) out.push(`${entry.name}/${rel}`);
    } else if (entry.isFile()) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/**
 * Apply anchored patch ops to one file's bytes. Every find must occur EXACTLY
 * once — zero matches means the base drifted (or never existed); multiple
 * matches mean the anchor is not specific enough. Both refuse.
 */
export function applyPatches(text, ops, label) {
  let out = text;
  const applied = [];
  for (const op of ops) {
    const count = out.split(op.find).length - 1;
    if (count === 0) {
      throw new BuildRefusal([`${label}: patch op '${op.id}' anchor not found in base bytes — skill base drifted or missing; re-diff skill-overrides against stock`]);
    }
    if (count > 1) {
      throw new BuildRefusal([`${label}: patch op '${op.id}' anchor matches ${count} times — anchor is not unique; make it specific instead of trusting the first hit`]);
    }
    out = out.replace(op.find, op.replace);
    applied.push({ id: op.id, findSha256: sha256Bytes(Buffer.from(op.find, "utf8")), replaceSha256: sha256Bytes(Buffer.from(op.replace, "utf8")) });
  }
  return { text: out, applied };
}

function loadPatchFile(overridesDir, skill, file = `${skill}.json`) {
  const path = join(overridesDir, file);
  if (!existsSync(path)) {
    throw new BuildRefusal([`patch file missing: ${path} — every patched skill needs an auditable delta file`]);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new BuildRefusal([`patch file ${path} is not valid JSON: ${err.message}`]);
  }
  if (doc.target !== `skills/${skill}/SKILL.md`) {
    throw new BuildRefusal([`patch file ${path} target must be "skills/${skill}/SKILL.md", got ${JSON.stringify(doc.target)}`]);
  }
  if (!Array.isArray(doc.ops) || doc.ops.length === 0) {
    throw new BuildRefusal([`patch file ${path} must carry a non-empty ops array`]);
  }
  for (const op of doc.ops) {
    if (typeof op.id !== "string" || op.id.length === 0) throw new BuildRefusal([`patch file ${path} has an op without a non-empty id`]);
    if (typeof op.find !== "string" || op.find.length === 0 || typeof op.replace !== "string") {
      throw new BuildRefusal([`patch file ${path} op '${op.id}' needs non-empty find and replace strings`]);
    }
  }
  return { path, doc };
}

/**
 * Generate the skills tree.
 * @param opts { packageDir: stock package root (version-pinned),
 *   personalDir: source of verbatim personal skills,
 *   outDir: output root — receives skills/ + build-manifest.json,
 *   overridesDir: patch files (default: <this module dir>/skill-overrides) }
 * @returns { skillsDir, manifestPath, manifest }
 */
export function buildSkills(opts) {
  const { packageDir, personalDir, outDir } = opts;
  const overridesDir = opts.overridesDir ?? join(dirname(fileURLToPath(import.meta.url)), "skill-overrides");
  const report = [];

  // stock package identity
  const pkgPath = join(packageDir, "package.json");
  let version;
  if (!existsSync(pkgPath)) report.push(`stock package.json missing: ${pkgPath}`);
  else {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (err) {
      pkg = { parseError: err.message };
    }
    if (pkg.name !== STOCK_PACKAGE_NAME) report.push(`stock package name is ${JSON.stringify(pkg.name)} — expected ${JSON.stringify(STOCK_PACKAGE_NAME)}`);
    version = pkg.version;
    if (!Object.hasOwn(STOCK_RELEASES, version)) {
      report.push(`stock package version is ${JSON.stringify(version)} — supported pinned releases: ${STOCK_PACKAGE_VERSIONS.join(", ")}; re-diff skill-overrides and re-pin stock hashes for a deliberate upgrade`);
    }
  }
  if (report.length > 0) throw new BuildRefusal(report);
  const release = STOCK_RELEASES[version];
  const stockSkillsDir = join(packageDir, ...STOCK_SKILLS_REL.split("/"));
  if (!existsSync(stockSkillsDir)) report.push(`stock skills dir missing: ${stockSkillsDir}`);

  // stock bytes: every pinned file must exist with the exact pinned hash —
  // and the directory must not have grown unpinned files (a new stock file in
  // a patched skill must be pinned consciously, never silently skipped)
  const verifiedStock = {};
  if (existsSync(stockSkillsDir)) {
    const stockFiles = listFilesRel(stockSkillsDir);
    for (const rel of stockFiles) {
      const [top] = rel.split("/");
      const relevant = PATCHED_SKILLS.includes(top) || STOCK_INHERITED_SKILLS.includes(top);
      if (!relevant) continue;
      const pinned = release.files[rel];
      if (!pinned) {
        report.push(`unpinned stock skill file present: ${rel} — add it to STOCK_SKILL_SHA256 or account for it explicitly`);
        continue;
      }
      const actual = sha256Bytes(readFileSync(join(stockSkillsDir, ...rel.split("/"))));
      if (actual !== pinned) report.push(`stock file drifted: ${rel} sha256 ${actual} != pinned ${pinned}`);
      else verifiedStock[rel] = actual;
    }
    for (const rel of Object.keys(release.files)) {
      if (!stockFiles.includes(rel)) report.push(`pinned stock file missing: ${rel} — the stock package no longer carries it; re-pin`);
    }
  }

  // personal source: every top-level skill kept verbatim, each with SKILL.md
  const personalFiles = {};
  const personalModes = {};
  const personalSkills = [];
  const skippedPersonal = [];
  if (!existsSync(personalDir)) report.push(`personal skills dir missing: ${personalDir}`);
  else {
    for (const entry of readdirSync(personalDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (EXCLUDED_PERSONAL_SKILLS.includes(entry.name)) {
        skippedPersonal.push(entry.name);
        continue;
      }
      const dirAbs = join(personalDir, entry.name);
      const rels = listFilesRel(dirAbs);
      if (!rels.includes("SKILL.md")) {
        report.push(`personal skill '${entry.name}' has no SKILL.md at its root — refusing an unnamed skill base`);
        continue;
      }
      personalSkills.push(entry.name);
      for (const rel of rels) {
        personalFiles[`${entry.name}/${rel}`] = sha256Bytes(readFileSync(join(dirAbs, ...rel.split("/"))));
        personalModes[`${entry.name}/${rel}`] = (statSync(join(dirAbs, ...rel.split("/"))).mode & 0o777).toString(8).padStart(4, "0");
      }
    }
  }
  personalSkills.sort();
  skippedPersonal.sort();

  // Pass 1 (BEFORE anything is written): load every patch file and compute
  // every patched SKILL.md in memory — patch anchor drift, a missing patch
  // file, or any earlier refusal must leave the output untouched.
  const patchedTexts = new Map();
  const patches = {};
  if (existsSync(stockSkillsDir)) {
    for (const skill of PATCHED_SKILLS) {
      let patch;
      try {
        patch = loadPatchFile(overridesDir, skill, release.overrides[skill]);
      } catch (err) {
        if (err instanceof BuildRefusal) {
          report.push(...err.report);
          continue;
        }
        throw err;
      }
      const skillMdAbs = join(stockSkillsDir, skill, "SKILL.md");
      if (!existsSync(skillMdAbs)) {
        report.push(`stock skill SKILL.md missing: skills/${skill}/SKILL.md — nothing to patch`);
        continue;
      }
      try {
        const { text, applied } = applyPatches(readFileSync(skillMdAbs, "utf8"), patch.doc.ops, `skills/${skill}/SKILL.md`);
        patchedTexts.set(skill, text);
        patches[skill] = { patchFile: patch.path, note: patch.doc.note ?? null, ops: applied };
      } catch (err) {
        if (err instanceof BuildRefusal) {
          report.push(...err.report);
          continue;
        }
        throw err;
      }
    }
  }

  if (report.length > 0) throw new BuildRefusal(report);

  // write output (only after every refusal check passed)
  rmSync(outDir, { recursive: true, force: true });
  const skillsDir = join(outDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  const generated = {};
  const generatedModes = {};
  // Pass 2: write — full stock skill directories (companions travel: README,
  // codemap.md, scripts/) plus the pre-computed patched SKILL.md.
  for (const skill of PATCHED_SKILLS) {
    const destDir = join(skillsDir, skill);
    mkdirSync(destDir, { recursive: true });
    const stockDir = join(stockSkillsDir, skill);
    for (const rel of listFilesRel(stockDir)) {
      const destAbs = join(destDir, ...rel.split("/"));
      mkdirSync(dirname(destAbs), { recursive: true });
      if (rel === "SKILL.md") {
        const text = patchedTexts.get(skill);
        writeFileSync(destAbs, text);
        generated[`skills/${skill}/SKILL.md`] = sha256Bytes(Buffer.from(text, "utf8"));
      } else {
        const bytes = readFileSync(join(stockDir, ...rel.split("/")));
        writeFileSync(destAbs, bytes);
        generated[`skills/${skill}/${rel}`] = sha256Bytes(bytes);
      }
      const mode = statSync(join(stockDir, ...rel.split("/"))).mode & 0o777;
      chmodSync(destAbs, mode);
      generatedModes[`skills/${skill}/${rel}`] = mode.toString(8).padStart(4, "0");
    }
  }

  for (const skill of personalSkills) {
    const srcDir = join(personalDir, skill);
    for (const rel of listFilesRel(srcDir)) {
      const destAbs = join(skillsDir, skill, ...rel.split("/"));
      mkdirSync(dirname(destAbs), { recursive: true });
      const bytes = readFileSync(join(srcDir, ...rel.split("/")));
      writeFileSync(destAbs, bytes);
      // writeFileSync's default mode would silently strip executable bits
      // from script companions. Explicit chmod also defeats a restrictive umask.
      chmodSync(destAbs, parseInt(personalModes[`${skill}/${rel}`], 8));
      generated[`skills/${skill}/${rel}`] = sha256Bytes(bytes);
      generatedModes[`skills/${skill}/${rel}`] = personalModes[`${skill}/${rel}`];
    }
  }

  // shadow guard: an inherited name must never enter the generated tree
  for (const name of Object.keys(generated)) {
    const top = name.split("/")[1];
    if (STOCK_INHERITED_SKILLS.includes(top) || STOCK_UNREGISTERED_SKILLS.includes(top)) {
      throw new BuildRefusal([`generated tree contains stock-inherited skill '${top}' — a file copy would shadow the plugin's in-process registration`]);
    }
  }

  const manifest = {
    schemaVersion: 1,
    generator: "integrations/omo-slim/build-skills.mjs",
    stockPackage: {
      name: STOCK_PACKAGE_NAME,
      version,
      dir: packageDir,
      skillsRel: STOCK_SKILLS_REL,
      verifiedFiles: verifiedStock,
    },
    inherited: [...STOCK_INHERITED_SKILLS].sort(),
    unregistered: [...STOCK_UNREGISTERED_SKILLS],
    patched: patches,
    personal: { dir: personalDir, skills: personalSkills, skipped: skippedPersonal, files: personalFiles, modes: personalModes },
    output: { skillsDir, files: Object.fromEntries(Object.entries(generated).sort(([a], [b]) => (a < b ? -1 : 1))),
      modes: Object.fromEntries(Object.entries(generatedModes).sort(([a], [b]) => (a < b ? -1 : 1))) },
  };
  const manifestPath = join(outDir, "build-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { skillsDir, manifestPath, manifest };
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    args[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  const required = ["package-dir", "personal-dir", "out-dir"];
  for (const key of required) {
    if (!args[key]) {
      console.error(`usage: build-skills.mjs --package-dir <stock pkg root> --personal-dir <skills source> --out-dir <output root> [--overrides-dir <dir>]`);
      process.exit(2);
    }
  }
  const { skillsDir, manifestPath, manifest } = buildSkills({
    packageDir: args["package-dir"],
    personalDir: args["personal-dir"],
    outDir: args["out-dir"],
    ...(args["overrides-dir"] ? { overridesDir: args["overrides-dir"] } : {}),
  });
  const counts = {
    inherited: manifest.inherited.length,
    patched: Object.keys(manifest.patched).length,
    personal: manifest.personal.skills.length,
    files: Object.keys(manifest.output.files).length,
  };
  console.log(`skills tree generated: ${skillsDir}`);
  console.log(`manifest: ${manifestPath}`);
  console.log(`inherited(upstream, no copies): ${counts.inherited}; patched: ${counts.patched}; personal verbatim: ${counts.personal}; files: ${counts.files}`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof BuildRefusal) {
      console.error(err.message);
      process.exit(err.code);
    }
    throw err;
  }
}
