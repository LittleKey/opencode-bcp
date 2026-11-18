import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { packageOpenChamber } from "../scripts/package-openchamber.mjs";

const host = process.env.OPENCHAMBER_WEB_ROOT;
test("offline package: actual host parser, external deny-default options, private inode checks",
  { skip: !host && "set OPENCHAMBER_WEB_ROOT to installed 2.7.2 package" }, async () => {
    // Large artifacts never go on RAM-backed /tmp.
    const root = await fs.mkdtemp(join(homedir(), ".openchamber-package-test-"));
    await fs.chmod(root, 0o700);
    try {
      const target = join(root, "extension");
      const options = join(root, "operator.json");
      await packageOpenChamber(target, host, options);
      assert.deepEqual((await fs.readdir(target)).sort(), ["package.json", "plugin"]);
      await assert.rejects(fs.stat(options), { code: "ENOENT" });
      const manifest = JSON.parse(await fs.readFile(join(target, "package.json"))).openchamber;
      assert.deepEqual(Object.keys(manifest.contributes).sort(), ["opencodePlugin", "panel"]);
      assert.equal(manifest.contributes.panel.entry, undefined);
      const { resolveOpenCodePluginFolder, openCodePluginDelivery } =
        await import(pathToFileURL(join(host, "server/lib/guests/opencode-plugin.js")));
      assert.equal(await resolveOpenCodePluginFolder(fs, target, "plugin"), join(target, "plugin"));
      assert.equal(openCodePluginDelivery({ external: false, ownsConfigFile: true }), "file");
      // Execute the generated loader with a capture-only fixture, not BCP or a host.
      await fs.writeFile(join(target, "plugin/file-archive.js"),
        'export default {id:"fixture",setup(ctx){ globalThis.__bcpPackageOptions = ctx.options.loadOperatorOptions; }};');
      const wrapper = await import(pathToFileURL(join(target, "plugin/index.mjs")));
      await wrapper.default.setup({});
      const load = globalThis.__bcpPackageOptions;
      delete globalThis.__bcpPackageOptions;
      assert.deepEqual(await load(), {}); // No enabled flag, connection or scope.
      await fs.writeFile(options, '{"enabled":false}', { mode: 0o600 });
      assert.deepEqual(await load(), { enabled: false });
      await fs.chmod(options, 0o644);
      await assert.rejects(load(), /owner-private/);
      await fs.chmod(options, 0o600);
      await fs.link(options, join(root, "hardlink"));
      await assert.rejects(load(), /owner-private/);
      await fs.unlink(join(root, "hardlink"));
      await fs.rename(options, join(root, "real-options"));
      await fs.symlink(join(root, "real-options"), options);
      await assert.rejects(load());
      await assert.rejects(packageOpenChamber(join(root, "other"), host, options), /must not exist/);
      await assert.rejects(packageOpenChamber(join(root, "other"), host, join(root, "other/options")), /outside package/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
