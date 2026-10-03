/**
 * Privacy bundle builder.
 *
 * Emits a self-contained privacy bundle:
 *   outDir/
 *     package.json       — v2 host-facing plugin package
 *     vibeguard/         — opencode-vibeguard 0.1.0 src/ copy (hash-gated),
 *                          with the documented adjacent-placeholder repair
 *                          applied to session.js
 *     index.js           — loadable v1 plugin entry: re-exports the pinned
 *                          engine from ./vibeguard/index.js (the engine's
 *                          imports are engine-relative and must never leave
 *                          vibeguard/) and adds the v1 default export
 *     v2-plugin.mjs      — v2 host plugin (default export = {id, setup})
 *     manifest.json      — support/hash/test/removal documentation
 *
 * Gates: the source must be exactly opencode-vibeguard@0.1.0 with the known
 * stock session.js hash; unknown sources fail the build instead of being
 * patched fuzzily. The patched session.js must in turn match the known patched
 * hash (identical to the local-plugins build), so the emitted repair is
 * byte-identical to the already-tested one.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, sha256Text } from "../lib/hash.mjs";

export const VIBEGUARD_VERSION = "0.1.0";
/** opencode-vibeguard 0.1.0 stock src/session.js */
export const STOCK_SESSION_SHA256 = "9175bd052cc47ac4e155c568fac6b3902dd2b1c59bfa9c49323b95945065b45d";
/** src/session.js after the non-greedy adjacent-placeholder repair (same bytes as the local-plugins build) */
export const PATCHED_SESSION_SHA256 = "5a4d3f18aeb24c45a2aefbdbcfd362cd443dd6a5446de67da073ba51e2be35af";

const GREEDY_FRAGMENT = "[A-Za-z0-9_]+_[a-f0-9A-F]{12}";
const NON_GREEDY_FRAGMENT = "[A-Za-z0-9_]+?_[a-f0-9A-F]{12}";

const VIBEGUARD_SRC_FILES = [
  "index.js",
  "config.js",
  "patterns.js",
  "session.js",
  "engine.js",
  "restore.js",
  "deep.js",
];

function writeFile(outDir, relPath, content) {
  const target = join(outDir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return target;
}

/** Apply the documented adjacent-placeholder repair to stock session.js. */
export function patchSessionSource(source) {
  const count = source.split(GREEDY_FRAGMENT).length - 1;
  if (count !== 1) {
    throw new Error(
      `session.js repair aborted: expected exactly one occurrence of the greedy placeholder fragment, found ${count}`,
    );
  }
  return source.replace(GREEDY_FRAGMENT, NON_GREEDY_FRAGMENT);
}

export async function buildPrivacy({
  vibeguardDir,
  outDir,
  expectedVersion = VIBEGUARD_VERSION,
  ...rest
}) {
  // Apply defaults only when the key is ABSENT; an explicitly-passed
  // undefined/invalid pin must fail the build instead of silently falling back.
  const stockSessionSha256 = "stockSessionSha256" in rest ? rest.stockSessionSha256 : STOCK_SESSION_SHA256;
  const patchedSessionSha256 =
    "patchedSessionSha256" in rest ? rest.patchedSessionSha256 : PATCHED_SESSION_SHA256;
  const generatedAt = "generatedAt" in rest ? rest.generatedAt : new Date().toISOString();
  if (!vibeguardDir || !outDir) throw new Error("buildPrivacy requires vibeguardDir and outDir");
  if (typeof stockSessionSha256 !== "string" || stockSessionSha256.length !== 64) {
    throw new Error("buildPrivacy requires a 64-hex stockSessionSha256 pin");
  }
  if (typeof patchedSessionSha256 !== "string" || patchedSessionSha256.length !== 64) {
    throw new Error("buildPrivacy requires a 64-hex patchedSessionSha256 pin");
  }
  const pkg = JSON.parse(readFileSync(join(vibeguardDir, "package.json"), "utf8"));
  if (pkg.name !== "opencode-vibeguard" || pkg.version !== expectedVersion) {
    throw new Error(
      `opencode-vibeguard mismatch: expected opencode-vibeguard@${expectedVersion}, found ${pkg.name}@${pkg.version}`,
    );
  }

  const sessionPath = join(vibeguardDir, "src", "session.js");
  const actualSessionSha = await sha256File(sessionPath);
  if (actualSessionSha !== stockSessionSha256) {
    throw new Error(
      `stock session.js sha256 mismatch (expected ${stockSessionSha256}, found ${actualSessionSha}) — refusing to patch an unknown source`,
    );
  }
  const patched = patchSessionSource(readFileSync(sessionPath, "utf8"));
  const actualPatchedSha = sha256Text(patched);
  if (actualPatchedSha !== patchedSessionSha256) {
    throw new Error(
      `patched session.js sha256 mismatch (expected ${patchedSessionSha256}, got ${actualPatchedSha}) — repair output drifted from the known-good build`,
    );
  }

  const outAbs = resolve(outDir);
  mkdirSync(join(outAbs, "vibeguard"), { recursive: true });

  const fileHashes = {};
  for (const file of VIBEGUARD_SRC_FILES) {
    let content;
    if (file === "session.js") {
      content = patched;
      writeFileSync(join(outAbs, "vibeguard", file), content, "utf8");
    } else {
      cpSync(join(vibeguardDir, "src", file), join(outAbs, "vibeguard", file));
    }
    fileHashes[file] = await sha256File(join(outAbs, "vibeguard", file));
  }
  // Bundle-root v1 entry: the stock engine's imports are engine-relative
  // ("./config.js", ...), so a root copy of src/index.js cannot resolve them.
  // Re-export the engine from its emitted copy and expose the factory as the
  // default export (v1 hosts accept a default function).
  writeFile(
    outAbs,
    "index.js",
    `/**
 * v1 host-facing plugin entry (opencode plugin factory).
 *
 * Re-exports the pinned opencode-vibeguard@${expectedVersion} engine from
 * ./vibeguard/index.js — the engine's imports are engine-relative and must
 * stay inside the emitted vibeguard/ directory. The factory is also the
 * default export.
 */

export { VibeGuardPrivacy } from "./vibeguard/index.js";

import { VibeGuardPrivacy } from "./vibeguard/index.js";

export default VibeGuardPrivacy;
`,
  );

  const srcRoot = dirname(fileURLToPath(import.meta.url));
  for (const pluginModule of ["v2-plugin.mjs", "stream-restore.mjs"]) {
    const source = readFileSync(join(srcRoot, pluginModule), "utf8");
    writeFileSync(join(outAbs, pluginModule), source, "utf8");
  }

  writeFile(
    outAbs,
    "package.json",
    `${JSON.stringify(
      {
        name: "opencode-community-privacy",
        version: `0.0.0-vg${expectedVersion}`,
        private: true,
        type: "module",
        description: "VibeGuard privacy entries: request redaction, tool-argument restoration, final-output restoration (v1 hooks + v2 public hook domains).",
        exports: {
          ".": "./index.js",
          "./v2": "./v2-plugin.mjs",
        },
      },
      null,
      2,
    )}\n`,
  );

  const manifest = {
    generator: "opencode-community-compat/privacy",
    generatedAt,
    upstream: {
      opencodeVibeguard: {
        name: "opencode-vibeguard",
        version: expectedVersion,
        resolution: resolve(vibeguardDir),
        files: fileHashes,
        stockSessionSha256: actualSessionSha,
        patchedSessionSha256: actualPatchedSha,
        changes: [
          "getPlaceholderRegex: greedy [A-Za-z0-9_]+_ -> non-greedy +?_ so adjacent placeholders restore correctly",
        ],
      },
    },
    coverage: {
      v1: [
        "experimental.chat.messages.transform: request redaction (text/reasoning/tool input/output/error/raw)",
        "experimental.text.complete: full final-output restoration",
        "tool.execute.before: tool-argument restoration",
      ],
      v2: [
        "session.hook context/compaction/generate/title: request redaction of mutable messages+system on model-facing request kinds only (root string fields re-assigned, object/array fields deep-redacted); the pre-admission session.prompt hook is deliberately NOT registered — raw user input reaches storage unmutated",
        "tool.hook execute.before: tool-argument restoration (deep restore for object/array inputs, root string inputs restored by re-assignment)",
        "session.hook http.response: request/output-scoped final-output restoration for JSON bodies and delta-aware SSE streams — placeholders split across provider semantic delta events (choices[].delta.content, content_block_delta, response.output_text.delta, legacy choices[].text, ...) are reassembled per semantic stream identity (structural role + sorted index/item_id/output_index/content_index/block_index annotations; JSON property order and array position never affect identity); SSE events accept CR, LF or CRLF line terminators in any mixture; unchanged frames, data: [DONE] and finish events pass through byte-identical; at stream end pending inert fragments are re-emitted as provider-shaped delta DATA events (never comments, never dropped), so decoded consumer text is exactly the original model output; JSON-encoded model tool input (choices[].delta.tool_calls[].function.arguments, Anthropic input_json_delta partial_json, Responses function_call_arguments deltas and atomic function_call arguments) is passed through with placeholders retained — the host parses the serialized arguments after the response and tool.execute.before restores the parsed values safely",
        "session.hook experimental.ws.receive: inbound WebSocket frame restoration with the same delta-aware accumulation, scoped per (sessionID, agent, model.id/providerID, kind); wire events carrying per-stream IDs (item_id, content_index, ...) stay isolated even for concurrent same-kind completions",
        "session.hook experimental.ws.handshake: per-model-call lifecycle reset of WS accumulation scopes (fail-closed: stale partial fragments are dropped, never merged into a later call's stream)",
      ],
    },
    limits: [
      "Bounded restoration, no conversation-sized buffering: per delta stream at most one pending fragment shorter than the longest session mapping key; at most 4096 delta streams per response (beyond that, complete-placeholder-only restoration); at most one SSE event buffered and the bound is enforced incrementally — an event crossing 1 MiB without a terminator is passed through unrestored immediately instead of being buffered further. Placeholders split across delta events are reassembled within these bounds; a stale mapping-size cache (equal-size delete+add of a longer key between frames) can in principle miss one split — a residual, documented risk.",
      "A stream whose final characters are an incomplete placeholder prefix (or an unknown placeholder-shaped literal) has that inert fragment re-emitted as a provider-shaped delta DATA event at stream end (before a held data: [DONE] when present): fragments are non-restorable [A-Za-z0-9_]+ shapes, never secrets, and delta-accumulating consumers observe the exact original text. Event shapes outside the enumerated provider families (OpenAI choice delta/text, Anthropic content_block_delta, Responses output_text.delta with item_id) use the documented generic {\"delta\": ...} carrier.",
      "WebSocket receive frames carry no connection identifier on the pinned @opencode/plugin 2.0.20 surface (SessionWebSocketReceive = sessionID/agent/model/kind/frame), so scope isolation uses model.id/providerID plus each wire event's own stream annotations (item_id, content_index, ...). Two precise unsupported cases remain: (a) concurrent same-kind WS completions whose events carry NO distinguishing annotations (e.g. bare {\"delta\": ...}) share one accumulator and can interleave fragments; (b) a placeholder-prefix fragment still pending at experimental.ws.handshake has no frame to be re-emitted into and is dropped fail-closed (never merged into the next call's stream). WS frames are never given synthetic comment carriers.",
      "Model tool-argument JSON is deliberately NOT restored on the wire: splicing a mapped value that itself contains a quote or backslash into the JSON-encoded arguments/partial_json source corrupts the tool call before the host parses it (verified repro against opencode-vibeguard 0.1.0 restoreText). Placeholders therefore survive serialized model tool input until the host parses the arguments and runs tool.execute.before; a host that never runs execute.before, or a surface that displays raw arguments before execution, shows the inert placeholder text. The generic {\"delta\": ...} WS shape cannot distinguish tool-argument fragments from text and remains text-restored.",
      "WebSocket-backed providers bypass the HTTP hooks entirely (official v2 plugin docs: handshake/send/receive do not traverse http.*). Coverage for WS model output depends on the experimental.ws.receive/handshake surfaces; where a host lacks them, WS output restoration is unavailable while request redaction stays total — an explicit, documented gap, never silently ignored in acceptance evidence.",
      "No real secrets or user config values are read at build time; only hashes of source files.",
    ],
    removal:
      "remove when the privacy module is superseded upstream: opencode-vibeguard newer than 0.1.0 ships the adjacent-placeholder fix and a v2 entry, or hosts provide a completed-text hook; re-verify the stock session.js sha256 pin before rebuilding against any new version",
  };
  writeFile(outAbs, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    outDir: outAbs,
    files: [
      "package.json",
      "vibeguard/index.js",
      "vibeguard/config.js",
      "vibeguard/patterns.js",
      "vibeguard/session.js",
      "vibeguard/engine.js",
      "vibeguard/restore.js",
      "vibeguard/deep.js",
      "index.js",
      "v2-plugin.mjs",
      "stream-restore.mjs",
      "manifest.json",
    ],
    hashes: { stockSession: actualSessionSha, patchedSession: actualPatchedSha, files: fileHashes },
  };
}
