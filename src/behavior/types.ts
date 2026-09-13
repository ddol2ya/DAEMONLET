import type { ContinuousInteractionId } from "../interaction/types"
import type { Anime25DParameter, Anime25DParameterState } from "../engine/anime25d/types"
import type { MotionTrack, MotionTiming } from "../motion/types"

export type CharacterSemanticState = "NORMAL" | "BORED" | "BUSY" | "HAPPY" | "WAITING"
export type CharacterWaitingReason = "user-input" | "approval"

export type UserActivitySource = "pointer" | "touch" | "keyboard" | "debug"

export type CharacterCompletionConfidence = "authoritative" | "observed"
export type CharacterRunOutcome =
  | { kind: "completed"; taskId: string; confidence: CharacterCompletionConfidence | null; at: number }
  | { kind: "failed"; taskId: string; code: string | null; at: number }
  | { kind: "cancelled"; taskId: string; reason: string | null; at: number }

export type CharacterTaskEvent =
  | { type: "TASK_STARTED"; taskId: string; at?: number }
  | { type: "TASK_PROGRESS"; taskId: string; progress?: number; at?: number }
  | { type: "TASK_WAITING"; taskId: string; reason?: CharacterWaitingReason; at?: number }
  | { type: "TASK_RESUMED"; taskId: string; at?: number }
  | { type: "TASK_COMPLETED"; taskId: string; confidence?: CharacterCompletionConfidence; at?: number }
  | { type: "TASK_FAILED"; taskId: string; code?: string; message?: string; at?: number }
  | { type: "TASK_CANCELLED"; taskId: string; reason?: string; at?: number }
  | { type: "TASK_SNAPSHOT"; tasks: Array<{ taskId: string; progress?: number; waitingFor?: CharacterWaitingReason }>; at?: number }
  | { type: "CONNECTION_CHANGED"; connected: boolean; at?: number }
  | { type: "USER_ACTIVITY"; source: UserActivitySource; at?: number }
  | { type: "RESET"; at?: number }

export interface Clock {
  now(): number
}

export type BehaviorTiming = {
  boredAfterMs: number
  happyDurationMs: number
  stateBlendMs: number
  boredActionDelayMinMs: number
  boredActionDelayMaxMs: number
}

export type BehaviorMotion = MotionTiming & {
  parameters: Partial<Record<Anime25DParameter, MotionTrack>>
}

export type BehaviorAction = {
  id: string
  durationMs: number
  motion: BehaviorMotion
  poseId?: string
  /** Additional complete pose models, chosen without repetition for each action. */
  poseVariants?: string[]
}

export type ContinuousReaction = {
  poseId?: string
  motion: BehaviorMotion
  enterMs: number
  releaseMs: number
  workScale: number
}

export type BehaviorStateDefinition = {
  poseId: string | null
  poseVariants?: string[]
  /** Optional idle rotation; its clock starts after the chosen model is ready. */
  poseVariantIntervalMs?: number
  motion?: BehaviorMotion
  fallbackMotion?: BehaviorMotion
  actions?: BehaviorAction[]
}

export type BehaviorManifest = {
  schemaVersion: 1
  gazeTakeoverFromCurrent?: boolean
  timing: BehaviorTiming
  states: Record<Exclude<CharacterSemanticState, "WAITING">, BehaviorStateDefinition> & { WAITING?: BehaviorStateDefinition }
  failureReaction?: BehaviorAction
  cancellationReaction?: BehaviorAction
  interactionReactions?: Partial<Record<"HEAD_TAP" | "TORSO_TAP", BehaviorAction>>
  continuousReactions?: Partial<Record<ContinuousInteractionId, ContinuousReaction>>
  disconnected?: BehaviorStateDefinition
}

export type BehaviorProfile = BehaviorManifest & {
  sourceUrl: string | null
  warnings: string[]
  usedDefault: boolean
}

export type CharacterStateSnapshot = {
  state: CharacterSemanticState
  previousState: CharacterSemanticState | null
  stateSince: number
  lastActivityAt: number
  activeTaskIds: string[]
  waitingTaskIds: string[]
  taskProgress: Record<string, number | undefined>
  lastEvent: CharacterTaskEvent | null
  lastEventAccepted: boolean
  lastOutcome: CharacterRunOutcome | null
  lastStaleEvent: CharacterTaskEvent | null
  staleEventCount: number
  transitionReason: string
}

export type BehaviorControlMode = "AUTO_BEHAVIOR" | "MANUAL_POSE"
export type BehaviorPoseLoadStatus = "idle" | "loading" | "entering" | "ready" | "fallback" | "manual"

export type BehaviorHistoryEntry = {
  at: number
  state: CharacterSemanticState
  reason: string
  activeTaskIds: string[]
}

export type CharacterBehaviorDiagnostics = {
  controlMode: BehaviorControlMode
  semantic: CharacterStateSnapshot
  idleElapsedMs: number
  currentBoredAction: string | null
  currentReaction: string | null
  connected: boolean
  desiredPoseId: string | null
  loadedPoseId: string | null
  activePoseId: string | null
  poseLoadStatus: BehaviorPoseLoadStatus
  warning: string | null
  stateParameters: Partial<Anime25DParameterState>
  actionParameters: Partial<Anime25DParameterState>
  transitionHistory: BehaviorHistoryEntry[]
  boredActionHistory: string[]
  manifestWarnings: string[]
}
