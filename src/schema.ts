// 消息 schema 与两个字节域（DESIGN §4/§6/§7；P6）：
// - 幂等域 TLV（encodeImmutablePayload）：调用方不可变载荷的精确字节；显式空数组编码（非缺失语义）。
// - 记录域 JSON（buildRecordBytes）：entry 文件字节；固定键序；可选字段缺失则键不出现（不注入默认值，P15）。
// hash 的对象是记录创建时固定的不可变字节（记录域）；幂等判定按不可变载荷 TLV 精确字节相等（P15）。

export const KINDS = ["note", "finding", "change", "review", "decision", "index_summary"] as const
export type RecordKind = (typeof KINDS)[number]

export const DESCRIPTION_MAX_CODE_POINTS = 80
export const CONTENT_MAX_BYTES = 65536

export type Writer = { agent: string; session_id: string; message_id: string }

/** 聚合成员投影（仅 index_summary 记录携带；hash = 成员 entry 落盘字节的 sha256） */
export type AggregateMember = { id: string; hash: string }

export type BbRecord = {
  schema_version: number
  id: string
  scope_id: string
  stream_id: string
  sequence: number
  writer: Writer
  created_at: string
  created_round: number | null
  description: string
  content: string
  kind?: RecordKind
  source_refs?: string[]
  related?: string[]
  supersedes?: string[]
  publication_for?: string
  members?: AggregateMember[]
  summary_basis?: "descriptions"
}

/** 调用方提交的不可变载荷（工具新分配的元数据不参与幂等比较，DESIGN §6） */
export type PutInput = {
  description: string
  content: string
  kind?: RecordKind
  source_refs?: string[]
  related?: string[]
  supersedes?: string[]
  publication_for?: string
}

export type FieldError = { field: string; code: string }

/** 工具机械校验（DESIGN §7）：任一命中整条拒绝，不产生半条记录，不静默截断 */
export function validatePutInput(input: Partial<PutInput>): FieldError[] {
  const errs: FieldError[] = []
  const d = input.description
  if (d === undefined) {
    errs.push({ field: "description", code: "description_missing" })
  } else {
    if (d.trim() === "") errs.push({ field: "description", code: "description_blank" })
    if (/[\n\r]/.test(d)) errs.push({ field: "description", code: "description_newline" })
    if ([...d].length > DESCRIPTION_MAX_CODE_POINTS) {
      errs.push({ field: "description", code: "description_too_long" })
    }
  }
  const c = input.content
  if (c === undefined) {
    errs.push({ field: "content", code: "content_missing" })
  } else if (Buffer.byteLength(c, "utf8") > CONTENT_MAX_BYTES) {
    errs.push({ field: "content", code: "content_too_large" })
  }
  if (input.kind !== undefined && !(KINDS as readonly string[]).includes(input.kind)) {
    errs.push({ field: "kind", code: "kind_invalid" })
  }
  return errs
}

const TAG = {
  description: 0x01,
  content: 0x02,
  kind: 0x03,
  source_refs: 0x04,
  related: 0x05,
  supersedes: 0x06,
  publication_for: 0x07,
} as const

function putScalar(out: number[], tag: number, value: string): void {
  const bytes = new TextEncoder().encode(value)
  out.push(tag, (bytes.length >>> 24) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 8) & 0xff, bytes.length & 0xff, ...bytes)
}

function putArray(out: number[], tag: number, values: string[] | undefined): void {
  if (values === undefined) return // 缺字段语义：字段 undefined 时不写入该 tag（与显式空数组编码区分）
  out.push(tag)
  const n = values.length
  out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  for (const v of values) {
    const b = new TextEncoder().encode(v)
    out.push((b.length >>> 24) & 0xff, (b.length >>> 16) & 0xff, (b.length >>> 8) & 0xff, b.length & 0xff, ...b)
  }
}

/** 幂等域：调用方不可变载荷 → TLV 字节（调用方语义的显式形态：undefined 数组=显式空数组编码；缺失标量不编码；idempotency_key 不入域） */
export function encodeImmutablePayload(input: PutInput): Uint8Array {
  const out: number[] = []
  putScalar(out, TAG.description, input.description)
  putScalar(out, TAG.content, input.content)
  if (input.kind !== undefined) putScalar(out, TAG.kind, input.kind)
  putArray(out, TAG.source_refs, input.source_refs)
  putArray(out, TAG.related, input.related)
  putArray(out, TAG.supersedes, input.supersedes)
  if (input.publication_for !== undefined) putScalar(out, TAG.publication_for, input.publication_for)
  return new Uint8Array(out)
}

export function payloadBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** 记录域：固定键序 JSON 序列化，可选字段按提交形态（缺失则键不出现）；输入对象不得预填默认值（P15） */
export function buildRecordBytes(rec: BbRecord): Uint8Array {
  const ordered: BbRecord = {
    schema_version: rec.schema_version,
    id: rec.id,
    scope_id: rec.scope_id,
    stream_id: rec.stream_id,
    sequence: rec.sequence,
    writer: {
      agent: rec.writer.agent,
      session_id: rec.writer.session_id,
      message_id: rec.writer.message_id,
    },
    created_at: rec.created_at,
    created_round: rec.created_round,
    description: rec.description,
    content: rec.content,
    ...(rec.kind !== undefined ? { kind: rec.kind } : {}),
    ...(rec.source_refs !== undefined ? { source_refs: rec.source_refs } : {}),
    ...(rec.related !== undefined ? { related: rec.related } : {}),
    ...(rec.supersedes !== undefined ? { supersedes: rec.supersedes } : {}),
    ...(rec.publication_for !== undefined ? { publication_for: rec.publication_for } : {}),
    ...(rec.members !== undefined ? { members: rec.members } : {}),
    ...(rec.summary_basis !== undefined ? { summary_basis: rec.summary_basis } : {}),
  }
  return new TextEncoder().encode(JSON.stringify(ordered))
}

/** hash = 不可变字节（记录域）的 sha256 hex，64 字符（DESIGN §4 hash 约定） */
export function recordHash(recBytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(recBytes).digest("hex")
}
