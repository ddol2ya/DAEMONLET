import type { BehaviorAction, BehaviorTiming } from "./types"

export type RandomSource = () => number

export type IdleActionSchedulerSnapshot = {
  current: BehaviorAction | null
  currentStartedAt: number | null
  nextActionAt: number | null
  history: string[]
}

export class IdleActionScheduler {
  private actions: BehaviorAction[] = []
  private timing: Pick<BehaviorTiming, "boredActionDelayMinMs" | "boredActionDelayMaxMs"> = {
    boredActionDelayMinMs: 0,
    boredActionDelayMaxMs: 0,
  }
  private current: BehaviorAction | null = null
  private currentStartedAt: number | null = null
  private nextActionAt: number | null = null
  private history: string[] = []

  constructor(private readonly random: RandomSource = Math.random) {}

  start(actions: BehaviorAction[], timing: BehaviorTiming, now: number): void {
    this.cancel()
    this.actions = [...actions]
    this.timing = timing
    this.nextActionAt = this.actions.length ? now + this.nextDelay() : null
  }

  tick(now: number): IdleActionSchedulerSnapshot {
    if (this.current && this.currentStartedAt !== null && now - this.currentStartedAt >= this.current.durationMs) {
      this.current = null
      this.currentStartedAt = null
      this.nextActionAt = now + this.nextDelay()
    }
    if (!this.current && this.nextActionAt !== null && now >= this.nextActionAt && this.actions.length) {
      this.current = this.chooseAction()
      this.currentStartedAt = now
      this.nextActionAt = null
      this.history.push(this.current.id)
      if (this.history.length > 64) this.history.splice(0, this.history.length - 64)
    }
    return this.getSnapshot()
  }

  cancel(): void {
    this.actions = []
    this.current = null
    this.currentStartedAt = null
    this.nextActionAt = null
  }

  getSnapshot(): IdleActionSchedulerSnapshot {
    return {
      current: this.current,
      currentStartedAt: this.currentStartedAt,
      nextActionAt: this.nextActionAt,
      history: [...this.history],
    }
  }

  private nextDelay(): number {
    const min = this.timing.boredActionDelayMinMs
    const max = this.timing.boredActionDelayMaxMs
    return min + Math.max(0, Math.min(1, this.random())) * (max - min)
  }

  private chooseAction(): BehaviorAction {
    const recent = this.history.slice(-2)
    const candidates = recent.length === 2 && recent[0] === recent[1]
      ? this.actions.filter((action) => action.id !== recent[0])
      : this.actions
    const pool = candidates.length ? candidates : this.actions
    const index = Math.min(pool.length - 1, Math.floor(Math.max(0, Math.min(0.999999, this.random())) * pool.length))
    return pool[index]
  }
}

