import type { CharacterTaskEvent, Clock } from "../behavior/types"
import type { CharacterEventSource } from "../lifecycle/CharacterEventSource"
import { taskEventLifecycle, type CharacterLifecycleEvent } from "../lifecycle/CharacterLifecycleEvent"
import type { CharacterEventProtocolClient } from "./CharacterEventProtocolClient"
import type { ProtocolDomainEvent, ProtocolSnapshotFrame, ProtocolTaskKind } from "./types"

const systemClock: Clock = { now: () => performance.now() }
const taskKey = (runId: string, taskId: string) => JSON.stringify([runId, taskId])

export class ProtocolTaskEventSource implements CharacterEventSource {
  private readonly listeners = new Set<(event: CharacterTaskEvent) => void>()
  private readonly lifecycleListeners = new Set<(event: CharacterLifecycleEvent) => void>()
  private readonly activeRuns = new Set<string>()
  private readonly taskKinds = new Map<string, { runId: string; kind: ProtocolTaskKind }>()
  private readonly unsubscribeClient: () => void
  private readonly unsubscribeDiagnostics: () => void
  private connected: boolean | null = null
  private sourceAvailable = true
  private transportConnected = true

  constructor(client: Pick<CharacterEventProtocolClient, "subscribeAccepted"> & Partial<Pick<CharacterEventProtocolClient, "subscribeDiagnostics" | "getDiagnostics">>, private readonly clock: Clock = systemClock) {
    this.unsubscribeClient = client.subscribeAccepted((frame) => {
      const at = this.clock.now()
      if (frame.frameType === "snapshot") this.emitSnapshot(frame, at)
      if (frame.frameType === "event") this.emitDomainEvent(frame.payload, at)
    })
    const updateConnection = () => {
      if (!client.getDiagnostics) return
      const state = client.getDiagnostics().connectionState
      this.transportConnected = state === "READY"
      const connected = this.transportConnected && this.sourceAvailable
      // Initial handshake is not a lost connection; avoid a startup pose flash.
      if (this.connected === null && state !== "ERROR") {
        if (connected) this.connected = true
        return
      }
      if (connected === this.connected) return
      this.connected = connected
      this.emit({ type: "CONNECTION_CHANGED", connected, at: this.clock.now() })
    }
    this.unsubscribeDiagnostics = client.subscribeDiagnostics?.(updateConnection) ?? (() => {})
    updateConnection()
  }

  setSourceAvailable(available: boolean): void {
    this.sourceAvailable = available
    if (this.connected === null && available) return
    const connected = available && this.transportConnected
    if (connected === this.connected) return
    this.connected = connected
    this.emit({ type: "CONNECTION_CHANGED", connected, at: this.clock.now() })
  }

  subscribe(listener: (event: CharacterTaskEvent) => void): () => void {
    this.listeners.add(listener)
    if (this.connected === false) listener({ type: "CONNECTION_CHANGED", connected: false, at: this.clock.now() })
    return () => this.listeners.delete(listener)
  }

  subscribeLifecycle(listener: (event: CharacterLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  dispose(): void {
    this.unsubscribeClient()
    this.unsubscribeDiagnostics()
    this.listeners.clear()
    this.lifecycleListeners.clear()
    this.activeRuns.clear()
    this.taskKinds.clear()
  }

  private emitSnapshot(frame: ProtocolSnapshotFrame, at: number): void {
    this.activeRuns.clear()
    this.taskKinds.clear()
    for (const run of frame.payload.activeRuns) {
      this.activeRuns.add(run.runId)
      for (const task of run.tasks) this.rememberTask(run.runId, task.taskId, task.kind ?? "other")
    }
    this.emit({ type: "TASK_SNAPSHOT", tasks: frame.payload.activeRuns.map((run) => ({ taskId: run.runId, ...(run.progress === undefined ? {} : { progress: run.progress }), ...(run.waitingFor === undefined ? {} : { waitingFor: run.waitingFor }) })), at })
  }

  private emitDomainEvent(event: ProtocolDomainEvent, at: number): void {
    if (event.type === "run.started") {
      if (this.activeRuns.has(event.runId) || this.activeRuns.size >= 64) return
      this.activeRuns.add(event.runId)
      this.emit({ type: "TASK_STARTED", taskId: event.runId, at })
      return
    }
    if (!this.activeRuns.has(event.runId)) return
    switch (event.type) {
      case "run.progress":
        this.emit({ type: "TASK_PROGRESS", taskId: event.runId, ...(event.progress === undefined ? {} : { progress: event.progress }), at })
        return
      case "run.waiting":
        this.emit({ type: "TASK_WAITING", taskId: event.runId, reason: event.reason, at })
        return
      case "run.resumed":
        this.emit({ type: "TASK_RESUMED", taskId: event.runId, at })
        return
      case "run.completed":
        this.finishRun(event.runId)
        this.emit({ type: "TASK_COMPLETED", taskId: event.runId, ...(event.confidence === undefined ? {} : { confidence: event.confidence }), at })
        return
      case "run.failed":
        this.finishRun(event.runId)
        this.emit({ type: "TASK_FAILED", taskId: event.runId, ...(event.code === undefined ? {} : { code: event.code }), ...(event.message === undefined ? {} : { message: event.message }), at })
        return
      case "run.cancelled":
        this.finishRun(event.runId)
        this.emit({ type: "TASK_CANCELLED", taskId: event.runId, ...(event.reason === undefined ? {} : { reason: event.reason }), at })
        return
      default: {
        const key = taskKey(event.runId, event.taskId)
        const cached = this.taskKinds.get(key)
        const kind = event.kind ?? cached?.kind ?? "other"
        if (event.type === "task.started" || event.type === "task.progress") {
          this.rememberTask(event.runId, event.taskId, kind)
          if (event.type === "task.progress" || cached) return
        } else this.taskKinds.delete(key)
        this.emitLifecycle({ type: event.type, runId: event.runId, taskId: event.taskId, kind, at })
      }
    }
  }

  private rememberTask(runId: string, taskId: string, kind: ProtocolTaskKind): void {
    this.taskKinds.set(taskKey(runId, taskId), { runId, kind })
    if (this.taskKinds.size > 1_024) this.taskKinds.delete(this.taskKinds.keys().next().value!)
  }

  private finishRun(runId: string): void {
    this.activeRuns.delete(runId)
    for (const [key, value] of this.taskKinds) if (value.runId === runId) this.taskKinds.delete(key)
  }

  private emit(event: CharacterTaskEvent & { at: number }): void {
    // Behavior dispatch finishes before presentation reads the semantic snapshot.
    for (const listener of this.listeners) listener(event)
    const lifecycle = taskEventLifecycle(event, event.at)
    if (lifecycle) this.emitLifecycle(lifecycle)
  }

  private emitLifecycle(event: CharacterLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try { listener(event) } catch { /* Presentation cannot interrupt protocol or motion. */ }
    }
  }
}
