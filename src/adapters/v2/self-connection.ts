import { readFileSync, readdirSync, readlinkSync } from "node:fs"

/** Connection to the OpenCode server this plugin instance runs inside.
 * Derived only from the process's own listening sockets and environment;
 * never from tool arguments or plugin JSON.
 */
export type LoopbackConnection = {
  baseUrl: string
  headers: Record<string, string>
  serverPid: number
}

export type SelfConnectionReason = "no_listener" | "ambiguous_listener"

export class SelfConnectionError extends Error {
  constructor(public readonly reason: SelfConnectionReason) { super(reason) }
}

export type SelfConnectionDeps = {
  /** Read a /proc file (utf8). */
  readProcFile?: (path: string) => string
  /** List this process's open file descriptors with their link targets. */
  listFds?: () => Array<{ link: string }>
  env?: Record<string, string | undefined>
  pid?: number
}

const IPV4_LOOPBACK = "0100007F" // 127.0.0.1 in /proc/net/tcp byte order
const IPV6_LOOPBACK = "00000000000000000000000001000000" // ::1 in /proc/net/tcp6 byte order

type Listener = { address: string; port: number; inode: string }

function parseListeners(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 10) continue
    const [local, state, inode] = [columns[1], columns[3], columns[9]]
    if (state !== "0A") continue // TCP_LISTEN
    const separator = local.lastIndexOf(":")
    if (separator < 0) continue
    const address = local.slice(0, separator)
    const port = Number.parseInt(local.slice(separator + 1), 16)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    if (!/^\d+$/.test(inode)) continue
    out.push({ address, port, inode })
  }
  return out
}

/** Derive the loopback connection for THIS server process.
 * Exactly one loopback LISTEN socket owned by the process is accepted;
 * zero or several distinct candidates are refused, never guessed.
 * The password is never returned or logged outside the Authorization header.
 */
export function deriveLoopbackConnection(deps: SelfConnectionDeps = {}): LoopbackConnection {
  const readProcFile = deps.readProcFile ?? ((path: string) => readFileSync(path, "utf8"))
  const listFds = deps.listFds ?? (() => {
    const links: Array<{ link: string }> = []
    for (const fd of readdirSync("/proc/self/fd")) {
      try { links.push({ link: readlinkSync(`/proc/self/fd/${fd}`) }) } catch { /* closed */ }
    }
    return links
  })
  const env = deps.env ?? process.env
  const socketInodes = new Set<string>()
  for (const { link } of listFds()) {
    const match = /^socket:\[(\d+)\]$/.exec(link)
    if (match) socketInodes.add(match[1]!)
  }
  const candidates = new Set<string>()
  for (const { ipv6, text } of [
    { ipv6: false, text: readProcFile("/proc/self/net/tcp") },
    { ipv6: true, text: readProcFile("/proc/self/net/tcp6") },
  ]) {
    for (const listener of parseListeners(text)) {
      if (listener.address !== (ipv6 ? IPV6_LOOPBACK : IPV4_LOOPBACK)) continue
      if (!socketInodes.has(listener.inode)) continue
      candidates.add(ipv6 ? `http://[::1]:${listener.port}` : `http://127.0.0.1:${listener.port}`)
    }
  }
  if (candidates.size === 0) throw new SelfConnectionError("no_listener")
  if (candidates.size > 1) throw new SelfConnectionError("ambiguous_listener")
  const headers: Record<string, string> = {}
  // Fixed username "opencode": the host's built-in Basic-auth name. A host
  // using a custom username cannot be self-derived and stays fail-closed.
  const password = env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD
  if (password) headers.Authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  return { baseUrl: [...candidates][0]!, headers, serverPid: deps.pid ?? process.pid }
}
