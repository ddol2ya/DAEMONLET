import type { ContinuousInteractionId } from "../interaction/types"
import type { CharacterSemanticState } from "./types"

export type BehaviorLifecycleEvent =
  | { type: "semantic.changed"; previous: CharacterSemanticState; current: CharacterSemanticState; reason: string; at: number }
  | { type: "action.started" | "action.completed" | "action.cancelled"; actionId: string; kind: "bored" | "transient" | "continuous"; at: number }

  | { type: "continuous.changed"; gestureId: number; interactionId: ContinuousInteractionId; phase: "pending" | "active" | "ended"; poseId: string | null; at: number }
