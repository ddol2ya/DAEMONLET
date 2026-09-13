import type { Anime25DParameter } from "../../engine/anime25d/types"
import type { MixPolicy } from "../../interaction/ParameterMixer"

export type MotionContribution = number | {
  value: number
  mode?: MixPolicy
  weight?: number
}

export type MotionContributionFrame = Partial<Record<Anime25DParameter, MotionContribution>>

export type MotionSourceUpdateOptions = {
  priority?: number
  weight?: number
  modes?: Partial<Record<Anime25DParameter, MixPolicy>>
}

export type MotionSourceStatus = "active" | "superseded" | "released" | "cleared"

export type MotionSourceDiagnostics = {
  slot: string
  ownerId: string
  token: number
  priority: number
  weight: number
  activeParameterCount: number
  modeOverrides: Partial<Record<Anime25DParameter, MixPolicy>>
  status: MotionSourceStatus
  createdAt: number
  updatedAt: number
}

export interface MotionSourceLease {
  readonly slot: string
  readonly ownerId: string
  readonly token: number

  update(values: MotionContributionFrame, options?: MotionSourceUpdateOptions): void
  release(): void
  active(): boolean
}

export interface MotionSourceHostApi {
  acquire(options: { slot: string; ownerId: string; priority: number; weight?: number }): MotionSourceLease
  releaseOwner(ownerId: string): void
  clear(): void
  diagnostics(): MotionSourceDiagnostics[]
}
