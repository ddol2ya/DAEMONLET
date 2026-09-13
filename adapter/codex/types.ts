export type CodexAdapterMode = "HOOK_OBSERVER" | "APP_SERVER_OWNED" | "APP_SERVER_ATTACH"

export type CodexTaskCategory =
  | "command"
  | "file-change"
  | "mcp-tool"
  | "dynamic-tool"
  | "web-search"
  | "subagent"
  | "review"
  | "other"

type Observed = { observedAt: number }
type RunIdentity = { sessionId: string; turnId: string }
type TaskIdentity = RunIdentity & {
  taskId: string
  category: CodexTaskCategory
  label: string
}

export type NormalizedCodexEvent =
  | (Observed & { type: "session.observed"; sessionId: string; cwd?: string; model?: string; backend: CodexAdapterMode })
  | (Observed & RunIdentity & { type: "run.started"; backend: CodexAdapterMode })
  | (Observed & RunIdentity & { type: "run.waiting"; requestId: string; reason: "user-input" | "approval"; backend: CodexAdapterMode })
  | (Observed & RunIdentity & { type: "run.resumed"; requestId: string; backend: CodexAdapterMode })
  | (Observed & RunIdentity & {
      type: "run.completed"
      backend: CodexAdapterMode
      confidence: "authoritative" | "hook-stop"
    })
  | (Observed & RunIdentity & { type: "run.failed"; backend: CodexAdapterMode; code?: string; message?: string })
  | (Observed & RunIdentity & { type: "run.cancelled"; backend: CodexAdapterMode; reason?: string })
  | (Observed & TaskIdentity & { type: "task.started" })
  | (Observed & TaskIdentity & { type: "task.completed" | "task.failed" | "task.cancelled" })

export type NormalizedCodexAction =
  | { kind: "event"; event: NormalizedCodexEvent }
  | { kind: "session-ended"; sessionId: string; observedAt: number; reason?: string }

export type CodexTaskRecord = {
  taskId: string
  sourceTaskId: string
  category: CodexTaskCategory
  label: string
  startedAt: number
  updatedAt: number
}

export type CodexRunRecord = {
  runId: string
  sessionId: string
  turnId: string
  backend: CodexAdapterMode
  status: "running"
  startedAt: number
  updatedAt: number
  tasks: Map<string, CodexTaskRecord>
  waitingRequests?: Map<string, "user-input" | "approval">
  recovery?: {
    restoredAt: number
    confirmationDeadline: number
  }
}

export type CodexAdapterStatus = "STOPPED" | "STARTING" | "READY" | "DEGRADED" | "ERROR"

export type CodexAdapterDiagnostics = {
  mode: CodexAdapterMode
  status: CodexAdapterStatus
  codexPath: string | null
  codexVersion: string | null
  sourceInstanceId: string
  hookIngress: {
    events?: import("./hooks/HookEvents.ts").HookEventReceipt[]
    endpoint: string
    accepted: number
    rejected: number
    authFailures: number
    timeouts: number
    lastEventAt: number | null
  }
  appServer: {
    processState: string
    handshakeState: string
    pendingRequests: number
    lastNotification: string | null
    lastError: string | null
  }
  activeRunCount: number
  activeTaskCount: number
  provisionalRecoveredRunCount: number
  recoveredRunCount: number
  staleRunCount: number
  protocolClientCount: number
  lastPersistenceAt: number | null
  warnings: string[]
  eventTrace: Array<{
    eventType: string
    backend: CodexAdapterMode
    sessionHash: string
    turnHash: string | null
    decision: "accepted" | "ignored"
    latencyMs: number
  }>
  idMappings: Array<{
    runId: string
    sessionId: string
    turnId: string
    tasks: Array<{ taskId: string; sourceTaskId: string }>
  }>
}
