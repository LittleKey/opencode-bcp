// 稳定 ID：bb://<scope-uuid>/<stream-uuid>/eNNNNNN（DESIGN §5）
// — entry 文件名 e%06d.json；一经公开永不重用；聚合/压缩/重启不重编号。

export function entryFileName(seq: number): string {
  return `e${String(seq).padStart(6, "0")}.json`
}

export function parseEntryFileName(name: string): number | null {
  const m = /^e(\d{6,})\.json$/.exec(name)
  return m ? Number(m[1]) : null
}

export function formatBbId(scopeId: string, streamId: string, seq: number): string {
  return `bb://${scopeId}/${streamId}/e${String(seq).padStart(6, "0")}`
}

export function parseBbId(id: string): { scopeId: string; streamId: string; seq: number } {
  const m = /^bb:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/e(\d+)$/.exec(id)
  if (!m) throw new Error(`malformed_id: ${id}`)
  return { scopeId: m[1]!, streamId: m[2]!, seq: Number(m[3]) }
}
