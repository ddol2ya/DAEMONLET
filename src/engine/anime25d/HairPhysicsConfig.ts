import type { HairPhysicsConfig, HairPhysicsTuning } from "./types"

export type SpringValue = { x: number; v: number; dx: number }

export const DEFAULT_HAIR_PHYSICS: HairPhysicsConfig = {
  frontHair: {
    amplitude: 0.72,
    stiffness: 78,
    damping: 12,
    wind: 0.34,
    inertia: 0.62,
    rootLock: 0.3,
    maxOffset: 14,
  },
  backHair: {
    amplitude: 0.86,
    stiffness: 48,
    damping: 9.5,
    wind: 0.46,
    inertia: 0.82,
    rootLock: 0.24,
    maxOffset: 22,
  },
  layers: {},
}

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function normalizeHairTuning(value: Partial<HairPhysicsTuning>, fallback: HairPhysicsTuning): HairPhysicsTuning {
  return {
    amplitude: clamp(finite(value.amplitude ?? fallback.amplitude, fallback.amplitude), 0, 3),
    stiffness: clamp(finite(value.stiffness ?? fallback.stiffness, fallback.stiffness), 1, 240),
    damping: clamp(finite(value.damping ?? fallback.damping, fallback.damping), 0.1, 60),
    wind: clamp(finite(value.wind ?? fallback.wind, fallback.wind), 0, 3),
    inertia: clamp(finite(value.inertia ?? fallback.inertia, fallback.inertia), 0, 3),
    rootLock: clamp(finite(value.rootLock ?? fallback.rootLock, fallback.rootLock), 0, 0.95),
    maxOffset: clamp(finite(value.maxOffset ?? fallback.maxOffset, fallback.maxOffset), 0, 160),
  }
}

export function mergeHairPhysics(value?: Partial<HairPhysicsConfig>): HairPhysicsConfig {
  return {
    frontHair: normalizeHairTuning(value?.frontHair ?? {}, DEFAULT_HAIR_PHYSICS.frontHair),
    backHair: normalizeHairTuning(value?.backHair ?? {}, DEFAULT_HAIR_PHYSICS.backHair),
    layers: { ...(value?.layers ?? {}) },
  }
}

export function tuningForLayer(config: HairPhysicsConfig, name: string): HairPhysicsTuning {
  const base = name.replace(/_(l|r)$/i, "").replace(/_\d+$/, "") === "front hair" ? config.frontHair : config.backHair
  const override = config.layers[name] ?? config.layers[name.replace(/_\d+$/, "")] ?? {}
  return normalizeHairTuning(override, base)
}

export function rootWeightedAmount(u: number, rootLock: number, exponent: number): number {
  const unlocked = clamp((u - rootLock) / Math.max(0.001, 1 - rootLock), 0, 1)
  return Math.pow(unlocked, exponent)
}

export function stepSpring(spring: SpringValue, target: number, stiffness: number, damping: number, maxOffset: number, dt: number): SpringValue {
  // Semi-implicit Euler stays deterministic across refresh rates when every
  // public step is divided into the same small integration quanta. Preserve a
  // bounded 250ms catch-up window after a long frame instead of hiding all
  // elapsed time behind a single 50ms clamp.
  let remaining = clamp(finite(dt, 0), 0, 0.25)
  let x = finite(spring.x, target)
  let v = finite(spring.v, 0)
  const limit = Math.max(0, finite(maxOffset, 0))
  while (remaining > 1e-8) {
    const step = Math.min(remaining, 1 / 240)
    const acceleration = -stiffness * (x - target) - damping * v
    v = finite(v + acceleration * step, 0)
    x = finite(x + v * step, target)
    const bounded = clamp(x, target - limit, target + limit)
    if (bounded !== x && Math.sign(v) === Math.sign(x - target)) v = 0
    x = bounded
    remaining -= step
  }
  const displacement = clamp(-(x - target), -limit, limit)
  return { x, v, dx: Object.is(displacement, -0) ? 0 : displacement }
}

export function blendSpringOffset(stiff: number, soft: number, softness: number): number {
  const mix = clamp(softness, 0, 1)
  return stiff * (1 - mix) + soft * mix
}
