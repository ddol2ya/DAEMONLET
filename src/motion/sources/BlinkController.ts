import type { Clock } from "../../behavior/types"

export type BlinkPhase = "IDLE" | "CLOSING" | "CLOSED" | "OPENING"

export type BlinkConfig = {
  intervalMinMs: number
  intervalMaxMs: number
  closeDurationMs: number
  closedHoldMinMs: number
  closedHoldMaxMs: number
  openDurationMinMs: number
  openDurationMaxMs: number
  suppressBelow: number
}

export type BlinkDiagnostics = {
  enabled: boolean
  phase: BlinkPhase
  nextBlinkAt: number
  nextBlinkInMs: number
  currentCycleDurationMs: number
  baselineEyeOpenL: number
  baselineEyeOpenR: number
  forcedBlinkCount: number
}

export const DEFAULT_BLINK_CONFIG: BlinkConfig = {
  intervalMinMs: 3000,
  intervalMaxMs: 8000,
  closeDurationMs: 82,
  closedHoldMinMs: 30,
  closedHoldMaxMs: 70,
  openDurationMinMs: 160,
  openDurationMaxMs: 260,
  suppressBelow: 0.15,
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export class BlinkController {
  private readonly config: BlinkConfig
  private phase: BlinkPhase = "IDLE"
  private enabled = true
  private nextBlinkAt = 0
  private cycleStartedAt = 0
  private closeDurationMs = 0
  private closedHoldMs = 0
  private openDurationMs = 0
  private baselineEyeOpenL = 1
  private baselineEyeOpenR = 1
  private forcedBlinkCount = 0
  private forceRequested = false

  constructor(options: { clock: Clock; random?: () => number; config?: Partial<BlinkConfig> }) {
    this.clock = options.clock
    this.random = options.random ?? Math.random
    this.config = { ...DEFAULT_BLINK_CONFIG, ...options.config }
    this.reset()
  }

  private readonly clock: Clock
  private readonly random: () => number

  update(input: { now: number; baselineEyeOpenL: number; baselineEyeOpenR: number; enabled: boolean }): { eyeOpenL: number; eyeOpenR: number; phase: BlinkPhase } {
    if (!input.enabled) {
      if (this.enabled || this.phase !== "IDLE") this.reset(input.now)
      this.enabled = false
      this.baselineEyeOpenL = input.baselineEyeOpenL
      this.baselineEyeOpenR = input.baselineEyeOpenR
      return { eyeOpenL: input.baselineEyeOpenL, eyeOpenR: input.baselineEyeOpenR, phase: this.phase }
    }
    if (!this.enabled) {
      this.enabled = true
      this.reset(input.now)
    }

    if (this.phase === "IDLE" && (this.forceRequested || input.now >= this.nextBlinkAt)) {
      const suppressed = Math.min(input.baselineEyeOpenL, input.baselineEyeOpenR) <= this.config.suppressBelow
      if (suppressed && !this.forceRequested) {
        this.scheduleNext(input.now)
      } else {
        this.startCycle(input.now, input.baselineEyeOpenL, input.baselineEyeOpenR, this.forceRequested)
      }
      this.forceRequested = false
    }

    if (this.phase === "IDLE") {
      this.baselineEyeOpenL = input.baselineEyeOpenL
      this.baselineEyeOpenR = input.baselineEyeOpenR
      return { eyeOpenL: input.baselineEyeOpenL, eyeOpenR: input.baselineEyeOpenR, phase: this.phase }
    }

    const elapsed = Math.max(0, input.now - this.cycleStartedAt)
    const closedAt = this.closeDurationMs
    const openingAt = closedAt + this.closedHoldMs
    const completedAt = openingAt + this.openDurationMs
    let factor = 1
    if (elapsed < closedAt) {
      this.phase = "CLOSING"
      factor = 1 - clamp01(elapsed / Math.max(1, this.closeDurationMs))
    } else if (elapsed < openingAt) {
      this.phase = "CLOSED"
      factor = 0
    } else if (elapsed < completedAt) {
      this.phase = "OPENING"
      factor = clamp01((elapsed - openingAt) / Math.max(1, this.openDurationMs))
    } else {
      this.phase = "IDLE"
      this.scheduleNext(input.now)
      this.baselineEyeOpenL = input.baselineEyeOpenL
      this.baselineEyeOpenR = input.baselineEyeOpenR
      return { eyeOpenL: input.baselineEyeOpenL, eyeOpenR: input.baselineEyeOpenR, phase: this.phase }
    }

    return {
      eyeOpenL: this.baselineEyeOpenL * factor,
      eyeOpenR: this.baselineEyeOpenR * factor,
      phase: this.phase,
    }
  }

  trigger(): void {
    if (this.phase === "IDLE") this.forceRequested = true
  }

  reset(now = this.clock.now()): void {
    this.phase = "IDLE"
    this.cycleStartedAt = 0
    this.closeDurationMs = 0
    this.closedHoldMs = 0
    this.openDurationMs = 0
    this.baselineEyeOpenL = 1
    this.baselineEyeOpenR = 1
    this.forceRequested = false
    this.scheduleNext(now)
  }

  getDiagnostics(now = this.clock.now()): BlinkDiagnostics {
    return {
      enabled: this.enabled,
      phase: this.phase,
      nextBlinkAt: this.nextBlinkAt,
      nextBlinkInMs: Math.max(0, this.nextBlinkAt - now),
      currentCycleDurationMs: this.closeDurationMs + this.closedHoldMs + this.openDurationMs,
      baselineEyeOpenL: this.baselineEyeOpenL,
      baselineEyeOpenR: this.baselineEyeOpenR,
      forcedBlinkCount: this.forcedBlinkCount,
    }
  }

  private startCycle(now: number, baselineEyeOpenL: number, baselineEyeOpenR: number, forced: boolean): void {
    this.phase = "CLOSING"
    this.cycleStartedAt = now
    this.baselineEyeOpenL = clamp01(baselineEyeOpenL)
    this.baselineEyeOpenR = clamp01(baselineEyeOpenR)
    this.closeDurationMs = this.config.closeDurationMs
    this.closedHoldMs = this.range(this.config.closedHoldMinMs, this.config.closedHoldMaxMs)
    this.openDurationMs = this.range(this.config.openDurationMinMs, this.config.openDurationMaxMs)
    if (forced) this.forcedBlinkCount++
  }

  private scheduleNext(now: number): void {
    this.nextBlinkAt = now + this.range(this.config.intervalMinMs, this.config.intervalMaxMs)
  }

  private range(min: number, max: number): number {
    return min + (max - min) * clamp01(this.random())
  }
}
