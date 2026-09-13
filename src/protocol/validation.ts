import {
  MAX_PROTOCOL_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_TASK_KINDS,
  type ProtocolCapability,
  type ProtocolDomainEvent,
  type ProtocolFrame,
  type ProtocolRunSnapshot,
} from "./types"

export type ProtocolValidationError = { code: string; message: string; fatal: boolean }
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: ProtocolValidationError }

const ID_MAX = 128
const LABEL_MAX = 256
const TEXT_MAX = 2_000
const MAX_RUNS = 64
const MAX_TASKS_PER_RUN = 256
const MAX_TOTAL_TASKS = 1_024
const CAPABILITIES = new Set<ProtocolCapability>(["snapshot", "heartbeat", "runs", "tasks", "progress", "replay"])
const FRAME_KEYS = new Set(["protocolVersion", "frameType", "messageId", "source", "sourceInstanceId", "sessionId", "sentAt", "sequence", "payload"])
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

const fail = (code: string, message: string, fatal = false): ValidationResult<never> => ({ ok: false, error: { code, message, fatal } })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key))
const text = (value: unknown, max: number, required = true) => typeof value === "string" && (!required || value.trim().length > 0) && value.length <= max && !CONTROL_CHARACTER.test(value)
export const isCanonicalProtocolId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= ID_MAX && value === value.trim() && !CONTROL_CHARACTER.test(value)
const id = isCanonicalProtocolId
const optionalText = (value: unknown, max: number) => value === undefined || text(value, max, false)
const optionalId = (value: unknown) => value === undefined || id(value)
const taskKind = (value: unknown) => value === undefined || PROTOCOL_TASK_KINDS.some((kind) => kind === value)
const confidence = (value: unknown) => value === undefined || value === "observed" || value === "authoritative"
const waitingReason = (value: unknown) => value === "user-input" || value === "approval"
const progress = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
const finiteNonNegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const sequence = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1

function validateBase(value: Record<string, unknown>): ValidationResult<never> | null {
  if (!hasOnly(value, [...FRAME_KEYS])) return fail("unknown-field", "frame contains an unknown top-level field")
  if (value.protocolVersion !== PROTOCOL_VERSION) return fail("unsupported-version", `unsupported protocolVersion: ${String(value.protocolVersion)}`, true)
  if (!id(value.messageId) || !id(value.source) || !id(value.sourceInstanceId) || !id(value.sessionId)) return fail("invalid-id", "frame IDs must be canonical 1-128 character values without leading/trailing whitespace or control characters")
  if (!finiteNonNegative(value.sentAt)) return fail("invalid-sent-at", "sentAt must be a finite non-negative number")
  if (!isRecord(value.payload)) return fail("invalid-payload", "payload must be an object")
  return null
}

function validateDomainEvent(value: Record<string, unknown>): ValidationResult<ProtocolDomainEvent> {
  const type = value.type
  if (typeof type !== "string") return fail("invalid-event-type", "event type is required")
  const runOnly = ["type", "runId"]
  const taskOnly = ["type", "runId", "taskId", "kind"]
  if (!id(value.runId)) return fail("invalid-run-id", "runId must be a canonical 1-128 character ID without leading/trailing whitespace or control characters")
  if (type.startsWith("task.") && !taskKind(value.kind)) return fail("invalid-task-kind", "unknown task kind")

  switch (type) {
    case "run.started":
      if (!hasOnly(value, [...runOnly, "label"]) || !optionalText(value.label, LABEL_MAX)) return fail("invalid-run-started", "invalid run.started payload")
      break
    case "run.progress":
      if (!hasOnly(value, [...runOnly, "progress"]) || !progress(value.progress)) return fail("invalid-progress", "progress must be a finite number from 0 to 1")
      break
    case "run.waiting":
      if (!hasOnly(value, [...runOnly, "reason"]) || !waitingReason(value.reason)) return fail("invalid-run-waiting", "run.waiting requires user-input or approval reason")
      break
    case "run.resumed":
      if (!hasOnly(value, runOnly)) return fail("invalid-run-resumed", "invalid run.resumed payload")
      break
    case "run.completed":
      if (!hasOnly(value, [...runOnly, "summary", "confidence"]) || !optionalText(value.summary, TEXT_MAX) || !confidence(value.confidence)) return fail("invalid-run-completed", "invalid run.completed payload")
      break
    case "run.failed":
      if (!hasOnly(value, [...runOnly, "code", "message"]) || !optionalId(value.code) || !optionalText(value.message, TEXT_MAX)) return fail("invalid-run-failed", "invalid run.failed payload")
      break
    case "run.cancelled":
      if (!hasOnly(value, [...runOnly, "reason"]) || !optionalText(value.reason, TEXT_MAX)) return fail("invalid-run-cancelled", "invalid run.cancelled payload")
      break
    case "task.started":
      if (!hasOnly(value, [...taskOnly, "label"]) || !id(value.taskId) || !optionalText(value.label, LABEL_MAX)) return fail("invalid-task-started", "invalid task.started payload")
      break
    case "task.progress":
      if (!hasOnly(value, [...taskOnly, "progress"]) || !id(value.taskId) || !progress(value.progress)) return fail("invalid-progress", "progress must be a finite number from 0 to 1")
      break
    case "task.completed":
      if (!hasOnly(value, taskOnly) || !id(value.taskId)) return fail("invalid-task-completed", "invalid task.completed payload")
      break
    case "task.failed":
      if (!hasOnly(value, [...taskOnly, "code", "message"]) || !id(value.taskId) || !optionalId(value.code) || !optionalText(value.message, TEXT_MAX)) return fail("invalid-task-failed", "invalid task.failed payload")
      break
    case "task.cancelled":
      if (!hasOnly(value, [...taskOnly, "reason"]) || !id(value.taskId) || !optionalText(value.reason, TEXT_MAX)) return fail("invalid-task-cancelled", "invalid task.cancelled payload")
      break
    default:
      return fail("unknown-event-type", `unknown event type: ${type}`)
  }
  return { ok: true, value: value as ProtocolDomainEvent }
}

function validateRunSnapshot(value: unknown): ValidationResult<ProtocolRunSnapshot> {
  if (!isRecord(value) || !hasOnly(value, ["runId", "label", "progress", "waitingFor", "tasks"]) || !id(value.runId) || !optionalText(value.label, LABEL_MAX) || !progress(value.progress) || (value.waitingFor !== undefined && !waitingReason(value.waitingFor)) || !Array.isArray(value.tasks)) {
    return fail("invalid-run-snapshot", "invalid run snapshot")
  }
  if (value.tasks.length > MAX_TASKS_PER_RUN) return fail("too-many-tasks", `a run may contain at most ${MAX_TASKS_PER_RUN} tasks`)
  const seen = new Set<string>()
  for (const task of value.tasks) {
    if (!isRecord(task) || !hasOnly(task, ["taskId", "label", "status", "progress", "kind"]) || !id(task.taskId) || task.status !== "running" || !optionalText(task.label, LABEL_MAX) || !progress(task.progress) || !taskKind(task.kind)) return fail("invalid-task-snapshot", "invalid task snapshot")
    const taskId = task.taskId as string
    if (seen.has(taskId)) return fail("duplicate-task", `duplicate taskId in snapshot: ${taskId}`)
    seen.add(taskId)
  }
  return { ok: true, value: value as ProtocolRunSnapshot }
}

export function validateProtocolFrame(value: unknown): ValidationResult<ProtocolFrame> {
  if (!isRecord(value)) return fail("invalid-frame", "frame must be an object")
  const baseError = validateBase(value)
  if (baseError) return baseError
  const payload = value.payload as Record<string, unknown>

  switch (value.frameType) {
    case "hello": {
      if (value.sequence !== undefined || !hasOnly(payload, ["sourceName", "supportedProtocolVersions", "capabilities", "heartbeatIntervalMs"])) return fail("invalid-hello", "invalid hello frame fields")
      if (!text(payload.sourceName, LABEL_MAX) || !Array.isArray(payload.supportedProtocolVersions) || !payload.supportedProtocolVersions.includes(PROTOCOL_VERSION)) return fail("unsupported-version", "hello must support protocol version 1", true)
      if (!Array.isArray(payload.capabilities) || payload.capabilities.length > CAPABILITIES.size || !payload.capabilities.every((item) => typeof item === "string" && CAPABILITIES.has(item as ProtocolCapability)) || !payload.capabilities.includes("snapshot")) return fail("invalid-capabilities", "hello must advertise valid capabilities including snapshot")
      if (typeof payload.heartbeatIntervalMs !== "number" || !Number.isFinite(payload.heartbeatIntervalMs) || payload.heartbeatIntervalMs < 1_000 || payload.heartbeatIntervalMs > 60_000) return fail("invalid-heartbeat-interval", "heartbeatIntervalMs must be from 1000 to 60000")
      break
    }
    case "heartbeat":
      if (value.sequence !== undefined || !hasOnly(payload, ["heartbeatId"]) || !id(payload.heartbeatId)) return fail("invalid-heartbeat", "invalid heartbeat frame")
      break
    case "error":
      if (value.sequence !== undefined || !hasOnly(payload, ["code", "message", "recoverable"]) || !id(payload.code) || !text(payload.message, TEXT_MAX, false) || typeof payload.recoverable !== "boolean") return fail("invalid-error", "invalid error frame")
      break
    case "event": {
      if (!sequence(value.sequence)) return fail("invalid-sequence", "event sequence must be a positive safe integer")
      const event = validateDomainEvent(payload)
      if (!event.ok) return event
      break
    }
    case "snapshot": {
      if (!sequence(value.sequence) || !hasOnly(payload, ["snapshotId", "activeRuns"]) || !id(payload.snapshotId) || !Array.isArray(payload.activeRuns)) return fail("invalid-snapshot", "invalid snapshot frame")
      if (payload.activeRuns.length > MAX_RUNS) return fail("too-many-runs", `snapshot may contain at most ${MAX_RUNS} runs`)
      const runIds = new Set<string>()
      let taskCount = 0
      for (const run of payload.activeRuns) {
        const validated = validateRunSnapshot(run)
        if (!validated.ok) return validated
        const runId = validated.value.runId
        if (runIds.has(runId)) return fail("duplicate-run", `duplicate runId in snapshot: ${runId}`)
        runIds.add(runId)
        taskCount += validated.value.tasks.length
      }
      if (taskCount > MAX_TOTAL_TASKS) return fail("too-many-tasks", `snapshot may contain at most ${MAX_TOTAL_TASKS} tasks`)
      break
    }
    default:
      return fail("unknown-frame-type", `unknown frameType: ${String(value.frameType)}`)
  }
  return { ok: true, value: value as ProtocolFrame }
}

export function parseProtocolFrame(raw: string | ArrayBuffer): ValidationResult<ProtocolFrame> {
  if (raw instanceof ArrayBuffer) return fail("binary-not-supported", "binary protocol frames are not supported in v1")
  if (new TextEncoder().encode(raw).byteLength > MAX_PROTOCOL_MESSAGE_BYTES) return fail("message-too-large", `protocol frame exceeds ${MAX_PROTOCOL_MESSAGE_BYTES} bytes`)
  try {
    return validateProtocolFrame(JSON.parse(raw) as unknown)
  } catch {
    return fail("malformed-json", "protocol frame is not valid JSON")
  }
}
