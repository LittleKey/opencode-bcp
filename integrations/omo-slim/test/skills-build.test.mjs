// integrations/omo-slim — build-skills.mjs test suite (node:test).
// Hermetic: no network, no model requests, no production writes. The real
// pinned stock package is used when present (regression coverage for real
// anchors); every refusal path is exercised against throwaway fixtures.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { buildSkills, applyPatches, BuildRefusal, STOCK_INHERITED_SKILLS, PATCHED_SKILLS, STOCK_UNREGISTERED_SKILLS, EXCLUDED_PERSONAL_SKILLS } from "../build-skills.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // integrations/omo-slim/test
const MODULE_DIR = dirname(HERE); // integrations/omo-slim
const OVERRIDES = join(MODULE_DIR, "skill-overrides");
const STOCK_PKG = "/home/littlekey/.cache/opencode/packages/oh-my-opencode-slim@3.0.1/node_modules/oh-my-opencode-slim";
const HAS_STOCK = existsSync(join(STOCK_PKG, "package.json"));
const STOCK_303 = process.env.OMO_303_PACKAGE ?? "/home/littlekey/.cache/opencode/packages/oh-my-opencode-slim@3.0.3/node_modules/oh-my-opencode-slim";
const HAS_STOCK_303 = existsSync(join(STOCK_303, "package.json"));

let S;

before(() => {
  S = mkdtempSync(join(tmpdir(), "skills-build-test-"));
});

after(() => {
  rmSync(S, { recursive: true, force: true });
});

/** Minimal fake personal source: two valid skills + same-name OMO copies. */
function fakePersonal(dir) {
  mkdirSync(join(dir, "grilling"), { recursive: true });
  writeFileSync(join(dir, "grilling", "SKILL.md"), "---\ndescription: grilling\n---\nAsk hard questions.\n");
  mkdirSync(join(dir, "handoff"), { recursive: true });
  writeFileSync(join(dir, "handoff", "SKILL.md"), "# handoff\n");
  writeFileSync(join(dir, "handoff", "notes.md"), "extra file travels verbatim\n");
  // OMO same-name copies: must be EXCLUDED (stock or stock+patch serves them)
  mkdirSync(join(dir, "codemap"), { recursive: true });
  writeFileSync(join(dir, "codemap", "SKILL.md"), "STALE GLOBAL COPY — must never reach the generated tree\n");
  mkdirSync(join(dir, "reflect"), { recursive: true });
  writeFileSync(join(dir, "reflect", "SKILL.md"), "STALE INHERITED COPY — must never reach the generated tree\n");
  return dir;
}

test("canonical inheritance sets cover exactly the excluded personal names", () => {
  assert.deepEqual(new Set([...STOCK_INHERITED_SKILLS, ...PATCHED_SKILLS, ...STOCK_UNREGISTERED_SKILLS]), new Set(EXCLUDED_PERSONAL_SKILLS));
  assert.equal(STOCK_INHERITED_SKILLS.length, 5);
  assert.equal(PATCHED_SKILLS.length, 3);
});

test("canonical inheritance sets agree with the companion runtime stage guard", {
  skip: process.env.OPROFILE_RUNTIME_DIR ? false : "set OPROFILE_RUNTIME_DIR to the companion dotfiles opencode/runtime checkout",
}, async () => {
  const { STOCK_INHERITED_SKILLS: runtimeSkills } = await import(pathToFileURL(join(process.env.OPROFILE_RUNTIME_DIR, "lib/stage.mjs")).href);
  assert.deepEqual([...STOCK_INHERITED_SKILLS].sort(), [...runtimeSkills].sort());
});

test("applyPatches: exactly-once anchors apply; zero and multiple matches refuse", () => {
  const { text, applied } = applyPatches("alpha ALPHA beta", [{ id: "op1", find: "alpha", replace: "A" }], "t");
  assert.equal(text, "A ALPHA beta");
  assert.equal(applied.length, 1);
  assert.match(applied[0].findSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => applyPatches("no anchor here", [{ id: "op1", find: "alpha", replace: "A" }], "t"), (e) => e instanceof BuildRefusal && /anchor not found/.test(e.message));
  assert.throws(() => applyPatches("x x x", [{ id: "op1", find: "x", replace: "y" }], "t"), (e) => e instanceof BuildRefusal && /matches 3 times/.test(e.message));
});

test("3.0.3 skills use audited new deepwork bytes and keep compatible router, local state and commit policies", {skip: HAS_STOCK_303 ? false : "set OMO_303_PACKAGE to the pinned 3.0.3 package"}, () => {
  const {skillsDir, manifest} = buildSkills({packageDir: STOCK_303, personalDir: fakePersonal(join(S, "personal-303")), outDir: join(S, "out-303")});
  assert.equal(manifest.stockPackage.version, "3.0.3");
  assert.equal(manifest.stockPackage.verifiedFiles["deepwork/SKILL.md"], "8c19f0533810a693a3437929343acabc70f79f74cb757c78c253cb353f1fe0a9");
  const text = readFileSync(join(skillsDir, "deepwork/SKILL.md"), "utf8");
  for (const marker of ["<session-id>.md", "<task-slug>/progress.md", "Todo", "original", "deepwork never commits on its own initiative", "1 + 2 review budget"]) assert.ok(text.includes(marker), marker);
  assert.ok(!text.includes("grep -m1"));
  for (const inherited of STOCK_INHERITED_SKILLS) assert.equal(existsSync(join(skillsDir, inherited)), false);
});

test("3.0.3 drift refuses before replacing existing output and a 3.0.1 deepwork cannot pass its lock", {skip: HAS_STOCK_303 && HAS_STOCK ? false : "both pinned stock packages required"}, () => {
  const packageDir = join(S, "303-drift"), outDir = join(S, "303-preserved-output");
  mkdirSync(join(packageDir, "src"), {recursive: true});
  cpSync(join(STOCK_303, "src/skills"), join(packageDir, "src/skills"), {recursive: true});
  cpSync(join(STOCK_303, "package.json"), join(packageDir, "package.json"));
  mkdirSync(outDir); writeFileSync(join(outDir, "sentinel"), "preserved");
  cpSync(join(STOCK_PKG, "src/skills/deepwork/SKILL.md"), join(packageDir, "src/skills/deepwork/SKILL.md"));
  assert.throws(() => buildSkills({packageDir, personalDir: fakePersonal(join(S, "303-personal-drift")), outDir}), /stock file drifted: deepwork\/SKILL.md/);
  assert.equal(readFileSync(join(outDir, "sentinel"), "utf8"), "preserved");
});

test("3.0.3 preserves all eight approved personal files and five executable helpers", {skip: HAS_STOCK_303 && process.env.OPROFILE_RUNTIME_DIR ? false : "set OMO_303_PACKAGE and OPROFILE_RUNTIME_DIR for pinned sources"}, () => {
  const personalDir = join(process.env.OPROFILE_RUNTIME_DIR, "../skills");
  const {skillsDir, manifest} = buildSkills({packageDir: STOCK_303, personalDir, outDir: join(S, "303-personal")});
  const files = ["executing-plans/SKILL.md", "writing-plans/SKILL.md", "executing-plans/references/code-reviewer.md", ...["plan-workspace", "review-package", "task-brief", "task-done", "task-start"].map(name => `executing-plans/scripts/${name}`)];
  for (const path of files) {
    const source = join(personalDir, path), output = join(skillsDir, path);
    assert.deepEqual(readFileSync(output), readFileSync(source), path);
    assert.equal(statSync(output).mode & 0o777, statSync(source).mode & 0o777, path);
    assert.equal(manifest.output.files[`skills/${path}`], createHash("sha256").update(readFileSync(source)).digest("hex"));
    if (path.includes("/scripts/")) { assert.equal(statSync(output).mode & 0o777, 0o755); execFileSync("bash", ["-n", output]); }
  }
});

if (!HAS_STOCK) {
  test("real stock package present for anchor regression coverage", { skip: "pinned stock 3.0.1 cache not available on this machine" }, () => {});
} else {
  test("build: companion scripts preserve executable and restricted modes across relocation and rebuild", () => {
    const personal = fakePersonal(join(S, "personal-modes"));
    const scripts = join(personal, "handoff", "scripts");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "helper"), "#!/bin/sh\nprintf 'companion-ok\\n'\n");
    chmodSync(join(scripts, "helper"), 0o755);
    chmodSync(join(personal, "handoff", "notes.md"), 0o600);
    const out = join(S, "out-modes");
    const oldMask = process.umask(0o077);
    let built;
    try { built = buildSkills({ packageDir: STOCK_PKG, personalDir: personal, outDir: out }); }
    finally { process.umask(oldMask); }
    const moved = join(S, "relocated-modes");
    cpSync(out, moved, { recursive: true });
    const rebuilt = buildSkills({ packageDir: STOCK_PKG, personalDir: join(moved, "skills"), outDir: join(S, "rebuilt-modes") });
    for (const root of [built.skillsDir, join(moved, "skills"), rebuilt.skillsDir]) {
      const script = join(root, "handoff", "scripts", "helper");
      assert.equal(statSync(script).mode & 0o777, 0o755);
      assert.equal(statSync(join(root, "handoff", "notes.md")).mode & 0o777, 0o600);
      assert.equal(execFileSync(script, [], { encoding: "utf8" }), "companion-ok\n");
    }
    assert.equal(built.manifest.personal.modes["handoff/scripts/helper"], "0755");
    assert.equal(built.manifest.output.modes["skills/handoff/scripts/helper"], "0755");
    assert.equal(built.manifest.output.modes["skills/handoff/notes.md"], "0600");
  });

  test("build: inherited skills excluded, patched + personal present, required resources travel", () => {
    const personal = fakePersonal(join(S, "personal-a"));
    const { skillsDir, manifest } = buildSkills({ packageDir: STOCK_PKG, personalDir: personal, outDir: join(S, "out-a") });
    const outDirA = dirname(skillsDir); // output root is skills/'s parent
    // inherited + unregistered names NEVER enter the tree (patched names DO —
    // as stock+patch copies — and are asserted below)
    for (const name of [...STOCK_INHERITED_SKILLS, ...STOCK_UNREGISTERED_SKILLS]) {
      assert.ok(!existsSync(join(skillsDir, name)), `${name} must not be copied`);
    }
    // patched skills present with full stock companions
    assert.ok(existsSync(join(skillsDir, "codemap", "SKILL.md")));
    assert.ok(existsSync(join(skillsDir, "codemap", "scripts", "codemap.mjs")), "codemap script travels (base-dir relocation)");
    assert.ok(existsSync(join(skillsDir, "codemap", "codemap.md")));
    assert.ok(existsSync(join(skillsDir, "codemap", "README.md")));
    assert.ok(existsSync(join(skillsDir, "deepwork", "SKILL.md")));
    assert.ok(existsSync(join(skillsDir, "oh-my-opencode-slim", "SKILL.md")));
    // personal skills copied verbatim, same-name global copies excluded
    assert.equal(readFileSync(join(skillsDir, "grilling", "SKILL.md"), "utf8"), readFileSync(join(personal, "grilling", "SKILL.md"), "utf8"));
    assert.equal(existsSync(join(skillsDir, "handoff", "notes.md")), true, "personal companion files travel verbatim");
    assert.ok(!readFileSync(join(skillsDir, "codemap", "SKILL.md"), "utf8").includes("STALE GLOBAL COPY"), "codemap emitted only from stock+patch, never from the stale personal copy");
    assert.ok(!existsSync(join(skillsDir, "reflect")), "inherited name from the personal source never reaches the tree either");
    // manifest: provenance complete
    assert.equal(manifest.stockPackage.version, "3.0.1");
    assert.ok(Object.keys(manifest.stockPackage.verifiedFiles).length >= 16, "every patched + inherited stock file hash-verified");
    assert.deepEqual(manifest.inherited, [...STOCK_INHERITED_SKILLS].sort());
    assert.deepEqual(manifest.personal.skipped.sort(), [...EXCLUDED_PERSONAL_SKILLS].filter((n) => existsSync(join(personal, n))).sort(), "same-name personal copies recorded as skipped, not silently mixed");
    const patchedFiles = Object.keys(manifest.output.files).filter((f) => f.startsWith("skills/codemap/"));
    assert.ok(patchedFiles.length >= 5, "codemap emitted as a full stock dir + patched SKILL.md");
    for (const [rel, sha] of Object.entries(manifest.output.files)) {
      const actual = createHash("sha256").update(readFileSync(join(outDirA, "skills", ...rel.split("/").slice(1)))).digest("hex");
      assert.equal(actual, sha, `manifest hash matches emitted bytes for ${rel}`);
    }
  });

  test("build: applied patch content is the audited delta, nothing else drifted from stock", () => {
    const out = join(S, "out-patchcheck");
    const { skillsDir, manifest, outDir: checkOut } = buildSkills({
      packageDir: STOCK_PKG,
      personalDir: fakePersonal(join(S, "personal-b")),
      outDir: out,
    });
    for (const skill of PATCHED_SKILLS) {
      const stock = readFileSync(join(STOCK_PKG, "src", "skills", skill, "SKILL.md"), "utf8");
      const generated = readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8");
      // replay the ops by hand from the patch files and require equality
      const doc = JSON.parse(readFileSync(join(OVERRIDES, `${skill}.json`), "utf8"));
      let expected = stock;
      for (const op of doc.ops) {
        assert.equal(expected.split(op.find).length - 1, 1, `${skill}: op ${op.id} anchor occurs exactly once in stock`);
        expected = expected.replace(op.find, op.replace);
      }
      assert.equal(generated, expected, `${skill}: generated bytes == stock bytes + exactly the audited ops`);
      assert.equal(manifest.patched[skill].ops.length, doc.ops.length);
    }
    // spot-check the flagship deltas survived
    const deepwork = readFileSync(join(skillsDir, "deepwork", "SKILL.md"), "utf8");
    assert.ok(deepwork.includes("deepwork never commits on its own initiative"));
    assert.ok(deepwork.includes("<session-id>.md"), "stock session-pinned contract kept");
    const omy = readFileSync(join(skillsDir, "oh-my-opencode-slim", "SKILL.md"), "utf8");
    assert.ok(omy.includes("Built-in agents also accept inline `prompt` and `orchestratorPrompt`"));
    assert.ok(omy.includes("shadows the bundled in-process skill"));
  });

  test("build: wrong package version refuses", () => {
    const fakePkg = join(S, "wrong-version");
    mkdirSync(join(fakePkg, "src", "skills", "deepwork"), { recursive: true });
    writeFileSync(join(fakePkg, "package.json"), JSON.stringify({ name: "oh-my-opencode-slim", version: "3.1.0" }));
    writeFileSync(join(fakePkg, "src", "skills", "deepwork", "SKILL.md"), "upgraded bytes");
    assert.throws(
      () => buildSkills({ packageDir: fakePkg, personalDir: fakePersonal(join(S, "personal-c")), outDir: join(S, "out-c") }),
      (e) => e instanceof BuildRefusal && /version is "3\.1\.0" — supported pinned releases: 3\.0\.1, 3\.0\.3/.test(e.message) && /re-diff skill-overrides/.test(e.message)
    );
    assert.ok(!existsSync(join(S, "out-c")), "refusal writes nothing");
  });

  test("build: drifted or missing stock base bytes refuse (missing bases / anchor drift)", () => {
    // drifted SKILL.md under the pinned hash → refusal before any write
    const drifted = join(S, "drifted-pkg");
    cpSync(STOCK_PKG, drifted, { recursive: true });
    const p = join(drifted, "src", "skills", "deepwork", "SKILL.md");
    writeFileSync(p, readFileSync(p, "utf8") + "\ndrift line\n");
    assert.throws(
      () => buildSkills({ packageDir: drifted, personalDir: fakePersonal(join(S, "personal-d")), outDir: join(S, "out-d") }),
      (e) => e instanceof BuildRefusal && e.report.some((l) => l.includes("deepwork/SKILL.md") && l.includes("stock file drifted"))
    );
    assert.ok(!existsSync(join(S, "out-d")));

    // missing pinned stock file (base deleted upstream) → refusal
    const missing = join(S, "missing-pkg");
    cpSync(STOCK_PKG, missing, { recursive: true });
    rmSync(join(missing, "src", "skills", "codemap", "scripts", "codemap.mjs"));
    assert.throws(
      () => buildSkills({ packageDir: missing, personalDir: fakePersonal(join(S, "personal-e")), outDir: join(S, "out-e") }),
      (e) => e instanceof BuildRefusal && e.report.some((l) => l.includes("codemap/scripts/codemap.mjs") && l.includes("pinned stock file missing"))
    );
  });

  test("build: anchor drift in a patch refuses generation (never a silent skip)", () => {
    const overrides = join(S, "overrides-drift");
    mkdirSync(overrides);
    for (const skill of PATCHED_SKILLS) cpSync(join(OVERRIDES, `${skill}.json`), join(overrides, `${skill}.json`));
    const doc = JSON.parse(readFileSync(join(OVERRIDES, "deepwork.json"), "utf8"));
    writeFileSync(
      join(overrides, "deepwork.json"),
      JSON.stringify({ ...doc, ops: [{ ...doc.ops[0], find: doc.ops[0].find.replace("progress file", "progress FILES") }, ...doc.ops.slice(1)] })
    );
    assert.throws(
      () => buildSkills({ packageDir: STOCK_PKG, personalDir: fakePersonal(join(S, "personal-f")), outDir: join(S, "out-f"), overridesDir: overrides }),
      (e) => e instanceof BuildRefusal && /todo-live-status.*anchor not found|anchor not found.*todo-live-status/.test(e.message)
    );
    assert.ok(!existsSync(join(S, "out-f")));
  });

  test("build: missing patch file refuses (patched skill without an auditable delta is a policy error)", () => {
    const overrides = join(S, "overrides-missing");
    mkdirSync(overrides);
    assert.throws(
      () => buildSkills({ packageDir: STOCK_PKG, personalDir: fakePersonal(join(S, "personal-g")), outDir: join(S, "out-g"), overridesDir: overrides }),
      (e) => e instanceof BuildRefusal && /patch file missing/.test(e.message) && /codemap\.json/.test(e.message)
    );
  });

  test("build: personal skill without SKILL.md refuses; personal copy of an inherited name is skipped, not staged", () => {
    const personal = join(S, "personal-bad");
    mkdirSync(join(personal, "no-skill-md"), { recursive: true });
    writeFileSync(join(personal, "no-skill-md", "README.md"), "x");
    assert.throws(
      () => buildSkills({ packageDir: STOCK_PKG, personalDir: personal, outDir: join(S, "out-h") }),
      (e) => e instanceof BuildRefusal && /no-skill-md.*no SKILL\.md/.test(e.message)
    );
  });

  test("build: unpinned new stock file in a patched skill refuses (upstream must be pinned consciously)", () => {
    const grown = join(S, "grown-pkg");
    cpSync(STOCK_PKG, grown, { recursive: true });
    writeFileSync(join(grown, "src", "skills", "deepwork", "NEW-UPSTREAM.md"), "brand new upstream file");
    assert.throws(
      () => buildSkills({ packageDir: grown, personalDir: fakePersonal(join(S, "personal-i")), outDir: join(S, "out-i") }),
      (e) => e instanceof BuildRefusal && /unpinned stock skill file present: deepwork\/NEW-UPSTREAM\.md/.test(e.message)
    );
  });

  test("build: deterministic — same inputs produce byte-identical trees and manifests (modulo output dir path)", () => {
    const personal = fakePersonal(join(S, "personal-det"));
    const out1 = join(S, "out-det-1");
    const out2 = join(S, "out-det-2");
    const a = buildSkills({ packageDir: STOCK_PKG, personalDir: personal, outDir: out1 });
    const b = buildSkills({ packageDir: STOCK_PKG, personalDir: personal, outDir: out2 });
    const tree = (root) => readdirSync(join(root, "skills"), { recursive: true, withFileTypes: false }).sort().join("\n");
    assert.equal(tree(out1), tree(out2), "identical file lists");
    for (const [rel, sha] of Object.entries(a.manifest.output.files)) {
      assert.equal(sha, b.manifest.output.files[rel], `${rel} bytes identical across runs`);
      assert.equal(
        createHash("sha256").update(readFileSync(join(out1, "skills", ...rel.split("/").slice(1)))).digest("hex"),
        sha,
        `manifest hash matches disk for ${rel}`
      );
    }
    const strip = (m) => JSON.stringify({ ...m, output: { ...m.output, skillsDir: "X" } });
    assert.equal(strip(JSON.parse(readFileSync(a.manifestPath, "utf8"))), strip(JSON.parse(readFileSync(b.manifestPath, "utf8"))), "manifests identical except the output path");
    assert.ok(!JSON.stringify(a.manifest).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/), "no timestamps in the manifest — rebuilds stay reproducible");
  });

  test("build: rerun over an existing output replaces it cleanly (no stale files from a previous run)", () => {
    const personal = join(S, "personal-rerun");
    mkdirSync(join(personal, "temp-skill"), { recursive: true });
    writeFileSync(join(personal, "temp-skill", "SKILL.md"), "temporary\n");
    const out = join(S, "out-rerun");
    buildSkills({ packageDir: STOCK_PKG, personalDir: personal, outDir: out });
    assert.ok(existsSync(join(out, "skills", "temp-skill", "SKILL.md")));
    rmSync(join(personal, "temp-skill"), { recursive: true });
    buildSkills({ packageDir: STOCK_PKG, personalDir: personal, outDir: out });
    assert.ok(!existsSync(join(out, "skills", "temp-skill")), "removed source skill disappears from the regenerated tree");
    assert.ok(existsSync(join(out, "skills", "deepwork", "SKILL.md")), "patched skills still present after rerun");
  });
}
