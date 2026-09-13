import type { MotionPlayback, MotionTiming, MotionTrack } from "./types"

const FULL_CYCLE = Math.PI * 2
const smoothstep = (t: number) => t * t * (3 - 2 * t)
function localTime(elapsedMs: number, durationMs: number, playback: MotionPlayback) {
  // Invalid clocks cannot poison a source. Valid legacy negative elapsed still wraps.
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0
  return playback === "once" ? Math.max(0, Math.min(durationMs, elapsed)) : ((elapsed % durationMs) + durationMs) % durationMs
}

export function sampleMotionTrack(track: MotionTrack, elapsedMs: number, loopDurationMs: number, playback: MotionPlayback = "loop"): number {
  if (track.type === "constant") return track.value
  const elapsed = localTime(elapsedMs, loopDurationMs, playback)
  if (track.type === "sine") return track.offset + Math.sin(elapsed / loopDurationMs * FULL_CYCLE + track.phase) * track.amplitude
  const frames = track.frames
  if (elapsed <= frames[0].atMs) return frames[0].value
  for (let i = 1; i < frames.length; i++) {
    const right = frames[i], left = frames[i - 1]
    if (elapsed > right.atMs) continue
    const progress = (elapsed - left.atMs) / (right.atMs - left.atMs)
    const t = track.interpolation === "smoothstep" ? smoothstep(progress) : progress
    return left.value + (right.value - left.value) * t
  }
  return frames[frames.length - 1].value
}

export function sampleMotionEnvelope(motion: MotionTiming | undefined, elapsedMs: number): number {
  if (!motion?.envelope) return 1
  const elapsed = localTime(elapsedMs, motion.loopDurationMs, motion.playback ?? "loop")
  const { attackMs, releaseMs } = motion.envelope
  if (elapsedMs < 0 || elapsed >= motion.loopDurationMs) return 0
  if (attackMs > 0 && elapsed < attackMs) return smoothstep(elapsed / attackMs)
  if (releaseMs > 0 && elapsed > motion.loopDurationMs - releaseMs) return smoothstep((motion.loopDurationMs - elapsed) / releaseMs)
  return 1
}
