import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const host = process.env.OPENCHAMBER_WEB_ROOT;
test("repository extension: host parser and cold bundled setup, live private operator options", async () => {
  const root = await fs.mkdtemp(join(homedir(), ".bcp-repository-test-"));
  await fs.chmod(root, 0o700);
  const saved = process.env.BCP_OPERATOR_OPTIONS;
  try {
    const target = join(root, "extension");
    await fs.mkdir(target);
    await fs.copyFile(new URL("../package.json", import.meta.url), join(target, "package.json"));
    await fs.cp(new URL("../openchamber", import.meta.url), join(target, "openchamber"), { recursive: true });
    if (host) {
      const { inspectGuestPackage } = await import(pathToFileURL(join(host, "server/lib/guests/catalog.js")));
      assert.equal((await inspectGuestPackage(target, { openchamberVersion: "2.7.2" })).ok, true);
      const { resolveOpenCodePluginFolder } = await import(pathToFileURL(join(host, "server/lib/guests/opencode-plugin.js")));
      assert.equal(await resolveOpenCodePluginFolder(fs, target, "openchamber/plugin"), join(target, "openchamber/plugin"));
    }
    // The OpenCode plugin runtime is Bun (archive locking uses bun:ffi).
    // A separate process in the copied tree cannot inherit repo dependencies.
    execFileSync("bun", ["-e", `
      const {default: plugin} = await import(${JSON.stringify(pathToFileURL(join(target, "openchamber/plugin/index.mjs")).href)});
      let tool;
      await plugin.setup({options:{enabled:true},tool:{transform:async f=>f({add:t=>tool=t})}});
      if (tool?.name !== "bcp_save") throw Error("cold setup failed");
      const result = await tool.execute({sessionId:"s"}, {signal:new AbortController().signal});
      if (!result.content.includes("trusted_configuration_required")) throw Error("not denied");
      // Even apparently enabling ordinary host options cannot bypass the trusted
      // loader. With native permission API present, missing env still denies.
      await plugin.setup({options:{enabled:true,taskScopes:[]},
        permission:{assert:async()=>{throw Error("unexpected permission request")}},
        tool:{transform:async f=>f({add:t=>tool=t})}});
      const context = {signal:new AbortController().signal};
      const absent = JSON.parse((await tool.execute({sessionId:"s"}, context)).content);
      if (absent.status !== "denied" || absent.reason !== "trusted_configuration_required")
        throw Error("missing env bypassed");
      process.env.BCP_OPERATOR_OPTIONS = "relative-unsafe.json";
      const unsafe = JSON.parse((await tool.execute({sessionId:"s"}, context)).content);
      if (unsafe.status !== "denied") throw Error("unsafe config bypassed");
    `], { cwd: target, env: { ...process.env, BCP_OPERATOR_OPTIONS: "" } });
    const wrapperSource = await fs.readFile(join(target, "openchamber/plugin/index.mjs"), "utf8");
    assert.match(wrapperSource, /options: \{ loadOperatorOptions \}/);
    const { loadOperatorOptions } = await import(pathToFileURL(join(target, "openchamber/plugin/operator-options.mjs")));
    delete process.env.BCP_OPERATOR_OPTIONS;
    assert.deepEqual(await loadOperatorOptions(), {});
    const options = join(root, "options.json");
    process.env.BCP_OPERATOR_OPTIONS = options;
    const config = { enabled: true, taskScopes: [], policyFile: join(root, "policy.json") };
    await fs.writeFile(options, JSON.stringify(config), { mode: 0o600 });
    assert.equal((await loadOperatorOptions()).enabled, true);
    await fs.writeFile(options, JSON.stringify({ ...config, enabled: false }));
    assert.equal((await loadOperatorOptions()).enabled, false);
    await fs.chmod(options, 0o644);
    await assert.rejects(loadOperatorOptions(), /owner-private/);
    await fs.chmod(options, 0o600);
    await fs.link(options, join(root, "link"));
    await assert.rejects(loadOperatorOptions(), /owner-private/);
    await fs.unlink(join(root, "link"));
    await fs.rename(options, join(root, "real-options"));
    await fs.symlink(join(root, "real-options"), options);
    await assert.rejects(loadOperatorOptions(), /canonical/);
    await fs.unlink(options);
    await fs.rename(join(root, "real-options"), options);
    await fs.writeFile(options, " ".repeat(1024 * 1024 + 1));
    await assert.rejects(loadOperatorOptions(), /byte limit/);
    await fs.writeFile(options, JSON.stringify({ ...config, taskScopes: [{ directory: root }] }));
    await assert.rejects(loadOperatorOptions(), /outside task trees/);
    process.env.BCP_OPERATOR_OPTIONS = join(target, "package.json");
    await assert.rejects(loadOperatorOptions(), /outside extension/);
    process.env.BCP_OPERATOR_OPTIONS = "relative.json";
    await assert.rejects(loadOperatorOptions(), /canonical/);
    process.env.BCP_OPERATOR_OPTIONS = options;
    await fs.unlink(options);
    await assert.rejects(loadOperatorOptions());
  } finally {
    if (saved === undefined) delete process.env.BCP_OPERATOR_OPTIONS;
    else process.env.BCP_OPERATOR_OPTIONS = saved;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("committed bundle matches a fresh deterministic build", () => {
  execFileSync("bun", ["scripts/build-openchamber.mjs", "--check"], { cwd: new URL("../", import.meta.url) });
});
