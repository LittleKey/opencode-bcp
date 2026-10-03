/**
 * Exactly-one-compression-engine guard (per emitted bundle copy).
 *
 * SCOPE (precise, load-bearing): the `claimed` map is module-local to ONE
 * emitted bundle copy. Both compression wrappers of that copy (v1 and v2)
 * import this same module instance, so within one bundle copy at most one
 * engine can be armed at a time.
 *
 * What this guard is NOT:
 * - NOT a process-global exclusion. A host process may legitimately run
 *   several projects side by side, each with its own bundle copy (or another
 *   project's compression plugin entirely): separate module instances keep
 *   separate registries and never conflict. This module must never grow a
 *   global/per-process lock keyed on anything broader than the bundle copy.
 * - NOT a request router. It proves nothing about per-request routing by
 *   itself; the supported invariant is "this bundle copy arms at most one
 *   engine, and the wrapper that owns the claim releases it on host cleanup"
 *   (the v2 wrapper releases on its returned cleanup function).
 *
 * Unmodified stock plugins and other bundles do not participate in this
 * registry; detecting a conflicting foreign compressor is out of scope here —
 * the wrappers fail loudly only on their OWN double-arm attempts.
 */

const claimed = new Map();

/**
 * Claim the compression engine slot for `kind` ("compression-v1" | "compression-v2")
 * within this bundle copy. Throws when any engine (including the same kind) is
 * already claimed here. Returns a release token; `release()` frees the slot and
 * is idempotent-safe (a released token releasing again is a no-op).
 */
export function claimEngine(kind) {
  if (claimed.has(kind)) {
    throw new Error(
      `compression engine conflict: "${kind}" is already armed in this bundle copy; refusing to arm it twice (exactly one engine per bundle copy)`,
    );
  }
  if (claimed.size > 0) {
    const [existing] = [...claimed.keys()];
    throw new Error(
      `compression engine conflict: "${existing}" is already armed in this bundle copy; refusing to arm "${kind}" as well (exactly one engine per bundle copy)`,
    );
  }
  const token = {
    kind,
    released: false,
    release() {
      if (claimed.get(kind) === token) claimed.delete(kind);
      token.released = true;
    },
  };
  claimed.set(kind, token);
  return token;
}

/** Test/diagnostic helper: currently claimed kinds in this bundle copy, insertion order. */
export function claimedEngines() {
  return [...claimed.keys()];
}
