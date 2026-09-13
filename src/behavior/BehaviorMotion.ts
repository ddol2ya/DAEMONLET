import { DEFAULT_PARAMETERS } from "../engine/anime25d/Anime25DParameters"
import type { Anime25DParameter, Anime25DParameterState } from "../engine/anime25d/types"
import { sampleMotionTrack } from "../motion/MotionSampler"
import type { BehaviorMotion } from "./types"

export function sampleBehaviorMotion(motion: BehaviorMotion | undefined, elapsedMs: number): Partial<Anime25DParameterState> {
  if (!motion) return {}
  return Object.fromEntries(Object.entries(motion.parameters).map(([name, track]) => [
    name,
    sampleMotionTrack(track, elapsedMs, motion.loopDurationMs, motion.playback),
  ])) as Partial<Anime25DParameterState>
}

export function blendBehaviorParameters(
  from: Partial<Anime25DParameterState>,
  to: Partial<Anime25DParameterState>,
  progress: number,
): Partial<Anime25DParameterState> {
  const t = Math.max(0, Math.min(1, progress))
  const keys = new Set([...Object.keys(from), ...Object.keys(to)] as Anime25DParameter[])
  return Object.fromEntries([...keys].map((name) => {
    const start = from[name] ?? DEFAULT_PARAMETERS[name]
    const end = to[name] ?? DEFAULT_PARAMETERS[name]
    return [name, start + (end - start) * t]
  })) as Partial<Anime25DParameterState>
}

