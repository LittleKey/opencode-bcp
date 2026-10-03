/**
 * VibeGuard privacy plugin for v2 hosts (@opencode/plugin 2.0.20 surface).
 *
 * Emitted by the privacy builder next to a patched copy of opencode-vibeguard
 * 0.1.0's src/ — it reuses that engine verbatim (same placeholder format, same
 * per-session mapping isolation, same config loading) and wires it to the v2
 * public hook domains. No privacy processing is duplicated here: redaction and
 * restoration both go through the shared VibeGuard modules.
 *
 * Mapping from the v1 plugin (src index.js of opencode-vibeguard 0.1.0):
 *   v1 experimental.chat.messages.transform  ->  v2 session.hook on
 *       "context" (primary request) + "compaction" / "generate" / "title"
 *       (auxiliary model-facing request kinds): deep redaction of all mutable
 *       request message content. Root string fields are re-assigned (a
 *       mutating deep helper cannot touch a standalone primitive).
 *       The pre-admission session.prompt hook is deliberately NOT registered:
 *       a mutating prompt handler alters the stored original user message
 *       BEFORE storage. Redaction happens only on model-facing request
 *       content; raw prompt input is never rewritten by this plugin.
 *
 *       Typed transport instances (real-host fix, dual-host-2.0): the pinned
 *       host passes `messages` as @opencode/ai 2.0.20 `Message` CLASS
 *       instances (own data fields id/role/content/metadata on a custom
 *       prototype; constructor minified to `nH` in the host bundle) whose
 *       `content` parts are plain tagged-union objects ({type:"text", text},
 *       {type:"tool-call", input}, {type:"reasoning", text}, ...). The shared
 *       engine's redactDeep only walks plain objects/arrays, so class
 *       instances were silently skipped (observed on the real host:
 *       redaction no-op). This plugin therefore adds a NARROW adapter that
 *       enters such instances only through their own documented transport
 *       fields — a message's own `content`, a part's own `text`,
 *       `input`/`result` (parsed tool values, walked as plain data) — never
 *       role/id/metadata/providerMetadata, never getters or arbitrary
 *       prototypes. Writable instances are redacted in place (identity
 *       preserved); when the host pins instances readonly (frozen), a
 *       prototype-preserving redacted clone replaces the array slot so the
 *       model-facing projection is redacted while the original instance
 *       stays byte-intact. A frozen messages array is replaced on the hook
 *       input itself. Undocumented typed shapes are left untouched (never
 *       broadened to arbitrary objects). Parsed tool inputs arriving at
 *       tool.execute.before are host-parsed plain data (JSON.parse/zod
 *       output per the public ToolHooks surface); a host delivering CLASS
 *       instances there would be skipped by restoreDeep — a documented
 *       limit, not silently broadened.
 *   v1 tool.execute.before                   ->  v2 tool.hook "execute.before":
 *       restoreDeep on the mutable tool input so local execution sees real
 *       values.
 *   v1 experimental.text.complete            ->  NO direct v2 equivalent. The
 *       public interception surfaces for model output are:
 *       a) session.hook("http.response") with a mutable Response (official v2
 *          plugin docs: the response may be replaced). We restore placeholders
 *          in non-streaming JSON bodies and in SSE streams via a bounded,
 *          per-response delta restorer (stream-restore.mjs): provider semantic
 *          delta events (choices[].delta.content, content_block_delta,
 *          response.output_text.delta, legacy choices[].text, ...) accumulate
 *          per choice/output item, so a placeholder split at ANY offset across
 *          delta events is reassembled. Unchanged frames, data: [DONE] and
 *          finish events pass through byte-identical; memory stays bounded
 *          (no conversation-sized buffering) and state dies with the response.
 *          JSON-encoded model tool input (tool_calls[].function.arguments,
 *          input_json_delta partial_json, Responses function_call_arguments)
 *          is passed through with placeholders retained — the host parses the
 *          serialized arguments after the response and tool.execute.before
 *          restores the parsed values safely (restoring in place would splice
 *          mapped values containing quotes/backslashes into the JSON source).
 *       b) session.hook("experimental.ws.receive") for WebSocket-backed
 *          providers: per the official v2 docs, WS handshake/send/receive
 *          traffic does NOT traverse the HTTP hooks, so without this hook the
 *          model output of WS-based requests would be unreachable. Inbound
 *          frames run through the same delta-aware restorer. Scope isolation:
 *          pinned SDK (@opencode/plugin 2.0.20) Model.Ref = {id, providerID,
 *          variant?} and SessionWebSocketReceive = {sessionID, agent, model,
 *          kind, frame} — the surface carries no connection identifier, but
 *          the wire events themselves DO carry per-stream IDs (item_id,
 *          content_index, ...) which the restorer uses as semantic stream
 *          identity. Annotated wire events therefore stay isolated even for
 *          concurrent same-kind completions in one session; handshake resets
 *          per model call (model.id + providerID + agent + kind) keep calls
 *          apart. Both surfaces are experimental in the plugin SDK and
 *          register best-effort — a host without them keeps all core hooks
 *          and the documented gap applies to WS flows only.
 *
 * Session identity: every v2 hook input carries sessionID, so mappings stay
 * session-isolated exactly as in v1.
 */

import { loadConfig } from "./vibeguard/config.js";
import { buildPatternSet } from "./vibeguard/patterns.js";
import { PlaceholderSession } from "./vibeguard/session.js";
import { redactText } from "./vibeguard/engine.js";
import { restoreText } from "./vibeguard/restore.js";
import { redactDeep, restoreDeep } from "./vibeguard/deep.js";
import {
  OutputStreamRestorer,
  createSseRestoreTransform,
  restoreWireSafeDeep,
  restoreWsFrame,
} from "./stream-restore.mjs";

const JSON_CONTENT_TYPE = /application\/json/i;
const SSE_CONTENT_TYPE = /text\/event-stream/i;

function restoreJsonBody(body, session) {
  try {
    const value = JSON.parse(body);
    // A JSON document whose ROOT is a string ("…") cannot be restored by a
    // mutating deep helper — the restored primitive must be re-assigned.
    if (typeof value === "string") return JSON.stringify(restoreText(value, session));
    // Wire-safe walk: JSON-encoded tool arguments keep their placeholders
    // (the host parses them, then tool.execute.before restores the parsed
    // values); all other strings restore fully.
    restoreWireSafeDeep(value, session);
    return JSON.stringify(value);
  } catch {
    return body; // never break the response on unparsable bodies
  }
}

/** Mutable-response restoration: JSON bodies fully, SSE via a bounded per-response delta restorer. */
export async function restoreResponse(response, session) {
  if (!response || typeof response !== "object") return response;
  let contentType = "";
  try {
    contentType = response.headers?.get?.("content-type") ?? "";
  } catch {
    return response;
  }
  const rebuild = (body) => {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  };
  if (JSON_CONTENT_TYPE.test(contentType)) {
    const body = await response.text();
    return rebuild(restoreJsonBody(body, session));
  }
  if (SSE_CONTENT_TYPE.test(contentType) && response.body) {
    const restorer = new OutputStreamRestorer(session);
    return rebuild(response.body.pipeThrough(createSseRestoreTransform(restorer)));
  }
  return response;
}

/* ---------------------------------------------------------------------------
 * Typed transport-instance redaction (real-host adapter)
 *
 * The shared engine's redactDeep/restoreDeep only traverse plain objects and
 * arrays (isPlainObject). The pinned v2 host instead passes request messages
 * as @opencode/ai `Message` class instances (verified on the real host:
 * custom prototype, own writable data fields id/role/content/metadata; parts
 * inside `content` are plain objects). The helpers below add EXACTLY that
 * documented shape — explicit known-field traversal, no generic walk of
 * arbitrary objects/prototypes/getters — and a copy-on-write fallback for
 * frozen/readonly instances that preserves the prototype (so host
 * `instanceof`/serialization keep working) while the original instance stays
 * byte-intact.
 * ------------------------------------------------------------------------- */

function isPlainObjectValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when `key` is an OWN data property (not a getter/accessor) of `value`. */
function ownDataField(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return !!descriptor && "value" in descriptor;
}

/**
 * Prototype-preserving shallow copy of an instance's own fields. Data
 * descriptors are forced writable (a frozen source carries writable:false,
 * which would make the copy unmodifiable); enumerable-ness and the prototype
 * are kept, so JSON serialization and `instanceof` stay identical.
 */
function cloneWithOwnFields(instance) {
  const clone = Object.create(Object.getPrototypeOf(instance));
  for (const key of Reflect.ownKeys(instance)) {
    const descriptor = Object.getOwnPropertyDescriptor(instance, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.writable = true;
    Object.defineProperty(clone, key, descriptor);
  }
  return clone;
}

/** Deep copy of plain JSON-like data; non-plain values are shared untouched. */
function deepCopyPlain(value) {
  if (Array.isArray(value)) return value.map(deepCopyPlain);
  if (isPlainObjectValue(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepCopyPlain(value[key]);
    return out;
  }
  return value;
}

/**
 * Redact one `content` part. `copyMode` is true when an ancestor is frozen:
 * every plain container is then redacted on a copy and returned, so the
 * original objects are never mutated. Parts are reached only through their
 * own documented fields (`text`; parsed `input`/`result` values walked as
 * plain data). Returns the part to store in the content array.
 */
function redactContentPart(part, patterns, session, copyMode) {
  if (typeof part === "string") return redactText(part, patterns, session).text;
  if (!part || typeof part !== "object") return part;
  const mustCopy = copyMode || Object.isFrozen(part);
  if (Array.isArray(part) || isPlainObjectValue(part)) {
    if (!mustCopy) {
      redactDeep(part, patterns, session);
      return part;
    }
    const copy = deepCopyPlain(part);
    redactDeep(copy, patterns, session);
    return copy;
  }
  // typed part instance: explicit known fields only (never a generic walk)
  const target = mustCopy ? cloneWithOwnFields(part) : part;
  let changed = false;
  if (ownDataField(target, "text") && typeof target.text === "string") {
    const redacted = redactText(target.text, patterns, session).text;
    if (redacted !== target.text) changed = true;
    target.text = redacted;
  }
  for (const key of ["input", "result"]) {
    if (!ownDataField(target, key)) continue;
    const parsed = target[key];
    if (typeof parsed === "string") {
      const redacted = redactText(parsed, patterns, session).text;
      if (redacted !== parsed) changed = true;
      target[key] = redacted;
    } else if (Array.isArray(parsed) || isPlainObjectValue(parsed)) {
      if (!mustCopy && !Object.isFrozen(parsed)) {
        redactDeep(parsed, patterns, session);
      } else {
        const copy = deepCopyPlain(parsed);
        redactDeep(copy, patterns, session);
        target[key] = copy;
        changed = true;
      }
    }
    // other parsed shapes: undocumented, untouched
  }
  return mustCopy ? (changed ? target : part) : part;
}

/**
 * Redact one request message entry of the documented transport shapes:
 *   - string / plain object / plain array: the existing engine walk
 *     (redactDeep), with a deep-copied redaction when frozen;
 *   - typed instance carrying its own `content` (SDK Message class): the
 *     content string / content parts are redacted via redactContentPart;
 *   - typed instance carrying its own `text` (system/text part): the text is
 *     redacted directly.
 * `forceCopy` (an ancestor container is frozen) requires copy-on-write: the
 * returned entry is then a prototype-preserving clone and the original
 * instance is never mutated. Returns the entry to store in the array: the
 * same instance when mutated in place, a clone when frozen/forceCopy, or null
 * for undocumented typed shapes — which stay untouched, never broadened.
 * role/id/metadata/providerMetadata are never entered.
 */
function redactRequestEntry(entry, patterns, session, forceCopy = false) {
  if (typeof entry === "string") return redactText(entry, patterns, session).text;
  if (!entry || typeof entry !== "object") return entry;
  if (Array.isArray(entry) || isPlainObjectValue(entry)) {
    if (!forceCopy && !Object.isFrozen(entry)) {
      redactDeep(entry, patterns, session);
      return entry;
    }
    const copy = deepCopyPlain(entry);
    redactDeep(copy, patterns, session);
    return copy;
  }
  const entryFrozen = forceCopy || Object.isFrozen(entry);
  if (ownDataField(entry, "content")) {
    const content = entry.content;
    if (typeof content === "string") {
      const redacted = redactText(content, patterns, session).text;
      if (redacted === content) return entry;
      if (entryFrozen) {
        const target = cloneWithOwnFields(entry);
        target.content = redacted;
        return target;
      }
      entry.content = redacted;
      return entry;
    }
    if (Array.isArray(content)) {
      const copyMode = entryFrozen || Object.isFrozen(content);
      const parts = copyMode ? content.slice() : content;
      let changed = false;
      for (let i = 0; i < parts.length; i++) {
        const out = redactContentPart(parts[i], patterns, session, copyMode);
        if (out !== parts[i]) {
          parts[i] = out;
          changed = true;
        }
      }
      if (!changed) return entry;
      if (copyMode && entryFrozen) {
        const target = cloneWithOwnFields(entry);
        target.content = parts;
        return target;
      }
      if (copyMode) {
        entry.content = parts; // content array was frozen, the message is not
        return entry;
      }
      return entry; // mutated in place through the shared, writable array
    }
    return entry; // content of another type: untouched
  }
  if (ownDataField(entry, "text") && typeof entry.text === "string") {
    const redacted = redactText(entry.text, patterns, session).text;
    if (redacted === entry.text) return entry;
    if (entryFrozen) {
      const target = cloneWithOwnFields(entry);
      target.text = redacted;
      return target;
    }
    entry.text = redacted;
    return entry;
  }
  return null; // undocumented typed shape: never broadened
}

/**
 * Redact a request field that is an array of message entries. A frozen array
 * is redacted on a copy (entries via copy-on-write, so nothing the host
 * pinned readonly is mutated) which the caller must re-assign on the hook
 * input.
 */
function redactRequestArray(entries, patterns, session) {
  const arrayFrozen = Object.isFrozen(entries);
  const target = arrayFrozen ? entries.slice() : entries;
  for (let i = 0; i < target.length; i++) {
    const out = redactRequestEntry(target[i], patterns, session, arrayFrozen);
    if (out === null) continue; // undocumented typed shape stays untouched
    if (out !== target[i]) target[i] = out;
  }
  return arrayFrozen ? target : entries;
}

/**
 * Create the v2 plugin. `options.requestFields` defaults to
 * ["messages", "system"] — the mutable request-content fields of
 * SessionContext / SessionRequest. No prompt-domain hook is registered.
 */
export function createVibeGuardV2Plugin(options = {}) {
  return {
    id: options.id ?? "vibeguard-privacy-v2",
    async setup(ctx) {
      const directory =
        ctx?.directory ?? ctx?.location?.directory ?? options.directory ?? process.cwd();
      const config = await loadConfig(directory);
      if (!config.enabled) return; // no-op parity with v1: missing config or enabled=false never touches traffic

      const patterns = buildPatternSet(config.patterns);
      const sessions = new Map();

      const getSession = (sessionID) => {
        const key = String(sessionID ?? "");
        if (!key) return null;
        const existing = sessions.get(key);
        if (existing) return existing;
        const created = new PlaceholderSession({
          prefix: config.prefix,
          ttlMs: config.ttlMs,
          maxMappings: config.maxMappings,
        });
        sessions.set(key, created);
        return created;
      };

      const redactFields = (input, fields) => {
        const session = getSession(input?.sessionID);
        if (!session) return;
        session.cleanup?.();
        for (const field of fields) {
          const value = input?.[field];
          // Root string fields (e.g. a plain-string `system`) cannot be
          // mutated in place by a deep helper: the redacted primitive must be
          // re-assigned or protected data reaches the model unchanged.
          if (typeof value === "string") {
            input[field] = redactText(value, patterns, session).text;
          } else if (Array.isArray(value)) {
            // Message/part entries may be typed SDK instances (see the
            // adapter above); a frozen array comes back as a redacted copy
            // that must replace the field on the hook input.
            const redacted = redactRequestArray(value, patterns, session);
            if (redacted !== value) input[field] = redacted;
          } else if (value !== undefined && value !== null) {
            const out = redactRequestEntry(value, patterns, session);
            if (out !== null && out !== value) input[field] = out;
          }
        }
      };

      const requestFields = options.requestFields ?? ["messages", "system"];
      const registrations = [];
      // WebSocket delta-accumulation scopes. Scope key: sessionID + agent
      // + model (pinned SDK Model.Ref = {id, providerID, variant?} — the
      // model identity is `id`/`providerID`; `modelID` is read only as a
      // fallback for hosts on other shapes) + request kind. Reset per model
      // call by experimental.ws.handshake, cleared on plugin dispose.
      const wsScopes = new Map();
      const register = async (domain, name, handler) => {
        const reg = await domain.hook(name, handler);
        if (reg) registrations.push(reg);
      };

        const sessionHook = ctx?.session?.hook;
        if (typeof sessionHook === "function") {
        // request redaction: primary + auxiliary model-facing request kinds
        // where protected input can reach the model. The pre-admission
        // session.prompt hook is deliberately NOT registered: a mutating
        // prompt handler would alter the stored original user message before
        // storage (raw input must reach the store untouched).
        for (const name of ["context", "compaction", "generate", "title"]) {
          await register(ctx.session, name, (input) => redactFields(input, requestFields));
        }
        // final-output restoration over the only public model-output surface
        await register(ctx.session, "http.response", async (input) => {
          const session = getSession(input?.sessionID);
          if (!session) return;
          session.cleanup?.();
          input.response = await restoreResponse(input.response, session);
        });
        // WebSocket-backed providers bypass the HTTP hooks entirely (official
        // v2 docs), so inbound WS frames are restored here through the same
        // delta-aware, bounded restorer. The pinned SDK's
        // SessionWebSocketReceive carries no connection identifier, but wire
        // events carry per-stream IDs (item_id, content_index, ...) which the
        // restorer uses as semantic stream identity, so annotated concurrent
        // completions stay isolated within a scope. experimental.ws.handshake
        // runs once per model call and resets the scope fail-closed. Both
        // surfaces are experimental in the plugin SDK; a host that rejects
        // them must not break setup. The precise unsupported WS cases are
        // documented in the file header and the manifest — never silently
        // ignored in acceptance evidence.
        const wsScopeKey = (input) =>
          [
            input?.sessionID,
            input?.agent,
            input?.model?.providerID,
            // pinned SDK Model.Ref carries `id` (not `modelID`); keep the
            // legacy key as a fallback for other host shapes
            input?.model?.id ?? input?.model?.modelID,
            input?.kind,
          ]
            .map((part) => String(part ?? ""))
            .join("\u0000");
        const wsRestorer = (input) => {
          const session = getSession(input?.sessionID);
          if (!session) return null;
          session.cleanup?.();
          const key = wsScopeKey(input);
          let restorer = wsScopes.get(key);
          if (!restorer) {
            restorer = new OutputStreamRestorer(session);
            wsScopes.set(key, restorer);
          }
          return restorer;
        };
        try {
          await register(ctx.session, "experimental.ws.handshake", (input) => {
            const key = wsScopeKey(input);
            wsScopes.get(key)?.dispose();
            wsScopes.delete(key);
          });
        } catch {
          // host without experimental.ws.handshake: scopes then live until
          // plugin dispose (documented fail-open corner, see manifest)
        }
        try {
          await register(ctx.session, "experimental.ws.receive", (input) => {
            const restorer = wsRestorer(input);
            if (!restorer) return;
            input.frame = restoreWsFrame(restorer, input.frame);
          });
        } catch {
          // host without experimental.ws.receive: documented coverage limit
        }
      }

      const toolHook = ctx?.tool?.hook;
      if (typeof toolHook === "function") {
        // model-authored tool arguments may contain placeholders; local
        // execution must see the real values. Root string inputs (tools
        // whose input is a bare string primitive) need re-assignment — a
        // mutating deep helper silently no-ops on primitives.
        await register(ctx.tool, "execute.before", (input) => {
          const session = getSession(input?.sessionID);
          if (!session) return;
          session.cleanup?.();
          if (typeof input?.input === "string") {
            input.input = restoreText(input.input, session);
          } else {
            restoreDeep(input?.input, session);
          }
        });
      }

      return async () => {
        for (const reg of registrations) {
          try {
            await reg?.dispose?.();
          } catch {
            // best-effort dispose
          }
        }
        for (const restorer of wsScopes.values()) restorer.dispose();
        wsScopes.clear();
        sessions.clear();
      };
    },
  };
}

/**
 * Host-facing default export (v2 plugin contract): `{id, setup}`. Hosts load
 * this module and call `setup(hooks)` directly; `createVibeGuardV2Plugin`
 * stays available for explicit configuration.
 */
export default createVibeGuardV2Plugin();