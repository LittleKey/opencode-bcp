/**
 * Bounded, request/output-scoped placeholder restoration for streaming
 * provider output (HTTP/SSE bodies and WebSocket receive frames).
 *
 * Problem: the model echoes request placeholders (`__VG_<CATEGORY>_<hash12>__`)
 * back inside its output. Providers deliver that output as semantic delta
 * events (OpenAI `choices[].delta.content`, Anthropic `content_block_delta`,
 * Responses `response.output_text.delta`, legacy `choices[].text`, ...), and a
 * placeholder may be split at ANY character offset across two or more delta
 * events. Restoring only complete frames (the previous behavior) left split
 * placeholders unresolved in the user-visible text.
 *
 * Mechanism: one `OutputStreamRestorer` per output stream (one HTTP response
 * body, or one WebSocket receive scope). Delta text segments are keyed by a
 * CANONICAL semantic identity: the JSON structural role of the text field with
 * array positions erased (`choices[].delta.content`) plus the sorted set of
 * the event's annotation fields (`index`, `item_id`, `output_index`,
 * `content_index`, `block_index`). JSON property order and physical array
 * position are never part of the identity — `{index,delta}` and
 * `{delta,index}` are the same stream, and choices keyed by `index` value stay
 * isolated when their array positions are swapped. Each key keeps a pending
 * tail: text that has been restored but may still be the STRICT PREFIX of a
 * session mapping key (an incomplete placeholder). Complete placeholders are
 * restored immediately; the pending tail is re-emitted merged into the next
 * delta of the same key, so consumers that accumulate deltas see the exact
 * original text with placeholders resolved.
 *
 * End-of-stream preservation: a pending tail is never dropped and never
 * emitted as an SSE comment. At stream end every pending fragment is
 * re-emitted as a provider-shaped delta DATA event (same role and annotations
 * as the stream it belongs to), so decoded consumer text — what any consumer
 * accumulating delta fields observes — is exactly the original model output:
 * ordinary text tails (`_emphasis_`), unknown placeholder-shaped literals,
 * and incomplete prefix fragments are all preserved verbatim and stay inert.
 *
 * Bounds (no conversation-sized buffering):
 *   - pending tail per delta key  <  longest mapping key of the session
 *   - delta keys per stream       <= MAX_ACCUMULATORS (beyond: complete-only
 *     restoration, no holdback — degraded but never unbounded)
 *   - SSE byte buffer             <= one provider event, enforced
 *     INCREMENTALLY: an event that crosses MAX_FRAME_BYTES without a
 *     terminator is passed through immediately (never accumulated further);
 *     only one event is ever buffered
 *   - restorer lifetime = one HTTP response, or one WebSocket scope
 *     (sessionID, agent, model, kind) reset by experimental.ws.handshake
 *
 * Atomic (non-delta) events — completion echoes like `response.completed`,
 * non-streaming `finish_reason` responses, `message_stop` — are restored
 * whole-frame so their complete text is fixed up in place; unchanged frames,
 * `data: [DONE]`, and non-JSON events pass through byte-identical.
 *
 * Tool-argument retention: JSON-encoded model tool input (OpenAI chat
 * `tool_calls[].function.arguments`, Anthropic `input_json_delta`
 * `partial_json`, Responses `response.function_call_arguments.*` deltas and
 * atomic `function_call.arguments`) is JSON *source text* the host parses
 * AFTER the frame completes. Restoring a placeholder there would splice the
 * mapped original — which may itself contain `"` or `\` — into the JSON
 * source and corrupt the tool call before the host parses it (verified
 * repro). Placeholders are therefore RETAINED verbatim in those fields; the
 * host parses the serialized arguments and `tool.execute.before` restores
 * the parsed values safely. Ordinary textual delta restoration (final text,
 * reasoning) is unaffected.
 */

import { restoreText } from "./vibeguard/restore.js";

/**
 * String fields whose value is JSON-encoded model tool input — JSON *source
 * text* the host parses after the frame/body completes (OpenAI chat
 * `tool_calls[].function.arguments`, Anthropic `input_json_delta`
 * `partial_json`, Responses atomic `function_call.arguments`). Placeholders
 * are NEVER restored inside these fields on the wire: a mapped value
 * containing `"` or `\` would corrupt the JSON before the host parses it.
 * The host parses the serialized arguments first, then `tool.execute.before`
 * restores the parsed values safely.
 */
export const TOOL_JSON_KEYS = new Set(["arguments", "partial_json"]);

/** Responses event types whose `delta` field carries JSON-encoded tool arguments. */
export const TOOL_JSON_EVENT_PREFIX = "response.function_call_arguments.";

/** String fields that carry provider semantic delta text. */
export const DELTA_TEXT_KEYS = new Set([
  "content",
  "text",
  "delta",
  "reasoning_content",
  "thinking",
]);

/** Annotation fields that identify the stream an event belongs to. */
export const INDEX_KEYS = new Set(["index", "output_index", "content_index", "item_id", "block_index"]);

/** Top-level `type` values of atomic (echo / lifecycle) events. */
export const ATOMIC_TYPE_RE = /(?:^|\.)(?:completed|incomplete|failed|done|stop)$/;

export const MAX_ACCUMULATORS = 4096;
export const MAX_FRAME_BYTES = 1024 * 1024;

function mappingKeys(session) {
  const forward = session?.forward;
  if (!forward || typeof forward.keys !== "function") return [];
  return Array.from(forward.keys());
}

/* ---------------------------------------------------------------------------
 * SSE wire parsing (line-terminator aware)
 *
 * The SSE spec allows CR, LF, or CRLF as the line terminator; an event ends
 * at a blank line. All parsing below accepts any mixture — it never assumes
 * "\n\n" framing and never rewrites a frame that was not restored.
 * ------------------------------------------------------------------------- */

/** Split text into lines, each with its exact terminator ("" on the last). */
export function splitSseLines(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const cr = text.indexOf("\r", start);
    const idx = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
    if (idx === -1) {
      lines.push({ text: text.slice(start), term: "" });
      return lines;
    }
    const term = text[idx] === "\r" && text[idx + 1] === "\n" ? "\r\n" : text[idx];
    lines.push({ text: text.slice(start, idx), term });
    start = idx + term.length;
  }
}

/**
 * Find the end of the next SSE event in `buffer` (scanning from `from`):
 * the first EMPTY line. Returns `{found: true, end, next}` where `end` is the
 * event content end (start of the blank line) and `next` is past the blank
 * line's terminator, or `{found: false, resume}` where `resume` is the safe
 * rescan offset (start of the incomplete last line) for the next chunk.
 */
export function findSseEventEnd(buffer, from = 0) {
  let lineStart = from;
  for (;;) {
    const nl = buffer.indexOf("\n", lineStart);
    const cr = buffer.indexOf("\r", lineStart);
    if (nl === -1 && cr === -1) return { found: false, resume: lineStart };
    const idx = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
    const next = buffer[idx] === "\r" && buffer[idx + 1] === "\n" ? idx + 2 : idx + 1;
    if (idx === lineStart) return { found: true, end: lineStart, next };
    lineStart = next;
  }
}

/** Joined `data:` payload of one event (single leading space stripped), or null. */
export function sseDataPayload(eventText) {
  const data = [];
  for (const line of splitSseLines(eventText)) {
    if (!line.text.startsWith("data:")) continue;
    let value = line.text.slice(5);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
  }
  return data.length === 0 ? null : data.join("\n");
}

/* ---------------------------------------------------------------------------
 * End-of-stream tail carriers
 *
 * A pending fragment is re-emitted as a delta DATA event in the shape of the
 * stream it belongs to, derived from the canonical key (role + annotations)
 * the provider itself used. Comments and dropped tails are not preservation;
 * a carrier event is what a delta-accumulating consumer actually observes.
 * ------------------------------------------------------------------------- */

export function tailCarrierEvent(key, tail) {
  const hash = key.indexOf("#");
  const role = hash === -1 ? key : key.slice(0, hash);
  const ann = {};
  if (hash !== -1) {
    for (const pair of key.slice(hash + 1).split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0) ann[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  const num = (name) => {
    const n = Number(ann[name]);
    return Number.isFinite(n) ? n : 0;
  };
  // Responses-style output items are identified by their wire item_id.
  if (typeof ann.item_id === "string") {
    return JSON.stringify({
      type: "response.output_text.delta",
      item_id: ann.item_id,
      output_index: num("output_index"),
      content_index: num("content_index"),
      delta: tail,
    });
  }
  // Anthropic content_block_delta: bare `.delta.text` role with a block index.
  if (role === ".delta.text") {
    return JSON.stringify({
      type: "content_block_delta",
      index: num("index"),
      delta: { type: "text_delta", text: tail },
    });
  }
  // OpenAI chat deltas and legacy text completions.
  if (role.startsWith(".choices[]")) {
    if (role === ".choices[].text") {
      return JSON.stringify({ choices: [{ index: num("index"), text: tail }] });
    }
    const field = role.endsWith(".reasoning_content")
      ? "reasoning_content"
      : role.endsWith(".thinking")
        ? "thinking"
        : "content";
    return JSON.stringify({ choices: [{ index: num("index"), delta: { [field]: tail } }] });
  }
  // Documented generic carrier (the module's WS `delta` shape) for event
  // shapes outside the enumerated provider families.
  return JSON.stringify({ delta: tail });
}

/**
 * Accumulator store for one output stream.
 * `session` is the PlaceholderSession whose mappings placehold -> original
 * apply to this stream; lookups never cross sessions.
 */
export class OutputStreamRestorer {
  /** @param {{ prefix: string, forward?: Map<string,string>, lookup(ph: string): string|undefined }} session */
  constructor(session, { maxAccumulators = MAX_ACCUMULATORS } = {}) {
    this.session = session;
    this.#maxAccumulators = Number.isFinite(maxAccumulators) ? maxAccumulators : MAX_ACCUMULATORS;
  }

  #accumulators = new Map();
  #maxAccumulators;
  #maxKeyLen = 0;
  #maxKeySize = -1;

  /** Restore a complete (non-delta) string: complete placeholders only. */
  restoreComplete(text) {
    return restoreText(text, this.session);
  }

  /**
   * Feed one semantic delta text segment of stream `key`; returns the text
   * that may be emitted for it right now (possibly "" while a placeholder
   * fragment is pending). Emitted + pending always equals the accumulated
   * input with every completable placeholder restored.
   */
  restoreDelta(key, text) {
    let acc = this.#accumulators.get(key);
    if (!acc) {
      if (this.#accumulators.size >= this.#maxAccumulators) {
        // Degraded, still bounded: complete-placeholder-only restoration.
        return restoreText(String(text ?? ""), this.session);
      }
      acc = { pending: "" };
      this.#accumulators.set(key, acc);
    }
    acc.pending += String(text ?? "");
    if (!acc.pending) return "";
    const restored = restoreText(acc.pending, this.session);
    const tail = this.#holdback(restored);
    acc.pending = tail;
    return restored.slice(0, restored.length - tail.length);
  }

  /**
   * All unemitted pending fragments with their provider-shaped tail carriers;
   * clears the accumulators. Each entry is `{key, tail, carrier}` where
   * `carrier` is a JSON delta event carrying `tail` in the stream's own shape.
   */
  flushAll() {
    const entries = [];
    for (const [key, acc] of this.#accumulators) {
      if (!acc.pending) continue;
      entries.push({ key, tail: acc.pending, carrier: tailCarrierEvent(key, acc.pending) });
    }
    this.#accumulators.clear();
    return entries;
  }

  /** Release stream state (stream end or cancellation). */
  dispose() {
    this.#accumulators.clear();
  }

  #refreshBounds() {
    const size = this.session?.forward?.size ?? 0;
    if (size === this.#maxKeySize) return;
    this.#maxKeySize = size;
    let max = 0;
    for (const key of mappingKeys(this.session)) {
      if (key.length > max) max = key.length;
    }
    this.#maxKeyLen = max;
  }

  /**
   * Longest suffix of `str` that is a STRICT PREFIX of some mapping key —
   * i.e. text that may still grow into a restorable placeholder. Scanning is
   * bounded by the longest known key, so holdback can never exceed it.
   * Candidates start at the prefix's first character (every mapping key
   * starts with the prefix), which also catches splits INSIDE the prefix
   * token itself (e.g. a stream that pauses after `__VG`). Leftmost-first
   * scan order yields the longest matching suffix. At stream end any held
   * suffix is re-emitted verbatim through a tail carrier, so an ordinary
   * trailing underscore or unknown literal never loses a character.
   */
  #holdback(str) {
    this.#refreshBounds();
    const maxLen = this.#maxKeyLen;
    if (!str || maxLen <= 1) return "";
    const first = String(this.session?.prefix ?? "__VG_")[0];
    if (!first) return "";
    const keys = mappingKeys(this.session);
    if (keys.length === 0) return "";
    const stop = Math.max(0, str.length - maxLen + 1);
    for (let i = stop; i < str.length; i++) {
      if (str[i] !== first) continue;
      const candidate = str.slice(i);
      for (const key of keys) {
        if (key.length > candidate.length && key.startsWith(candidate)) return candidate;
      }
    }
    return "";
  }
}

/** Canonical per-node annotation set: order-independent, value-tagged. */
function collectAnnotations(node) {
  const found = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (INDEX_KEYS.has(key) && (typeof value === "number" || typeof value === "string")) {
      found.push(`${key}=${String(value)}`);
    }
  }
  if (found.length === 0) return "";
  found.sort();
  return `#${found.join(",")}`;
}

/**
 * Deep restore for ATOMIC frames / whole JSON bodies — the wire-safe variant
 * of the engine's restoreDeep. Identical walk, except placeholders are
 * retained inside JSON-encoded tool-argument strings (TOOL_JSON_KEYS, and
 * `delta` under a `response.function_call_arguments.*` event): those strings
 * are JSON source text the host parses later, so restoring in place would
 * splice quote/backslash values into the source and corrupt the tool call.
 * Parsed tool inputs are restored safely by tool.execute.before instead.
 */
export function restoreWireSafeDeep(value, session) {
  const seen = new WeakSet();

  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") node[i] = restoreText(v, session);
        if (v && typeof v === "object") walk(v);
      }
      return;
    }

    const fnArgsEvent =
      typeof node.type === "string" && node.type.startsWith(TOOL_JSON_EVENT_PREFIX);
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === "string") {
        if (TOOL_JSON_KEYS.has(key) || (key === "delta" && fnArgsEvent)) continue;
        node[key] = restoreText(v, session);
      } else if (v && typeof v === "object") {
        walk(v);
      }
    }
  };

  walk(value);
}

/**
 * Classify + transform one parsed provider event in place.
 * Returns true when any string value changed (callers re-serialize only then).
 *
 * Atomic events (completion echoes, non-streaming responses, stop markers)
 * are restored whole via restoreWireSafeDeep — their text is complete, so
 * every placeholder resolves in-frame and nothing may be held back, while
 * JSON-encoded tool arguments stay untouched. Delta events accumulate their
 * delta-text fields through the restorer; all other strings get
 * complete-only restoration.
 */
export function processEvent(value, restorer) {
  const segments = [];
  const direct = [];
  const ctx = { atomicType: false };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.type === "string" && ATOMIC_TYPE_RE.test(value.type)) ctx.atomicType = true;
  }
  scanNode(value, "", "", ctx, segments, direct, restorer);

  if (ctx.atomicType || (ctx.finishDone && segments.length === 0)) {
    const before = JSON.stringify(value);
    restoreWireSafeDeep(value, restorer.session);
    return JSON.stringify(value) !== before;
  }

  let changed = false;
  for (const item of direct) {
    const restored = restorer.restoreComplete(item.value);
    if (restored !== item.value) {
      item.parent[item.prop] = restored;
      changed = true;
    }
  }
  for (const segment of segments) {
    const emitted = restorer.restoreDelta(segment.key, segment.value);
    if (emitted !== segment.value) {
      segment.parent[segment.prop] = emitted;
      changed = true;
    }
  }
  return changed;
}

function scanNode(node, path, ann, ctx, segments, direct, restorer) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      // Array positions are erased from the identity path: the semantic
      // annotations carried by the elements (index/item_id/...) distinguish
      // streams, not their physical order in the JSON array.
      scanNode(node[i], `${path}[]`, ann, ctx, segments, direct, restorer);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  // This node's annotations are collected BEFORE walking any child, so a
  // sibling `index`/`item_id` annotates every text key of the same object
  // regardless of JSON property order. Per-node sets are sorted, so property
  // order never leaks into the stream identity.
  const ownAnn = ann + collectAnnotations(node);
  // Responses function-call-argument events carry the JSON-encoded tool
  // arguments in a plain `delta` field; their own `type` is the only marker.
  const fnArgsEvent =
    typeof node.type === "string" && node.type.startsWith(TOOL_JSON_EVENT_PREFIX);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (typeof value === "string") {
      if (key === "finish_reason" && value) {
        ctx.finishDone = true;
        continue;
      }
      // Serialized tool arguments stay byte-untouched on the wire (see
      // TOOL_JSON_KEYS): retention is the corruption fix — restoration
      // happens on the host-parsed object via tool.execute.before.
      if (TOOL_JSON_KEYS.has(key) || (key === "delta" && fnArgsEvent)) continue;
      if (DELTA_TEXT_KEYS.has(key)) {
        segments.push({ parent: node, prop: key, key: `${path}.${key}${ownAnn}`, value });
      } else {
        direct.push({ parent: node, prop: key, value });
      }
    } else if (value && typeof value === "object") {
      scanNode(value, `${path}.${key}`, ownAnn, ctx, segments, direct, restorer);
    } else if (key === "done" && value === true) {
      ctx.finishDone = true;
    }
  }
}

/**
 * Restore one complete SSE event block (no trailing blank line). Returns the
 * original string untouched unless a value was actually restored, so framing,
 * `event:`/`id:` lines, comments and unchanged data lines stay byte-identical.
 * Accepts CR, LF, or CRLF line terminators (including mixtures).
 */
export function restoreSseEventBlock(eventText, restorer) {
  const payload = sseDataPayload(eventText);
  if (!payload || payload === "[DONE]") return eventText;
  let value;
  try {
    value = JSON.parse(payload);
  } catch {
    return eventText; // non-JSON data frame: pass through untouched
  }
  if (!processEvent(value, restorer)) return eventText;
  const restored = JSON.stringify(value);
  // Rebuild with a single data line at the first data position; every other
  // line keeps its exact text and terminator. Extra data lines fold into the
  // rebuilt one (SSE joins same-event data lines with "\n" anyway).
  const out = [];
  let inserted = false;
  for (const line of splitSseLines(eventText)) {
    if (line.text.startsWith("data:")) {
      if (!inserted) {
        out.push(`data: ${restored}${line.term}`);
        inserted = true;
      }
      continue;
    }
    out.push(`${line.text}${line.term}`);
  }
  return out.join("");
}

/** Back-compat alias (one event block, as before). */
export const restoreSseFrameBlock = restoreSseEventBlock;

/**
 * TransformStream for an SSE response body. Holds at most one provider event;
 * the bound is enforced INCREMENTALLY — an event that crosses `maxFrameBytes`
 * without a terminator is passed through immediately instead of being
 * buffered further, so memory stays bounded even if no delimiter ever arrives.
 *
 * A terminal `data: [DONE]` event is held back (at most one) so end-of-stream
 * tail carriers stay in-band before it. At flush, every pending placeholder-
 * prefix fragment is re-emitted as a provider-shaped delta DATA event —
 * never as a comment, never dropped — so the decoded consumer text is exactly
 * the original model output. On cancellation stream state is simply released.
 */
export function createSseRestoreTransform(restorer, { maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let scanned = 0; // prefix of `buffer` already verified boundary-free
  let overflow = false; // passing through an oversized event; discard to its boundary
  let heldDone = null; // verbatim [DONE] event held back for in-band carriers

  const emit = (controller, text) => {
    if (text) controller.enqueue(encoder.encode(text));
  };
  const emitEvent = (controller, eventText, term) => {
    if (eventText.length > maxFrameBytes) {
      // Oversized event: pass through without restoration (documented).
      emit(controller, eventText + term);
      return;
    }
    if (sseDataPayload(eventText) === "[DONE]") {
      heldDone = eventText + term;
      return;
    }
    emit(controller, restoreSseEventBlock(eventText, restorer) + term);
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        if (overflow) {
          // Discard the remainder of the oversized event up to its boundary.
          const boundary = findSseEventEnd(buffer, 0);
          if (!boundary.found) {
            buffer = "";
            scanned = 0;
            return;
          }
          buffer = buffer.slice(boundary.next);
          scanned = 0;
          overflow = false;
          continue;
        }
        const boundary = findSseEventEnd(buffer, scanned);
        if (!boundary.found) {
          scanned = boundary.resume;
          if (buffer.length > maxFrameBytes) {
            // Incremental buffer bound: no delimiter, event over the bound —
            // pass through NOW; the buffer never accumulates further.
            emit(controller, buffer);
            buffer = "";
            scanned = 0;
            overflow = true;
          }
          return;
        }
        const eventText = buffer.slice(0, boundary.end);
        const term = buffer.slice(boundary.end, boundary.next);
        buffer = buffer.slice(boundary.next);
        scanned = 0;
        if (heldDone !== null) {
          emit(controller, heldDone);
          heldDone = null;
        }
        emitEvent(controller, eventText, term);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (overflow) {
        emit(controller, buffer);
      } else if (buffer.length > 0) {
        // Final event without a trailing blank line: process, then emit a
        // well-formed blank line so the output stays a valid event stream.
        if (heldDone !== null) {
          emit(controller, heldDone);
          heldDone = null;
        }
        emitEvent(controller, buffer, "\n\n");
      }
      buffer = "";
      // Tail carriers BEFORE the held [DONE]: consumers that stop reading at
      // [DONE] still observe the exact accumulated text.
      for (const entry of restorer.flushAll()) {
        emit(controller, `data: ${entry.carrier}\n\n`);
      }
      if (heldDone !== null) emit(controller, heldDone);
      heldDone = null;
      restorer.dispose();
    },
    cancel() {
      restorer.dispose();
    },
  });
}

/**
 * Restore one inbound WebSocket frame. Frames carrying SSE-shaped payloads
 * (`data:` field lines with any line-ending style) are processed per event
 * block; bare JSON payloads are processed as a single event. Unchanged frames
 * come back byte-identical.
 *
 * A pending fragment merges into the NEXT frame of the same scope. There is
 * deliberately no flush carrier here: when the scope is reset by
 * experimental.ws.handshake, a still-pending fragment is dropped (fail-closed
 * — a stale fragment is never merged into a later model call's stream, and
 * the handshake input carries no frame to re-emit it into; see the plugin
 * manifest for the precise unsupported case).
 */
export function restoreWsFrame(restorer, frame) {
  if (typeof frame !== "string" || !frame) return frame;
  let sseShaped = false;
  for (const line of splitSseLines(frame)) {
    if (line.text.startsWith("data:")) {
      sseShaped = true;
      break;
    }
  }
  if (!sseShaped) {
    let value;
    try {
      value = JSON.parse(frame);
    } catch {
      return frame; // non-JSON frame: pass through untouched
    }
    if (!processEvent(value, restorer)) return frame;
    return JSON.stringify(value);
  }
  let out = "";
  let pos = 0;
  for (;;) {
    const boundary = findSseEventEnd(frame, pos);
    if (!boundary.found) {
      out += restoreSseEventBlock(frame.slice(pos), restorer);
      return out;
    }
    out += restoreSseEventBlock(frame.slice(pos, boundary.end), restorer) + frame.slice(boundary.end, boundary.next);
    pos = boundary.next;
  }
}
