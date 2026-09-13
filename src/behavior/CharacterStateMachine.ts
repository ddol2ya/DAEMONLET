import type { BehaviorTiming, CharacterRunOutcome, CharacterSemanticState, CharacterStateSnapshot, CharacterTaskEvent, Clock } from "./types"

const taskId = (value: string) => value.trim()

export class CharacterStateMachine {
  private state: CharacterSemanticState = "NORMAL"
  private previousState: CharacterSemanticState | null = null
  private stateSince: number
  private lastActivityAt: number
  private readonly tasks = new Map<string, number | undefined>()
  private readonly waitingTasks = new Set<string>()
  private lastEvent: CharacterTaskEvent | null = null
  private lastEventAccepted = false
  private lastOutcome: CharacterRunOutcome | null = null
  private lastStaleEvent: CharacterTaskEvent | null = null
  private staleEventCount = 0
  private transitionReason = "initial"

  constructor(private timing: BehaviorTiming, private readonly clock: Clock) {
    const now = clock.now()
    this.stateSince = now
    this.lastActivityAt = now
  }

  dispatch(event: CharacterTaskEvent): CharacterStateSnapshot {
    const now = event.at ?? this.clock.now()
    this.lastEvent = event
    this.lastEventAccepted = true

    if (event.type === "RESET") {
      this.reset(now)
      this.lastEvent = event
      this.lastEventAccepted = true
      return this.getSnapshot()
    }

    if (event.type === "USER_ACTIVITY") {
      this.lastActivityAt = now
      if (this.state === "BORED") this.transition("NORMAL", now, "user-activity")
      return this.getSnapshot()
    }

    // Connection loss changes presentation, not the remembered task outcomes.
    if (event.type === "CONNECTION_CHANGED") return this.getSnapshot()

    if (event.type === "TASK_SNAPSHOT") return this.applyTaskSnapshot(event, now)

    const id = taskId(event.taskId)
    if (!id) return this.recordStale(event)

    if (event.type === "TASK_STARTED") {
      this.lastActivityAt = now
      if (!this.tasks.has(id)) this.tasks.set(id, undefined)
      this.transitionForActiveTasks(now, "task-started")
      return this.getSnapshot()
    }

    if (!this.tasks.has(id)) return this.recordStale(event)

    if (event.type === "TASK_WAITING" || event.type === "TASK_RESUMED") {
      if (event.type === "TASK_WAITING") {
        if (event.reason !== undefined && event.reason !== "user-input" && event.reason !== "approval") return this.recordStale(event)
        this.waitingTasks.add(id)
      } else this.waitingTasks.delete(id)
      this.lastActivityAt = now
      this.transitionForActiveTasks(now, event.type === "TASK_WAITING" ? "task-waiting" : "task-resumed")
      return this.getSnapshot()
    }

    if (event.type === "TASK_PROGRESS") {
      if (!this.isProgress(event.progress)) return this.recordStale(event)
      this.lastActivityAt = now
      this.tasks.set(id, event.progress)
      return this.getSnapshot()
    }

    this.lastActivityAt = now
    this.tasks.delete(id)
    this.waitingTasks.delete(id)
    if (event.type === "TASK_COMPLETED") this.lastOutcome = { kind: "completed", taskId: id, confidence: event.confidence ?? null, at: now }
    if (event.type === "TASK_FAILED") this.lastOutcome = { kind: "failed", taskId: id, code: event.code ?? null, at: now }
    if (event.type === "TASK_CANCELLED") this.lastOutcome = { kind: "cancelled", taskId: id, reason: event.reason ?? null, at: now }
    if (this.tasks.size) {
      this.transitionForActiveTasks(now, "remaining-tasks")
      return this.getSnapshot()
    }
    if (event.type === "TASK_COMPLETED") this.transition("HAPPY", now, "all-tasks-completed")
    if (event.type === "TASK_FAILED") this.transition("NORMAL", now, "last-task-failed")
    if (event.type === "TASK_CANCELLED") this.transition("NORMAL", now, "last-task-cancelled")
    return this.getSnapshot()
  }

  tick(now = this.clock.now()): CharacterStateSnapshot {
    if (this.state === "HAPPY" && now - this.stateSince >= this.timing.happyDurationMs) {
      this.transition("NORMAL", now, "happy-timeout")
    } else if (this.state === "NORMAL" && !this.tasks.size && now - this.lastActivityAt >= this.timing.boredAfterMs) {
      this.transition("BORED", now, "idle-timeout")
    }
    return this.getSnapshot()
  }

  getSnapshot(): CharacterStateSnapshot {
    const activeTaskIds = [...this.tasks.keys()].sort()
    return {
      state: this.state,
      previousState: this.previousState,
      stateSince: this.stateSince,
      lastActivityAt: this.lastActivityAt,
      activeTaskIds,
      waitingTaskIds: [...this.waitingTasks].sort(),
      taskProgress: Object.fromEntries(activeTaskIds.map((id) => [id, this.tasks.get(id)])),
      lastEvent: this.lastEvent ? { ...this.lastEvent } : null,
      lastEventAccepted: this.lastEventAccepted,
      lastOutcome: this.lastOutcome ? { ...this.lastOutcome } : null,
      lastStaleEvent: this.lastStaleEvent ? { ...this.lastStaleEvent } : null,
      staleEventCount: this.staleEventCount,
      transitionReason: this.transitionReason,
    }
  }

  reset(now = this.clock.now()): CharacterStateSnapshot {
    const oldState = this.state
    this.state = "NORMAL"
    this.previousState = oldState === "NORMAL" ? null : oldState
    this.stateSince = now
    this.lastActivityAt = now
    this.tasks.clear()
    this.waitingTasks.clear()
    this.lastEvent = null
    this.lastEventAccepted = false
    this.lastOutcome = null
    this.lastStaleEvent = null
    this.staleEventCount = 0
    this.transitionReason = "reset"
    return this.getSnapshot()
  }

  configure(timing: BehaviorTiming, reset = true): CharacterStateSnapshot {
    this.timing = timing
    return reset ? this.reset(this.clock.now()) : this.getSnapshot()
  }

  getTiming(): BehaviorTiming {
    return { ...this.timing }
  }

  private transition(state: CharacterSemanticState, now: number, reason: string) {
    if (state === this.state) return
    this.previousState = this.state
    this.state = state
    this.stateSince = now
    this.transitionReason = reason
  }

  private transitionForActiveTasks(now: number, reason: string) {
    this.transition(this.tasks.size > 0 && this.waitingTasks.size === this.tasks.size ? "WAITING" : "BUSY", now, reason)
  }

  private recordStale(event: CharacterTaskEvent) {
    this.lastEventAccepted = false
    this.staleEventCount++
    this.lastStaleEvent = { ...event }
    return this.getSnapshot()
  }

  private applyTaskSnapshot(event: Extract<CharacterTaskEvent, { type: "TASK_SNAPSHOT" }>, now: number): CharacterStateSnapshot {
    if (!Array.isArray(event.tasks) || event.tasks.length > 64) return this.recordStale(event)
    const replacement = new Map<string, number | undefined>()
    const waiting = new Set<string>()
    for (const task of event.tasks) {
      if (!task || typeof task !== "object" || Array.isArray(task) || typeof task.taskId !== "string") return this.recordStale(event)
      const id = taskId(task.taskId)
      if (!id || replacement.has(id) || !this.isProgress(task.progress)) return this.recordStale(event)
      if (task.waitingFor !== undefined && task.waitingFor !== "user-input" && task.waitingFor !== "approval") return this.recordStale(event)
      replacement.set(id, task.progress)
      if (task.waitingFor) waiting.add(id)
    }
    this.tasks.clear()
    this.waitingTasks.clear()
    for (const [id, progress] of replacement) this.tasks.set(id, progress)
    for (const id of waiting) this.waitingTasks.add(id)
    this.lastActivityAt = now
    if (this.tasks.size) {
      const next = waiting.size === replacement.size ? "WAITING" : "BUSY"
      if (this.state === next) this.transitionReason = "snapshot-refresh"
      else this.transition(next, now, "snapshot-active-runs")
    } else if (this.state === "BUSY" || this.state === "WAITING") {
      this.transition("NORMAL", now, "snapshot-empty")
    } else {
      this.transitionReason = "snapshot-refresh"
    }
    return this.getSnapshot()
  }

  private isProgress(progress: number | undefined): boolean {
    return progress === undefined || (Number.isFinite(progress) && progress >= 0 && progress <= 1)
  }
}
