import type { Clock } from "./types"

export class PerformanceClock implements Clock {
  now(): number {
    return performance.now()
  }
}

export class AdjustableClock implements Clock {
  private offsetMs = 0

  constructor(private readonly base: Clock = new PerformanceClock()) {}

  now(): number {
    return this.base.now() + this.offsetMs
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("clock advance must be a non-negative finite number")
    this.offsetMs += ms
  }
}

