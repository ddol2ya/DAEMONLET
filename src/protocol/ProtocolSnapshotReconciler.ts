import type {
  ProtocolEventFrame,
  ProtocolRunDiagnostics,
  ProtocolRunSnapshot,
  ProtocolRuntimeSnapshot,
  ProtocolSnapshotFrame,
  ProtocolTaskKind,
  ProtocolWaitingReason,
} from "./types"

type MutableRun = {
  runId: string
  label?: string
  progress?: number
  waitingFor?: ProtocolWaitingReason
  tasks: Map<string, { taskId: string; label?: string; progress?: number; kind?: ProtocolTaskKind }>
  failedTaskIds: string[]
}

const createRun = (runId: string, label?: string): MutableRun => ({ runId, ...(label === undefined ? {} : { label }), tasks: new Map(), failedTaskIds: [] })

export class ProtocolSnapshotReconciler {
  private readonly runs = new Map<string, MutableRun>()
  private sourceInstanceId = ""
  private sessionId = ""
  private sequence = 0

  applySnapshot(frame: ProtocolSnapshotFrame): void {
    const replacement = new Map<string, MutableRun>()
    for (const snapshot of frame.payload.activeRuns) replacement.set(snapshot.runId, this.fromSnapshot(snapshot, this.runs.get(snapshot.runId)))
    this.runs.clear()
    for (const [runId, run] of replacement) this.runs.set(runId, run)
    this.sourceInstanceId = frame.sourceInstanceId
    this.sessionId = frame.sessionId
    this.sequence = frame.sequence
  }

  applyEvent(frame: ProtocolEventFrame): void {
    const event = frame.payload
    this.sourceInstanceId = frame.sourceInstanceId
    this.sessionId = frame.sessionId
    this.sequence = frame.sequence
    if (event.type === "run.started") {
      const existing = this.runs.get(event.runId)
      if (!existing) this.runs.set(event.runId, createRun(event.runId, event.label))
      else if (event.label !== undefined) existing.label = event.label
      return
    }
    const run = this.runs.get(event.runId)
    if (!run) return
    switch (event.type) {
      case "run.progress":
        run.progress = event.progress
        break
      case "run.waiting":
        run.waitingFor = event.reason
        break
      case "run.resumed":
        delete run.waitingFor
        break
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
        this.runs.delete(event.runId)
        break
      case "task.started":
        run.tasks.set(event.taskId, { taskId: event.taskId, ...(event.label === undefined ? {} : { label: event.label }), ...(event.kind === undefined ? {} : { kind: event.kind }) })
        break
      case "task.progress": {
        const task = run.tasks.get(event.taskId)
        if (task) {
          task.progress = event.progress
          if (event.kind !== undefined) task.kind = event.kind
        }
        break
      }
      case "task.completed":
      case "task.cancelled":
        run.tasks.delete(event.taskId)
        break
      case "task.failed":
        run.tasks.delete(event.taskId)
        if (!run.failedTaskIds.includes(event.taskId)) {
          run.failedTaskIds.push(event.taskId)
          if (run.failedTaskIds.length > 64) run.failedTaskIds.shift()
        }
        break
    }
  }

  getDiagnostics(): ProtocolRunDiagnostics[] {
    return [...this.runs.values()].map((run) => ({
      runId: run.runId,
      ...(run.label === undefined ? {} : { label: run.label }),
      ...(run.progress === undefined ? {} : { progress: run.progress }),
      ...(run.waitingFor === undefined ? {} : { waitingFor: run.waitingFor }),
      runningTaskIds: [...run.tasks.keys()].sort(),
      failedTaskIds: [...run.failedTaskIds],
    })).sort((left, right) => left.runId.localeCompare(right.runId))
  }

  getSnapshot(): ProtocolRuntimeSnapshot {
    return {
      sourceInstanceId: this.sourceInstanceId,
      sessionId: this.sessionId,
      sequence: this.sequence,
      activeRuns: [...this.runs.values()].map((run) => ({
        runId: run.runId,
        ...(run.label === undefined ? {} : { label: run.label }),
        ...(run.progress === undefined ? {} : { progress: run.progress }),
        ...(run.waitingFor === undefined ? {} : { waitingFor: run.waitingFor }),
        tasks: [...run.tasks.values()].map((task) => ({ ...task, status: "running" as const })),
      })),
    }
  }

  clear(): void {
    this.runs.clear()
    this.sourceInstanceId = ""
    this.sessionId = ""
    this.sequence = 0
  }

  private fromSnapshot(snapshot: ProtocolRunSnapshot, previous?: MutableRun): MutableRun {
    const run = createRun(snapshot.runId, snapshot.label)
    run.progress = snapshot.progress
    run.waitingFor = snapshot.waitingFor
    if (previous) run.failedTaskIds = [...previous.failedTaskIds]
    for (const task of snapshot.tasks) run.tasks.set(task.taskId, { taskId: task.taskId, ...(task.label === undefined ? {} : { label: task.label }), ...(task.progress === undefined ? {} : { progress: task.progress }), ...(task.kind === undefined ? {} : { kind: task.kind }) })
    return run
  }
}
