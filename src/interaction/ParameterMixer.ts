import { DEFAULT_PARAMETERS, PARAMETER_RANGES } from "../engine/anime25d/Anime25DParameters"
import type { Anime25DParameter, Anime25DParameterState } from "../engine/anime25d/types"
import type { MotionContribution, MotionContributionFrame } from "../motion/orchestration/types"

export type MixPolicy = "add" | "multiply" | "override" | "min" | "max" | "weighted"
type Source = { values: MotionContributionFrame; priority: number; weight: number; order: number }

const ADDITIVE = new Set<Anime25DParameter>(["angleX", "angleY", "angleZ", "eyeX", "eyeY", "brow", "browAngL", "browAngR", "browAngSym", "mouthOpen", "mouthForm", "mouthCY", "body", "armY", "armPos", "bangL", "bangC", "bangR", "eyeCY", "eyeCAng", "mouthCAng"])
const MINIMUM = new Set<Anime25DParameter>(["eyeOpenL", "eyeOpenR"])

export const DEFAULT_POLICIES = Object.fromEntries(
  (Object.keys(DEFAULT_PARAMETERS) as Anime25DParameter[]).map((name) => [name, MINIMUM.has(name) ? "min" : ADDITIVE.has(name) ? "add" : "override"]),
) as Record<Anime25DParameter, MixPolicy>

export class ParameterMixer {
  private readonly sources = new Map<string, Source>()
  private nextOrder = 1

  constructor(
    private readonly policies: Record<Anime25DParameter, MixPolicy> = DEFAULT_POLICIES,
    private readonly defaults: Anime25DParameterState = DEFAULT_PARAMETERS,
  ) {}

  /** Compatibility entry point. Runtime producers use MotionSourceHost leases. */
  setSource(name: string, values: Partial<Anime25DParameterState> | MotionContributionFrame, priority = 0, weight = 1) {
    const previous = this.sources.get(name)
    const cloned = Object.fromEntries(Object.entries(values).map(([key, contribution]) => [
      key,
      typeof contribution === "number" ? contribution : { ...contribution },
    ])) as MotionContributionFrame
    this.sources.set(name, {
      values: cloned,
      priority,
      weight: Math.max(0, Math.min(1, weight)),
      order: previous?.order ?? this.nextOrder++,
    })
  }

  removeSource(name: string) {
    this.sources.delete(name)
  }

  clear() {
    this.sources.clear()
  }

  evaluate(options: { exclude?: string | Iterable<string> } = {}): Anime25DParameterState {
    const output = { ...this.defaults }
    const excluded = typeof options.exclude === "string"
      ? new Set([options.exclude])
      : new Set(options.exclude ?? [])
    const ordered = [...this.sources.entries()]
      .filter(([name]) => !excluded.has(name))
      .map(([, source]) => source)
      .sort((a, b) => a.priority - b.priority || a.order - b.order)

    for (const key of Object.keys(output) as Anime25DParameter[]) {
      const entries = ordered.filter((source) => source.values[key] !== undefined)
      if (!entries.length) continue
      let value = output[key]

      for (const source of entries) {
        const contribution = source.values[key] as MotionContribution
        const amount = typeof contribution === "number" ? contribution : contribution.value
        const policy = typeof contribution === "number" ? this.policies[key] : contribution.mode ?? this.policies[key]
        const weight = Math.max(0, Math.min(1, source.weight * (typeof contribution === "number" ? 1 : contribution.weight ?? 1)))
        if (policy === "add") value += amount * weight
        if (policy === "multiply") value *= 1 + (amount - 1) * weight
        if (policy === "min") value = weight === 1 ? Math.min(value, amount) : value + (Math.min(value, amount) - value) * weight
        if (policy === "max") value = weight === 1 ? Math.max(value, amount) : value + (Math.max(value, amount) - value) * weight
        if (policy === "override" || policy === "weighted") value += (amount - value) * weight
      }

      const [min, max] = PARAMETER_RANGES[key]
      output[key] = Math.max(min, Math.min(max, value))
    }
    return output
  }
}
