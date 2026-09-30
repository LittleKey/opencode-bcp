import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { COUNCIL_BRIDGE, COUNCIL_TEXT_LIMIT, inspectCouncilSource, type CouncilHost, type CouncilMessage, type CouncilRequest, type CouncilSource } from "../src/council"

const CALLER = "ses_caller"
const TASK = "ses_task"
const SEAT = "councillor-devil"
const INPUT_ID = "msg_input"
const FINAL_ID = "msg_final"
const ANSWER = "最终公开结论\nsecond line"

const inputMessage = (over: Partial<CouncilMessage["info"]> = {}, parts: CouncilMessage["parts"] = [{ type: "text", text: "原始问题" }]): CouncilMessage =>
  ({ info: { id: INPUT_ID, sessionID: TASK, role: "user", parentID: CALLER, ...over }, parts })

const finalMessage = (over: Partial<CouncilMessage["info"]> = {}, parts: CouncilMessage["parts"] = [{ type: "text", text: ANSWER }]): CouncilMessage =>
  ({ info: { id: FINAL_ID, sessionID: TASK, role: "assistant", parentID: INPUT_ID, agent: SEAT, finish: "stop",
    modelID: "glm-5.3-flash", providerID: "newapi", time: { created: 100, completed: 200 }, ...over }, parts })

const makeHost = (over: Partial<CouncilHost> = {}, terminal = finalMessage(), input = inputMessage()) => {
  const calls: string[][] = []
  const host: CouncilHost & { calls: string[][] } = {
    calls,
    parentFor: async () => CALLER,
    message: async (session, id) => { calls.push([session, id]); return id === FINAL_ID ? terminal : id === INPUT_ID ? input : null },
    current: () => true,
    isSeat: async () => true,
    ...over,
  }
  return host
}

const request = (): CouncilRequest => ({ callerSessionID: CALLER, taskID: TASK, agent: SEAT, inputMessageID: INPUT_ID, terminalMessageID: FINAL_ID })

const inspect = (over: Partial<CouncilRequest> = {}, host?: CouncilHost) =>
  inspectCouncilSource({ ...request(), ...over }, host ?? makeHost())

const expectUnavailable = (result: CouncilSource, reason: string) => {
  expect(result.status).toBe("unavailable")
  expect((result as { reason: string }).reason).toBe(reason)
  expect(result).not.toHaveProperty("text")
  expect(result).not.toHaveProperty("text_sha256")
}

describe("council bridge identity", () => {
  test("COUNCIL_BRIDGE is the global registry symbol shared with the OMO helper", () => {
    expect(Symbol.for("opencode.bcp.council.v1") === COUNCIL_BRIDGE).toBe(true)
    expect(COUNCIL_TEXT_LIMIT).toBe(32768)
  })
})

describe("verified originals", () => {
  test("happy path returns verbatim text, digest, author seat, model and message ids", async () => {
    const result = await inspect()
    expect(result.status).toBe("verified")
    expect(result.status === "verified" && result.text).toBe(ANSWER)
    expect(result.status === "verified" && result.text_sha256).toBe(createHash("sha256").update(ANSWER, "utf8").digest("hex"))
    expect(result.status === "verified" && result.agent).toBe(SEAT)
    expect(result.status === "verified" && result.model).toEqual({ modelID: "glm-5.3-flash", providerID: "newapi" })
    expect(result.status === "verified" && result.input_message_id).toBe(INPUT_ID)
    expect(result.status === "verified" && result.terminal_message_id).toBe(FINAL_ID)
    expect(result.status === "verified" && result.schema_version).toBe(1)
    expect(result.status === "verified" && result.text_bytes).toBe(Buffer.byteLength(ANSWER, "utf8"))
  })

  test("missing model fields are reported as literal unknown, never fabricated", async () => {
    const host = makeHost({}, finalMessage({ modelID: undefined, providerID: undefined }))
    const result = await inspect({}, host)
    expect(result.status === "verified" && result.model).toEqual({ modelID: "unknown", providerID: "unknown" })
  })

  test("multibyte text survives byte-exactly and hashes over UTF-8 bytes", async () => {
    const text = "中文🎉emoji 与 <bcp:store> 标签混合"
    const host = makeHost({}, finalMessage({}, [{ type: "text", text }]))
    const result = await inspect({}, host)
    expect(result.status === "verified" && result.text).toBe(text)
    expect(result.status === "verified" && result.text_sha256).toBe(createHash("sha256").update(text, "utf8").digest("hex"))
    expect(result.status === "verified" && result.text_bytes).toBe(Buffer.byteLength(text, "utf8"))
  })

  test("inspector only reads the two task messages through the injected view", async () => {
    const host = makeHost()
    await inspect({}, host)
    expect(host.calls.every(([session, id]) => session === TASK && [INPUT_ID, FINAL_ID].includes(id))).toBe(true)
  })
})

describe("identity and seat mismatches", () => {
  test("direct parent mismatch and parent lookup failure are unverified_owner", async () => {
    expectUnavailable(await inspect({}, makeHost({ parentFor: async () => "ses_other" })), "unverified_owner")
    expectUnavailable(await inspect({}, makeHost({ parentFor: async () => null })), "unverified_owner")
    expectUnavailable(await inspect({}, makeHost({ parentFor: async () => { throw Error("down") } })), "unverified_owner")
  })

  test("requested agent that is not a configured seat is not_configured_seat", async () => {
    expectUnavailable(await inspect({}, makeHost({ isSeat: async () => false })), "not_configured_seat")
    expectUnavailable(await inspect({}, makeHost({ isSeat: async () => { throw Error("x") } })), "not_configured_seat")
  })

  test("actual author agent differing from the requested seat is seat_mismatch", async () => {
    const host = makeHost({}, finalMessage({ agent: "councillor-rogue" }))
    expectUnavailable(await inspect({}, host), "seat_mismatch")
    expectUnavailable(await inspect({}, makeHost({}, finalMessage({ agent: undefined }))), "seat_mismatch")
  })

  test("request shape failures carry no body", async () => {
    expectUnavailable(await inspect({ inputMessageID: "", terminalMessageID: "" }), "no_terminal_identity")
    expectUnavailable(await inspect({ terminalMessageID: "" }), "no_terminal_identity")
    expectUnavailable(await inspect({ callerSessionID: "" }), "invalid_request")
    expectUnavailable(await inspect({ taskID: "" }), "invalid_request")
    expectUnavailable(await inspect({ agent: "" }), "invalid_request")
  })
})

describe("input / terminal message identity", () => {
  test("input message id/session/role mismatches (incl. old input) are rejected", async () => {
    for (const over of [ { id: "msg_old" }, { sessionID: "ses_elsewhere" }, { role: "assistant" } ]) {
      expectUnavailable(await inspect({}, makeHost({}, finalMessage(), inputMessage(over))), "message_identity_unavailable")
    }
  })

  test("terminal parent pointing at an older input is rejected", async () => {
    const host = makeHost({}, finalMessage({ parentID: "msg_old" }), inputMessage({ id: "msg_old" }))
    // 输入消息与请求不一致（请求的是 msg_input，而终结挂在 msg_old 上）。
    expectUnavailable(await inspect({}, host), "message_identity_unavailable")
  })

  test("terminal id/session/role mismatches are rejected", async () => {
    for (const over of [ { id: "msg_other" }, { sessionID: "ses_elsewhere" }, { role: "user" } ]) {
      expectUnavailable(await inspect({}, makeHost({}, finalMessage(over))), "message_identity_unavailable")
    }
  })

  test("missing terminal or input message is message_identity_unavailable", async () => {
    const missingTerminal = makeHost({ message: async (_s, id) => id === INPUT_ID ? inputMessage() : null })
    expectUnavailable(await inspect({}, missingTerminal), "message_identity_unavailable")
    const missingInput = makeHost({ message: async (_s, id) => id === FINAL_ID ? finalMessage() : null })
    expectUnavailable(await inspect({}, missingInput), "message_identity_unavailable")
  })

  test("message read failure is unavailable without body", async () => {
    expectUnavailable(await inspect({}, makeHost({ message: async () => { throw Error("storage down") } })), "message_identity_unavailable")
  })
})

describe("public reply quality", () => {
  test("unfinished terminal (finish tool-calls) is not a public final", async () => {
    expectUnavailable(await inspect({}, makeHost({}, finalMessage({ finish: "tool-calls" }))), "not_public_reply")
  })

  test("synthetic-only text carries no public content", async () => {
    expectUnavailable(await inspect({}, makeHost({}, finalMessage({}, [{ type: "text", text: "internal nudge", synthetic: true }]))), "not_public_reply")
  })

  test("running tool part means the reply is not complete", async () => {
    const parts = [{ type: "text" as const, text: ANSWER }, { type: "tool" as const, state: { status: "running" as const } }]
    expectUnavailable(await inspect({}, makeHost({}, finalMessage({}, parts))), "not_public_reply")
  })

  test("errored or summary messages are not public replies", async () => {
    expectUnavailable(await inspect({}, makeHost({}, finalMessage({ error: { message: "boom" } }))), "not_public_reply")
    expectUnavailable(await inspect({}, makeHost({}, finalMessage({ summary: true }))), "not_public_reply")
  })
})

describe("freshness (current before/after) and read-after recheck", () => {
  test("input already superseded before reading is not_current_input", async () => {
    const host = makeHost({ current: () => false })
    expectUnavailable(await inspect({}, host), "not_current_input")
    expect(host.calls.length).toBe(0)
  })

  test("current flipping to false after the read is not_current_input", async () => {
    let currentCalls = 0
    const host = makeHost({ current: () => currentCalls++ === 0 })
    expectUnavailable(await inspect({}, host), "not_current_input")
  })

  test("terminal content rewritten during the read is message_changed_during_read", async () => {
    let reads = 0
    const host = makeHost({
      message: async (_session, id) => {
        if (id !== FINAL_ID) return inputMessage()
        reads += 1
        return reads === 1 ? finalMessage() : finalMessage({}, [{ type: "text", text: "rewritten" }])
      },
    })
    expectUnavailable(await inspect({}, host), "message_changed_during_read")
  })

  test("terminal identity broken during the recheck is message_changed_during_read", async () => {
    let reads = 0
    const host = makeHost({
      message: async (_session, id) => {
        if (id !== FINAL_ID) return inputMessage()
        reads += 1
        return reads === 1 ? finalMessage() : finalMessage({ parentID: "msg_other" })
      },
    })
    expectUnavailable(await inspect({}, host), "message_changed_during_read")
  })

  test("changed actual agent or model during the recheck is not trusted", async () => {
    for (const delta of [{agent:'councillor-other'}, {modelID:'other-model'}, {providerID:'other-provider'}]) {
      let reads = 0
      const host = makeHost({ message: async (_session, id) => {
        if (id !== FINAL_ID) return inputMessage()
        return ++reads === 1 ? finalMessage() : finalMessage(delta)
      } })
      expectUnavailable(await inspect({}, host), 'message_changed_during_read')
    }
  })

  test("every failure attaches no original text", async () => {
    const results: CouncilSource[] = [
      await inspect({}, makeHost({ parentFor: async () => null })),
      await inspect({}, makeHost({ current: () => false })),
      await inspect({}, makeHost({ isSeat: async () => false })),
      await inspect({}, makeHost({ message: async () => null })),
      await inspect({}, makeHost({}, finalMessage({ finish: "tool-calls" }))),
      await inspect({}, makeHost({}, finalMessage({ agent: "someone-else" }))),
    ]
    for (const result of results) {
      expect(result.status).toBe("unavailable")
      expect(result).not.toHaveProperty("text")
    }
  })
})

describe("32 KiB UTF-8 limit", () => {
  test("exactly 32768 ASCII bytes is verified", async () => {
    const host = makeHost({}, finalMessage({}, [{ type: "text", text: "a".repeat(COUNCIL_TEXT_LIMIT) }]))
    const result = await inspect({}, host)
    expect(result.status).toBe("verified")
  })

  test("32769 ASCII bytes is text_size_limit", async () => {
    const host = makeHost({}, finalMessage({}, [{ type: "text", text: "a".repeat(COUNCIL_TEXT_LIMIT + 1) }]))
    expectUnavailable(await inspect({}, host), "text_size_limit")
  })

  test("UTF-8 multibyte text is measured in bytes, not characters", async () => {
    // 10923 个 CJK 字符 = 32769 字节 > 上限，尽管字符数远小于 32768。
    const host = makeHost({}, finalMessage({}, [{ type: "text", text: "中".repeat(10923) }]))
    expectUnavailable(await inspect({}, host), "text_size_limit")
    // 10922 个 CJK（32766 字节）+ 2 个 ASCII = 恰好 32768 字节，允许。
    const ok = makeHost({}, finalMessage({}, [{ type: "text", text: "中".repeat(10922) + "ok" }]))
    const result = await inspect({}, ok)
    expect(result.status).toBe("verified")
    expect(result.status === "verified" && result.text_bytes).toBe(COUNCIL_TEXT_LIMIT)
  })
})
