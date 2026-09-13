import { PROTOCOL_VERSION, type ProtocolDomainEvent, type ProtocolFrame, type ProtocolRunSnapshot, type ProtocolWaitingReason } from "./types"
import type { InMemoryProtocolTransport } from "./transports/InMemoryProtocolTransport"

type LoopbackTask = { taskId: string; label?: string; progress?: number }
type LoopbackRun = { runId: string; label?: string; progress?: number; waitingFor?: ProtocolWaitingReason; tasks: Map<string, LoopbackTask> }

let nextLoopbackId = 1

export class ProtocolLoopbackSource {
  private sourceInstanceId = `loopback-instance-${nextLoopbackId++}`
  private readonly sessionId = `loopback-session-${nextLoopbackId++}`
  private sequence = 0
  private messageSequence = 0
  private readonly runs = new Map<string, LoopbackRun>()
  private lastFrame: ProtocolFrame | null = null
  private readonly unsubscribeCommand: () => void

  constructor(private readonly transport: InMemoryProtocolTransport, private readonly now: () => number = () => Date.now()) {
    this.unsubscribeCommand = transport.subscribeCommand((command) => {
      if (command.commandType === "client.hello") this.sendHello()
      if (command.commandType === "snapshot.request") this.sendSnapshot()
    })
  }

  startRun(runId: string, label?: string): void {
    this.runs.set(runId, { runId, ...(label === undefined ? {} : { label }), tasks: new Map() })
    this.sendEvent({ type: "run.started", runId, ...(label === undefined ? {} : { label }) })
  }

  progressRun(runId: string, progress: number): void {
    const run = this.runs.get(runId)
    if (run) run.progress = progress
    this.sendEvent({ type: "run.progress", runId, progress })
  }

  completeRun(runId: string): void {
    this.runs.delete(runId)
    this.sendEvent({ type: "run.completed", runId })
  }

  waitRun(runId: string, reason: ProtocolWaitingReason = "user-input"): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.waitingFor = reason
    this.sendEvent({ type: "run.waiting", runId, reason })
  }

  resumeRun(runId: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    delete run.waitingFor
    this.sendEvent({ type: "run.resumed", runId })
  }

  failRun(runId: string, message = "simulated run failure"): void {
    this.runs.delete(runId)
    this.sendEvent({ type: "run.failed", runId, message })
  }

  cancelRun(runId: string): void {
    this.runs.delete(runId)
    this.sendEvent({ type: "run.cancelled", runId, reason: "simulated cancellation" })
  }

  startTask(runId: string, taskId: string): void {
    this.runs.get(runId)?.tasks.set(taskId, { taskId })
    this.sendEvent({ type: "task.started", runId, taskId })
  }

  failTask(runId: string, taskId: string): void {
    this.runs.get(runId)?.tasks.delete(taskId)
    this.sendEvent({ type: "task.failed", runId, taskId, message: "simulated child failure" })
  }

  completeTask(runId: string, taskId: string): void {
    this.runs.get(runId)?.tasks.delete(taskId)
    this.sendEvent({ type: "task.completed", runId, taskId })
  }

  duplicateLast(): void {
    if (this.lastFrame) this.transport.inject(this.lastFrame)
  }

  sendOutOfOrder(): void {
    const sequence = Math.max(1, this.sequence - 1)
    this.inject({
      ...this.base("event"),
      frameType: "event",
      sequence,
      payload: { type: "run.progress", runId: [...this.runs.keys()][0] ?? "loopback-run", progress: 0.25 },
    })
  }

  sendGap(): void {
    this.sequence++
    const runId = "gap-run"
    this.runs.set(runId, { runId, label: "Gap recovery run", tasks: new Map() })
    this.sendEvent({ type: "run.started", runId, label: "Gap recovery run" })
  }

  sendSnapshot(): void {
    const activeRuns: ProtocolRunSnapshot[] = [...this.runs.values()].map((run) => ({
      runId: run.runId,
      ...(run.label === undefined ? {} : { label: run.label }),
      ...(run.progress === undefined ? {} : { progress: run.progress }),
      ...(run.waitingFor === undefined ? {} : { waitingFor: run.waitingFor }),
      tasks: [...run.tasks.values()].map((task) => ({ ...task, status: "running" as const })),
    }))
    this.inject({ ...this.base("snapshot"), frameType: "snapshot", sequence: ++this.sequence, payload: { snapshotId: `snapshot-${this.messageSequence}`, activeRuns } })
  }

  restartSource(): void {
    this.sourceInstanceId = `loopback-instance-${nextLoopbackId++}`
    this.sequence = 0
    this.sendHello()
  }

  sendMalformed(): void {
    this.transport.inject("{ malformed JSON")
  }

  sendInvalidProgress(): void {
    this.transport.inject({ ...this.base("event"), frameType: "event", sequence: this.sequence + 1, payload: { type: "run.progress", runId: "loopback-run", progress: 2 } })
  }

  sendUnsupportedVersion(): void {
    this.transport.inject({ ...this.base("heartbeat"), protocolVersion: 99, frameType: "heartbeat", payload: { heartbeatId: "unsupported" } })
  }

  sendHello(): void {
    this.inject({
      ...this.base("hello"),
      frameType: "hello",
      payload: {
        sourceName: "Protocol Loopback",
        supportedProtocolVersions: [PROTOCOL_VERSION],
        capabilities: ["snapshot", "heartbeat", "runs", "tasks", "progress", "replay"],
        heartbeatIntervalMs: 60_000,
      },
    })
  }

  dispose(): void {
    this.unsubscribeCommand()
  }

  private sendEvent(payload: ProtocolDomainEvent): void {
    this.inject({ ...this.base("event"), frameType: "event", sequence: ++this.sequence, payload })
  }

  private base(frameType: ProtocolFrame["frameType"]) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      frameType,
      messageId: `loopback-message-${++this.messageSequence}`,
      source: "mock-bridge",
      sourceInstanceId: this.sourceInstanceId,
      sessionId: this.sessionId,
      sentAt: this.now(),
    }
  }

  private inject(frame: ProtocolFrame): void {
    this.lastFrame = structuredClone(frame)
    this.transport.inject(frame)
  }
}
