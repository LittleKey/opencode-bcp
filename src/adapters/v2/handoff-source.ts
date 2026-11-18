import { constants, openSync, fstatSync, readSync, closeSync, lstatSync, realpathSync } from "node:fs"
import { isAbsolute, dirname, resolve } from "node:path"

/** Operator-owned JSON policy, re-opened every check. This is an explicit
 * attestation of upstream retention and every actual file reader, NOT inferred
 * from ancestry/UID. Keep outside model-writable project trees.
 */
export function readOperatorPolicy(path: string, expected: {
  taskId: string; taskRoot: string; callerSessionId: string; agent: string; sourceSessionId: string
}): boolean {
  if (!isAbsolute(path) || path !== resolve(path)) return false
  let fd: number | undefined
  try {
    if (realpathSync(path) !== path) return false
    for (let parent = dirname(path);;) {
      const stat = lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
        (stat.uid !== 0 && stat.uid !== process.getuid?.())) return false
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    const limit = 64 * 1024
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return false
    const bytes = Buffer.alloc(limit + 1)
    let size = 0
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null)
      if (!n) break
      size += n
    }
    if (size > limit) return false
    const data: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"))
    if (!data || typeof data !== "object" || Array.isArray(data)) return false
    const policy = data as Record<string, unknown>
    if (policy.schema !== "bcp.operator-handoff-policy.v1" || !Array.isArray(policy.grants) ||
      policy.grants.length > 128) return false
    const matches = policy.grants.filter((grant: unknown) => {
      if (!grant || typeof grant !== "object") return false
      const g = grant as Record<string, unknown>
      return Object.entries(expected).every(([key, value]) => g[key] === value)
    })
    return matches.length === 1 && matches[0].authorized === true &&
      matches[0].noStore === false && matches[0].sharedReadersApproved === true &&
      typeof matches[0].expiresAt === "number" && matches[0].expiresAt > Date.now()
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}
