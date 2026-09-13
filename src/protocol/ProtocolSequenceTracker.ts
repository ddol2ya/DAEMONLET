import type { ProtocolEventFrame, ProtocolSnapshotFrame, SequencedProtocolFrame } from "./types"

export type SequenceStatus = "SYNCING" | "READY" | "DESYNCED"
export type SequenceDecision =
  | { decision: "accepted"; frames: ProtocolEventFrame[]; gap: false }
  | { decision: "snapshot-applied"; frames: Array<ProtocolSnapshotFrame | ProtocolEventFrame>; gap: boolean }
  | { decision: "buffered"; frames: []; gap: boolean; droppedMessageId?: string }
  | { decision: "duplicate" | "stale"; frames: []; gap: false }

export type ProtocolSequenceSnapshot = {
  sourceInstanceId: string | null
  sessionId: string | null
  lastAppliedSequence: number
  bufferedFrameCount: number
  status: SequenceStatus
}

export type BeginSyncOptions = {
  preserveAppliedSequence: boolean
}

export class ProtocolSequenceTracker {
  private sourceInstanceId: string | null = null
  private sessionId: string | null = null
  private lastAppliedSequence = 0
  private status: SequenceStatus = "SYNCING"
  private readonly recentMessageIds = new Set<string>()
  private readonly recentMessageIdQueue: string[] = []
  private readonly buffer: ProtocolEventFrame[] = []

  constructor(private readonly bufferLimit = 128, private readonly dedupeLimit = 1_024) {
    if (bufferLimit < 1 || dedupeLimit < 1) throw new Error("sequence tracker limits must be positive")
  }

  beginSync(sourceInstanceId: string, sessionId: string, options: BeginSyncOptions): boolean {
    const sameIdentity = sourceInstanceId === this.sourceInstanceId && sessionId === this.sessionId
    const preserveAppliedSequence = options.preserveAppliedSequence && sameIdentity
    this.status = "SYNCING"
    this.sourceInstanceId = sourceInstanceId
    this.sessionId = sessionId
    if (!preserveAppliedSequence) this.lastAppliedSequence = 0
    this.buffer.length = 0
    this.recentMessageIds.clear()
    this.recentMessageIdQueue.length = 0
    return !preserveAppliedSequence
  }

  process(frame: SequencedProtocolFrame): SequenceDecision {
    if (this.recentMessageIds.has(frame.messageId)) return { decision: "duplicate", frames: [], gap: false }
    this.remember(frame.messageId)
    if (frame.frameType === "snapshot") return this.applySnapshot(frame)
    return this.applyEvent(frame)
  }

  reset(): void {
    this.sourceInstanceId = null
    this.sessionId = null
    this.lastAppliedSequence = 0
    this.status = "SYNCING"
    this.buffer.length = 0
    this.recentMessageIds.clear()
    this.recentMessageIdQueue.length = 0
  }

  getSnapshot(): ProtocolSequenceSnapshot {
    return {
      sourceInstanceId: this.sourceInstanceId,
      sessionId: this.sessionId,
      lastAppliedSequence: this.lastAppliedSequence,
      bufferedFrameCount: this.buffer.length,
      status: this.status,
    }
  }

  private applyEvent(frame: ProtocolEventFrame): SequenceDecision {
    if (frame.sequence <= this.lastAppliedSequence) return { decision: "stale", frames: [], gap: false }
    if (this.buffer.some((candidate) => candidate.sequence === frame.sequence)) return { decision: "stale", frames: [], gap: false }
    if (this.status === "READY" && frame.sequence === this.lastAppliedSequence + 1) {
      this.lastAppliedSequence = frame.sequence
      return { decision: "accepted", frames: [frame], gap: false }
    }

    const previousStatus = this.status
    const droppedMessageId = this.bufferFrame(frame)
    const gap = previousStatus === "READY" || (previousStatus === "DESYNCED" && frame.sequence > this.lastAppliedSequence + 1)
    if (previousStatus === "READY") this.status = "DESYNCED"
    return { decision: "buffered", frames: [], gap, ...(droppedMessageId ? { droppedMessageId } : {}) }
  }

  private applySnapshot(frame: ProtocolSnapshotFrame): SequenceDecision {
    if (frame.sequence < this.lastAppliedSequence) return { decision: "stale", frames: [], gap: false }
    this.lastAppliedSequence = frame.sequence
    const remaining = this.buffer
      .filter((candidate) => candidate.sequence > frame.sequence)
      .sort((left, right) => left.sequence - right.sequence)
    this.buffer.length = 0
    const frames: Array<ProtocolSnapshotFrame | ProtocolEventFrame> = [frame]
    for (const candidate of remaining) {
      if (candidate.sequence === this.lastAppliedSequence + 1) {
        frames.push(candidate)
        this.lastAppliedSequence = candidate.sequence
      } else {
        this.bufferFrame(candidate)
      }
    }
    const gap = this.buffer.length > 0
    this.status = gap ? "DESYNCED" : "READY"
    return { decision: "snapshot-applied", frames, gap }
  }

  private bufferFrame(frame: ProtocolEventFrame): string | undefined {
    this.buffer.push(frame)
    this.buffer.sort((left, right) => left.sequence - right.sequence)
    if (this.buffer.length <= this.bufferLimit) return undefined
    return this.buffer.shift()?.messageId
  }

  private remember(messageId: string): void {
    this.recentMessageIds.add(messageId)
    this.recentMessageIdQueue.push(messageId)
    if (this.recentMessageIdQueue.length <= this.dedupeLimit) return
    const oldest = this.recentMessageIdQueue.shift()
    if (oldest) this.recentMessageIds.delete(oldest)
  }
}
