import type { ProtocolDomainEvent, ProtocolRunSnapshot, ProtocolTaskKind } from "../../src/protocol/types.ts"
import { canonicalRunId, canonicalTaskId } from "./privacy/CanonicalId.ts"
import type { CodexRunRecord, CodexTaskCategory, NormalizedCodexEvent } from "./types.ts"

const MAX_FUTURE_TIMESTAMP_SKEW_MS = 5 * 60 * 1_000

export function protocolTaskKind(category: CodexTaskCategory): ProtocolTaskKind {
  switch (category) {
    case "command": case "file-change": case "web-search": case "review": return category
    case "mcp-tool": case "dynamic-tool": return "tool"
    case "subagent": return "subtask"
    default: return "other"
  }
}

export type RegistryOptions = {
  maxRuns?: number
  maxTasksPerRun?: number
  maxTotalTasks?: number
  staleTtlMs?: number
  recoveryTtlMs?: number
  now?: () => number
}

export type PersistedRegistryState = {
  runs: Array<{
    sessionId: string
    turnId: string
    backend: CodexRunRecord["backend"]
    startedAt: number
    updatedAt: number
    waitingRequests?: Array<{ requestId: string; reason: "user-input" | "approval" }>
    tasks: Array<{
      sourceTaskId: string
      category: CodexTaskCategory
      label: string
      startedAt: number
      updatedAt: number
    }>
  }>
}

export class CodexRunRegistry {
  readonly runs = new Map<string, CodexRunRecord>()
  private readonly listeners = new Set<(event: ProtocolDomainEvent) => void>()
  private readonly terminalRuns = new Set<string>()
  private readonly terminalTasks = new Set<string>()
  private readonly latestObservedTurns = new Map<string, { turnId: string; observedAt: number }>()
  private readonly maxRuns: number
  private readonly maxTasksPerRun: number
  private readonly maxTotalTasks: number
  private readonly staleTtlMs: number
  private readonly recoveryTtlMs: number
  private readonly now: () => number
  private warnings: string[] = []
  recoveredRunCount = 0
  staleRunCount = 0

  constructor(options: RegistryOptions = {}) {
    this.maxRuns = options.maxRuns ?? 64
    this.maxTasksPerRun = options.maxTasksPerRun ?? 256
    this.maxTotalTasks = options.maxTotalTasks ?? 1_024
    this.staleTtlMs = options.staleTtlMs ?? 6 * 60 * 60 * 1_000
    this.recoveryTtlMs = options.recoveryTtlMs ?? 2 * 60 * 1_000
    this.now = options.now ?? Date.now
  }

  subscribe(listener: (event: ProtocolDomainEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: ProtocolDomainEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private remember(set: Set<string>, value: string): void {
    set.add(value)
    if (set.size > 2_048) set.delete(set.values().next().value as string)
  }

  private warn(message: string): void {
    if (this.warnings.at(-1) !== message) this.warnings.push(message.slice(0, 1_000))
    if (this.warnings.length > 20) this.warnings.splice(0, this.warnings.length - 20)
  }

  private confirmRecoveredRun(run: CodexRunRecord, observedAt: number): boolean {
    if (!run.recovery) return false
    delete run.recovery
    run.updatedAt = observedAt
    return true
  }

  private rememberObservation(sessionId: string, turnId: string, observedAt: number): void {
    if (!Number.isFinite(observedAt) || observedAt < 0) return
    const previous = this.latestObservedTurns.get(sessionId)
    if (previous && (previous.observedAt > observedAt || previous.observedAt === observedAt && previous.turnId !== turnId)) return
    this.latestObservedTurns.delete(sessionId)
    this.latestObservedTurns.set(sessionId, { turnId, observedAt })
    while (this.latestObservedTurns.size > 2048) this.latestObservedTurns.delete(this.latestObservedTurns.keys().next().value!)
  }

  isSupersededObservation(sessionId: string, turnId: string, observedAt: number): boolean {
    if (!Number.isFinite(observedAt) || observedAt < 0) return true
    const latest = this.latestObservedTurns.get(sessionId)
    if (latest && latest.turnId !== turnId && latest.observedAt >= observedAt) return true
    return [...this.runs.values()].some(run => run.sessionId === sessionId && run.turnId !== turnId && !run.recovery && run.updatedAt >= observedAt)
  }

  apply(event: NormalizedCodexEvent): ProtocolDomainEvent | null {
    if (event.type === "session.observed") return null
    const runId = canonicalRunId(event.sessionId, event.turnId)

    if (event.type === "run.started") {
      if (this.terminalRuns.has(runId)) return null
      const existing = this.runs.get(runId)
      if (existing) {
        this.confirmRecoveredRun(existing, event.observedAt)
        existing.updatedAt = Math.max(existing.updatedAt, event.observedAt)
        this.rememberObservation(event.sessionId, event.turnId, event.observedAt)
        return null
      }
      if (this.runs.size >= this.maxRuns) {
        this.warn(`active run limit reached (${this.maxRuns})`)
        return null
      }
      this.runs.set(runId, {
        runId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        backend: event.backend,
        status: "running",
        startedAt: event.observedAt,
        updatedAt: event.observedAt,
        tasks: new Map(),
      })
      this.rememberObservation(event.sessionId, event.turnId, event.observedAt)
      const protocolEvent: ProtocolDomainEvent = { type: "run.started", runId }
      this.emit(protocolEvent)
      return protocolEvent
    }

    if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
      const run = this.runs.get(runId)
      if (!this.terminalRuns.has(runId)) this.rememberObservation(event.sessionId, event.turnId, event.observedAt)
      // A fast interrupt may beat the fallback start observation. Remember it even
      // without an active record, so a late start cannot revive that exact turn.
      this.remember(this.terminalRuns, runId)
      if (!run) return null
      this.runs.delete(runId)
      for (const taskId of run.tasks.keys()) this.remember(this.terminalTasks, taskId)
      let protocolEvent: ProtocolDomainEvent
      if (event.type === "run.completed") protocolEvent = { type: "run.completed", runId, confidence: event.confidence === "hook-stop" ? "observed" : "authoritative" }
      else if (event.type === "run.failed") protocolEvent = { type: "run.failed", runId, ...(event.code ? { code: event.code } : {}), ...(event.message ? { message: event.message } : {}) }
      else protocolEvent = { type: "run.cancelled", runId, ...(event.reason ? { reason: event.reason } : {}) }
      this.emit(protocolEvent)
      return protocolEvent
    }

    const run = this.runs.get(runId)
    if (!run || this.terminalRuns.has(runId)) return null
    if (event.type === "run.waiting" || event.type === "run.resumed") {
      const requestKey = canonicalTaskId(event.sessionId, event.turnId, event.requestId)
      const waiting = run.waitingRequests ??= new Map()
      let protocolEvent: ProtocolDomainEvent | null = null
      if (event.type === "run.waiting") {
        if (waiting.has(event.requestId) || this.terminalTasks.has(requestKey) || waiting.size >= 64) return null
        waiting.set(event.requestId, event.reason)
        protocolEvent = { type: "run.waiting", runId, reason: event.reason }
      } else {
        this.remember(this.terminalTasks, requestKey)
        if (!waiting.delete(event.requestId)) return null
        if (!waiting.size) protocolEvent = { type: "run.resumed", runId }
        else protocolEvent = { type: "run.waiting", runId, reason: [...waiting.values()].includes("approval") ? "approval" : "user-input" }
      }
      this.confirmRecoveredRun(run, event.observedAt)
      run.updatedAt = Math.max(run.updatedAt, event.observedAt)
      this.rememberObservation(event.sessionId, event.turnId, event.observedAt)
      this.emit(protocolEvent)
      return protocolEvent
    }
    const taskId = canonicalTaskId(event.sessionId, event.turnId, event.taskId)
    this.confirmRecoveredRun(run, event.observedAt)
    if (event.type === "task.started") {
      if (run.tasks.has(taskId) || this.terminalTasks.has(taskId)) return null
      const totalTasks = [...this.runs.values()].reduce((sum, item) => sum + item.tasks.size, 0)
      if (run.tasks.size >= this.maxTasksPerRun || totalTasks >= this.maxTotalTasks) {
        this.warn("task limit reached for an active run")
        return null
      }
      run.tasks.set(taskId, {
        taskId,
        sourceTaskId: event.taskId,
        category: event.category,
        label: event.label,
        startedAt: event.observedAt,
        updatedAt: event.observedAt,
      })
      run.updatedAt = Math.max(run.updatedAt, event.observedAt)
      this.rememberObservation(event.sessionId, event.turnId, event.observedAt)
      const protocolEvent: ProtocolDomainEvent = { type: "task.started", runId, taskId, label: event.label, kind: protocolTaskKind(event.category) }
      this.emit(protocolEvent)
      return protocolEvent
    }

    const task = run.tasks.get(taskId)
    if (!task) {
      this.remember(this.terminalTasks, taskId)
      return null
    }
    run.tasks.delete(taskId)
    run.updatedAt = Math.max(run.updatedAt, event.observedAt)
    this.rememberObservation(event.sessionId, event.turnId, event.observedAt)
    this.remember(this.terminalTasks, taskId)
    const protocolEvent: ProtocolDomainEvent = event.type === "task.completed"
      ? { type: "task.completed", runId, taskId, kind: protocolTaskKind(task.category) }
      : event.type === "task.failed"
        ? { type: "task.failed", runId, taskId, kind: protocolTaskKind(task.category) }
        : { type: "task.cancelled", runId, taskId, kind: protocolTaskKind(task.category) }
    this.emit(protocolEvent)
    return protocolEvent
  }

  cancelSession(sessionId: string, reason = "session-ended"): ProtocolDomainEvent[] {
    const events: ProtocolDomainEvent[] = []
    for (const run of [...this.runs.values()]) {
      if (run.sessionId !== sessionId) continue
      const event: NormalizedCodexEvent = {
        type: "run.cancelled",
        sessionId,
        turnId: run.turnId,
        backend: run.backend,
        observedAt: this.now(),
        reason,
      }
      const result = this.apply(event)
      if (result) events.push(result)
    }
    return events
  }

  /** Lost observation is not a terminal outcome. Publish a fresh snapshot after
   * removing these records so a later live owner can restore the same turn. */
  forgetSessions(sessionIds: ReadonlySet<string>): boolean {
    let changed = false
    for (const [id, run] of this.runs) if (sessionIds.has(run.sessionId)) { this.runs.delete(id); changed = true }
    return changed
  }

  forgetOtherTurns(sessionId: string, turnId: string, observedAt: number): boolean {
    if (!Number.isFinite(observedAt) || observedAt < 0) return false
    let changed = false
    for (const [id, run] of this.runs) if (run.sessionId === sessionId && run.turnId !== turnId && (run.recovery || run.updatedAt < observedAt)) { this.runs.delete(id); changed = true }
    return changed
  }

  forgetObservedTurn(sessionId: string, turnId: string, observedAt: number): boolean {
    if (!Number.isFinite(observedAt) || observedAt < 0) return false
    const id = canonicalRunId(sessionId, turnId), run = this.runs.get(id)
    return Boolean(run && (run.recovery || run.updatedAt <= observedAt) && this.runs.delete(id))
  }

  confirmLive(sessionId: string, turnId: string, waiting: boolean | undefined, at = this.now()): boolean {
    const run = this.runs.get(canonicalRunId(sessionId, turnId))
    if (!run || !Number.isFinite(at) || at < 0 || !run.recovery && at < run.updatedAt) return false
    this.confirmRecoveredRun(run, at)
    run.updatedAt = at
    this.rememberObservation(sessionId, turnId, at)
    if (waiting === undefined) return false
    const wasWaiting = Boolean(run.waitingRequests?.size)
    if (waiting === wasWaiting) return false
    // A live owner's current status supersedes obsolete Hook request tokens.
    run.waitingRequests = waiting ? new Map([["live-owner", "user-input"]]) : new Map()
    this.emit(waiting ? { type: "run.waiting", runId: run.runId, reason: "user-input" } : { type: "run.resumed", runId: run.runId })
    return true
  }

  cleanupStale(at = this.now()): ProtocolDomainEvent[] {
    const events: ProtocolDomainEvent[] = []
    for (const run of [...this.runs.values()]) {
      if (run.recovery && at >= run.recovery.confirmationDeadline) {
        this.staleRunCount++
        this.warn("Recovered Run expired without live confirmation (recovery-not-confirmed)")
        const result = this.apply({
          type: "run.cancelled",
          sessionId: run.sessionId,
          turnId: run.turnId,
          backend: run.backend,
          observedAt: at,
          reason: "recovery-not-confirmed",
        })
        if (result) events.push(result)
        continue
      }
      if (at - run.updatedAt < this.staleTtlMs) continue
      this.staleRunCount++
      const result = this.apply({
        type: "run.cancelled",
        sessionId: run.sessionId,
        turnId: run.turnId,
        backend: run.backend,
        observedAt: at,
        reason: "stale-adapter-state",
      })
      if (result) events.push(result)
    }
    return events
  }

  getSnapshot(): ProtocolRunSnapshot[] {
    return [...this.runs.values()].map((run) => ({
      runId: run.runId,
      ...(run.waitingRequests?.size ? { waitingFor: [...run.waitingRequests.values()].includes("approval") ? "approval" as const : "user-input" as const } : {}),
      tasks: [...run.tasks.values()].map((task) => ({ taskId: task.taskId, label: task.label, kind: protocolTaskKind(task.category), status: "running" as const })),
    }))
  }

  exportState(): PersistedRegistryState {
    return {
      runs: [...this.runs.values()].map((run) => ({
        sessionId: run.sessionId,
        turnId: run.turnId,
        backend: run.backend,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        ...(run.waitingRequests?.size ? { waitingRequests: [...run.waitingRequests].map(([requestId, reason]) => ({ requestId, reason })) } : {}),
        tasks: [...run.tasks.values()].map(({ sourceTaskId, category, label, startedAt, updatedAt }) => ({ sourceTaskId, category, label, startedAt, updatedAt })),
      })),
    }
  }

  restore(state: PersistedRegistryState): void {
    const restoredAt = this.now()
    for (const saved of state.runs.slice(0, this.maxRuns)) {
      if (
        !Number.isFinite(saved.updatedAt)
        || restoredAt - saved.updatedAt >= this.recoveryTtlMs
        || saved.updatedAt > restoredAt + MAX_FUTURE_TIMESTAMP_SKEW_MS
      ) {
        this.staleRunCount++
        if (saved.updatedAt > restoredAt + MAX_FUTURE_TIMESTAMP_SKEW_MS) this.warn("Persisted Run timestamp is too far in the future")
        continue
      }
      const runId = canonicalRunId(saved.sessionId, saved.turnId)
      const tasks = new Map()
      for (const savedTask of saved.tasks.slice(0, this.maxTasksPerRun)) {
        const taskId = canonicalTaskId(saved.sessionId, saved.turnId, savedTask.sourceTaskId)
        tasks.set(taskId, { taskId, ...savedTask })
      }
      this.runs.set(runId, {
        runId,
        ...saved,
        status: "running",
        tasks,
        waitingRequests: new Map((saved.waitingRequests ?? []).slice(0, 64).map(({ requestId, reason }) => [requestId, reason])),
        recovery: {
          restoredAt,
          confirmationDeadline: restoredAt + this.recoveryTtlMs,
        },
      })
      this.recoveredRunCount++
    }
  }

  getDiagnostics(): { activeRunCount: number; activeTaskCount: number; provisionalRecoveredRunCount: number; warnings: string[] } {
    const activeTaskCount = [...this.runs.values()].reduce((sum, run) => sum + run.tasks.size, 0)
    const provisionalRecoveredRunCount = [...this.runs.values()].filter((run) => run.recovery !== undefined).length
    const warnings = this.warnings.slice(-20)
    this.warnings = warnings
    return { activeRunCount: this.runs.size, activeTaskCount, provisionalRecoveredRunCount, warnings }
  }

  getIdMappings(): Array<{ runId: string; sessionId: string; turnId: string; tasks: Array<{ taskId: string; sourceTaskId: string }> }> {
    return [...this.runs.values()].map((run) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      turnId: run.turnId,
      tasks: [...run.tasks.values()].map((task) => ({ taskId: task.taskId, sourceTaskId: task.sourceTaskId })),
    }))
  }
}
