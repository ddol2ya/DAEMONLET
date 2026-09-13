import { describe, expect, it } from "vitest"
import { ProtocolSequenceTracker } from "../src/protocol/ProtocolSequenceTracker"
import type { ProtocolEventFrame, ProtocolSnapshotFrame } from "../src/protocol/types"

const base = { protocolVersion: 1 as const, source: "mock", sourceInstanceId: "i", sessionId: "s", sentAt: 0 }
const frame = (sequence: number, messageId = `m-${sequence}`): ProtocolEventFrame => ({ ...base, frameType: "event", messageId, sequence, payload: { type: "run.started", runId: `r-${sequence}` } })
const snapshot = (sequence: number, messageId = `s-${sequence}`): ProtocolSnapshotFrame => ({ ...base, frameType: "snapshot", messageId, sequence, payload: { snapshotId: messageId, activeRuns: [] } })

describe("ProtocolSequenceTracker", () => {
  it("establishes sequence with a snapshot and accepts only consecutive events", () => {
    const tracker = new ProtocolSequenceTracker()
    tracker.beginSync("i", "s", { preserveAppliedSequence: false })
    expect(tracker.process(snapshot(10))).toMatchObject({ decision: "snapshot-applied", gap: false })
    expect(tracker.process(frame(11))).toMatchObject({ decision: "accepted" })
    expect(tracker.getSnapshot()).toMatchObject({ status: "READY", lastAppliedSequence: 11 })
  })

  it("deduplicates message IDs and rejects unknown stale sequences", () => {
    const tracker = new ProtocolSequenceTracker()
    tracker.beginSync("i", "s", { preserveAppliedSequence: false })
    tracker.process(snapshot(3))
    expect(tracker.process(frame(4, "same"))).toMatchObject({ decision: "accepted" })
    expect(tracker.process(frame(5, "same"))).toMatchObject({ decision: "duplicate" })
    expect(tracker.process(frame(2, "unknown"))).toMatchObject({ decision: "stale" })
  })

  it("rejects a different message claiming an already buffered sequence", () => {
    const tracker = new ProtocolSequenceTracker()
    tracker.beginSync("i", "s", { preserveAppliedSequence: false })
    tracker.process(snapshot(1))
    tracker.process(frame(3, "first-gap-frame"))
    expect(tracker.process(frame(3, "conflicting-frame"))).toMatchObject({ decision: "stale" })
    expect(tracker.getSnapshot().bufferedFrameCount).toBe(1)
  })

  it("buffers a gap and replays only contiguous frames after snapshot", () => {
    const tracker = new ProtocolSequenceTracker()
    tracker.beginSync("i", "s", { preserveAppliedSequence: false })
    tracker.process(snapshot(1))
    expect(tracker.process(frame(4))).toMatchObject({ decision: "buffered", gap: true })
    expect(tracker.getSnapshot().status).toBe("DESYNCED")
    const repaired = tracker.process(snapshot(2, "repair"))
    expect(repaired).toMatchObject({ decision: "snapshot-applied", gap: true })
    expect(tracker.getSnapshot()).toMatchObject({ status: "DESYNCED", bufferedFrameCount: 1 })
    tracker.process(frame(3))
    const completed = tracker.process(snapshot(2, "repair-2"))
    expect(completed.decision).toBe("snapshot-applied")
    if (completed.decision === "snapshot-applied") expect(completed.frames.map((item) => item.sequence)).toEqual([2, 3, 4])
    expect(tracker.getSnapshot().status).toBe("READY")
  })

  it("bounds its gap buffer and resets for a new source instance or session", () => {
    const tracker = new ProtocolSequenceTracker(2)
    tracker.beginSync("i", "s", { preserveAppliedSequence: false })
    tracker.process(snapshot(1))
    tracker.process(frame(4))
    tracker.process(frame(5))
    expect(tracker.process(frame(6))).toMatchObject({ decision: "buffered", droppedMessageId: "m-4" })
    expect(tracker.getSnapshot().bufferedFrameCount).toBe(2)
    expect(tracker.beginSync("i-2", "s", { preserveAppliedSequence: false })).toBe(true)
    expect(tracker.getSnapshot()).toMatchObject({ status: "SYNCING", lastAppliedSequence: 0, bufferedFrameCount: 0 })
    expect(tracker.beginSync("i-2", "s-2", { preserveAppliedSequence: false })).toBe(true)
  })

  it("preserves applied sequence but clears dedupe and gaps for the same-identity reconnect epoch", () => {
    const tracker = new ProtocolSequenceTracker()
    tracker.beginSync("i", "s", { preserveAppliedSequence: false })
    tracker.process(snapshot(10, "snapshot-1"))
    tracker.process(frame(12, "gap"))
    expect(tracker.getSnapshot()).toMatchObject({ status: "DESYNCED", lastAppliedSequence: 10, bufferedFrameCount: 1 })

    expect(tracker.beginSync("i", "s", { preserveAppliedSequence: true })).toBe(false)
    expect(tracker.getSnapshot()).toMatchObject({ status: "SYNCING", lastAppliedSequence: 10, bufferedFrameCount: 0 })
    expect(tracker.process(snapshot(10, "snapshot-1"))).toMatchObject({ decision: "snapshot-applied", gap: false })
    expect(tracker.getSnapshot()).toMatchObject({ status: "READY", lastAppliedSequence: 10 })
  })

  it("fully resets applied sequence and recent IDs for a new identity", () => {
    const tracker = new ProtocolSequenceTracker()
    tracker.beginSync("i", "s", { preserveAppliedSequence: false })
    tracker.process(snapshot(10, "snapshot-1"))
    expect(tracker.beginSync("i-2", "s", { preserveAppliedSequence: true })).toBe(true)
    expect(tracker.getSnapshot()).toMatchObject({ status: "SYNCING", lastAppliedSequence: 0, bufferedFrameCount: 0 })
    expect(tracker.process(snapshot(1, "snapshot-1"))).toMatchObject({ decision: "snapshot-applied", gap: false })
  })
})
