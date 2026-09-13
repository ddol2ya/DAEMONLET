import type { Anime25DParameterState } from "../engine/anime25d/types"

export type PoseId = "ARM_RAISED" | "MEMO_GLANCE"
export type PosePhase = "BASE" | "ENTER" | "ARM_RAISED_LOOP" | "MEMO_GLANCE_LOOP" | "EXIT"

type PoseSample = { active: boolean; phase: PosePhase; values: Partial<Anime25DParameterState> }

const PRESETS: Record<PoseId, Partial<Anime25DParameterState>> = {
  ARM_RAISED: { armY: 0.72, armPos: -0.12, body: -0.18, angleX: 0.24, brow: 0.18 },
  MEMO_GLANCE: { armY: 0.2, armPos: 0.18, body: 0.22, angleX: -0.3, eyeX: -0.35 },
}

const smoothstep = (value: number) => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

function interpolate(
  from: Partial<Anime25DParameterState>,
  to: Partial<Anime25DParameterState>,
  progress: number,
): Partial<Anime25DParameterState> {
  const output: Partial<Anime25DParameterState> = {}
  const keys = new Set([...Object.keys(from), ...Object.keys(to)] as (keyof Anime25DParameterState)[])
  for (const key of keys) output[key] = (from[key] ?? 0) + ((to[key] ?? 0) - (from[key] ?? 0)) * progress
  return output
}

export class PoseSequence {
  private phase: PosePhase = "BASE"
  private pose: PoseId = "ARM_RAISED"
  private startedAt = 0
  private from: Partial<Anime25DParameterState> = {}
  private target: Partial<Anime25DParameterState> = {}

  constructor(private readonly enterMs = 650, private readonly exitMs = 520) {}

  play(pose: PoseId, now: number): void {
    const current = this.sample(now).values
    this.pose = pose
    this.from = current
    this.target = { ...PRESETS[pose] }
    this.startedAt = now
    this.phase = "ENTER"
  }

  exit(now: number): void {
    if (this.phase === "BASE" || this.phase === "EXIT") return
    this.from = this.sample(now).values
    this.target = {}
    this.startedAt = now
    this.phase = "EXIT"
  }

  sample(now: number): PoseSample {
    if (this.phase === "BASE") return { active: false, phase: "BASE", values: {} }
    if (this.phase === "ENTER") {
      const progress = (now - this.startedAt) / this.enterMs
      if (progress >= 1) {
        this.phase = `${this.pose}_LOOP`
        this.startedAt = now
      } else return { active: true, phase: "ENTER", values: interpolate(this.from, this.target, smoothstep(progress)) }
    }
    if (this.phase === "EXIT") {
      const progress = (now - this.startedAt) / this.exitMs
      if (progress >= 1) {
        this.phase = "BASE"
        this.from = {}
        return { active: false, phase: "BASE", values: {} }
      }
      return { active: true, phase: "EXIT", values: interpolate(this.from, {}, smoothstep(progress)) }
    }

    const loopSeconds = (now - this.startedAt) / 1000
    const values = { ...this.target }
    values.body = (values.body ?? 0) + Math.sin(loopSeconds * 2.2) * 0.018
    values.angleZ = (values.angleZ ?? 0) + Math.sin(loopSeconds * 1.7) * 0.025
    return { active: true, phase: this.phase, values }
  }
}
