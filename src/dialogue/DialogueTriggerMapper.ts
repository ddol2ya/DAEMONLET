import type { BehaviorLifecycleEvent } from "../behavior/BehaviorLifecycleEvent"
import type { CharacterStateSnapshot } from "../behavior/types"
import type { CharacterLifecycleEvent } from "../lifecycle/CharacterLifecycleEvent"
import { isUserInterruption } from "../lifecycle/isUserInterruption"
import type { MotionLifecycleEvent } from "../motion/orchestration/MotionLifecycleBus"
import { isDialogueTriggerId, type DialogueTriggerId } from "./types"

export function mapLifecycleTrigger(event: CharacterLifecycleEvent, semantic: CharacterStateSnapshot): DialogueTriggerId | null {
  if (event.type === "snapshot.applied") return null
  if (event.type === "run.started") {
    return semantic.state === "BUSY" && semantic.activeTaskIds.length === 1 && semantic.activeTaskIds[0] === event.runId ? "run.started" : null
  }
  if (event.type === "task.started") {
    const id = `task.started.${event.kind}`
    return semantic.state === "BUSY" && semantic.activeTaskIds.includes(event.runId) && isDialogueTriggerId(id) ? id : null
  }
  const outcome = semantic.lastOutcome
  // Snapshot recovery, unknown and stale terminals cannot borrow an earlier outcome.
  const lastEvent = semantic.lastEvent
  if (!outcome || outcome.taskId !== event.runId || !lastEvent || !("taskId" in lastEvent) || lastEvent.taskId !== event.runId
    || !semantic.lastEventAccepted || semantic.activeTaskIds.length) return null
  if (event.type === "run.completed" && outcome.kind === "completed" && lastEvent.type === "TASK_COMPLETED" && semantic.state === "HAPPY") {
    return event.confidence === "authoritative" ? "run.completed.authoritative" : "run.completed.observed"
  }
  if (event.type === "run.failed" && outcome.kind === "failed" && lastEvent.type === "TASK_FAILED" && semantic.transitionReason === "last-task-failed") return "run.failed"
  if (event.type === "run.cancelled" && outcome.kind === "cancelled" && lastEvent.type === "TASK_CANCELLED" && semantic.transitionReason === "last-task-cancelled"
    && isUserInterruption(event.reason)) return "run.cancelled.user"
  return null
}

export function mapBehaviorTrigger(event: BehaviorLifecycleEvent): DialogueTriggerId | null {
  if (event.type === "semantic.changed") return event.previous === "NORMAL" && event.current === "BORED" && event.reason === "idle-timeout" ? "state.bored" : null
  if (event.type !== "action.started" || event.kind !== "bored") return null
  if (event.actionId === "bored-look-away") return "behavior.bored-look-away"
  if (event.actionId === "bored-sigh") return "behavior.bored-sigh"
  return null
}

export function mapMotionTrigger(event: MotionLifecycleEvent): DialogueTriggerId | null {
  if (event.type !== "interaction.started") return null
  switch (event.interactionId) {
    case "HEAD_TAP": return "interaction.head-tap"
    case "TORSO_TAP": return "interaction.torso-tap"
    case "HOLD":
    case "HOLD_START": return "interaction.face-hold"
    case "PET":
    case "PET_START": return "interaction.pet"
    default: return null
  }
}
