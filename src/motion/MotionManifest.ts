import type { MotionTiming, MotionTrack } from "./types"

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const finite = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}
const unknown = (value: Record<string, unknown>, keys: string[], label: string, warnings: string[]) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) warnings.push(`${label}: unknown field '${key}'`)
}

export function parseMotionTiming(motion: Record<string, unknown>, label: string, warnings: string[]): MotionTiming {
  const loopDurationMs = finite(motion.loopDurationMs, `${label}.loopDurationMs`)
  if (loopDurationMs <= 0) throw new Error(`${label}.loopDurationMs must be positive`)
  if (motion.playback !== undefined && motion.playback !== "loop" && motion.playback !== "once") throw new Error(`${label}.playback must be 'loop' or 'once'`)
  if ((motion.playback !== undefined || motion.envelope !== undefined) && loopDurationMs > 60000) throw new Error(`${label} extended duration must be <= 60000ms`)
  let envelope: MotionTiming["envelope"]
  if (motion.envelope !== undefined) {
    const e = object(motion.envelope, `${label}.envelope`)
    unknown(e, ["attackMs", "releaseMs"], `${label}.envelope`, warnings)
    const attackMs = finite(e.attackMs, `${label}.envelope.attackMs`), releaseMs = finite(e.releaseMs, `${label}.envelope.releaseMs`)
    if (attackMs < 0 || releaseMs <= 0 || attackMs + releaseMs > loopDurationMs) throw new Error(`${label}.envelope requires non-negative attack, positive release and attack + release <= duration`)
    if ((motion.playback ?? "loop") === "loop" && attackMs === 0) throw new Error(`${label} looping envelope needs a positive attack for a continuous boundary`)
    envelope = { attackMs, releaseMs }
  }
  return { loopDurationMs, ...(motion.playback === undefined ? {} : { playback: motion.playback }), ...(envelope ? { envelope } : {}) }
}

export function parseMotionTrack(value: unknown, label: string, warnings: string[], timing: MotionTiming, range?: readonly [number, number]): MotionTrack {
  const track = object(value, label)
  if (track.type === "constant") {
    unknown(track, ["type", "value"], label, warnings)
    return { type: "constant", value: finite(track.value, `${label}.value`) }
  }
  if (track.type === "sine") {
    unknown(track, ["type", "amplitude", "phase", "offset"], label, warnings)
    return { type: "sine", amplitude: finite(track.amplitude, `${label}.amplitude`), phase: track.phase === undefined ? 0 : finite(track.phase, `${label}.phase`), offset: track.offset === undefined ? 0 : finite(track.offset, `${label}.offset`) }
  }
  if (track.type !== "keyframes") throw new Error(`${label}.type must be 'constant', 'sine' or 'keyframes'`)
  unknown(track, ["type", "frames", "interpolation"], label, warnings)
  if (track.interpolation !== "linear" && track.interpolation !== "smoothstep") throw new Error(`${label}.interpolation must be 'linear' or 'smoothstep'`)
  if (timing.loopDurationMs > 60000) throw new Error(`${label} keyframe duration must be <= 60000ms`)
  if (!Array.isArray(track.frames) || track.frames.length < 2 || track.frames.length > 32) throw new Error(`${label}.frames requires 2..32 entries`)
  const frames = track.frames.map((value, i) => {
    const frame = object(value, `${label}.frames[${i}]`)
    unknown(frame, ["atMs", "value"], `${label}.frames[${i}]`, warnings)
    const atMs = finite(frame.atMs, `${label}.frames[${i}].atMs`), amount = finite(frame.value, `${label}.frames[${i}].value`)
    if (atMs < 0 || atMs > timing.loopDurationMs) throw new Error(`${label} frame time is outside duration`)
    if (range && (amount < range[0] || amount > range[1])) throw new Error(`${label} frame value is outside allowed range`)
    return { atMs, value: amount }
  })
  if (frames[0].atMs !== 0 || frames.at(-1)!.atMs !== timing.loopDurationMs) throw new Error(`${label} frames must span the full duration`)
  if (frames.some((frame, i) => i > 0 && frame.atMs <= frames[i - 1].atMs)) throw new Error(`${label} times must be strictly increasing`)
  if ((timing.playback ?? "loop") === "loop" && frames[0].value !== frames.at(-1)!.value) throw new Error(`${label} loop endpoints must match`)
  return { type: "keyframes", interpolation: track.interpolation, frames }
}
