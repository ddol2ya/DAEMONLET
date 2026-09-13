import type { Anime25DParameterState } from "../engine/anime25d/types"
import { sampleMotionTrack } from "../motion/MotionSampler"
import type { PoseLayerTransform, PoseMotion, PoseMotionTrack } from "./types"

export function samplePoseMotionTrack(track: PoseMotionTrack, elapsedMs: number, loopDurationMs: number): number {
  return sampleMotionTrack(track, elapsedMs, loopDurationMs)
}

export function samplePoseMotion(motion: PoseMotion | undefined, elapsedMs: number): {
  parameters: Partial<Anime25DParameterState>
  layers: Record<string, PoseLayerTransform>
} {
  if (!motion) return { parameters: {}, layers: {} }
  const sample = (track: PoseMotionTrack) => sampleMotionTrack(track, elapsedMs, motion.loopDurationMs, motion.playback)
  const parameters = Object.fromEntries(Object.entries(motion.parameters).map(([name, track]) => [name, sample(track)])) as Partial<Anime25DParameterState>
  const layers = Object.fromEntries(Object.entries(motion.layers).map(([name, layer]) => [name, {
    translateX: layer.translateX ? sample(layer.translateX) : 0,
    translateY: layer.translateY ? sample(layer.translateY) : 0,
    rotationDeg: layer.rotationDeg ? sample(layer.rotationDeg) : 0,
    scale: layer.scale ? sample(layer.scale) : 1,
    ...(layer.origin ? { origin: layer.origin } : {}),
    ...(layer.influence ? { influence: layer.influence } : {}),
  }]))
  return { parameters, layers }
}

/** Weight a local transform around its identity, including scale=1. */
export function weightPoseLayerTransforms(layers: Record<string, PoseLayerTransform>, weight: number): Record<string, PoseLayerTransform> {
  return Object.fromEntries(Object.entries(layers).map(([name, layer]) => [name, {
    ...layer, translateX: layer.translateX * weight, translateY: layer.translateY * weight,
    rotationDeg: layer.rotationDeg * weight, scale: 1 + (layer.scale - 1) * weight,
  }]))
}

/** Blend two samples of the same authored pose without resetting its geometry. */
export function blendPoseLayerTransforms(from: Record<string, PoseLayerTransform>, to: Record<string, PoseLayerTransform>, mix: number): Record<string, PoseLayerTransform> {
  const t = Math.max(0, Math.min(1, mix))
  const lerp = (a: number, b: number) => a + (b - a) * t
  return Object.fromEntries([...new Set([...Object.keys(from), ...Object.keys(to)])].map(name => {
    const a = from[name], b = to[name]
    return [name, {
      ...(b ?? a),
      translateX: lerp(a?.translateX ?? 0, b?.translateX ?? 0),
      translateY: lerp(a?.translateY ?? 0, b?.translateY ?? 0),
      rotationDeg: lerp(a?.rotationDeg ?? 0, b?.rotationDeg ?? 0),
      scale: lerp(a?.scale ?? 1, b?.scale ?? 1),
    }]
  }))
}
