import { describe, test, expect } from "bun:test"
import {
  validatePutInput,
  truncateDescription,
  encodeImmutablePayload,
  payloadBytesEqual,
  buildRecordBytes,
  recordHash,
  type PutInput,
  type BbRecord,
} from "../src/schema"

const baseInput: PutInput = {
  description: "ok",
  content: "hello",
  source_refs: ["a"],
  related: ["r"],
  supersedes: ["s"],
  publication_for: "p",
}

const rec: BbRecord = {
  schema_version: 1,
  id: "bb://3f2a1c1e-6b1e-4f0e-9a2b-1c2d3e4f5a6b/9be1d2f0-1111-4222-8333-444455556666/e000001",
  scope_id: "3f2a1c1e-6b1e-4f0e-9a2b-1c2d3e4f5a6b",
  stream_id: "9be1d2f0-1111-4222-8333-444455556666",
  sequence: 1,
  writer: { agent: "build", session_id: "s1", message_id: "m1" },
  created_at: "2026-09-23T00:00:00.000Z",
  created_round: null,
  description: "d",
  content: "c",
  source_refs: ["a"],
}

describe("schema", () => {
  // schema-1
  test("合法输入 validatePutInput 返回空数组", () => {
    expect(validatePutInput({ description: "单行描述", content: "正文" })).toEqual([])
    expect(validatePutInput({ ...baseInput, kind: "note" })).toEqual([])
  })

  // schema-2
  test("缺 description → description_missing（整条拒绝）", () => {
    expect(validatePutInput({ content: "正文" }).map((e) => e.code)).toContain("description_missing")
    expect(validatePutInput({}).map((e) => e.code)).toContain("description_missing")
  })

  // schema-3
  test("全空白 description → description_blank", () => {
    expect(validatePutInput({ description: "   ", content: "c" }).map((e) => e.code)).toContain("description_blank")
  })

  // schema-4
  test("含换行 description → description_newline", () => {
    expect(validatePutInput({ description: "a\nb", content: "c" }).map((e) => e.code)).toContain("description_newline")
  })

  // schema-5（v1.21.2：描述上限改按 UTF-8 字节计，硬门槛 512B；提示层仍要求 ≤80 字符）
  test("描述 >512 UTF-8 字节 → too_long；恰 512 字节（ASCII 或多字节）通过", () => {
    expect(validatePutInput({ description: "a".repeat(513), content: "c" }).map((e) => e.code)).toContain("description_too_long")
    expect(validatePutInput({ description: "a".repeat(512), content: "c" })).toEqual([])
    expect(validatePutInput({ description: "é".repeat(256), content: "c" })).toEqual([])
    expect(validatePutInput({ description: "é".repeat(257), content: "c" }).map((e) => e.code)).toContain("description_too_long")
  })

  // schema-5b（v1.21.2：截断按整字节、不切断多字节字符）
  test("truncateDescription 恰 512B 原样；超限按字节截断且落在字符边界", () => {
    expect(truncateDescription("a".repeat(512))).toBe("a".repeat(512))
    expect(truncateDescription("a".repeat(513))).toBe("a".repeat(512))
    expect(truncateDescription("汉".repeat(171))).toBe("汉".repeat(170)) // 513B → 510B
    expect(truncateDescription("a".repeat(510) + "汉")).toBe("a".repeat(510)) // 513B，界落在字符中间 → 丢弃整字
    expect(truncateDescription("a".repeat(509) + "汉")).toBe("a".repeat(509) + "汉") // 恰 512B
    expect(truncateDescription("😀".repeat(129))).toBe("😀".repeat(128)) // 4B emoji：516B → 512B
  })

  // schema-6
  test("content 262144 字节通过；262145 → content_too_large", () => {
    expect(validatePutInput({ description: "d", content: "a".repeat(262144) })).toEqual([])
    expect(validatePutInput({ description: "d", content: "a".repeat(262145) }).map((e) => e.code)).toContain("content_too_large")
  })

  // schema-7
  test("TLV：仅改一个数组/可选标量字段 → 字节不同", () => {
    const t0 = encodeImmutablePayload(baseInput)
    expect(payloadBytesEqual(t0, encodeImmutablePayload({ ...baseInput, source_refs: ["b"] }))).toBe(false)
    expect(payloadBytesEqual(t0, encodeImmutablePayload({ ...baseInput, related: ["x"] }))).toBe(false)
    expect(payloadBytesEqual(t0, encodeImmutablePayload({ ...baseInput, supersedes: ["y"] }))).toBe(false)
    expect(payloadBytesEqual(t0, encodeImmutablePayload({ ...baseInput, publication_for: "q" }))).toBe(false)
  })

  // schema-8
  test("TLV：数组顺序参与判定；undefined 与显式空数组编码不同", () => {
    const t0 = encodeImmutablePayload(baseInput)
    expect(payloadBytesEqual(t0, encodeImmutablePayload({ ...baseInput, source_refs: ["a", "b"] }))).toBe(false)
    expect(
      payloadBytesEqual(
        encodeImmutablePayload({ description: "d", content: "c", source_refs: ["a", "b"] }),
        encodeImmutablePayload({ description: "d", content: "c", source_refs: ["b", "a"] }),
      ),
    ).toBe(false)
    expect(
      payloadBytesEqual(
        encodeImmutablePayload({ description: "d", content: "c" }),
        encodeImmutablePayload({ description: "d", content: "c", source_refs: [] }),
      ),
    ).toBe(false)
  })

  // schema-9
  test("TLV：完全相同输入 → 字节相等", () => {
    const a = encodeImmutablePayload(baseInput)
    const b = encodeImmutablePayload({ ...baseInput })
    expect(payloadBytesEqual(a, b)).toBe(true)
  })

  // schema-10
  test("recordHash：确定性、字节敏感、64 hex", () => {
    const bytes = buildRecordBytes(rec)
    const h1 = recordHash(bytes)
    const h2 = recordHash(buildRecordBytes(rec))
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    const flipped = bytes.slice()
    flipped[10] = flipped[10]! ^ 0x01
    expect(recordHash(flipped)).not.toBe(h1)
  })
})
