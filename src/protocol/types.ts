export const PROTOCOL_VERSION = 1 as const
export const MAX_PROTOCOL_MESSAGE_BYTES = 64 * 1024

export type ProtocolVersion = typeof PROTOCOL_VERSION
export type ProtocolFrameType = "hello" | "event" | "snapshot" | "heartbeat" | "error"
export type ProtocolCapability = "snapshot" | "heartbeat" | "runs" | "tasks" | "progress" | "replay"
export type ProtocolCompletionConfidence = "authoritative" | "observed"
export type ProtocolWaitingReason = "user-input" | "approval"
export const PROTOCOL_TASK_KINDS = ["command", "file-change", "tool", "web-search", "subtask", "review", "other"] as const
export type ProtocolTaskKind = typeof PROTOCOL_TASK_KINDS[number]

export type ProtocolFrameBase = {
  protocolVersion: ProtocolVersion
  frameType: ProtocolFrameType
  messageId: string
  source: string
  sourceInstanceId: string
  sessionId: string
  sentAt: number
}

export type SequencedProtocolFrameBase = ProtocolFrameBase & { sequence: number }

export type SourceHelloFrame = ProtocolFrameBase & {
  frameType: "hello"
  payload: {
    sourceName: string
    supportedProtocolVersions: ProtocolVersion[]
    capabilities: ProtocolCapability[]
    heartbeatIntervalMs: number
  }
}

export type HeartbeatFrame = ProtocolFrameBase & {
  frameType: "heartbeat"
  payload: { heartbeatId: string }
}

export type ProtocolDomainEvent =
  | { type: "run.started"; runId: string; label?: string }
  | { type: "run.progress"; runId: string; progress?: number }
  | { type: "run.waiting"; runId: string; reason: ProtocolWaitingReason }
  | { type: "run.resumed"; runId: string }
  | { type: "run.completed"; runId: string; summary?: string; confidence?: ProtocolCompletionConfidence }
  | { type: "run.failed"; runId: string; code?: string; message?: string }
  | { type: "run.cancelled"; runId: string; reason?: string }
  | { type: "task.started"; runId: string; taskId: string; label?: string; kind?: ProtocolTaskKind }
  | { type: "task.progress"; runId: string; taskId: string; progress?: number; kind?: ProtocolTaskKind }
  | { type: "task.completed"; runId: string; taskId: string; kind?: ProtocolTaskKind }
  | { type: "task.failed"; runId: string; taskId: string; code?: string; message?: string; kind?: ProtocolTaskKind }
  | { type: "task.cancelled"; runId: string; taskId: string; reason?: string; kind?: ProtocolTaskKind }

export type ProtocolEventFrame = SequencedProtocolFrameBase & {
  frameType: "event"
  payload: ProtocolDomainEvent
}

export type ProtocolTaskSnapshot = {
  taskId: string
  kind?: ProtocolTaskKind
  label?: string
  status: "running"
  progress?: number
}

export type ProtocolRunSnapshot = {
  runId: string
  label?: string
  progress?: number
  waitingFor?: ProtocolWaitingReason
  tasks: ProtocolTaskSnapshot[]
}

export type ProtocolSnapshotFrame = SequencedProtocolFrameBase & {
  frameType: "snapshot"
  payload: {
    snapshotId: string
    activeRuns: ProtocolRunSnapshot[]
  }
}

export type SourceErrorFrame = ProtocolFrameBase & {
  frameType: "error"
  payload: { code: string; message: string; recoverable: boolean }
}

export type ProtocolFrame = SourceHelloFrame | HeartbeatFrame | ProtocolEventFrame | ProtocolSnapshotFrame | SourceErrorFrame
export type SequencedProtocolFrame = ProtocolEventFrame | ProtocolSnapshotFrame
export type AcceptedProtocolFrame = ProtocolFrame

export type SnapshotRequestReason = "initial" | "reconnect" | "sequence-gap" | "manual"

export type ClientHelloCommand = {
  protocolVersion: ProtocolVersion
  commandType: "client.hello"
  requestId: string
  clientId: string
  supportedProtocolVersions: ProtocolVersion[]
}

export type SnapshotRequestCommand = {
  protocolVersion: ProtocolVersion
  commandType: "snapshot.request"
  requestId: string
  reason: SnapshotRequestReason
}

export type ClientPingCommand = {
  protocolVersion: ProtocolVersion
  commandType: "client.ping"
  requestId: string
  sentAt: number
}

export type ProtocolClientCommand = ClientHelloCommand | SnapshotRequestCommand | ClientPingCommand

export type ProtocolConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "HANDSHAKING"
  | "SYNCING"
  | "READY"
  | "DESYNCED"
  | "RECONNECTING"
  | "ERROR"

export type ProtocolRunDiagnostics = {
  runId: string
  label?: string
  progress?: number
  waitingFor?: ProtocolWaitingReason
  runningTaskIds: string[]
  failedTaskIds: string[]
}

export type ProtocolDiagnostics = {
  connectionState: ProtocolConnectionState
  connectionEpoch: number
  endpoint: string | null
  protocolVersion: number | null
  source: string | null
  sourceInstanceId: string | null
  sessionId: string | null
  lastAppliedSequence: number
  bufferedFrameCount: number
  acceptedCount: number
  duplicateCount: number
  staleCount: number
  rejectedCount: number
  gapCount: number
  snapshotCount: number
  reconnectCount: number
  snapshotRequestPending: boolean
  lastMessageAt: number | null
  lastHeartbeatAt: number | null
  heartbeatAgeMs: number | null
  activeRuns: ProtocolRunDiagnostics[]
  activeTaskCount: number
  lastError: string | null
  lastRejectionReason: string | null
}

export type ProtocolTraceDecision = "accepted" | "buffered" | "duplicate" | "stale" | "rejected" | "snapshot-applied"

export type ProtocolTraceEntry = {
  receivedAt: number
  messageId: string | null
  frameType: string | null
  sequence: number | null
  decision: ProtocolTraceDecision
  reason?: string
  latencyMs?: number
}

export type ProtocolTraceExport = {
  protocolVersion: ProtocolVersion
  exportedAt: number
  entries: ProtocolTraceEntry[]
}

export type ProtocolRuntimeSnapshot = {
  sourceInstanceId: string
  sessionId: string
  sequence: number
  activeRuns: ProtocolRunSnapshot[]
}
