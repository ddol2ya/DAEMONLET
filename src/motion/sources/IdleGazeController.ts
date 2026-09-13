import type { CharacterSemanticState, Clock } from "../../behavior/types"

export type IdleGazeConfig = {
  pointerReleaseDelayMs: number
  targetHoldMinMs: number
  targetHoldMaxMs: number
  eyeXMin: number
  eyeXMax: number
  eyeYMin: number
  eyeYMax: number
  headFactorX: number
  headFactorY: number
  eyeSpeed: number
  headSpeed: number
  minimumTargetDistance: number
}

export type IdleGazeOutput = {
  eyeX: number
  eyeY: number
  headX: number
  headY: number
  active: boolean
}

export type IdleGazeDiagnostics = IdleGazeOutput & {
  enabled: boolean
  targetEyeX: number
  targetEyeY: number
  nextTargetAt: number
  nextTargetInMs: number
}

export const DEFAULT_IDLE_GAZE_CONFIG: IdleGazeConfig = {
  pointerReleaseDelayMs: 1500,
  targetHoldMinMs: 1600,
  targetHoldMaxMs: 3600,
  eyeXMin: -0.42,
  eyeXMax: 0.42,
  eyeYMin: -0.22,
  eyeYMax: 0.15,
  headFactorX: 0.24,
  headFactorY: -0.2,
  eyeSpeed: 10,
  headSpeed: 3.2,
  minimumTargetDistance: 0.18,
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export class IdleGazeController {
  private readonly config: IdleGazeConfig
  private enabled = true
  private active = false
  private targetEyeX = 0
  private targetEyeY = 0
  private eyeX = 0
  private eyeY = 0
  private headX = 0
  private headY = 0
  private nextTargetAt = 0
  private lastUpdatedAt = 0
  private forceTarget = false

  constructor(options: { clock: Clock; random?: () => number; config?: Partial<IdleGazeConfig> }) {
    this.clock = options.clock
    this.random = options.random ?? Math.random
    this.config = { ...DEFAULT_IDLE_GAZE_CONFIG, ...options.config }
    this.reset()
  }

  private readonly clock: Clock
  private readonly random: () => number

  update(input: { now: number; semanticState: CharacterSemanticState; pointerActive: boolean }): IdleGazeOutput {
    const dt = Math.max(0, Math.min(0.1, (input.now - this.lastUpdatedAt) / 1000))
    this.lastUpdatedAt = input.now
    if (!this.enabled || input.pointerActive || input.semanticState !== "NORMAL") {
      this.active = false
      this.targetEyeX = 0
      this.targetEyeY = 0
      this.eyeX = 0
      this.eyeY = 0
      this.headX = 0
      this.headY = 0
      this.nextTargetAt = input.now + this.config.pointerReleaseDelayMs
      return this.output()
    }

    if (this.forceTarget || input.now >= this.nextTargetAt) {
      this.pickTarget()
      this.active = true
      this.forceTarget = false
      this.nextTargetAt = input.now + this.range(this.config.targetHoldMinMs, this.config.targetHoldMaxMs)
    }
    if (!this.active) return this.output()

    const eyeAlpha = 1 - Math.exp(-this.config.eyeSpeed * dt)
    const headAlpha = 1 - Math.exp(-this.config.headSpeed * dt)
    this.eyeX += (this.targetEyeX - this.eyeX) * eyeAlpha
    this.eyeY += (this.targetEyeY - this.eyeY) * eyeAlpha
    this.headX += (this.targetEyeX * this.config.headFactorX - this.headX) * headAlpha
    this.headY += (this.targetEyeY * this.config.headFactorY - this.headY) * headAlpha
    return this.output()
  }

  notifyPointerActivity(now = this.clock.now()): void {
    this.active = false
    this.targetEyeX = 0
    this.targetEyeY = 0
    this.eyeX = 0
    this.eyeY = 0
    this.headX = 0
    this.headY = 0
    this.nextTargetAt = now + this.config.pointerReleaseDelayMs
    this.lastUpdatedAt = now
  }

  forceNewTarget(): void {
    this.forceTarget = true
  }

  setEnabled(enabled: boolean, now = this.clock.now()): void {
    this.enabled = enabled
    if (!enabled) this.reset(now)
  }

  reset(now = this.clock.now()): void {
    this.active = false
    this.targetEyeX = 0
    this.targetEyeY = 0
    this.eyeX = 0
    this.eyeY = 0
    this.headX = 0
    this.headY = 0
    this.forceTarget = false
    this.lastUpdatedAt = now
    this.nextTargetAt = now + this.config.pointerReleaseDelayMs
  }

  getDiagnostics(now = this.clock.now()): IdleGazeDiagnostics {
    return {
      ...this.output(),
      enabled: this.enabled,
      targetEyeX: this.targetEyeX,
      targetEyeY: this.targetEyeY,
      nextTargetAt: this.nextTargetAt,
      nextTargetInMs: Math.max(0, this.nextTargetAt - now),
    }
  }

  private pickTarget(): void {
    const previousX = this.targetEyeX
    const previousY = this.targetEyeY
    let x = previousX
    let y = previousY
    for (let attempt = 0; attempt < 4; attempt++) {
      x = this.range(this.config.eyeXMin, this.config.eyeXMax)
      y = this.range(this.config.eyeYMin, this.config.eyeYMax)
      if (Math.hypot(x - previousX, y - previousY) >= this.config.minimumTargetDistance) break
    }
    if (Math.hypot(x - previousX, y - previousY) < this.config.minimumTargetDistance) {
      x = Math.abs(this.config.eyeXMax - previousX) >= Math.abs(this.config.eyeXMin - previousX) ? this.config.eyeXMax : this.config.eyeXMin
      y = Math.abs(this.config.eyeYMax - previousY) >= Math.abs(this.config.eyeYMin - previousY) ? this.config.eyeYMax : this.config.eyeYMin
    }
    this.targetEyeX = x
    this.targetEyeY = y
  }

  private output(): IdleGazeOutput {
    return { eyeX: this.eyeX, eyeY: this.eyeY, headX: this.headX, headY: this.headY, active: this.active }
  }

  private range(min: number, max: number): number {
    return min + (max - min) * clamp01(this.random())
  }
}
