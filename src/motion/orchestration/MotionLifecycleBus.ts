export type MotionLifecycleEvent =
  | { type: "pose.enter.started"; poseId: string; requestId: string; at: number }
  | { type: "pose.enter.completed"; poseId: string; requestId: string; at: number }
  | { type: "pose.exit.started"; poseId: string; requestId: string; at: number }
  | { type: "pose.exit.completed"; poseId: string; requestId: string; at: number }
  | {
      type: "pose.cancelled"
      poseId: string | null
      requestId: string | null
      reason: string
      direction?: "enter" | "exit"
      settleTarget?: "BASE" | "ACTIVE_LOOP" | null
      at: number
    }
  | { type: "pose.rejected"; poseId: string; requestId: string; reason: string; at: number }
  | { type: "interaction.started"; interactionId: string; at: number }
  | { type: "interaction.completed"; interactionId: string; at: number }
  | { type: "interaction.cancelled"; interactionId: string; reason: string; at: number }

export type RuntimeEventEnvelope<T> = {
  id: string
  sequence: number
  at: number
  event: T
}

export class MotionLifecycleBus {
  private readonly listeners = new Set<(event: MotionLifecycleEvent) => void>()
  private readonly history: Array<RuntimeEventEnvelope<MotionLifecycleEvent>> = []
  private sequence = 0

  constructor(private readonly historyLimit = 256) {}

  emit(event: MotionLifecycleEvent): RuntimeEventEnvelope<MotionLifecycleEvent> {
    const sequence = ++this.sequence
    const envelope = { id: `runtime-event:${sequence}`, sequence, at: event.at, event }
    this.history.push(envelope)
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit)
    for (const listener of this.listeners) listener(event)
    return envelope
  }

  subscribe(listener: (event: MotionLifecycleEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getHistory(): Array<RuntimeEventEnvelope<MotionLifecycleEvent>> {
    return this.history.map((entry) => ({ ...entry, event: { ...entry.event } }))
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  clear(): void {
    this.history.length = 0
  }

  dispose(): void {
    this.listeners.clear()
    this.history.length = 0
  }
}
