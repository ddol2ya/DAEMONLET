import type { CharacterCompletionConfidence, CharacterTaskEvent } from "../behavior/types"
import type { ProtocolTaskKind } from "../protocol/types"

/** Presentation signals deliberately omit labels, summaries and failure messages. */
export type CharacterLifecycleEvent =
  | { type: "run.started"; runId: string; at: number }
  | { type: "run.completed"; runId: string; confidence: CharacterCompletionConfidence | null; at: number }
  | { type: "run.failed"; runId: string; code: string | null; at: number }
  | { type: "run.cancelled"; runId: string; reason: string | null; at: number }
  | { type: "task.started" | "task.completed" | "task.failed" | "task.cancelled"; runId: string; taskId: string; kind: ProtocolTaskKind; at: number }
  | { type: "snapshot.applied"; activeRunIds: string[]; at: number }

export function taskEventLifecycle(event: CharacterTaskEvent, at: number): CharacterLifecycleEvent | null {
  switch (event.type) {
    case "TASK_STARTED": return { type: "run.started", runId: event.taskId, at }
    case "TASK_COMPLETED": return { type: "run.completed", runId: event.taskId, confidence: event.confidence ?? null, at }
    case "TASK_FAILED": return { type: "run.failed", runId: event.taskId, code: event.code ?? null, at }
    case "TASK_CANCELLED": return { type: "run.cancelled", runId: event.taskId, reason: event.reason ?? null, at }
    case "TASK_SNAPSHOT": return { type: "snapshot.applied", activeRunIds: event.tasks.map((task) => task.taskId), at }
    case "RESET": return { type: "snapshot.applied", activeRunIds: [], at }
    default: return null
  }
}
