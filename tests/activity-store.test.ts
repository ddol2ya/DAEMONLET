import { describe, expect, it } from "vitest"
import { ActivityStore } from "../electron/main/activity/ActivityStore"
import { ACTIVITY_HISTORY_AGE_MS, activitySummary } from "../electron/shared/activity-contract"
import type { ProtocolDomainEvent, ProtocolEventFrame, ProtocolSnapshotFrame } from "../src/protocol/types"

function harness() {
  let now = 10_000, seq = 0
  const store = new ActivityStore(() => now)
  const base = () => ({ protocolVersion: 1 as const, source: "codex-adapter", sourceInstanceId: "source-one", sessionId: "wire-session", messageId: `message-${++seq}`, sequence: seq, sentAt: now })
  const event = (payload: ProtocolDomainEvent, patch: Partial<ProtocolEventFrame> = {}) => store.accept({ ...base(), frameType: "event", payload, ...patch })
  const snapshot = (activeRuns: ProtocolSnapshotFrame["payload"]["activeRuns"], patch: Partial<ProtocolSnapshotFrame> = {}) => store.accept({ ...base(), frameType: "snapshot", payload: { snapshotId: `snapshot-${seq}`, activeRuns }, ...patch })
  const targets = () => store.view().entries.filter(r => r.unread).map(({ activityId, revision }) => ({ activityId, revision }))
  store.setConnection("READY")
  return { store, event, snapshot, targets, advance: (ms = 100) => { now += ms } }
}

describe("ActivityStore, independent attention and result lifetime", () => {
  it("keeps A running while B waits, then only clears B on resume", () => {
    const h = harness()
    h.event({ type: "run.started", runId: "A" }); h.event({ type: "run.started", runId: "B" })
    h.event({ type: "run.waiting", runId: "B", reason: "user-input" })
    expect(h.store.view()).toMatchObject({ counts: { running: 1, waiting: 1, attention: 1 }, priority: "waiting" })
    expect(h.store.view().entries[0]).toMatchObject({ name: "작업 02", state: "waiting" })
    h.store.acknowledge({ targets: [] })
    expect(h.store.view().counts.waiting).toBe(1)
    h.event({ type: "run.resumed", runId: "B" })
    expect(h.store.view().counts).toMatchObject({ running: 2, waiting: 0 })
  })

  it("retains unread completion/failure during other Runs and orders attention", () => {
    const h = harness()
    for (const runId of ["A", "B", "C", "D"]) h.event({ type: "run.started", runId })
    h.event({ type: "run.completed", runId: "B", confidence: "observed" })
    h.event({ type: "run.failed", runId: "C", message: "private response" })
    h.event({ type: "run.waiting", runId: "D", reason: "user-input" })
    expect(h.store.view().entries.map(r => r.state)).toEqual(["waiting", "failed", "completed", "running"])
    expect(h.store.view().counts).toEqual({ running: 1, waiting: 1, failed: 1, completed: 1, attention: 3 })
    expect(h.store.view().entries[2].confidence).toBe("observed")
  })

  it("never turns child completion/failure into a Run result", () => {
    const h = harness()
    h.event({ type: "task.completed", runId: "missing", taskId: "task" })
    expect(h.store.view().entries).toHaveLength(0)
    h.event({ type: "run.started", runId: "A" })
    h.event({ type: "task.started", runId: "A", taskId: "task", kind: "subtask", label: "secret title" })
    h.event({ type: "task.failed", runId: "A", taskId: "task", message: "secret failure" })
    expect(h.store.view().entries[0]).toMatchObject({ state: "running", category: "subtask", unread: false })
  })

  it.each(["user-interrupted", "interrupted", "session-ended", "recovery-not-confirmed", "stale-adapter-state", "unknown-reason"])("classifies cancellation %s without completion/failure alerts", reason => {
    const h = harness()
    h.event({ type: "run.started", runId: "A" }); h.event({ type: "run.cancelled", runId: "A", reason })
    expect(h.store.view().entries[0].state).toBe(["interrupted", "user-interrupted"].includes(reason) ? "cancelled" : "unknown")
    expect(h.store.view().counts.attention).toBe(0)
  })

  it("acknowledges click-time IDs and revisions only, leaving new results and waits", () => {
    const h = harness()
    h.event({ type: "run.completed", runId: "old" })
    const request = { targets: h.targets() }
    h.advance(); h.event({ type: "run.failed", runId: "new" })
    h.event({ type: "run.waiting", runId: "waiting", reason: "user-input" })
    h.store.acknowledge({ targets: request.targets.map(t => ({ ...t, revision: t.revision - 1 })) })
    expect(h.store.view().counts.completed).toBe(1)
    h.store.acknowledge(request)
    expect(h.store.view().counts).toMatchObject({ completed: 0, failed: 1, waiting: 1 })
  })

  it("latches terminal identity across source restarts, duplicates and reverse event order", () => {
    const h = harness()
    h.event({ type: "run.completed", runId: "A" })
    h.store.acknowledge({ targets: h.targets() })
    h.advance()
    h.event({ type: "run.completed", runId: "A" }, { sourceInstanceId: "restarted" })
    h.event({ type: "run.started", runId: "A" }, { sourceInstanceId: "restarted" })
    h.snapshot([{ runId: "A", tasks: [] }], { sourceInstanceId: "restarted" })
    expect(h.store.view().entries).toHaveLength(1)
    expect(h.store.view().entries[0]).toMatchObject({ state: "completed", unread: false })
  })

  it("does not let a late start clear a wait, or an older wait undo a resume", () => {
    const h = harness()
    h.event({ type: "run.waiting", runId: "A", reason: "user-input" })
    h.event({ type: "run.started", runId: "A" })
    expect(h.store.view().counts.waiting).toBe(1)
    h.advance(); h.event({ type: "run.resumed", runId: "A" })
    h.event({ type: "run.waiting", runId: "A", reason: "user-input" }, { sentAt: 10_000 })
    expect(h.store.view().counts.running).toBe(1)
  })

  it("marks snapshot omissions unknown, preserves results, and can observe a later terminal", () => {
    const h = harness()
    h.event({ type: "run.started", runId: "A" }); h.event({ type: "run.completed", runId: "B" })
    h.advance(); h.snapshot([])
    expect(h.store.view().entries.map(r => r.state)).toEqual(["completed", "unknown"])
    h.advance(); h.event({ type: "run.failed", runId: "A" })
    expect(h.store.view().counts).toMatchObject({ failed: 1, completed: 1 })
  })

  it("restores unread results and marks active entries rechecking until snapshot/event", () => {
    const h = harness()
    h.event({ type: "run.waiting", runId: "A", reason: "user-input" }); h.event({ type: "run.failed", runId: "B" })
    const restored = new ActivityStore(() => 20_000)
    restored.restore(h.store.exportHistory())
    expect(restored.view()).toMatchObject({ connection: "DISCONNECTED", counts: { waiting: 1, failed: 1 } })
    restored.setConnection("READY")
    expect(restored.view().entries[0].freshness).toBe("rechecking")
    restored.accept({ protocolVersion: 1, frameType: "snapshot", source: "codex-adapter", sourceInstanceId: "new", sessionId: "new-session", sequence: 1, messageId: "new-snapshot", sentAt: 20_000, payload: { snapshotId: "snapshot", activeRuns: [{ runId: "A", waitingFor: "user-input", tasks: [] }] } })
    expect(restored.view().entries[0].freshness).toBe("observed")
    restored.setConnection("DESYNCED")
    expect(restored.view().entries[0].freshness).toBe("rechecking")
    expect(activitySummary(restored.view())).toContain("마지막 관찰")
  })

  it("uses observation time for snapshot discoveries and strips wire strings/IDs", () => {
    const h = harness()
    h.snapshot([{ runId: "private-id", label: "raw prompt <script>", tasks: [{ taskId: "private-tool", status: "running", label: "tool output" }] }], { sentAt: 1 })
    expect(h.store.view().entries[0].firstObservedAt).toBe(10_000)
    h.event({ type: "run.completed", runId: "private-id", summary: "https://evil.example/command" })
    const publicText = JSON.stringify(h.store.view()), saved = JSON.stringify(h.store.exportHistory())
    for (const secret of ["private-id", "private-tool", "raw prompt", "<script>", "tool output", "evil.example", "wire-session", "source-one"]) {
      expect(publicText).not.toContain(secret); expect(saved).not.toContain(secret)
    }
    expect(h.store.view().entries[0].confidence).toBe("observed")
  })

  it("prefers pruning acknowledged history and preserves all active Runs", () => {
    const h = harness()
    for (let i = 0; i < 64; i++) h.event({ type: "run.started", runId: `active-${i}` })
    // Terminals whose starts were missed still deserve records even at the active cap.
    for (let i = 0; i < 100; i++) { h.advance(); h.event({ type: "run.completed", runId: `done-${i}` }) }
    const last = h.targets().at(-1)!
    h.store.acknowledge({ targets: [last] })
    h.advance(); h.event({ type: "run.failed", runId: "another" })
    expect(h.store.view().entries).toHaveLength(164)
    expect(h.store.view().counts.running).toBe(64)
    expect(h.store.view().entries.some(r => r.activityId === last.activityId)).toBe(false)
    expect(h.store.view().droppedUnread).toBe(0)
  })

  it("reports unread eviction, dedupes evicted history, and expires at seven days", () => {
    const h = harness()
    for (let i = 0; i < 101; i++) { h.advance(); h.event({ type: "run.completed", runId: `done-${i}` }) }
    expect(h.store.view()).toMatchObject({ droppedUnread: 1, counts: { completed: 100 } })
    h.event({ type: "run.completed", runId: "done-0" })
    expect(h.store.view().counts.completed).toBe(100)
    h.event({ type: "run.started", runId: "still-active" })
    h.advance(ACTIVITY_HISTORY_AGE_MS); h.store.prune()
    expect(h.store.view()).toMatchObject({ counts: { running: 1, completed: 0 }, droppedUnread: 101 })
  })

  it("ignores foreign sources", () => {
    const h = harness()
    h.event({ type: "run.failed", runId: "foreign" }, { source: "mock-bridge" })
    expect(h.store.view().entries).toHaveLength(0)
  })
})
