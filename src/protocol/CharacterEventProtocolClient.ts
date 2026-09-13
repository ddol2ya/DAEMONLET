import type { Clock } from "../behavior/types"
import { ProtocolSequenceTracker } from "./ProtocolSequenceTracker"
import { ProtocolSnapshotReconciler } from "./ProtocolSnapshotReconciler"
import { ProtocolTrace } from "./ProtocolTrace"
import {
  PROTOCOL_VERSION,
  type AcceptedProtocolFrame,
  type ProtocolClientCommand,
  type ProtocolConnectionState,
  type ProtocolDiagnostics,
  type ProtocolEventFrame,
  type ProtocolFrame,
  type ProtocolSnapshotFrame,
  type ProtocolTraceExport,
  type SnapshotRequestReason,
  type SourceHelloFrame,
} from "./types"
import { isCanonicalProtocolId, parseProtocolFrame } from "./validation"
import type { CharacterEventTransport, TransportStatus } from "./transports/CharacterEventTransport"

type TimerHandle = ReturnType<typeof setTimeout>
type ProtocolClientOptions = {
  clock?: Clock
  clientId?: string
  random?: () => number
  setTimer?: (callback: () => void, delay: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  traceLimit?: number
  bufferLimit?: number
  dedupeLimit?: number
}

const systemClock: Clock = { now: () => Date.now() }
let nextRequestId = 1
const createRequestId = () => `request-${Date.now().toString(36)}-${nextRequestId++}`

export class CharacterEventProtocolClient {
  private connectionState: ProtocolConnectionState = "DISCONNECTED"
  private readonly clock: Clock
  private readonly clientId: string
  private readonly random: () => number
  private readonly setTimer: NonNullable<ProtocolClientOptions["setTimer"]>
  private readonly clearTimer: NonNullable<ProtocolClientOptions["clearTimer"]>
  private readonly sequence: ProtocolSequenceTracker
  private readonly trace: ProtocolTrace
  private readonly reconciler = new ProtocolSnapshotReconciler()
  private readonly acceptedListeners = new Set<(frame: AcceptedProtocolFrame) => void>()
  private readonly diagnosticsListeners = new Set<() => void>()
  private readonly connectionMessageIds = new Set<string>()
  private readonly connectionMessageIdQueue: string[] = []
  private readonly invalidFrameTimes: number[] = []
  private readonly unsubscribeMessage: () => void
  private readonly unsubscribeStatus: () => void
  private heartbeatTimer: TimerHandle | null = null
  private reconnectTimer: TimerHandle | null = null
  private heartbeatIntervalMs = 0
  private reconnectAttempt = 0
  private manualDisconnect = false
  private reconnectAfterClose = false
  private reconnectHandshake = false
  private snapshotRequestPending = false
  private connectionEpoch = 0
  private disposed = false
  private connecting: Promise<void> | null = null
  private protocolVersion: number | null = null
  private source: string | null = null
  private sourceInstanceId: string | null = null
  private sessionId: string | null = null
  private acceptedCount = 0
  private duplicateCount = 0
  private staleCount = 0
  private rejectedCount = 0
  private gapCount = 0
  private snapshotCount = 0
  private reconnectCount = 0
  private lastMessageAt: number | null = null
  private lastHeartbeatAt: number | null = null
  private lastError: string | null = null
  private lastRejectionReason: string | null = null

  constructor(readonly transport: CharacterEventTransport, options: ProtocolClientOptions = {}) {
    this.clock = options.clock ?? systemClock
    this.clientId = options.clientId ?? "anime25d-motion-lab"
    if (!isCanonicalProtocolId(this.clientId)) throw new Error("clientId must be a canonical protocol ID")
    this.random = options.random ?? Math.random
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
    this.sequence = new ProtocolSequenceTracker(options.bufferLimit, options.dedupeLimit)
    this.trace = new ProtocolTrace(options.traceLimit)
    this.unsubscribeMessage = transport.subscribeMessage((raw) => this.receive(raw))
    this.unsubscribeStatus = transport.subscribeStatus((status) => this.handleTransportStatus(status))
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("protocol client is disposed"))
    if (this.connectionState === "READY" || this.connectionState === "HANDSHAKING" || this.connectionState === "SYNCING" || this.connectionState === "DESYNCED") return Promise.resolve()
    if (this.connecting) return this.connecting
    this.clearReconnectTimer()
    this.manualDisconnect = false
    this.lastError = null
    this.setConnectionState(this.reconnectHandshake ? "RECONNECTING" : "CONNECTING")
    this.connecting = this.transport.connect().finally(() => { this.connecting = null })
    return this.connecting
  }

  disconnect(reason = "manual disconnect"): void {
    if (this.disposed) return
    this.manualDisconnect = true
    this.reconnectHandshake = false
    this.snapshotRequestPending = false
    this.clearReconnectTimer()
    this.clearHeartbeatTimer()
    this.transport.disconnect(reason)
    this.setConnectionState("DISCONNECTED")
  }

  requestSnapshot(reason: SnapshotRequestReason): void {
    if (this.transport.getStatus().state !== "OPEN" || !this.sourceInstanceId) return
    const snapshotCountBeforeSend = this.snapshotCount
    const sent = this.send({ protocolVersion: PROTOCOL_VERSION, commandType: "snapshot.request", requestId: createRequestId(), reason })
    this.snapshotRequestPending = sent && this.snapshotCount === snapshotCountBeforeSend
    this.emitDiagnostics()
  }

  subscribeAccepted(listener: (frame: AcceptedProtocolFrame) => void): () => void {
    this.acceptedListeners.add(listener)
    return () => this.acceptedListeners.delete(listener)
  }

  subscribeDiagnostics(listener: () => void): () => void {
    this.diagnosticsListeners.add(listener)
    return () => this.diagnosticsListeners.delete(listener)
  }

  getDiagnostics(): ProtocolDiagnostics {
    const now = this.clock.now()
    const sequence = this.sequence.getSnapshot()
    const activeRuns = this.reconciler.getDiagnostics()
    return {
      connectionState: this.connectionState,
      connectionEpoch: this.connectionEpoch,
      endpoint: this.transport.endpoint,
      protocolVersion: this.protocolVersion,
      source: this.source,
      sourceInstanceId: this.sourceInstanceId,
      sessionId: this.sessionId,
      lastAppliedSequence: sequence.lastAppliedSequence,
      bufferedFrameCount: sequence.bufferedFrameCount,
      acceptedCount: this.acceptedCount,
      duplicateCount: this.duplicateCount,
      staleCount: this.staleCount,
      rejectedCount: this.rejectedCount,
      gapCount: this.gapCount,
      snapshotCount: this.snapshotCount,
      reconnectCount: this.reconnectCount,
      snapshotRequestPending: this.snapshotRequestPending,
      lastMessageAt: this.lastMessageAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      heartbeatAgeMs: this.lastHeartbeatAt === null ? null : Math.max(0, now - this.lastHeartbeatAt),
      activeRuns,
      activeTaskCount: activeRuns.reduce((count, run) => count + run.runningTaskIds.length, 0),
      lastError: this.lastError,
      lastRejectionReason: this.lastRejectionReason,
    }
  }

  getRuntimeSnapshot() {
    return this.reconciler.getSnapshot()
  }

  exportTrace(): ProtocolTraceExport {
    return this.trace.export(this.clock.now())
  }

  reset(): void {
    if (this.disposed) return
    this.manualDisconnect = true
    this.reconnectHandshake = false
    this.reconnectAfterClose = false
    this.snapshotRequestPending = false
    this.clearReconnectTimer()
    this.clearHeartbeatTimer()
    this.transport.disconnect("protocol client reset")
    this.sequence.reset()
    this.reconciler.clear()
    this.trace.clear()
    this.connectionMessageIds.clear()
    this.connectionMessageIdQueue.length = 0
    this.invalidFrameTimes.length = 0
    this.protocolVersion = null
    this.source = null
    this.sourceInstanceId = null
    this.sessionId = null
    this.heartbeatIntervalMs = 0
    this.reconnectAttempt = 0
    this.acceptedCount = 0
    this.duplicateCount = 0
    this.staleCount = 0
    this.rejectedCount = 0
    this.gapCount = 0
    this.snapshotCount = 0
    this.reconnectCount = 0
    this.connectionEpoch = 0
    this.lastMessageAt = null
    this.lastHeartbeatAt = null
    this.lastError = null
    this.lastRejectionReason = null
    this.connectionState = "DISCONNECTED"
    this.emitDiagnostics()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.manualDisconnect = true
    this.snapshotRequestPending = false
    this.clearReconnectTimer()
    this.clearHeartbeatTimer()
    this.unsubscribeMessage()
    this.unsubscribeStatus()
    this.transport.dispose()
    this.acceptedListeners.clear()
    this.diagnosticsListeners.clear()
    this.connectionState = "DISCONNECTED"
  }

  private receive(raw: string | ArrayBuffer): void {
    if (this.disposed || this.connectionState === "ERROR") return
    const receivedAt = this.clock.now()
    this.lastMessageAt = receivedAt
    const parsed = parseProtocolFrame(raw)
    if (!parsed.ok) {
      this.reject(parsed.error.message, receivedAt, parsed.error.fatal)
      return
    }
    const frame = parsed.value
    if (frame.frameType === "hello") {
      this.acceptHello(frame, receivedAt)
      return
    }
    if (!this.sourceInstanceId || this.connectionState === "HANDSHAKING" || this.connectionState === "CONNECTING") {
      this.reject("received a frame before source hello", receivedAt, false, frame)
      return
    }
    if (frame.source !== this.source || frame.sourceInstanceId !== this.sourceInstanceId || frame.sessionId !== this.sessionId) {
      this.reject("frame source instance or session does not match the active hello", receivedAt, false, frame)
      return
    }
    if (this.isDuplicateMessage(frame)) {
      this.duplicateCount++
      this.trace.add(receivedAt, "duplicate", frame, "duplicate messageId in connection epoch")
      this.emitDiagnostics()
      return
    }
    if (frame.frameType === "event" || frame.frameType === "snapshot") {
      this.acceptSequenced(frame, receivedAt)
      return
    }
    if (frame.frameType === "heartbeat") {
      this.lastHeartbeatAt = receivedAt
      this.armHeartbeatTimeout()
    } else {
      this.lastError = `${frame.payload.code}: ${frame.payload.message}`
      if (!frame.payload.recoverable) {
        this.fatal(this.lastError)
        return
      }
    }
    this.acceptedCount++
    this.trace.add(receivedAt, "accepted", frame)
    this.emitAccepted(frame)
    this.emitDiagnostics()
  }

  private acceptHello(frame: SourceHelloFrame, receivedAt: number): void {
    if (this.isDuplicateMessage(frame)) {
      this.duplicateCount++
      this.trace.add(receivedAt, "duplicate", frame, "duplicate hello in connection epoch")
      this.emitDiagnostics()
      return
    }
    const restartWhileConnected = (this.connectionState === "READY" || this.connectionState === "DESYNCED")
      && (frame.sourceInstanceId !== this.sourceInstanceId || frame.sessionId !== this.sessionId)
    if (this.connectionState !== "HANDSHAKING" && this.connectionState !== "SYNCING" && this.connectionState !== "RECONNECTING" && !restartWhileConnected) {
      this.reject("unexpected hello outside handshake", receivedAt, false, frame)
      return
    }
    const sameIdentity = frame.sourceInstanceId === this.sourceInstanceId && frame.sessionId === this.sessionId
    this.protocolVersion = frame.protocolVersion
    this.source = frame.source
    this.sourceInstanceId = frame.sourceInstanceId
    this.sessionId = frame.sessionId
    this.heartbeatIntervalMs = frame.payload.heartbeatIntervalMs
    this.lastHeartbeatAt = receivedAt
    this.sequence.beginSync(frame.sourceInstanceId, frame.sessionId, { preserveAppliedSequence: sameIdentity })
    this.setConnectionState("SYNCING")
    this.acceptedCount++
    this.trace.add(receivedAt, "accepted", frame)
    this.emitAccepted(frame)
    this.armHeartbeatTimeout()
    this.snapshotRequestPending = false
    this.requestSnapshot(this.reconnectHandshake ? "reconnect" : "initial")
    this.emitDiagnostics()
  }

  private acceptSequenced(frame: ProtocolEventFrame | ProtocolSnapshotFrame, receivedAt: number): void {
    const result = this.sequence.process(frame)
    if (result.decision === "duplicate") {
      this.duplicateCount++
      this.trace.add(receivedAt, "duplicate", frame, "duplicate messageId")
    } else if (result.decision === "stale") {
      this.staleCount++
      this.trace.add(receivedAt, "stale", frame, "sequence is not newer than the applied snapshot")
    } else if (result.decision === "buffered") {
      if (result.gap) this.gapCount++
      this.trace.add(receivedAt, "buffered", frame, result.droppedMessageId ? `buffer full; dropped ${result.droppedMessageId}` : "waiting for authoritative snapshot")
      if (this.sequence.getSnapshot().status === "DESYNCED") this.setConnectionState("DESYNCED")
      if (result.gap && !this.snapshotRequestPending) this.requestSnapshot("sequence-gap")
    } else {
      for (const accepted of result.frames) this.applyAcceptedSequenced(accepted, receivedAt)
      const sequenceStatus = this.sequence.getSnapshot().status
      this.setConnectionState(sequenceStatus === "READY" ? "READY" : "DESYNCED")
      if (result.gap) {
        this.gapCount++
        this.requestSnapshot("sequence-gap")
      } else {
        this.reconnectAttempt = 0
        this.reconnectHandshake = false
      }
    }
    this.emitDiagnostics()
  }

  private applyAcceptedSequenced(frame: ProtocolSnapshotFrame | ProtocolEventFrame, receivedAt: number): void {
    if (frame.frameType === "snapshot") {
      this.reconciler.applySnapshot(frame)
      this.snapshotCount++
      this.snapshotRequestPending = false
      this.trace.add(receivedAt, "snapshot-applied", frame)
    } else {
      this.reconciler.applyEvent(frame)
      this.trace.add(receivedAt, "accepted", frame, "ordered domain event")
    }
    this.acceptedCount++
    this.emitAccepted(frame)
  }

  private reject(reason: string, receivedAt: number, fatal: boolean, frame?: ProtocolFrame): void {
    this.rejectedCount++
    this.lastRejectionReason = reason
    this.trace.add(receivedAt, "rejected", frame, reason)
    this.invalidFrameTimes.push(receivedAt)
    while (this.invalidFrameTimes.length && receivedAt - this.invalidFrameTimes[0] > 10_000) this.invalidFrameTimes.shift()
    if (fatal || this.invalidFrameTimes.length >= 20) this.fatal(fatal ? reason : "validation failure flood: 20 invalid frames in 10 seconds")
    else this.emitDiagnostics()
  }

  private fatal(reason: string): void {
    this.lastError = reason
    this.manualDisconnect = true
    this.snapshotRequestPending = false
    this.clearReconnectTimer()
    this.clearHeartbeatTimer()
    this.setConnectionState("ERROR")
    this.transport.disconnect(reason)
    this.emitDiagnostics()
  }

  private handleTransportStatus(status: TransportStatus): void {
    if (this.disposed) return
    if (status.state === "OPEN") {
      this.connectionEpoch++
      this.connectionMessageIds.clear()
      this.connectionMessageIdQueue.length = 0
      this.snapshotRequestPending = false
      this.setConnectionState("HANDSHAKING")
      this.send({
        protocolVersion: PROTOCOL_VERSION,
        commandType: "client.hello",
        requestId: createRequestId(),
        clientId: this.clientId,
        supportedProtocolVersions: [PROTOCOL_VERSION],
      })
      return
    }
    if (status.state === "ERROR") {
      this.lastError = status.reason ?? "transport error"
      this.snapshotRequestPending = false
      this.emitDiagnostics()
      return
    }
    if (status.state !== "CLOSED") return
    this.snapshotRequestPending = false
    this.clearHeartbeatTimer()
    if (this.manualDisconnect || (status.manual && !this.reconnectAfterClose)) {
      if (this.connectionState !== "ERROR") this.setConnectionState("DISCONNECTED")
      return
    }
    this.reconnectAfterClose = false
    this.scheduleReconnect(status.reason ?? "transport closed")
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer || this.disposed || this.manualDisconnect || this.connectionState === "ERROR") return
    this.lastError = reason
    this.reconnectHandshake = true
    this.setConnectionState("RECONNECTING")
    const base = Math.min(10_000, 500 * 2 ** this.reconnectAttempt)
    const delay = Math.round(base * (0.9 + this.random() * 0.2))
    this.reconnectAttempt++
    this.reconnectCount++
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null
      void this.connect().catch((error) => this.scheduleReconnect(error instanceof Error ? error.message : String(error)))
    }, delay)
    this.emitDiagnostics()
  }

  private armHeartbeatTimeout(): void {
    this.clearHeartbeatTimer()
    if (!this.heartbeatIntervalMs) return
    const timeout = Math.max(this.heartbeatIntervalMs * 3, 10_000)
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null
      const age = this.lastHeartbeatAt === null ? Number.POSITIVE_INFINITY : this.clock.now() - this.lastHeartbeatAt
      if (age < timeout) {
        this.armHeartbeatTimeout()
        return
      }
      this.lastError = "heartbeat timeout"
      this.reconnectAfterClose = true
      this.transport.disconnect("heartbeat timeout")
    }, timeout)
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) this.clearTimer(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private isDuplicateMessage(frame: ProtocolFrame): boolean {
    const key = JSON.stringify([this.connectionEpoch, frame.sourceInstanceId, frame.sessionId, frame.messageId])
    if (this.connectionMessageIds.has(key)) return true
    this.connectionMessageIds.add(key)
    this.connectionMessageIdQueue.push(key)
    if (this.connectionMessageIdQueue.length > 1_024) {
      const oldest = this.connectionMessageIdQueue.shift()
      if (oldest) this.connectionMessageIds.delete(oldest)
    }
    return false
  }

  private send(command: ProtocolClientCommand): boolean {
    try {
      this.transport.send(command)
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitDiagnostics()
      return false
    }
  }

  private emitAccepted(frame: AcceptedProtocolFrame): void {
    for (const listener of this.acceptedListeners) listener(frame)
  }

  private setConnectionState(state: ProtocolConnectionState): void {
    if (state === this.connectionState) return
    this.connectionState = state
    this.emitDiagnostics()
  }

  private emitDiagnostics(): void {
    for (const listener of this.diagnosticsListeners) listener()
  }
}
