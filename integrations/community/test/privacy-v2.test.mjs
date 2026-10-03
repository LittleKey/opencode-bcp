import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPrivacy, PATCHED_SESSION_SHA256, STOCK_SESSION_SHA256 } from "../src/privacy/builder.mjs";
import { DEPS, PLACEHOLDER_RE, collectStrings, withEnv, withTempDir } from "./helper.mjs";

const SECRET = "PROJECT-SECRET-TOKEN";
const EMAIL = "alice@example.com";
// deterministic synthetic PEM block (test fixture only — not a real key);
// shaped so the configured PEM regex actually fires on it
const PEM = [
  "-----BEGIN TEST PRIVATE KEY-----",
  "ZmFrZXBlbWJvZHlmYWtlcGVtYm9keWZha2VwZW1ib2R5ZmFrZXBlbWJvZHlmYWtl",
  "cGVtYm9keWZha2VwZW1ib2R5ZmFrZXBlbWJvZHlmYWtlcGVtYm9keWZha2VwZW0=",
  "-----END TEST PRIVATE KEY-----",
].join("\n");

const FIXTURE_CONFIG = {
  enabled: true,
  debug: false,
  session: { ttl: "1h" },
  patterns: {
    builtin: ["email", "uuid", "ipv4"],
    keywords: [{ value: SECRET, category: "token" }],
    regex: [
      {
        pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        flags: "",
        category: "pem",
      },
    ],
    exclude: [],
  },
};

async function buildPrivacyTo(tmp) {
  return buildPrivacy({
    vibeguardDir: DEPS.vibeguardDir,
    outDir: join(tmp, "privacy"),
    expectedVersion: "0.1.0",
    stockSessionSha256: STOCK_SESSION_SHA256,
    patchedSessionSha256: PATCHED_SESSION_SHA256,
    generatedAt: "2026-09-30T00:00:00.000Z",
  });
}

async function writeConfig(directory, config = FIXTURE_CONFIG) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "vibeguard.config.json"), JSON.stringify(config, null, 2), "utf8");
}

function makeCtx(directory) {
  const sessionRegistrations = [];
  const toolRegistrations = [];
  const disposeLog = [];
  const ctx = {
    directory,
    session: {
      hook: async (name, cb) => {
        sessionRegistrations.push({ name, cb });
        return { dispose: async () => disposeLog.push(name) };
      },
    },
    tool: {
      hook: async (name, cb) => {
        toolRegistrations.push({ name, cb });
        return { dispose: async () => disposeLog.push(`tool:${name}`) };
      },
    },
  };
  return { ctx, sessionRegistrations, toolRegistrations, disposeLog };
}

async function setupPlugin(tmp, { directoryName = "proj", config = FIXTURE_CONFIG } = {}) {
  const result = await buildPrivacyTo(tmp);
  const directory = join(tmp, directoryName);
  await writeConfig(directory, config);
  const mod = await import(pathToFileURL(join(result.outDir, "v2-plugin.mjs")).href);
  const { ctx, sessionRegistrations, toolRegistrations, disposeLog } = makeCtx(directory);
  const plugin = mod.createVibeGuardV2Plugin();
  assert.equal(plugin.id, "vibeguard-privacy-v2");
  const cleanup = await plugin.setup(ctx);
  return { cleanup, sessionRegistrations, toolRegistrations, disposeLog, outDir: result.outDir };
}

function hookFn(registrations, name) {
  const found = registrations.filter((r) => r.name === name);
  assert.ok(found.length === 1, `expected exactly one ${name} hook, got ${found.length}`);
  return found[0].cb;
}

// --- streaming fixtures (synthetic, deterministic) ---------------------------

/** One SSE data frame for a JSON payload. */
function frame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/** Response whose SSE body is delivered in explicit byte chunks. */
function chunkedSseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** data: payloads of an SSE wire dump, in order. */
function sseDataBlocks(text) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map((block) => block.slice(5).trim());
}

/** Accumulate OpenAI-style delta / complete-message contents of an SSE wire dump. */
function accumulatedChoices(text) {
  const acc = new Map();
  for (const block of sseDataBlocks(text)) {
    if (block === "[DONE]") continue;
    for (const choice of JSON.parse(block).choices ?? []) {
      const index = choice.index ?? 0;
      const delta = choice.delta?.content ?? choice.message?.content ?? choice.text ?? "";
      acc.set(index, (acc.get(index) ?? "") + delta);
    }
  }
  return acc;
}

/** Accumulate generic `delta` string fields of SSE-shaped WS frames. */
function wsAccumulated(frames) {
  let out = "";
  for (const frameText of frames) {
    for (const block of sseDataBlocks(frameText)) out += JSON.parse(block).delta ?? "";
  }
  return out;
}

/** Redact `text` in a fresh context hook for `sessionID`; returns its placeholders. */
async function seedPlaceholder(sessionRegistrations, sessionID, text) {
  const contextHook = hookFn(sessionRegistrations, "context");
  const seed = {
    sessionID,
    model: { providerID: "p", modelID: "m" },
    system: [],
    messages: [{ info: { id: "m1", role: "user", sessionID }, parts: [{ type: "text", text }] }],
  };
  await contextHook(seed);
  const placeholders = collectStrings(seed).join("\n").match(new RegExp(PLACEHOLDER_RE.source, "g"));
  assert.ok(placeholders?.length >= 1, `seeding ${sessionID} must produce placeholders`);
  return placeholders;
}

async function runSse(responseHook, sessionID, chunks) {
  const hookInput = {
    sessionID,
    request: {},
    response: chunkedSseResponse(chunks),
  };
  await responseHook(hookInput);
  return { input: hookInput, text: await hookInput.response.text() };
}

test("v2 plugin registers coverage hooks for model-facing surfaces and no raw-prompt handler", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations, cleanup, disposeLog } = await setupPlugin(tmp);
    const names = sessionRegistrations.map((r) => r.name).sort();
    assert.deepEqual(
      names,
      [
        "compaction",
        "context",
        "experimental.ws.handshake",
        "experimental.ws.receive",
        "generate",
        "http.response",
        "title",
      ].sort(),
    );
    // pre-admission raw user input is never mutated pre-storage: the plugin
    // must not register any session.prompt handler
    assert.ok(!names.includes("prompt"), "no session.prompt handler may be registered");
    assert.deepEqual(toolRegistrations.map((r) => r.name), ["execute.before"]);
    await cleanup();
    assert.equal(disposeLog.length, 8, "cleanup disposes every registration");
  }));

test("host without experimental.ws surfaces keeps all core coverage hooks", async () =>
  withTempDir(async (tmp) => {
    // documented degradation path: the WS surfaces are experimental in the SDK,
    // a host that rejects them must not break setup — the five core surfaces
    // (and tool execute.before) register unchanged, with no prompt hook
    const result = await buildPrivacyTo(tmp);
    const directory = join(tmp, "proj-ws-less");
    await writeConfig(directory);
    const mod = await import(pathToFileURL(join(result.outDir, "v2-plugin.mjs")).href);
    const sessionRegistrations = [];
    const ctx = {
      directory,
      session: {
        hook: async (name, cb) => {
          if (name.startsWith("experimental.ws.")) throw new Error(`unknown hook: ${name}`);
          sessionRegistrations.push({ name, cb });
          return { dispose: async () => {} };
        },
      },
      tool: { hook: async (name, cb) => ({ dispose: async () => {} }) },
    };
    const plugin = mod.createVibeGuardV2Plugin();
    const cleanup = await plugin.setup(ctx);
    const names = sessionRegistrations.map((r) => r.name).sort();
    assert.deepEqual(names, ["compaction", "context", "generate", "http.response", "title"].sort());
    assert.ok(!names.includes("prompt"), "no session.prompt handler may be registered");
    await cleanup();
  }));

test("experimental.ws.receive restores placeholders in inbound WS frames", async () =>
  withTempDir(async (tmp) => {
    // WS handshake/send/receive traffic never traverses the HTTP hooks
    // (official v2 docs), so inbound frames are the WS counterpart of
    // http.response restoration
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");
    const wsReceive = hookFn(sessionRegistrations, "experimental.ws.receive");

    const seed = {
      sessionID: "ses_ws",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [{ info: { id: "m1", role: "user", sessionID: "ses_ws" }, parts: [{ type: "text", text: `mail ${EMAIL}` }] }],
    };
    await contextHook(seed);
    const ph = collectStrings(seed).join("\n").match(PLACEHOLDER_RE)?.[0];
    assert.ok(ph, "context produced a placeholder");
    assert.ok(!collectStrings(seed).join("\n").includes(EMAIL), "email must not survive context");

    const frame = `data: {"delta":"contact ${ph} for details"}\n\n`;
    const input = { sessionID: "ses_ws", agent: "build", model: { providerID: "p", modelID: "m" }, kind: "chat", frame };
    await wsReceive(input);
    assert.equal(input.frame, `data: {"delta":"contact ${EMAIL} for details"}\n\n`, "inbound WS frame must restore placeholders");
    assert.ok(!PLACEHOLDER_RE.test(input.frame), "no placeholder may survive in the restored frame");
  }));

test("missing config is a no-op with no hook registrations", async () =>
  withTempDir(async (tmp) => {
    const result = await buildPrivacyTo(tmp);
    const directory = join(tmp, "off");
    mkdirSync(directory, { recursive: true }); // no config file -> loadConfig -> enabled=false
    // isolate HOME + explicit env override: the global fallback config
    // (~/.config/opencode/vibeguard.config.json) must not enable the plugin
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    await withEnv("OPENCODE_VIBEGUARD_CONFIG", undefined, async () =>
      withEnv("HOME", home, async () => {
        const mod = await import(pathToFileURL(join(result.outDir, "v2-plugin.mjs")).href);
        const { ctx, sessionRegistrations, toolRegistrations } = makeCtx(directory);
        const plugin = mod.createVibeGuardV2Plugin();
        const cleanup = await plugin.setup(ctx);
        assert.equal(sessionRegistrations.length, 0);
        assert.equal(toolRegistrations.length, 0);
        await cleanup?.();
      }),
    );
  }));

test("model-facing request hooks redact content while the raw prompt input passes through untouched", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");

    const input = {
      sessionID: "ses_a",
      model: { providerID: "p", modelID: "m" },
      system: [{ type: "text", text: `key ${SECRET}` }],
      messages: [
        { info: { id: "m1", role: "user", sessionID: "ses_a" }, parts: [{ type: "text", text: `mail ${EMAIL}` }] },
        {
          info: { id: "m2", role: "assistant", sessionID: "ses_a" },
          parts: [
            { type: "reasoning", text: `pem\n${PEM}` },
            { type: "text", text: `contact ${EMAIL} and ${SECRET}` },
            { type: "tool-call", id: "t1", name: "bash", input: { command: `echo ${SECRET}` } },
          ],
        },
      ],
      agent: "build",
    };
    await contextHook(input);

    const strings = collectStrings(input);
    assert.ok(!strings.some((s) => s.includes(EMAIL)), `email leaked: ${JSON.stringify(strings)}`);
    assert.ok(!strings.some((s) => s.includes(SECRET)), `keyword leaked: ${JSON.stringify(strings)}`);
    assert.ok(!strings.some((s) => s.includes("PRIVATE KEY")), "PEM leaked");
    const placeholders = strings.join("\n").match(new RegExp(PLACEHOLDER_RE.source, "g")) ?? [];
    assert.ok(placeholders.length >= 4, `expected placeholders, got ${placeholders}`);
    // tool-call inputs are structural; redaction walks them too
    // (categories are sanitized to uppercase)
    assert.ok(input.messages[1].parts[2].input.command.includes("__VG_TOKEN_"));
    // PEM collapsed to a single placeholder covering the full block
    assert.equal(input.messages[1].parts[0].text.match(new RegExp(PLACEHOLDER_RE.source, "g")).length, 1);

    // same session, second context call: same secret -> same placeholder token
    // (placeholder reuse is a property of the per-session mapping, proven on
    // the model-facing surface itself)
    const again = {
      sessionID: "ses_a",
      model: input.model,
      system: [],
      messages: [
        { info: { id: "m4", role: "user", sessionID: "ses_a" }, parts: [{ type: "text", text: `again ${SECRET}` }] },
      ],
    };
    await contextHook(again);
    const phFromContext = input.messages[1].parts[2].input.command.match(PLACEHOLDER_RE)[0];
    assert.ok(again.messages[0].parts[0].text.includes(phFromContext), "same session+secret must reuse the placeholder");
    assert.ok(!again.messages[0].parts[0].text.includes(SECRET), "second context call must be redacted too");

    // the raw prompt hook receives NO mutating handler from this plugin: no
    // "prompt" registration exists, and no registered session handler rewrites
    // a prompt-shaped input (bare string or Prompt struct) in any way
    assert.ok(!sessionRegistrations.some((r) => r.name === "prompt"), "no prompt registration");
    const untouchedStruct = { sessionID: "ses_a", prompt: { text: `raw ${SECRET} ${EMAIL}` } };
    const untouchedString = { sessionID: "ses_a", prompt: `raw ${SECRET} ${EMAIL}` };
    for (const { name, cb } of sessionRegistrations) {
      await cb(untouchedStruct);
      await cb(untouchedString);
    }
    assert.equal(untouchedStruct.prompt.text, `raw ${SECRET} ${EMAIL}`, "prompt struct must stay untouched");
    assert.equal(untouchedString.prompt, `raw ${SECRET} ${EMAIL}`, "bare string prompt must stay untouched");

    // different session: isolation (different placeholder for the same secret)
    const otherContext = {
      sessionID: "ses_b",
      model: input.model,
      system: [],
      messages: [
        { info: { id: "m3", role: "user", sessionID: "ses_b" }, parts: [{ type: "text", text: `mail ${EMAIL}` }] },
      ],
    };
    await contextHook(otherContext);
    const phA = input.messages[0].parts[0].text.match(PLACEHOLDER_RE)[0];
    const phB = otherContext.messages[0].parts[0].text.match(PLACEHOLDER_RE)[0];
    assert.notEqual(phA, phB, "placeholders must be session-isolated");
  }));

test("generate/title/compaction hooks redact their inputs", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    for (const name of ["generate", "title", "compaction"]) {
      const hook = hookFn(sessionRegistrations, name);
      const input = {
        sessionID: "ses_t",
        model: { providerID: "p", modelID: "m" },
        system: [],
        messages: [
          {
            info: { id: "m9", role: "user", sessionID: "ses_t" },
            parts: [{ type: "text", text: `secret ${SECRET} mail ${EMAIL}` }],
          },
        ],
      };
      await hook(input);
      const strings = collectStrings(input);
      assert.ok(!strings.some((s) => s.includes(SECRET)), `${name} leaked keyword`);
      assert.ok(!strings.some((s) => s.includes(EMAIL)), `${name} leaked email`);
      assert.ok(strings.join("\n").match(PLACEHOLDER_RE), `${name} produced placeholder`);
    }
  }));

test("tool execute.before restores placeholders back to secrets", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");
    const toolHook = hookFn(toolRegistrations, "execute.before");

    // seed two placeholders in the same session (keyword + email)
    const seed = {
      sessionID: "ses_tool",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: "ses_tool" },
          parts: [{ type: "text", text: `${SECRET} ${EMAIL}` }],
        },
      ],
    };
    await contextHook(seed);
    const [phToken, phEmail] = collectStrings(seed).join("\n").match(new RegExp(PLACEHOLDER_RE.source, "g"));
    assert.ok(phToken && phEmail);

    const toolInput = {
      tool: "bash",
      sessionID: "ses_tool",
      input: { command: `run ${phToken}`, nested: { list: [`x ${phEmail}`] } },
    };
    await toolHook(toolInput);
    assert.ok(toolInput.input.command.includes(SECRET), "keyword placeholder must be restored");
    assert.ok(toolInput.input.nested.list[0].includes(EMAIL), "email placeholder must be restored");
    assert.ok(!collectStrings(toolInput).join("\n").match(PLACEHOLDER_RE), "no placeholder survives");
  }));

test("other sessions cannot restore a placeholder from a different session", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");
    const toolHook = hookFn(toolRegistrations, "execute.before");

    const seed = {
      sessionID: "ses_owner",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: "ses_owner" },
          parts: [{ type: "text", text: SECRET }],
        },
      ],
    };
    await contextHook(seed);
    const ph = collectStrings(seed).join("\n").match(PLACEHOLDER_RE)[0];

    const foreign = { tool: "bash", sessionID: "ses_attacker", input: { command: `echo ${ph}` } };
    await toolHook(foreign);
    assert.ok(foreign.input.command.includes(ph), "placeholder must stay inert in a foreign session");
    assert.ok(!foreign.input.command.includes(SECRET), "secret must never leak across sessions");
  }));

test("http.response restores final output payloads (JSON)", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");
    const responseHook = hookFn(sessionRegistrations, "http.response");

    const seed = {
      sessionID: "ses_out",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: "ses_out" },
          parts: [{ type: "text", text: `about ${EMAIL}` }],
        },
      ],
    };
    await contextHook(seed);
    const ph = collectStrings(seed).join("\n").match(PLACEHOLDER_RE)[0];
    assert.ok(ph, "email must be redacted in the request");

    const payload = JSON.stringify({
      model: "m",
      choices: [{ message: { role: "assistant", content: `meets ${ph} in person` } }],
    });
    const response = new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(payload.length) },
    });
    const hookInput = { sessionID: "ses_out", request: new Request("https://api.example.invalid/v1/messages"), response };
    await responseHook(hookInput);
    const text = await hookInput.response.text();
    assert.ok(text.includes(EMAIL), `email must be restored to the model output: ${text}`);
    assert.ok(!text.includes(ph));
    assert.equal(hookInput.response.status, 200);
  }));

test("http.response restores SSE frames and passes non-JSON frames through", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");
    const responseHook = hookFn(sessionRegistrations, "http.response");

    const seed = {
      sessionID: "ses_sse",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: "ses_sse" },
          parts: [{ type: "text", text: `call ${SECRET}` }],
        },
      ],
    };
    await contextHook(seed);
    const ph = collectStrings(seed).join("\n").match(PLACEHOLDER_RE)[0];

    const sseBody = [
      `event: message\ndata: {"delta":"uses ${ph} today"}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n");
    const response = new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    const hookInput = { sessionID: "ses_sse", request: {}, response };
    await responseHook(hookInput);
    // the hook replaces hookInput.response with the restored stream; the
    // original response body has been consumed by the transform
    const out = await hookInput.response.text();
    assert.ok(out.includes(SECRET), `sse frame must be restored: ${out}`);
    assert.ok(out.includes("[DONE]"), "non-JSON frames pass through");
    assert.ok(!out.includes(ph));
  }));

test("http.response leaves unrelated content types untouched", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const binary = new Uint8Array([1, 2, 3, 4]);
    const response = new Response(binary, { headers: { "content-type": "application/octet-stream" } });
    await responseHook({ sessionID: "ses_bin", request: {}, response });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), binary);
  }));

// ---------------------------------------------------------------------------
// provider-wire tool-argument retention: JSON-encoded model tool input
// (arguments/partial_json, Responses function_call_arguments) is JSON SOURCE
// TEXT the host parses after the response — a mapped value containing a quote
// or backslash spliced into that source corrupts the tool call BEFORE the
// host parses it. Placeholders must be retained verbatim until the existing
// tool.execute.before restores the host-parsed arguments. Ordinary textual
// final/reasoning restoration is unaffected.
// ---------------------------------------------------------------------------

// deterministic synthetic secret deliberately containing a double quote and
// a backslash — exactly the mapped-value shape that corrupts wire JSON
const WIRE_SECRET = 'WIRE-"SECRET"-\\PATH';
const WIRE_CONFIG = {
  enabled: true,
  session: { ttl: "1h" },
  patterns: {
    builtin: [],
    keywords: [{ value: WIRE_SECRET, category: "wire" }],
    regex: [],
    exclude: [],
  },
};

/** Concatenated OpenAI chat tool-call `function.arguments` deltas of an SSE dump. */
function accumulatedToolArgs(text, { choice = 0, call = 0 } = {}) {
  let out = "";
  for (const block of sseDataBlocks(text)) {
    if (block === "[DONE]") continue;
    const evt = JSON.parse(block);
    out += evt.choices?.[choice]?.delta?.tool_calls?.[call]?.function?.arguments ?? "";
  }
  return out;
}

test("OpenAI chat tool-call arguments keep placeholders on the wire; text deltas still restore", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp, { config: WIRE_CONFIG });
    const contextHook = hookFn(sessionRegistrations, "context");
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const toolHook = hookFn(toolRegistrations, "execute.before");

    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_wire_oai", `run ${WIRE_SECRET}`);
    const headPayload = {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: `{"command": "echo ${ph.slice(0, 12)}` } }] } }],
    };
    const tailPayload = {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `${ph.slice(12)}"}` } }] } }],
    };
    const { text } = await runSse(responseHook, "ses_wire_oai", [
      frame(headPayload),
      frame(tailPayload),
      // textual final output in a sibling choice must still restore
      frame({ choices: [{ index: 1, delta: { content: `uses ${ph.slice(0, 7)}` } }] }),
      frame({ choices: [{ index: 1, delta: { content: `${ph.slice(7)} ok` } }] }),
      "data: [DONE]\n\n",
    ]);

    // tool-argument frames are byte-identical: serialized placeholders survive
    const blocks = sseDataBlocks(text);
    assert.equal(blocks[0], JSON.stringify(headPayload), "arguments head frame must stay byte-identical");
    assert.equal(blocks[1], JSON.stringify(tailPayload), "arguments tail frame must stay byte-identical");

    // what the host does: accumulate the arguments deltas, then parse
    const accumulated = accumulatedToolArgs(text);
    assert.equal(accumulated, `{"command": "echo ${ph}"}`);
    const parsed = JSON.parse(accumulated); // must not throw (the old behavior corrupted this)
    assert.equal(parsed.command, `echo ${ph}`, "parsed tool input must carry the inert placeholder");

    // textual restoration unaffected by the retention
    assert.equal(accumulatedChoices(text).get(1), `uses ${WIRE_SECRET} ok`, "sibling text deltas must still restore");
    assert.ok(!text.includes(WIRE_SECRET), "the secret must never appear on the wire");

    // the existing tool.execute.before restores the host-parsed arguments safely
    const toolInput = { tool: "bash", sessionID: "ses_wire_oai", input: parsed };
    await toolHook(toolInput);
    assert.equal(parsed.command, `echo ${WIRE_SECRET}`, "parsed arguments must restore via tool.execute.before");
  }));

test("Anthropic input_json_delta keeps placeholders; sibling text blocks still restore", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp, { config: WIRE_CONFIG });
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const toolHook = hookFn(toolRegistrations, "execute.before");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_wire_ant", `run ${WIRE_SECRET}`);

    const partialFrames = [
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{"command": "echo ${ph.slice(0, 12)}` } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `${ph.slice(12)}"}` } },
    ];
    const { text } = await runSse(responseHook, "ses_wire_ant", [
      frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} } }),
      frame(partialFrames[0]),
      frame(partialFrames[1]),
      frame({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: ph.slice(0, 9) } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `${ph.slice(9)} done` } }),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "content_block_stop", index: 1 }),
      frame({ type: "message_stop" }),
    ]);

    const blocks = sseDataBlocks(text);
    assert.equal(blocks[1], JSON.stringify(partialFrames[0]), "partial_json head frame must stay byte-identical");
    assert.equal(blocks[2], JSON.stringify(partialFrames[1]), "partial_json tail frame must stay byte-identical");
    const partialJson = partialFrames[0].delta.partial_json + partialFrames[1].delta.partial_json;
    assert.equal(partialJson, `{"command": "echo ${ph}"}`);
    const parsed = JSON.parse(partialJson); // must not throw
    assert.equal(parsed.command, `echo ${ph}`);

    const blocksText = new Map();
    for (const block of blocks) {
      const evt = JSON.parse(block);
      if (evt.type === "content_block_delta" && evt.delta.type === "text_delta") {
        blocksText.set(evt.index, (blocksText.get(evt.index) ?? "") + evt.delta.text);
      }
    }
    assert.equal(blocksText.get(1), `${WIRE_SECRET} done`, "sibling text block must still restore");
    assert.ok(!text.includes(WIRE_SECRET), "the secret must never appear on the wire");

    const toolInput = { tool: "bash", sessionID: "ses_wire_ant", input: parsed };
    await toolHook(toolInput);
    assert.equal(parsed.command, `echo ${WIRE_SECRET}`, "parsed arguments must restore via tool.execute.before");
  }));

test("Responses function_call_arguments.delta and atomic function_call keep arguments; output_text still restores", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp, { config: WIRE_CONFIG });
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const toolHook = hookFn(toolRegistrations, "execute.before");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_wire_res", `run ${WIRE_SECRET}`);

    const deltaFrames = [
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: `{"command": "echo ${ph.slice(0, 12)}` },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: `${ph.slice(12)}"}` },
    ];
    const atomicPayload = {
      type: "response.completed",
      response: {
        output: [
          { type: "function_call", id: "fc_1", name: "bash", arguments: `{"command": "echo ${ph}"` + `}` },
          { type: "message", id: "msg_1", content: [{ type: "output_text", text: `done ${ph}` }] },
        ],
      },
    };
    const { text } = await runSse(responseHook, "ses_wire_res", [
      frame(deltaFrames[0]),
      frame(deltaFrames[1]),
      frame({ type: "response.output_text.delta", item_id: "item_a", output_index: 1, content_index: 0, delta: `see ${ph}` }),
      frame(atomicPayload),
    ]);

    const blocks = sseDataBlocks(text);
    assert.equal(blocks[0], JSON.stringify(deltaFrames[0]), "function_call_arguments delta head must stay byte-identical");
    assert.equal(blocks[1], JSON.stringify(deltaFrames[1]), "function_call_arguments delta tail must stay byte-identical");
    const accumulated = deltaFrames[0].delta + deltaFrames[1].delta;
    assert.equal(accumulated, `{"command": "echo ${ph}"}`);
    const parsed = JSON.parse(accumulated); // must not throw
    assert.equal(parsed.command, `echo ${ph}`);

    assert.equal(JSON.parse(blocks[2]).delta, `see ${WIRE_SECRET}`, "output_text.delta must still restore");

    const completed = JSON.parse(blocks[3]);
    const fnCall = completed.response.output[0];
    assert.equal(fnCall.arguments, `{"command": "echo ${ph}"` + `}`, "atomic function_call arguments must keep the placeholder");
    assert.equal(JSON.parse(fnCall.arguments).command, `echo ${ph}`, "atomic arguments must stay parseable");
    assert.equal(completed.response.output[1].content[0].text, `done ${WIRE_SECRET}`, "atomic message text must still restore");
    assert.ok(!text.includes(WIRE_SECRET), "the secret must never appear on the wire");

    const toolInput = { tool: "bash", sessionID: "ses_wire_res", input: parsed };
    await toolHook(toolInput);
    assert.equal(parsed.command, `echo ${WIRE_SECRET}`, "parsed arguments must restore via tool.execute.before");
  }));

test("non-streaming JSON body: tool_calls[].function.arguments keep placeholders, message content restores", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp, { config: WIRE_CONFIG });
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const toolHook = hookFn(toolRegistrations, "execute.before");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_wire_json", `run ${WIRE_SECRET}`);

    const payload = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: `see ${ph}`,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: `{"command": "echo ${ph}"` + `}` } }],
          },
        },
      ],
    });
    const response = new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    const hookInput = { sessionID: "ses_wire_json", request: {}, response };
    await responseHook(hookInput);
    const text = await hookInput.response.text();
    const body = JSON.parse(text);

    assert.equal(body.choices[0].message.content, `see ${WIRE_SECRET}`, "message content must restore");
    const argsText = body.choices[0].message.tool_calls[0].function.arguments;
    assert.equal(argsText, `{"command": "echo ${ph}"` + `}`, "serialized arguments must keep the placeholder");
    const parsed = JSON.parse(argsText); // must not throw
    assert.equal(parsed.command, `echo ${ph}`);
    assert.ok(!text.includes(WIRE_SECRET), "the secret must never appear in the body");

    const toolInput = { tool: "bash", sessionID: "ses_wire_json", input: parsed };
    await toolHook(toolInput);
    assert.equal(parsed.command, `echo ${WIRE_SECRET}`, "parsed arguments must restore via tool.execute.before");
  }));

// ---------------------------------------------------------------------------
// root primitive propagation: redactDeep/restoreDeep mutate only
// objects/arrays — root string fields and JSON-string documents must get
// their replacement re-assigned instead of being silently discarded
// ---------------------------------------------------------------------------

test("root string request fields are redacted by re-assignment", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    for (const name of ["context", "compaction", "generate", "title"]) {
      const hook = hookFn(sessionRegistrations, name);
      const input = {
        sessionID: `ses_root_${name}`,
        model: { providerID: "p", modelID: "m" },
        // plain-string system prompt: a deep helper cannot mutate this in place
        system: `sys prompt with ${SECRET}`,
        messages: [{ info: { id: "m1", role: "user", sessionID: `ses_root_${name}` }, parts: [{ type: "text", text: `mail ${EMAIL}` }] }],
      };
      await hook(input);
      assert.equal(typeof input.system, "string");
      assert.ok(!input.system.includes(SECRET), `${name}: root string system must be redacted`);
      assert.ok(input.system.includes("__VG_TOKEN_"), `${name}: root string system must carry the placeholder`);
      assert.ok(!collectStrings(input).join("\n").includes(SECRET), `${name}: no keyword may leak`);
    }
  }));

test("root JSON-string response documents restore by re-assignment", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_root_str", SECRET);
    const responseHook = hookFn(sessionRegistrations, "http.response");

    // a JSON document whose root is a string: "\"echo __VG_...__\""
    const body = JSON.stringify(`echo ${ph}`);
    const response = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    const hookInput = { sessionID: "ses_root_str", request: {}, response };
    await responseHook(hookInput);
    const out = await hookInput.response.text();
    assert.equal(out, JSON.stringify(`echo ${SECRET}`), `root JSON string must restore: ${out}`);
  }));

test("tool execute.before restores root string tool inputs", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp);
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_root_tool", SECRET);
    const toolHook = hookFn(toolRegistrations, "execute.before");

    const toolInput = { tool: "custom", sessionID: "ses_root_tool", input: `echo ${ph}` };
    await toolHook(toolInput);
    assert.equal(toolInput.input, `echo ${SECRET}`, "root string tool input must restore by re-assignment");
  }));


// ---------------------------------------------------------------------------
// bounded streaming restoration across provider semantic delta events:
// split placeholders at every offset, interleaved choices/output items,
// adjacent placeholders, unknown/incomplete literals, completion,
// cancellation, two-session isolation, WS receive surface
// ---------------------------------------------------------------------------

test("placeholders split across SSE delta events restore at every offset", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_split_all", SECRET);
    assert.ok(ph.length > 2, `placeholder must be splittable, got ${ph}`);

    for (let offset = 1; offset < ph.length; offset++) {
      const { text } = await runSse(responseHook, "ses_split_all", [
        frame({ choices: [{ index: 0, delta: { content: `uses ${ph.slice(0, offset)}` } }] }),
        frame({ choices: [{ index: 0, delta: { content: `${ph.slice(offset)} today` } }] }),
        "data: [DONE]\n\n",
      ]);
      const contents = accumulatedChoices(text).get(0);
      assert.equal(contents, `uses ${SECRET} today`, `split offset ${offset} must reassemble, got ${JSON.stringify(contents)}`);
      assert.ok(!text.includes("__VG_"), `split offset ${offset}: no placeholder fragment may survive`);
    }
  }));

test("interleaved SSE choices restore independently at different split offsets", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [phEmail, phToken] = await seedPlaceholder(
      sessionRegistrations,
      "ses_interleave",
      `${EMAIL} and ${SECRET}`,
    );

    const { text } = await runSse(responseHook, "ses_interleave", [
      frame({ choices: [{ index: 0, delta: { content: phEmail.slice(0, 8) } }] }),
      frame({ choices: [{ index: 1, delta: { content: phToken.slice(0, 12) } }] }),
      frame({ choices: [{ index: 0, delta: { content: `${phEmail.slice(8)} ok` } }] }),
      frame({ choices: [{ index: 1, delta: { content: `${phToken.slice(12)} go` } }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: null }] }),
      frame({ choices: [{ index: 1, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const acc = accumulatedChoices(text);
    assert.equal(acc.get(0), `${EMAIL} ok`, "choice 0 must restore the email");
    assert.equal(acc.get(1), `${SECRET} go`, "choice 1 must restore the keyword");
    assert.ok(!text.includes("__VG_"), "no placeholder fragment may survive either choice");
  }));

test("output-item delta events (Anthropic / Responses shapes) restore per item", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [phEmail, phToken] = await seedPlaceholder(
      sessionRegistrations,
      "ses_items",
      `${EMAIL} and ${SECRET}`,
    );

    // Anthropic-style content_block_delta, interleaved block indexes
    const anthropic = await runSse(responseHook, "ses_items", [
      frame({ type: "content_block_start", index: 0, content: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: phEmail.slice(0, 6) } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: phToken.slice(0, 9) } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${phEmail.slice(6)}!` } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `${phToken.slice(9)}?` } }),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      frame({ type: "message_stop" }),
    ]);
    const blocks = new Map();
    for (const block of sseDataBlocks(anthropic.text)) {
      const parsed = JSON.parse(block);
      if (parsed.type === "content_block_delta") {
        blocks.set(parsed.index, (blocks.get(parsed.index) ?? "") + parsed.delta.text);
      }
    }
    assert.equal(blocks.get(0), `${EMAIL}!`, "block 0 must restore the email");
    assert.equal(blocks.get(1), `${SECRET}?`, "block 1 must restore the keyword");
    assert.ok(anthropic.text.includes('data: {"type":"message_stop"}'), "message_stop passes through unchanged");
    assert.ok(!anthropic.text.includes("__VG_"), "no placeholder fragment may survive");

    // Responses-style output_text.delta, keyed by item_id/output_index/content_index
    const responses = await runSse(responseHook, "ses_items", [
      frame({ type: "response.output_text.delta", item_id: "item_a", output_index: 0, content_index: 0, delta: phEmail.slice(0, 5) }),
      frame({ type: "response.output_text.delta", item_id: "item_b", output_index: 1, content_index: 0, delta: phToken.slice(0, 5) }),
      frame({ type: "response.output_text.delta", item_id: "item_a", output_index: 0, content_index: 0, delta: `${phEmail.slice(5)} a` }),
      frame({ type: "response.output_text.delta", item_id: "item_b", output_index: 1, content_index: 0, delta: `${phToken.slice(5)} b` }),
      // completion echo: atomic frame, full in-frame restoration
      frame({
        type: "response.completed",
        response: { output: [{ id: "item_a", content: [{ type: "output_text", text: `done ${phEmail}` }] }] },
      }),
    ]);
    const items = new Map();
    let completedText = "";
    for (const block of sseDataBlocks(responses.text)) {
      const parsed = JSON.parse(block);
      if (parsed.type === "response.output_text.delta") {
        const key = `${parsed.item_id}:${parsed.output_index}:${parsed.content_index}`;
        items.set(key, (items.get(key) ?? "") + parsed.delta);
      }
      if (parsed.type === "response.completed") {
        completedText = parsed.response.output[0].content[0].text;
      }
    }
    assert.equal(items.get("item_a:0:0"), `${EMAIL} a`, "item_a delta stream must restore");
    assert.equal(items.get("item_b:1:0"), `${SECRET} b`, "item_b delta stream must restore");
    assert.equal(completedText, `done ${EMAIL}`, "completion echo must restore fully in-frame");
    assert.ok(!responses.text.includes("__VG_"), "no placeholder fragment may survive");
  }));

test("adjacent placeholders split across frames restore as the exact concatenation", async () =>
  withTempDir(async (tmp) => {
    const ALPHA = "ALPHA-KEY-ONE";
    const BETA = "BETA-KEY-TWO";
    const config = {
      enabled: true,
      session: { ttl: "1h" },
      patterns: {
        builtin: [],
        keywords: [
          { value: ALPHA, category: "alpha" },
          { value: BETA, category: "beta" },
        ],
        regex: [],
        exclude: [],
      },
    };
    const { sessionRegistrations } = await setupPlugin(tmp, { config });
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [phAlpha, phBeta] = await seedPlaceholder(sessionRegistrations, "ses_adj_stream", `${ALPHA}${BETA}`);

    const { text } = await runSse(responseHook, "ses_adj_stream", [
      frame({ choices: [{ index: 0, delta: { content: `x ${phAlpha.slice(0, 10)}` } }] }),
      frame({ choices: [{ index: 0, delta: { content: `${phAlpha.slice(10)}${phBeta.slice(0, 7)}` } }] }),
      frame({ choices: [{ index: 0, delta: { content: `${phBeta.slice(7)} y` } }] }),
      "data: [DONE]\n\n",
    ]);
    assert.equal(accumulatedChoices(text).get(0), `x ${ALPHA}${BETA} y`, "adjacent placeholders must restore exactly");
    assert.ok(!text.includes("__VG_"), "no placeholder fragment may survive");
  }));

test("unknown placeholder-shaped literals pass through unrestored, complete or split", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    // a real mapping exists, but the unknown literal matches no key prefix
    await seedPlaceholder(sessionRegistrations, "ses_unknown", SECRET);
    const UNKNOWN = "__VG_NOTREAL_9abcdef01234__";

    const { text } = await runSse(responseHook, "ses_unknown", [
      frame({ choices: [{ index: 0, delta: { content: `see ${UNKNOWN.slice(0, 9)}` } }] }),
      frame({ choices: [{ index: 0, delta: { content: `${UNKNOWN.slice(9)} end` } }] }),
      frame({ choices: [{ index: 0, delta: { content: ` full ${UNKNOWN}` } }] }),
    ]);
    const blocks = sseDataBlocks(text);
    // frames 1-2 cannot be placeholder prefixes -> byte-identical
    assert.deepEqual(
      blocks.slice(0, 2),
      [
        '{"choices":[{"index":0,"delta":{"content":"see __VG_NOTR"}}]}',
        '{"choices":[{"index":0,"delta":{"content":"EAL_9abcdef01234__ end"}}]}',
      ],
      "frames that cannot start a mapping key must stay byte-identical",
    );
    // frame 3 ends with "__", which may always grow into a placeholder start;
    // the held "__" is re-emitted as a provider-shaped tail carrier DATA
    // event at stream end (before the held [DONE]) — never a comment, never
    // dropped — so the decoded consumer text is the exact unknown literal
    assert.equal(JSON.parse(blocks[2]).choices[0].delta.content, " full __VG_NOTREAL_9abcdef01234");
    assert.deepEqual(
      JSON.parse(blocks[3]),
      { choices: [{ index: 0, delta: { content: "__" } }] },
      "held tail must ride a delta data carrier, not a comment",
    );
    assert.ok(!text.includes(":vibeguard-tail"), "SSE comments are not preservation; none may be emitted");
    assert.equal(
      accumulatedChoices(text).get(0),
      "see __VG_NOTREAL_9abcdef01234__ end full __VG_NOTREAL_9abcdef01234__",
      "decoded consumer text must equal the original model output",
    );
    assert.ok(!text.includes(SECRET), "unknown literal must never resolve to a secret");
  }));

test("incomplete real-prefix literal at stream end is flushed byte-exact into decoded text", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_tail", SECRET);
    const fragment = ph.slice(0, 13); // strict prefix of the real key, never completed

    const { text } = await runSse(responseHook, "ses_tail", [
      frame({ choices: [{ index: 0, delta: { content: `end ${fragment}` } }] }),
      "data: [DONE]\n\n",
    ]);
    // the fragment rides a provider-shaped carrier data event emitted BEFORE
    // the held [DONE], so consumers that stop at [DONE] still see it
    const blocks = sseDataBlocks(text);
    assert.equal(accumulatedChoices(text).get(0), `end ${fragment}`, "decoded text must include the exact fragment");
    assert.deepEqual(
      JSON.parse(blocks[blocks.length - 2]),
      { choices: [{ index: 0, delta: { content: fragment } }] },
      "carrier data event carries the exact fragment",
    );
    assert.ok(text.endsWith("data: [DONE]\n\n"), `[DONE] must stay the final event, got ${JSON.stringify(text.slice(-30))}`);
    assert.ok(!text.includes(":vibeguard-tail"), "no comment carriers");
    assert.ok(!text.includes(SECRET), "incomplete literal must never resolve to a secret");
  }));

test("finish events stay byte-identical and cancellation releases stream state", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_finish", SECRET);

    // finish_reason-only frame and [DONE]: no text, no change -> byte-identical
    const finishFrame = frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    const { text } = await runSse(responseHook, "ses_finish", [finishFrame, "data: [DONE]\n\n"]);
    assert.deepEqual(sseDataBlocks(text), ['{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', "[DONE]"]);

    // non-streaming complete response relayed as SSE: atomic full restoration
    const complete = await runSse(responseHook, "ses_finish", [
      frame({
        choices: [{ index: 0, message: { role: "assistant", content: `fixed ${ph}` }, finish_reason: "stop" }],
      }),
    ]);
    assert.equal(accumulatedChoices(complete.text).get(0), `fixed ${SECRET}`, "complete frames restore fully in-frame");
    assert.ok(!complete.text.includes("__VG_"), "no placeholder may survive a complete frame");

    // cancellation: reader.cancel() mid-stream must not throw and must not
    // poison a later response of the same session
    const [phCancel] = await seedPlaceholder(sessionRegistrations, "ses_cancel", EMAIL);
    const cancelled = {
      sessionID: "ses_cancel",
      request: {},
      response: chunkedSseResponse([
        frame({ choices: [{ index: 0, delta: { content: phCancel.slice(0, 9) } }] }),
      ]),
    };
    await responseHook(cancelled);
    const reader = cancelled.response.body.getReader();
    await reader.read();
    await reader.cancel(); // restorer state released, fragment never emitted

    const after = await runSse(responseHook, "ses_cancel", [
      frame({ choices: [{ index: 0, delta: { content: `fresh ${phCancel}` } }] }),
      "data: [DONE]\n\n",
    ]);
    assert.equal(accumulatedChoices(after.text).get(0), `fresh ${EMAIL}`, "next response restores normally after cancellation");
    assert.ok(!after.text.includes("__VG_"), "no stale fragment may leak into the next response");
  }));

test("two concurrent SSE sessions restore only their own placeholders", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [phA] = await seedPlaceholder(sessionRegistrations, "ses_iso_a", EMAIL);
    const [phB] = await seedPlaceholder(sessionRegistrations, "ses_iso_b", SECRET);

    // each response carries its own placeholder split in two, plus the other
    // session's placeholder as a foreign literal that must stay inert
    const foreign = { a: { sid: "ses_iso_a", own: phA, foreign: phB, secret: EMAIL }, b: { sid: "ses_iso_b", own: phB, foreign: phA, secret: SECRET } };
    for (const side of [foreign.a, foreign.b]) {
      const { text } = await runSse(responseHook, side.sid, [
        frame({ choices: [{ index: 0, delta: { content: `${side.foreign} then ${side.own.slice(0, 7)}` } }] }),
        frame({ choices: [{ index: 0, delta: { content: `${side.own.slice(7)} done` } }] }),
        "data: [DONE]\n\n",
      ]);
      const acc = accumulatedChoices(text).get(0);
      assert.ok(acc.includes(side.secret), `${side.sid} must restore its own placeholder`);
      assert.ok(acc.includes(side.foreign), `${side.sid} must keep the foreign placeholder inert`);
      assert.ok(!acc.includes(side.foreign === phA ? EMAIL : SECRET), `${side.sid} must never restore the foreign placeholder`);
    }
  }));

// ---------------------------------------------------------------------------
// owner negative-counterexample regressions (dual-host-major-20260930):
// ordinary/unknown/incomplete tails, property & array order identity,
// CRLF line endings, incremental buffer bound, SDK model.id scope key,
// loadable default entries
// ---------------------------------------------------------------------------

test("ordinary trailing underscore survives to decoded consumer text", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    await seedPlaceholder(sessionRegistrations, "ses_ordinary", SECRET);

    const { text } = await runSse(responseHook, "ses_ordinary", [
      frame({ choices: [{ index: 0, delta: { content: "_emphasis_" } }] }),
      "data: [DONE]\n\n",
    ]);
    // a lone trailing "_" is a potential placeholder prefix, but it must
    // reach the consumer verbatim via a carrier data event
    assert.equal(accumulatedChoices(text).get(0), "_emphasis_", "decoded text must be exact");
    const blocks = sseDataBlocks(text);
    assert.deepEqual(
      JSON.parse(blocks[blocks.length - 2]),
      { choices: [{ index: 0, delta: { content: "_" } }] },
      "held underscore rides a delta data carrier",
    );
    assert.ok(!text.includes(":vibeguard-tail"), "no comment carriers");
  }));

test("JSON property order never affects stream identity", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_order", SECRET);

    // identical split, but the first event lists delta BEFORE index and the
    // second lists index BEFORE delta: both must key the same stream
    const { text } = await runSse(responseHook, "ses_order", [
      frame({ choices: [{ delta: { content: ph.slice(0, 10) }, index: 0 }] }),
      frame({ choices: [{ index: 0, delta: { content: ph.slice(10) } }] }),
      "data: [DONE]\n\n",
    ]);
    assert.equal(accumulatedChoices(text).get(0), SECRET, "property order must not split the stream");
    assert.ok(!text.includes("__VG_"), "no placeholder fragment may survive");
  }));

test("physical array position never affects stream identity", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [phEmail, phToken] = await seedPlaceholder(sessionRegistrations, "ses_position", `${EMAIL} and ${SECRET}`);

    // choice 0 / choice 1 swap array positions between frames; identity must
    // follow the `index` VALUE, not the position
    const { text } = await runSse(responseHook, "ses_position", [
      frame({ choices: [{ index: 0, delta: { content: phEmail.slice(0, 6) } }, { index: 1, delta: { content: phToken.slice(0, 6) } }] }),
      frame({ choices: [{ index: 1, delta: { content: phToken.slice(6) } }, { index: 0, delta: { content: phEmail.slice(6) } }] }),
      "data: [DONE]\n\n",
    ]);
    const acc = accumulatedChoices(text);
    assert.equal(acc.get(0), EMAIL, "choice index 0 must restore the email");
    assert.equal(acc.get(1), SECRET, "choice index 1 must restore the keyword");
    assert.ok(!text.includes("__VG_"), "no placeholder fragment may survive");
  }));

test("CRLF and mixed SSE line endings parse and restore", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_crlf", SECRET);

    const encoder = new TextEncoder();
    const wire = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ph.slice(0, 10) } }] })}\r\n\r\n`,
      `event: message\r\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ph.slice(10) } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: [DONE]\r\n\r\n`,
    ].join("");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          // deliver in two uneven chunks so a CRLF terminator itself is split
          const bytes = encoder.encode(wire);
          controller.enqueue(bytes.slice(0, 61));
          controller.enqueue(bytes.slice(61));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const hookInput = { sessionID: "ses_crlf", request: {}, response };
    await responseHook(hookInput);
    const text = await hookInput.response.text();
    const decoded = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .filter((t) => t !== "[DONE]")
      .map((t) => JSON.parse(t));
    const visible = decoded.flatMap((e) => e.choices ?? []).map((c) => c.delta?.content ?? "").join("");
    assert.equal(visible, SECRET, "CRLF-framed split placeholder must reassemble");
    assert.ok(!text.includes("__VG_"), "no placeholder fragment may survive");
  }));

test("oversized unterminated events pass through immediately (incremental bound)", async () =>
  withTempDir(async (tmp) => {
    const { outDir } = await setupPlugin(tmp);
    const { OutputStreamRestorer, createSseRestoreTransform } = await import(
      pathToFileURL(join(outDir, "stream-restore.mjs")).href
    );
    const restorer = new OutputStreamRestorer({
      prefix: "__VG_",
      forward: new Map([["__VG_SYN_0123456789ab__", "PROJECT-SYNTHETIC-TOKEN"]]),
      lookup(key) {
        return this.forward.get(key);
      },
    });
    // bound sits BETWEEN the two event sizes: the oversized unterminated
    // event (206 chars) must cross it, the good frame (~116 chars) must not
    const transform = createSseRestoreTransform(restorer, { maxFrameBytes: 150 });
    const oversized = `data: ${"x".repeat(200)}`; // no terminator, over the bound
    const readable = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(oversized));
        controller.enqueue(encoder.encode(` still-open\n\n`));
        controller.enqueue(encoder.encode(`data: {"choices":[{"index":0,"delta":{"content":"__VG_SYN_0123456789ab__"}},{"index":1,"delta":{"content":"done"}}]}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const text = await new Response(readable.pipeThrough(transform)).text();
    // the oversized bytes are NOT held waiting for a delimiter: they appear
    // verbatim (unrestored passthrough), and the next complete event still
    // restores normally
    assert.ok(text.includes(oversized), `oversized unterminated event must pass through immediately, got ${JSON.stringify(text.slice(0, 140))}`);
    assert.ok(text.includes("PROJECT-SYNTHETIC-TOKEN"), "restoration resumes after the oversized event");
    assert.ok(!text.includes("__VG_"), "no placeholder may survive in restored frames");
  }));

test("ws scope key uses the pinned SDK Model.Ref.id for isolation", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const wsReceive = hookFn(sessionRegistrations, "experimental.ws.receive");
    const [phA] = await seedPlaceholder(sessionRegistrations, "ses_modelid", EMAIL);
    const [phB] = await seedPlaceholder(sessionRegistrations, "ses_modelid", SECRET);

    // same sessionID/agent/kind, models distinguished ONLY by Model.Ref.id
    // (no modelID key at all — the pinned SDK field)
    const wsInput = (id, delta) => ({
      sessionID: "ses_modelid",
      agent: "build",
      model: { id, providerID: "p" },
      kind: "chat",
      frame: frame({ delta }),
    });
    const m1a = wsInput("model-one", phA.slice(0, 5));
    const m2a = wsInput("model-two", phB.slice(0, 5));
    const m1b = wsInput("model-one", `${phA.slice(5)} ok`);
    const m2b = wsInput("model-two", `${phB.slice(5)} go`);
    for (const input of [m1a, m2a, m1b, m2b]) await wsReceive(input);

    assert.equal(wsAccumulated([m1a.frame, m1b.frame]), `${EMAIL} ok`, "model-one scope restores only its own placeholder");
    assert.equal(wsAccumulated([m2a.frame, m2b.frame]), `${SECRET} go`, "model-two scope restores only its own placeholder");
    for (const input of [m1a, m1b]) assert.ok(!input.frame.includes(SECRET), "model-one must never emit model-two's secret");
    for (const input of [m2a, m2b]) assert.ok(!input.frame.includes(EMAIL), "model-two must never emit model-one's secret");
  }));

test("emitted package entries are loadable with the documented defaults", async () =>
  withTempDir(async (tmp) => {
    const { outDir } = await setupPlugin(tmp);
    const v1 = await import(pathToFileURL(join(outDir, "index.js")).href);
    assert.equal(typeof v1.default, "function", "v1 entry needs a default export factory");
    assert.equal(typeof v1.VibeGuardPrivacy, "function", "v1 entry re-exports the pinned engine factory");
    const v2 = await import(pathToFileURL(join(outDir, "v2-plugin.mjs")).href);
    assert.equal(typeof v2.default?.setup, "function", "v2 entry needs a default {id, setup}");
    assert.equal(v2.default.id, "vibeguard-privacy-v2");
    assert.equal(typeof v2.createVibeGuardV2Plugin, "function", "explicit factory stays exported");
  }));

test("tool execute.before and streamed final output restore in the same session", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp);
    const toolHook = hookFn(toolRegistrations, "execute.before");
    const responseHook = hookFn(sessionRegistrations, "http.response");
    const [phToken, phEmail] = await seedPlaceholder(sessionRegistrations, "ses_both", `${SECRET} ${EMAIL}`);

    const toolInput = { tool: "bash", sessionID: "ses_both", input: { command: `run ${phToken}` } };
    await toolHook(toolInput);
    assert.ok(toolInput.input.command.includes(SECRET), "tool input must restore");

    const { text } = await runSse(responseHook, "ses_both", [
      frame({ choices: [{ index: 0, delta: { content: `mail ${phEmail.slice(0, 11)}` } }] }),
      frame({ choices: [{ index: 0, delta: { content: phEmail.slice(11) } }] }),
      "data: [DONE]\n\n",
    ]);
    assert.equal(accumulatedChoices(text).get(0), `mail ${EMAIL}`, "streamed output must restore in the same session");
  }));

test("experimental.ws.receive reassembles placeholders split across frames", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const wsReceive = hookFn(sessionRegistrations, "experimental.ws.receive");
    const [phEmail] = await seedPlaceholder(sessionRegistrations, "ses_ws2", EMAIL);

    const first = { sessionID: "ses_ws2", agent: "build", model: { providerID: "p", modelID: "m" }, kind: "chat", frame: `data: {"delta":"contact ${phEmail.slice(0, 7)}"}\n\n` };
    await wsReceive(first);
    assert.equal(first.frame, `data: {"delta":"contact "}\n\n`, "first frame emits only the completable part");

    const second = { sessionID: "ses_ws2", agent: "build", model: { providerID: "p", modelID: "m" }, kind: "chat", frame: `data: {"delta":"${phEmail.slice(7)} now"}\n\n` };
    await wsReceive(second);
    assert.equal(second.frame, `data: {"delta":"${EMAIL} now"}\n\n`, "second frame carries the reassembled placeholder");

    const wsAcc = (value) => {
      let out = "";
      for (const block of value.split("\n\n")) {
        if (block.startsWith("data:")) out += JSON.parse(block.slice(5).trim()).delta ?? "";
      }
      return out;
    };
    assert.equal(wsAcc(first.frame) + wsAcc(second.frame), `contact ${EMAIL} now`, "accumulated WS deltas must equal the restored text");
    assert.ok(!first.frame.includes("__VG_") && !second.frame.includes("__VG_"), "no placeholder fragment may survive in WS frames");
  }));

test("ws.handshake resets scopes fail-closed: stale fragments never merge into the next call", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const wsReceive = hookFn(sessionRegistrations, "experimental.ws.receive");
    const wsHandshake = hookFn(sessionRegistrations, "experimental.ws.handshake");
    const [ph] = await seedPlaceholder(sessionRegistrations, "ses_ws3", SECRET);
    const wsInput = (frameText) => ({
      sessionID: "ses_ws3",
      agent: "build",
      model: { providerID: "p", modelID: "m" },
      kind: "chat",
      frame: frameText,
    });

    await wsReceive(wsInput(`data: {"delta":"${ph.slice(0, 9)}"}\n\n`)); // fragment pending
    await wsHandshake({ sessionID: "ses_ws3", agent: "build", model: { providerID: "p", modelID: "m" }, kind: "chat" });

    const next = wsInput(`data: {"delta":"${ph.slice(9)} tail"}\n\n`);
    await wsReceive(next);
    assert.equal(
      next.frame,
      `data: {"delta":"${ph.slice(9)} tail"}\n\n`,
      "after the handshake reset the orphan half must stay inert (fail-closed)",
    );
    assert.ok(!next.frame.includes(SECRET), "a stale fragment must never complete across model calls");
  }));

test("ws receive scopes are session-isolated", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const wsReceive = hookFn(sessionRegistrations, "experimental.ws.receive");
    const [phA] = await seedPlaceholder(sessionRegistrations, "ses_wsA", EMAIL);
    const [phB] = await seedPlaceholder(sessionRegistrations, "ses_wsB", SECRET);
    const wsInput = (sessionID, delta) => ({
      sessionID,
      agent: "build",
      model: { providerID: "p", modelID: "m" },
      kind: "chat",
      frame: frame({ delta }),
    });

    // interleave the two scopes, both split mid-placeholder
    const a1 = wsInput("ses_wsA", phA.slice(0, 5));
    const b1 = wsInput("ses_wsB", phB.slice(0, 5));
    const a2 = wsInput("ses_wsA", `${phA.slice(5)} a`);
    const b2 = wsInput("ses_wsB", `${phB.slice(5)} b`);
    for (const input of [a1, b1, a2, b2]) await wsReceive(input);

    assert.equal(wsAccumulated([a1.frame, a2.frame]), `${EMAIL} a`, "scope A restores only its own placeholder");
    assert.equal(wsAccumulated([b1.frame, b2.frame]), `${SECRET} b`, "scope B restores only its own placeholder");
    for (const input of [a1, a2]) assert.ok(!input.frame.includes(SECRET), "scope A must never emit scope B's secret");
    for (const input of [b1, b2]) assert.ok(!input.frame.includes(EMAIL), "scope B must never emit scope A's secret");
  }));

// ---------------------------------------------------------------------------
// regression coverage: builtin classes, custom regex classes, adjacent
// placeholders, full-PEM restore
// ---------------------------------------------------------------------------

const SIX_BUILTIN_VALUES = {
  email: "bob@example.net",
  china_phone: "13812345678",
  china_id: "11010519491231002X",
  uuid: "123e4567-e89b-12d3-a456-426614174000",
  ipv4: "192.168.1.10",
  mac: "00:1a:2b:3c:4d:5e",
};

const SIX_BUILTIN_CONFIG = {
  enabled: true,
  session: { ttl: "1h" },
  patterns: {
    builtin: Object.keys(SIX_BUILTIN_VALUES),
    keywords: [],
    regex: [],
    exclude: [],
  },
};

test("all six builtin pattern classes redact and restore", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp, { config: SIX_BUILTIN_CONFIG });
    const contextHook = hookFn(sessionRegistrations, "context");
    const toolHook = hookFn(toolRegistrations, "execute.before");

    const seed = {
      sessionID: "ses_six",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: "ses_six" },
          parts: Object.entries(SIX_BUILTIN_VALUES).map(([kind, value], i) => ({
            type: "text",
            text: `${kind} ${value}`,
          })),
        },
      ],
    };
    await contextHook(seed);

    const placeholders = collectStrings(seed)
      .map((s) => s.match(new RegExp(PLACEHOLDER_RE.source, "g")))
      .flat()
      .filter(Boolean);
    assert.equal(placeholders.length, 6, `expected one placeholder per builtin class, got ${JSON.stringify(placeholders)}`);
    assert.equal(new Set(placeholders).size, 6, "each class must get its own category placeholder");
    for (const value of Object.values(SIX_BUILTIN_VALUES)) {
      assert.ok(!collectStrings(seed).join("\n").includes(value), `${value} must be redacted`);
    }

    // restore everything through the tool hook, same session
    const toolInput = { tool: "bash", sessionID: "ses_six", input: { command: placeholders.join(",") } };
    await toolHook(toolInput);
    for (const value of Object.values(SIX_BUILTIN_VALUES)) {
      assert.ok(toolInput.input.command.includes(value), `${value} must be restored`);
    }
  }));

test("fifteen synthetic regex rules redact independently", async () =>
  withTempDir(async (tmp) => {
    const rules = Array.from({ length: 15 }, (_, i) => ({
      pattern: `rule${i + 1}-secret-[a-z]+`,
      flags: "",
      category: `rule${String(i + 1).padStart(2, "0")}`,
    }));
    const config = {
      enabled: true,
      session: { ttl: "1h" },
      patterns: { builtin: [], keywords: [], regex: rules, exclude: [] },
    };
    const { sessionRegistrations } = await setupPlugin(tmp, { config });
    const contextHook = hookFn(sessionRegistrations, "context");

    const seed = {
      sessionID: "ses_rules",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: "ses_rules" },
          parts: rules.map((_, i) => ({ type: "text", text: `hit rule${i + 1}-secret-alpha here` })),
        },
      ],
    };
    await contextHook(seed);

    const strings = collectStrings(seed);
    for (let i = 1; i <= 15; i++) {
      assert.ok(!strings.join("\n").includes(`rule${i}-secret-alpha`), `rule ${i} text leaked`);
      assert.ok(strings.join("\n").includes(`__VG_RULE${String(i).padStart(2, "0")}_`), `rule ${i} category placeholder missing`);
    }
    const placeholders = strings.join("\n").match(new RegExp(PLACEHOLDER_RE.source, "g")) ?? [];
    assert.equal(placeholders.length, 15, "each of the 15 rules must produce exactly one placeholder");
  }));

test("adjacent placeholders restore exactly (non-greedy repair is load-bearing)", async () =>
  withTempDir(async (tmp) => {
    const ALPHA = "ALPHA-KEY-ONE";
    const BETA = "BETA-KEY-TWO";
    const config = {
      enabled: true,
      session: { ttl: "1h" },
      patterns: {
        builtin: [],
        keywords: [
          { value: ALPHA, category: "alpha" },
          { value: BETA, category: "beta" },
        ],
        regex: [],
        exclude: [],
      },
    };
    const { sessionRegistrations, toolRegistrations, outDir } = await setupPlugin(tmp, { config });
    const contextHook = hookFn(sessionRegistrations, "context");
    const toolHook = hookFn(toolRegistrations, "execute.before");

    // two secrets DIRECTLY adjacent -> adjacent placeholders with no separator
    const seed = {
      sessionID: "ses_adj",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: "ses_adj" },
          parts: [{ type: "text", text: `${ALPHA}${BETA}` }],
        },
      ],
    };
    await contextHook(seed);
    const adjacent = collectStrings(seed).join("\n").match(new RegExp(PLACEHOLDER_RE.source, "g"));
    assert.equal(adjacent?.length, 2, `expected two adjacent placeholders, got ${JSON.stringify(adjacent)}`);

    // the shipped repair: the built session.js regex is non-greedy and splits
    // the adjacency correctly; the stock greedy form would merge the whole
    // span into ONE match and the lookup would fail (secret never restored)
    const { getPlaceholderRegex } = await import(pathToFileURL(join(outDir, "vibeguard", "session.js")).href);
    const patched = getPlaceholderRegex("__VG_");
    assert.ok(patched.source.includes("+?_"), "shipped session.js must carry the non-greedy repair");
    const greedyStock = new RegExp(patched.source.replace("+?_", "+_"), "g");
    const span = adjacent[0] + adjacent[1];
    assert.equal(span.match(patched).length, 2, "patched regex must match each placeholder");
    assert.equal(span.match(greedyStock).length, 1, "stock greedy regex demonstrably merged adjacent placeholders");

    // exact restoration through the tool hook
    const toolInput = { tool: "bash", sessionID: "ses_adj", input: { command: `x ${adjacent[0]}${adjacent[1]} y` } };
    await toolHook(toolInput);
    assert.equal(toolInput.input.command, `x ${ALPHA}${BETA} y`, "adjacent placeholders must restore exactly");
  }));

test("full PEM block collapses to one placeholder and restores verbatim", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");
    const responseHook = hookFn(sessionRegistrations, "http.response");

    // save the exact in-memory original BEFORE the hook: all round-trip
    // assertions derive from this captured string, never from re-reading the
    // fixture constant, so the test stays functional even if fixture bytes
    // differ between writing and running this suite
    const original = `pasted:\n${PEM}`;
    const seed = {
      sessionID: "ses_pem",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: "ses_pem" },
          parts: [{ type: "text", text: original }],
        },
      ],
    };
    await contextHook(seed);
    const redacted = seed.messages[0].parts[0].text;
    assert.notEqual(redacted, original, "PEM block must be redacted");
    assert.ok(redacted.includes("__VG_PEM_"), "PEM placeholder missing");
    // the full multi-line block is gone; exactly one placeholder remains
    assert.ok(!redacted.includes("BEGIN") && !redacted.includes("END"), "PEM body must not survive");
    const matches = redacted.match(new RegExp(PLACEHOLDER_RE.source, "g")) ?? [];
    assert.equal(matches.length, 1, `full PEM = single placeholder, got ${matches}`);
    const ph = matches[0];

    const payload = JSON.stringify({ choices: [{ message: { role: "assistant", content: `key:\n${ph}` } }] });
    const response = new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    const hookInput = { sessionID: "ses_pem", request: {}, response };
    await responseHook(hookInput);
    const text = await hookInput.response.text();
    assert.ok(!PLACEHOLDER_RE.test(text), `no placeholder may survive restore: ${text}`);
    const content = JSON.parse(text).choices[0].message.content;
    assert.ok(content.endsWith(`key:\n${PEM}`), `full PEM block must be restored verbatim: ${text}`);
  }));

// ---------------------------------------------------------------------------
// real-host typed transport instances (dual-host-2.0 regression, red-first)
//
// The pinned v2 host (@opencode/plugin 2.0.20 surface) passes `messages` as
// @opencode/ai `Message` CLASS instances — own writable data fields
// id/role/content/metadata on a custom prototype (constructor `nH` in the
// minified host bundle; observed on the real host in
// hook-observations.jsonl). The shared engine's redactDeep skips custom
// prototypes, so on the real host redaction was a silent no-op (RESULT.json:
// 8 redaction/restore checks failed) while the offline plain-object mocks
// passed. These tests are red-first: every assertion below fails against the
// pre-fix plugin.
//
// Exact public class shape: when `@opencode/ai` (the SDK package the pinned
// session.d.ts types reference) is importable, the tests construct the real
// `Message` class. Otherwise they fall back to a synthetic class with the
// same own-field layout — LIMIT: the synthetic prototype name differs from
// the minified host class and its constructor does not schema-validate, so
// the fallback proves the adapter logic, not the host's validation behavior.
// ---------------------------------------------------------------------------

let RealMessage = null;
try {
  RealMessage = (await import("@opencode/ai")).Message ?? null;
} catch {
  RealMessage = null; // fallback synthetic class below
}

class SyntheticHostMessage {
  constructor({ id, role, content, metadata }) {
    if (id !== undefined) this.id = id;
    this.role = role;
    this.content = content;
    if (metadata !== undefined) this.metadata = metadata;
  }
}

const HostMessage = RealMessage ?? SyntheticHostMessage;
const USING_REAL_SDK_CLASS = RealMessage !== null;

function makeHostMessage({ id = "msg_1", role = "user", content, metadata } = {}) {
  return new HostMessage({ id, role, content, metadata });
}

test("context redacts SDK Message class instances in place and preserves the host shape", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");

    const metadata = { origin: "local" };
    const message = makeHostMessage({
      id: "msg_user_1",
      role: "user",
      content: [
        { type: "text", text: `mail ${EMAIL}` },
        { type: "tool-call", id: "call_1", name: "bash", input: { command: `echo ${SECRET}` } },
      ],
      metadata,
    });
    const originalBytes = JSON.stringify(message); // captured BEFORE the hook
    assert.ok(originalBytes.includes(EMAIL), "fixture sanity: secret present before redaction");

    const input = {
      sessionID: "ses_typed_inplace",
      model: { providerID: "p", modelID: "m" },
      system: [{ type: "text", text: `sys ${SECRET}` }],
      messages: [message],
    };
    await contextHook(input);

    // identity preserved: writable instance redacted IN PLACE
    assert.ok(input.messages[0] === message, "writable typed instance must be redacted in place");
    const text = message.content[0].text;
    assert.ok(!text.includes(EMAIL), "email must not survive in the model view");
    assert.ok(PLACEHOLDER_RE.test(text), "text part must carry a placeholder");
    assert.ok(
      message.content[1].input.command.includes("__VG_TOKEN_") &&
        !message.content[1].input.command.includes(SECRET),
      "tool-call input must be redacted as parsed data (no string-mangled JSON)",
    );
    // identifiers and host metadata are never masked or entered. LIMIT: the
    // real SDK Message constructor itself normalizes `metadata` into a fresh
    // object BEFORE the hook runs, so value equality is the adapter-level
    // contract (the synthetic fallback preserves the reference).
    assert.equal(message.id, "msg_user_1", "id must stay untouched");
    assert.equal(message.role, "user", "role must stay untouched");
    assert.equal(message.content[1].id, "call_1", "tool-call id must stay untouched");
    assert.equal(message.content[1].name, "bash", "tool-call name must stay untouched");
    assert.deepEqual(message.metadata, metadata, "metadata values must be untouched");
    // serialization/shape preserved: same keys, same order, provider-parseable
    const modelBytes = JSON.stringify(message);
    assert.deepEqual(Object.keys(JSON.parse(modelBytes)), ["id", "role", "content", "metadata"]);
    assert.ok(!modelBytes.includes(EMAIL) && !modelBytes.includes(SECRET), "model projection carries no secrets");
    // original user bytes (pre-hook capture) stay intact for comparison
    assert.ok(originalBytes.includes(EMAIL), "captured original user bytes must be untouched");
    // system plain parts keep existing coverage
    assert.ok(!input.system[0].text.includes(SECRET), "system part must still be redacted");
  }));

test("frozen SDK Message instances are redacted via prototype-preserving clones (original byte-intact)", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");

    const message = makeHostMessage({
      id: "msg_frozen",
      role: "user",
      content: [{ type: "text", text: `call ${SECRET}` }],
      metadata: { keep: true },
    });
    Object.freeze(message);
    Object.freeze(message.content);
    Object.freeze(message.content[0]);
    const before = JSON.stringify(message);

    const input = {
      sessionID: "ses_typed_frozen",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [message],
    };
    await contextHook(input);

    const clone = input.messages[0];
    assert.ok(clone !== message, "frozen instance must be replaced by a redacted clone");
    assert.equal(JSON.stringify(message), before, "the original instance must stay byte-intact");
    assert.equal(Object.getPrototypeOf(clone), Object.getPrototypeOf(message), "prototype must be preserved");
    assert.ok(clone instanceof HostMessage, "clone must satisfy the host class");
    assert.ok(!Object.isFrozen(clone), "clone must be a mutable projection");
    assert.ok(PLACEHOLDER_RE.test(clone.content[0].text), "clone text must carry the placeholder");
    assert.ok(!clone.content[0].text.includes(SECRET), "clone text must not leak the secret");
    assert.equal(clone.id, "msg_frozen", "clone keeps identity fields");
    assert.deepEqual(clone.metadata, { keep: true }, "clone keeps metadata values");
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(clone))), ["id", "role", "content", "metadata"], "clone serialization shape preserved");
    assert.ok(!JSON.stringify(clone).includes(SECRET), "clone projection carries no secret");
  }));

test("frozen messages array is redacted by replacing the field with a copy-on-write array", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");

    const frozenMessage = makeHostMessage({
      role: "user",
      content: [{ type: "text", text: `pin ${SECRET}` }],
    });
    Object.freeze(frozenMessage);
    Object.freeze(frozenMessage.content);
    Object.freeze(frozenMessage.content[0]);
    const plainMessage = {
      info: { id: "m2", role: "user", sessionID: "ses_frozen_arr" },
      parts: [{ type: "text", text: `mail ${EMAIL}` }],
    };
    const frozenArray = Object.freeze([frozenMessage, plainMessage]);
    const beforeFrozen = JSON.stringify(frozenMessage);
    const beforePlain = JSON.stringify(plainMessage);

    const input = {
      sessionID: "ses_frozen_arr",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: frozenArray,
    };
    await contextHook(input);

    assert.ok(input.messages !== frozenArray, "frozen array must be replaced on the hook input");
    assert.ok(PLACEHOLDER_RE.test(input.messages[0].content[0].text), "frozen message copy must be redacted");
    assert.ok(!input.messages[1].parts[0].text.includes(EMAIL), "plain message copy must be redacted");
    assert.equal(JSON.stringify(frozenMessage), beforeFrozen, "original frozen message stays byte-intact");
    assert.equal(JSON.stringify(plainMessage), beforePlain, "original plain message stays byte-intact (copy-on-write)");
    assert.equal(frozenArray[0], frozenMessage, "the original frozen array is never mutated");
  }));

test("typed-instance redaction keeps placeholders stable and restores through tool.execute.before", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations, toolRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");
    const toolHook = hookFn(toolRegistrations, "execute.before");

    // clone path: the SAME frozen instance enters two context calls; the
    // mapping must reuse one stable placeholder for the same secret
    const frozenMessage = makeHostMessage({
      role: "user",
      content: [{ type: "text", text: `key ${SECRET}` }],
    });
    Object.freeze(frozenMessage);
    Object.freeze(frozenMessage.content);
    Object.freeze(frozenMessage.content[0]);
    // the context handler is synchronous (returns undefined); await covers it
    const call = async () => {
      const input = {
        sessionID: "ses_typed_stable",
        model: { providerID: "p", modelID: "m" },
        system: [],
        messages: [frozenMessage],
      };
      await contextHook(input);
      return input.messages[0].content[0].text;
    };
    const first = await call();
    const second = await call();
    const phFirst = first.match(PLACEHOLDER_RE)?.[0];
    const phSecond = second.match(PLACEHOLDER_RE)?.[0];
    assert.ok(phFirst, "first call must produce a placeholder");
    assert.equal(phFirst, phSecond, "same session+secret must reuse one stable placeholder");
    assert.equal(JSON.stringify(frozenMessage).includes(SECRET), true, "frozen original keeps the secret for later calls");

    // in-place path: calling again on the already-redacted instance adds no
    // second placeholder and loses none
    const mutableMessage = makeHostMessage({
      role: "user",
      content: [{ type: "text", text: `mail ${EMAIL}` }],
    });
    const inplaceInput = {
      sessionID: "ses_typed_stable",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [mutableMessage],
    };
    await contextHook(inplaceInput);
    const once = mutableMessage.content[0].text;
    await contextHook(inplaceInput);
    assert.equal(mutableMessage.content[0].text, once, "second in-place call must not double-redact");
    assert.equal(once.match(new RegExp(PLACEHOLDER_RE.source, "g"))?.length, 1, "exactly one placeholder");

    // end-to-end: the model-echoed placeholder restores through the tool hook
    const toolInput = { tool: "bash", sessionID: "ses_typed_stable", input: { command: `echo ${phFirst}` } };
    await toolHook(toolInput);
    assert.ok(toolInput.input.command.includes(SECRET), "typed-instance placeholder must restore like any other");
  }));

test("typed part instances inside typed message content redact via the explicit text field", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");

    // LIMIT: the real SDK constructor normalizes parts to plain objects, so a
    // typed part instance is exercised on the synthetic message class (same
    // own-field layout); the adapter must enter it ONLY via its own `text`.
    class TypedTextPart {
      constructor(type, text) {
        this.type = type;
        this.text = text;
      }
    }
    class SyntheticContentMessage {
      constructor(fields) {
        this.id = fields.id;
        this.role = fields.role;
        this.content = fields.content;
      }
    }
    const message = new SyntheticContentMessage({
      id: "msg_typed_part",
      role: "assistant",
      content: [new TypedTextPart("reasoning", `thought ${SECRET}`)],
    });

    const input = {
      sessionID: "ses_typed_part",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [message],
    };
    await contextHook(input);

    assert.ok(!message.content[0].text.includes(SECRET), "typed part text must be redacted");
    assert.ok(PLACEHOLDER_RE.test(message.content[0].text), "typed part text must carry the placeholder");
    assert.equal(message.content[0].type, "reasoning", "part type discriminator untouched");

    // system field with a typed text part instance: same explicit traversal
    class TypedSystemPart {
      constructor(text) {
        this.type = "text";
        this.text = text;
      }
    }
    const sysInput = {
      sessionID: "ses_typed_part",
      model: { providerID: "p", modelID: "m" },
      system: [new TypedSystemPart(`sys ${SECRET}`)],
      messages: [],
    };
    await contextHook(sysInput);
    assert.ok(!sysInput.system[0].text.includes(SECRET), "typed system part must be redacted");
    assert.ok(PLACEHOLDER_RE.test(sysInput.system[0].text), "typed system part carries the placeholder");
  }));

test("undocumented typed instances stay untouched (narrow adapter, never broadened)", async () =>
  withTempDir(async (tmp) => {
    const { sessionRegistrations } = await setupPlugin(tmp);
    const contextHook = hookFn(sessionRegistrations, "context");

    // The host only sends documented transport shapes (Message / system
    // parts). An unknown class with neither `content` nor `text` own fields
    // is deliberately NOT walked generically: no prototype fishing, no getter
    // entry, no destructive rewrite — pinned here as the narrow-adapter
    // contract (the diagnostic shows the real host sends Message instances).
    class Undocumented {
      constructor() {
        this.note = `note ${SECRET}`;
      }
    }
    const instance = new Undocumented();
    const input = {
      sessionID: "ses_undocumented",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [instance],
    };
    await contextHook(input);

    assert.ok(input.messages[0] === instance, "unknown instance must keep its array slot (never nulled/replaced)");
    assert.equal(instance.note, `note ${SECRET}`, "undocumented shape stays byte-identical (no generic walk)");
  }));

test(`typed-instance suite runs against the ${USING_REAL_SDK_CLASS ? "real @opencode/ai Message class" : "synthetic fallback class (limit: @opencode/ai not importable)"}`, () => {
  const message = makeHostMessage({ id: "probe", role: "user", content: [{ type: "text", text: "x" }] });
  assert.equal(Object.getPrototypeOf(message) === Object.prototype, false, "fixture sanity: instance must have a custom prototype");
  const keys = Object.keys(message);
  // the real SDK class always defines `metadata` (own prop, possibly undefined);
  // the synthetic fallback only defines fields it was given
  assert.deepEqual(keys.filter((k) => k !== "metadata"), ["id", "role", "content"], "fixture sanity: SDK Message own-field layout");
  assert.ok(keys.every((k) => ["id", "role", "content", "metadata"].includes(k)), "fixture sanity: no undocumented own fields");
});
