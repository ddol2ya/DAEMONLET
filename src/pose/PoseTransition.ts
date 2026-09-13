import type { PoseRuntimeState } from "./types"

export type PoseTransitionConfig = { enterMs: number; exitMs: number; swapStart: number; swapEnd: number }
export type PoseTransitionSample = { state: PoseRuntimeState; progress: number; mix: number; active: boolean; paused: boolean }

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const smoothstep = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t) }

export class PoseTransition {
  private state: PoseRuntimeState = "BASE"
  private mix = 0
  private from = 0
  private target = 0
  private startedAt = 0
  private duration = 0
  private paused = false

  constructor(private config: PoseTransitionConfig) {}

  configure(config: PoseTransitionConfig, preserveCurrent = false) {
    this.config = config
    if (!preserveCurrent) this.reset()
  }

  enter(now: number) {
    this.update(now)
    if (this.state === "ACTIVE_LOOP" || (!this.paused && this.state === "ENTERING" && this.target === 1)) return
    this.begin(1, now)
  }

  exit(now: number) {
    this.update(now)
    if (this.state === "BASE" || (!this.paused && this.state === "EXITING" && this.target === 0)) return
    this.begin(0, now)
  }

  pauseAt(progress: number, direction: "enter" | "exit" = "enter") {
    this.mix = clamp(progress)
    this.from = this.mix
    this.target = direction === "enter" ? 1 : 0
    this.state = this.mix <= 0 ? "BASE" : this.mix >= 1 ? "ACTIVE_LOOP" : direction === "enter" ? "ENTERING" : "EXITING"
    this.paused = this.mix > 0 && this.mix < 1
  }

  reset() {
    this.state = "BASE"
    this.mix = 0
    this.from = 0
    this.target = 0
    this.startedAt = 0
    this.duration = 0
    this.paused = false
  }

  sample(now: number): PoseTransitionSample {
    this.update(now)
    const local = (this.mix - this.config.swapStart) / (this.config.swapEnd - this.config.swapStart)
    return { state: this.state, progress: this.mix, mix: smoothstep(local), active: this.state !== "BASE", paused: this.paused }
  }

  private begin(target: 0 | 1, now: number) {
    this.paused = false
    this.from = this.mix
    this.target = target
    this.startedAt = now
    this.duration = Math.max(1, (target ? this.config.enterMs * (1 - this.mix) : this.config.exitMs * this.mix))
    this.state = target ? "ENTERING" : "EXITING"
  }

  private update(now: number) {
    if (this.paused || (this.state !== "ENTERING" && this.state !== "EXITING")) return
    const progress = clamp((now - this.startedAt) / this.duration)
    this.mix = this.from + (this.target - this.from) * smoothstep(progress)
    if (progress < 1) return
    this.mix = this.target
    this.state = this.target ? "ACTIVE_LOOP" : "BASE"
  }
}
