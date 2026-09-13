export type MotionPlayback = "loop" | "once"
export type MotionEnvelope = { attackMs: number; releaseMs: number }
export type MotionTiming = {
  loopDurationMs: number
  /** Omitted fields retain the original looping behavior. Once holds its last sample. */
  playback?: MotionPlayback
  /** Fades the source contribution, not the parameter's absolute value. */
  envelope?: MotionEnvelope
}
export type MotionTrack =
  | { type: "constant"; value: number }
  | { type: "sine"; amplitude: number; phase: number; offset: number }
  | { type: "keyframes"; interpolation: "linear" | "smoothstep"; frames: Array<{ atMs: number; value: number }> }
