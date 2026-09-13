import type { NormalizedCodexEvent } from "../types.ts"
import type { ValidatedAppServerNotification } from "./AppServerEventValidator.ts"

export function mapAppServerNotification(notification: ValidatedAppServerNotification): NormalizedCodexEvent | null {
  const backend = "APP_SERVER_OWNED" as const
  if (notification.method === "turn/started") {
    return { type: "run.started", sessionId: notification.threadId, turnId: notification.turn.id, observedAt: notification.observedAt, backend }
  }
  if (notification.method === "turn/completed") {
    const common = { sessionId: notification.threadId, turnId: notification.turn.id, observedAt: notification.observedAt, backend }
    if (notification.turn.status === "completed") return { ...common, type: "run.completed", confidence: "authoritative" }
    if (notification.turn.status === "failed") return { ...common, type: "run.failed", code: "codex-turn-failed", ...(notification.turn.errorMessage ? { message: notification.turn.errorMessage } : {}) }
    if (notification.turn.status === "interrupted") return { ...common, type: "run.cancelled", reason: "interrupted" }
    return null
  }
  if (!("item" in notification) || !notification.item) return null
  const common = {
    sessionId: notification.threadId,
    turnId: notification.turnId,
    taskId: notification.item.id,
    category: notification.item.category,
    label: notification.item.label,
    observedAt: notification.observedAt,
  }
  if (notification.method === "item/started") return { ...common, type: "task.started" }
  if (notification.item.status === "failed") return { ...common, type: "task.failed" }
  if (notification.item.status === "declined") return { ...common, type: "task.cancelled" }
  return { ...common, type: "task.completed" }
}
