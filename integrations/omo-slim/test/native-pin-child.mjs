#!/usr/bin/env node
// native-pin-child.mjs — bounded verification affordance for the native
// explicit-pin lane. NOT product code. Runs in-process setup instances of an
// OMO plugin bundle (patched candidate or pinned unpatched upstream) through
// the REAL v2 setup entry with a mock host ctx, and drives the registered
// agent.transform callback across MULTIPLE passes — the way a real v2 host
// re-runs both the config-agent effect and this plugin on every
// agent.reload(). Between passes the scenario may apply per-field
// system/mode writes onto the SAME registry entries (exactly what the host
// config-agent effect does via its per-field h.update upsert), so the
// two-pass clobber/retain behavior is observable.
//
// No host spawn, no LLM, no network, no production state: HOME/XDG are
// redirected by the parent, ctx is a minimal mock, storage/mcp/session are
// absent so background-job persistence and permission bridging stay
// process-local.
//
// Usage: node native-pin-child.mjs <bundlePath> <projectDir> <resultPath>
//                                  <scenarioJsonPath>
// Scenario JSON: { natives: {name: agentRecord}, passes: [ {config?: {name:
//                 {system?, mode?}}} | null, ... ] }
// Result JSON:   { passes: [{updates: [{name, value}], defaults: [...]}, ...] }
//                or { error } on failure.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [bundlePath, projectDir, resultPath, scenarioPath] = process.argv.slice(2);
if (!bundlePath || !projectDir || !resultPath || !scenarioPath) {
  console.error("usage: node native-pin-child.mjs <bundlePath> <projectDir> <resultPath> <scenarioJsonPath>");
  process.exit(2);
}

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function main() {
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  const mod = await import(pathToFileURL(bundlePath).href);
  const setupEntry = typeof mod.default?.setup === "function" ? mod.default.setup : undefined;
  if (!setupEntry) throw new Error("bundle exposes no v2 setup entry");
  const createInstance = async (id, seed) => {
    // Each instance owns its live registry; all instances share one module.
    const current = {};
    for (const [name, record] of Object.entries(seed ?? {})) current[name] = clone(record);
    let capturedCb;
    const draft = {
      list: () => Object.keys(current).map(id => ({ id })),
      get: name => (current[name] ? clone(current[name]) : undefined),
      update: (name, fn) => {
        const next = current[name] ? clone(current[name]) : {};
        fn(next);
        current[name] = next;
        return clone(next);
      },
      default: () => {},
    };
    const ctx = {
      app: {},
      location: { directory: id === "default" ? projectDir : path.join(projectDir, id) },
      agent: { transform: async cb => { capturedCb = cb; return { dispose() {} }; } },
      // No mcp/storage/session: no external persistence or permission bridge.
    };
    const dispose = await setupEntry(ctx);
    if (typeof capturedCb !== "function") throw new Error("setup did not register an agent transform callback");
    return { current, draft, capturedCb, dispose };
  };
  const instances = {};
  for (const [id, seed] of Object.entries(scenario.instances ?? { default: scenario.natives })) {
    instances[id] = await createInstance(id, seed);
  }
  const passes = [];
  for (const pass of scenario.passes ?? []) {
    const { current, draft, capturedCb } = instances[pass?.instance ?? "default"];
    // Host config-agent effect per-field upsert between transforms.
    for (const [name, fields] of Object.entries(pass?.config ?? {})) {
      current[name] = { ...(current[name] ?? {}), ...clone(fields) };
    }
    for (const [name, fields] of Object.entries(pass?.deleteFields ?? {})) {
      for (const field of fields) delete current[name][field];
    }
    const sink = [];
    const observingDraft = {
      ...draft,
      update: (name, fn) => {
        const value = draft.update(name, fn);
        sink.push({ name, value: clone(value) });
        return value;
      },
    };
    await capturedCb(observingDraft);
    passes.push({ updates: sink });
  }
  for (const { dispose } of Object.values(instances)) {
    if (typeof dispose === "function") { try { await dispose(); } catch {} }
  }
  fs.writeFileSync(resultPath, JSON.stringify({ passes }, null, 2));
}

main().then(
  () => process.exit(0),
  err => {
    fs.writeFileSync(resultPath, JSON.stringify({ error: String(err && err.stack || err) }, null, 2));
    process.exit(1);
  },
);
