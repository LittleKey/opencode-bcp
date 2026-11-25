import { test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, unlink } from "node:fs/promises"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
// @ts-ignore standalone operator CLI
import { install } from "../scripts/install-file-archive.mjs"

test("isolated local package registration and no-grants denial", async () => {
  const scratch = resolve(".opencode/work/install-tests")
  await mkdir(scratch, { recursive: true })
  const run = await mkdtemp(join(scratch, "run-"))
  // Installer deliberately rejects the repository's own discovery tree.
  // A sibling scratch root outside any configured project is required.
  const external = await mkdtemp("/var/tmp/bcp-install-test-")
  const project = join(external, "project")
  await mkdir(project, { mode: 0o700 })
  await mkdir(join(project, ".opencode/work"), { recursive: true })
  const target = join(external, "profile")
  const result = await install(["--target", target, "--project", project, "--port", "4096"])
  const config = JSON.parse(await readFile(join(target, "config/opencode/opencode.json"), "utf8"))
  expect(config.plugin).toEqual([pathToFileURL(join(target, "package")).href])
  expect(result.command).toContain("--server http://127.0.0.1:4096")
  expect(result.command).not.toContain("--standalone")
  expect(await readFile(join(target, "serve.txt"), "utf8")).toContain("serve --service --hostname 127.0.0.1 --port 4096")
  const manifest = JSON.parse(await readFile(join(target, "package/package.json"), "utf8"))
  const plugin = (await import(pathToFileURL(join(target, "package", manifest.exports)).href)).default
  let tool: any
  await plugin.setup({ tool: { transform: async (f: any) => f({ add: (t: any) => { tool = t } }) } })
  expect(tool.name).toBe("bcp_save")
  expect(JSON.parse((await tool.execute({ sessionId: "ses_test" }, {})).content).status).toBe("denied")
  const optionsPath = join(target, "options.json")
  // Capture the loader without invoking the adapter: setup must pass a lazy
  // loader, and every invocation must reopen and validate the current inode.
  const wrapper = await readFile(join(target, "package/index.mjs"), "utf8")
  const loaderModule = wrapper.replace('import plugin from "./file-archive.js";', "const plugin = { id: 'fixture', setup(ctx) { globalThis.__archiveLoader = ctx.options.loadOperatorOptions } };")
  const fixture = (await import("data:text/javascript;base64," + Buffer.from(loaderModule.replace('new URL("../options.json", import.meta.url)', JSON.stringify(optionsPath))).toString("base64"))).default
  await fixture.setup({})
  const load = (globalThis as any).__archiveLoader
  expect(await load()).toEqual({})
  await writeFile(optionsPath, '{"enabled":true}')
  expect(await load()).toEqual({ enabled: true })
  await chmod(optionsPath, 0o644)
  await expect(load()).rejects.toThrow("owner-private")
  await chmod(optionsPath, 0o600)
  await writeFile(optionsPath, " ".repeat(1024 * 1024 + 1))
  await expect(load()).rejects.toThrow("byte limit")
  await writeFile(optionsPath, "[]")
  await expect(load()).rejects.toThrow("object")
  await unlink(optionsPath)
  await symlink(join(target, "options.example.json"), optionsPath)
  await expect(load()).rejects.toThrow()
  delete (globalThis as any).__archiveLoader
  const host = spawnSync("sh", ["-c", result.command.replace(" --server http://127.0.0.1:4096", "") + " --standalone debug config"], { encoding: "utf8", timeout: 45000 })
  expect(host.status).toBe(0)
  const documents = JSON.parse(host.stdout)
  expect(documents.some((d: any) => d.path === join(target, "config/opencode/opencode.json") &&
    d.info?.plugins?.includes(config.plugin[0]))).toBe(true)
  await writeFile(join(run, "host-config.json"), host.stdout)
  await expect(install(["--target", target, "--project", project, "--port", "4096"])).rejects.toThrow("target already exists")
  const shared = join(external, "shared")
  await mkdir(shared)
  await chmod(shared, 0o777)
  const privateOptions = join(shared, "options.json")
  await writeFile(privateOptions, "{}", { mode: 0o600 })
  await expect(install(["--target", join(external, "unsafe"), "--project", project,
    "--port", "4096", "--options", privateOptions])).rejects.toThrow("untrusted options ancestor")
  const nestedProject = join(shared, "project")
  await mkdir(nestedProject, { mode: 0o700 })
  await expect(install(["--target", join(external, "unsafe"), "--project", nestedProject,
    "--port", "4096"])).rejects.toThrow("untrusted project ancestor")
  await writeFile(join(project, "opencode.json"), '{"plugin":["legacy-bcp"]}')
  await expect(install(["--target", join(external, "conflict"), "--project", project, "--port", "4096"])).rejects.toThrow("conflicting discovery")
  await writeFile(join(run, "evidence.json"), JSON.stringify({ external, target, config }))
  console.log(`install evidence: ${run}; isolated profile: ${target}`)
})
