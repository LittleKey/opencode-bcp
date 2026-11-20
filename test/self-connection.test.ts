import { describe, expect, test } from "bun:test"
import {
  deriveLoopbackConnection, SelfConnectionError,
} from "../src/adapters/v2/self-connection"

const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

const tcpRow = (address: string, port: number, inode: number, state = "0A") =>
  `  0: ${address}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000  ${state} 00000000:000000 00:00000000 00000000     0        0 ${inode} ffff880000000000 100 0 0 10 0`

describe("deriveLoopbackConnection", () => {
  const deps = (tcp: string, tcp6 = "", links: string[] = [], env: Record<string, string | undefined> = {}) => ({
    readProcFile: (path: string) => path.endsWith("tcp6") ? tcp6 : tcp,
    listFds: () => links.map(link => ({ link })),
    env,
    pid: 4242,
  })

  test("derives the single own loopback listener with password precedence", () => {
    const connection = deriveLoopbackConnection(deps(
      tcpHeader + tcpRow("0100007F", 40019, 9001),
      "",
      [`socket:[9001]`, `socket:[9002]`, "/dev/null"],
      { OPENCODE_PASSWORD: "pw-a", OPENCODE_SERVER_PASSWORD: "pw-b" },
    ))
    expect(connection.baseUrl).toBe("http://127.0.0.1:40019")
    expect(connection.serverPid).toBe(4242)
    expect(connection.headers.Authorization).toBe(`Basic ${Buffer.from("opencode:pw-a").toString("base64")}`)
  })

  test("falls back to OPENCODE_SERVER_PASSWORD then no header", () => {
    const onlyServer = deriveLoopbackConnection(deps(
      tcpHeader + tcpRow("0100007F", 1, 1), "", ["socket:[1]"], { OPENCODE_SERVER_PASSWORD: "pw-b" },
    ))
    expect(onlyServer.headers.Authorization).toBe(`Basic ${Buffer.from("opencode:pw-b").toString("base64")}`)
    // An EMPTY OPENCODE_PASSWORD is not a credential: it falls through too.
    const emptyPrimary = deriveLoopbackConnection(deps(
      tcpHeader + tcpRow("0100007F", 1, 1), "", ["socket:[1]"],
      { OPENCODE_PASSWORD: "", OPENCODE_SERVER_PASSWORD: "pw-b" },
    ))
    expect(emptyPrimary.headers.Authorization).toBe(`Basic ${Buffer.from("opencode:pw-b").toString("base64")}`)
    const none = deriveLoopbackConnection(deps(
      tcpHeader + tcpRow("0100007F", 1, 1), "", ["socket:[1]"], {},
    ))
    expect(none.headers).toEqual({})
  })

  test("supports the ipv6 loopback form", () => {
    const connection = deriveLoopbackConnection(deps(
      tcpHeader,
      tcpHeader + tcpRow("00000000000000000000000001000000", 33107, 77),
      ["socket:[77]"],
    ))
    expect(connection.baseUrl).toBe("http://[::1]:33107")
  })

  test("ignores non-loopback listeners and sockets owned by other processes", () => {
    const tcp = tcpHeader + [
      tcpRow("0100007F", 40019, 9001),            // loopback but not ours
      tcpRow("0100007F", 40020, 9002),            // ours
      tcpRow("00000000", 40021, 9003),            // 0.0.0.0, not loopback
      tcpRow("0100007F", 40022, 9004, "01"),      // ESTABLISHED, not LISTEN
    ].join("\n")
    const connection = deriveLoopbackConnection(deps(tcp, "", ["socket:[9002]"], {}))
    expect(connection.baseUrl).toBe("http://127.0.0.1:40020")
  })

  test("refuses zero listeners", () => {
    expect(() => deriveLoopbackConnection(deps(tcpHeader))).toThrow(SelfConnectionError)
    try { deriveLoopbackConnection(deps(tcpHeader)) } catch (error) {
      expect((error as SelfConnectionError).reason).toBe("no_listener")
    }
  })

  test("refuses several distinct own listeners", () => {
    const tcp = tcpHeader + tcpRow("0100007F", 1, 11) + "\n" + tcpRow("0100007F", 2, 22)
    expect(() => deriveLoopbackConnection(deps(tcp, "", ["socket:[11]", "socket:[22]"])))
      .toThrow(SelfConnectionError)
    try { deriveLoopbackConnection(deps(tcp, "", ["socket:[11]", "socket:[22]"])) } catch (error) {
      expect((error as SelfConnectionError).reason).toBe("ambiguous_listener")
    }
  })

  test("refuses dual-stack v4+v6 listeners even on the same port", () => {
    // Two distinct sockets (one per family) on one port are still two
    // candidates; a single kernel dual-stack listener appears in tcp6 only.
    const tcp = tcpHeader + tcpRow("0100007F", 33107, 11)
    const tcp6 = tcpHeader + tcpRow("00000000000000000000000001000000", 33107, 22)
    expect(() => deriveLoopbackConnection(deps(tcp, tcp6, ["socket:[11]", "socket:[22]"])))
      .toThrow(SelfConnectionError)
    try { deriveLoopbackConnection(deps(tcp, tcp6, ["socket:[11]", "socket:[22]"])) } catch (error) {
      expect((error as SelfConnectionError).reason).toBe("ambiguous_listener")
    }
  })
})
