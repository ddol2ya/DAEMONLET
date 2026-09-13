import type { HitArea } from "../engine/anime25d/types"

export type ContinuousInteractionId = "PET" | "HOLD"
/** One token belongs to a physical press, even if its recognizer changes modes. */
export type PointerGestureSignal =
  | { type: "begin"; gestureId: number }
  | { type: "continuous"; gestureId: number; interactionId: ContinuousInteractionId; phase: "start" | "loop" | "end" }
  | { type: "end"; gestureId: number; reason: string }

export type GestureType = "tap" | "hold-start" | "hold-loop" | "hold-end" | "drag-start" | "drag" | "drag-end" | "pet-start" | "pet-loop" | "pet-end" | "cancel"

export type GestureEvent = {
  type: GestureType
  x: number
  y: number
  dx: number
  dy: number
  elapsed: number
  area: HitArea
}

export type GestureConfig = {
  holdMs: number
  dragThresholdPx: number
  petHorizontalTravelPx: number
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  holdMs: 480,
  dragThresholdPx: 12,
  petHorizontalTravelPx: 24,
}
