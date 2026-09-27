// Bounded observations, not an acceptance gate or an OMO task-generation tracker.
type Publication = { observedAt: number; retainedAt?: number; paths: Set<string> }
type State = { input: string; writes: number; paths: Map<string, number>; unknownPath: boolean; publications: Map<string, Publication>; messages: Set<string>; finals: Set<string> }
type Capture = { state: State; revision: number } | undefined
type Status = "missing_handoff" | "manual_version_check" | "known_edits_snapshotted" | "publication_observed" | "unconfirmed"

export class ReceiptCheck {
  private sessions = new Map<string, State>()
  begin(id: string, input: string) {
    if (this.sessions.get(id)?.input === input) return
    this.sessions.set(id, { input, writes: 0, paths: new Map(), unknownPath: false, publications: new Map(), messages: new Set(), finals: new Set() })
  }
  assistant(id: string, messageId: string, parentId?: string) {
    const state = this.sessions.get(id)
    if (state && state.input === parentId) state.messages.add(messageId)
  }
  changed(id: string, paths: string[]) {
    const state = this.sessions.get(id)
    if (!state) return
    state.writes++
    if (!paths.length) state.unknownPath = true
    for (const path of paths) state.paths.set(path, state.writes)
  }
  capture(id: string, messageId?: string): Capture {
    const state = this.sessions.get(id)
    if (messageId !== undefined && !state?.messages.has(messageId)) return undefined
    return state && { state, revision: state.writes }
  }
  published(id: string, capture: Capture, record: string, paths: string[], status: "stored" | "replay") {
    const state = this.sessions.get(id)
    if (!capture || state !== capture.state) return
    if (status === "stored") {
      state.publications.set(record, { observedAt: capture.revision, retainedAt: capture.revision, paths: new Set(paths) })
    } else {
      const prior = state.publications.get(record)
      // A replay is a reference observation, not a new proof. Preserve any earlier proof unchanged.
      state.publications.set(record, { ...prior, observedAt: Math.max(prior?.observedAt ?? -1, capture.revision), paths: prior?.paths ?? new Set() })
    }
  }
  finish(id: string, messageId: string, parentId?: string) {
    const state = this.sessions.get(id)
    if (!state || state.input !== parentId || state.finals.has(messageId)) return null
    state.finals.add(messageId)
    const publications = [...state.publications.values()]
    let status: Status
    if (!state.writes) {
      status = publications.some(p => p.retainedAt !== undefined) ? "publication_observed" : "unconfirmed"
    } else if (!publications.some(p => p.observedAt >= state.writes)) {
      status = "missing_handoff"
    } else {
      const allKnownPaths = !state.unknownPath && [...state.paths].every(([path, revision]) =>
        publications.some(p => p.retainedAt !== undefined && p.retainedAt >= revision && p.paths.has(path)))
      status = allKnownPaths ? "known_edits_snapshotted" : "manual_version_check"
    }
    return { status, input_message_id: state.input, records: [...state.publications.keys()], coverage: "not_evaluated" as const }
  }
  forget(id: string) { this.sessions.delete(id) }
}
