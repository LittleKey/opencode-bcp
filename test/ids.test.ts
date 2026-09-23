import { describe, test, expect } from "bun:test"
import { entryFileName, parseEntryFileName, formatBbId, parseBbId } from "../src/ids"

describe("ids", () => {
  // ids-1
  test("entryFileName / parseEntryFileName 互逆且格式 e%06d.json", () => {
    expect(entryFileName(7)).toBe("e000007.json")
    expect(entryFileName(123456)).toBe("e123456.json")
    expect(entryFileName(1234567)).toBe("e1234567.json") // >6 位不截断
    expect(parseEntryFileName("e000007.json")).toBe(7)
    expect(parseEntryFileName(entryFileName(9))).toBe(9)
  })

  // ids-2
  test("parseEntryFileName 非法名返回 null；parseBbId 非法 id 抛 malformed_id", () => {
    expect(parseEntryFileName("e1.json")).toBe(null)
    expect(parseEntryFileName("e.json")).toBe(null)
    expect(parseEntryFileName("e000007.txt")).toBe(null)
    expect(parseEntryFileName("f000007.json")).toBe(null)
    expect(parseEntryFileName(".tmp-x.json")).toBe(null)

    const sid = "3f2a1c1e-6b1e-4f0e-9a2b-1c2d3e4f5a6b"
    const fid = "9be1d2f0-1111-4222-8333-444455556666"
    for (const bad of [
      "bb:/x/y/e000001",
      `${sid}/${fid}/e000001`,
      `bb://${sid}/${fid}/e-1`,
      `bb://${sid}/${fid}/e00000a.json`,
      `bb://${sid}/e000001`,
    ]) {
      expect(() => parseBbId(bad)).toThrow(/malformed_id/)
    }
  })

  // ids-3
  test("formatBbId 形态 bb://<scope>/<stream>/eNNNNNN 且与 parseBbId 互逆", () => {
    const sid = "3f2a1c1e-6b1e-4f0e-9a2b-1c2d3e4f5a6b"
    const fid = "9be1d2f0-1111-4222-8333-444455556666"
    const id = formatBbId(sid, fid, 123)
    expect(id).toBe(`bb://${sid}/${fid}/e000123`)
    expect(parseBbId(id)).toEqual({ scopeId: sid, streamId: fid, seq: 123 })
  })

  // ids-4
  test("parseBbId 序号解码无上限；文件名 padStart 6 位不损失更大序号", () => {
    expect(parseBbId(formatBbId("0".repeat(36), "1".repeat(36), 12345678)).seq).toBe(12345678)
    expect(parseEntryFileName("e12345678.json")).toBe(12345678)
  })

  // ids-5
  test("parseBbId 的 uuid 段必须恰为 36 字符", () => {
    const s36 = "a".repeat(36)
    const f36 = "b".repeat(36)
    expect(parseBbId(`bb://${s36}/${f36}/e000001`).scopeId).toBe(s36)
    expect(() => parseBbId(`bb://${s36}X/${f36}/e000001`)).toThrow(/malformed_id/)
    expect(() => parseBbId(`bb://${s36}/${f36.slice(1)}/e000001`)).toThrow(/malformed_id/)
  })
})
