import { randomUUID } from "node:crypto"
import type { HeartbeatFrame, ProtocolDomainEvent, ProtocolEventFrame, ProtocolRunSnapshot, ProtocolSnapshotFrame, SourceHelloFrame } from "../../../src/protocol/types.ts"

export class ProtocolFrameFactory {
  readonly sourceInstanceId: string
  readonly sessionId: string
  private message = 0
  private sequence = 0

  constructor(sourceInstanceId: string, sessionId: string) {
    this.sourceInstanceId = sourceInstanceId
    this.sessionId = sessionId
  }

  private base<T extends "hello" | "heartbeat" | "event" | "snapshot">(frameType: T) {
    return {
      protocolVersion: 1 as const,
      frameType,
      messageId: `codex-${frameType}-${++this.message}`,
      source: "codex-adapter",
      sourceInstanceId: this.sourceInstanceId,
      sessionId: this.sessionId,
      sentAt: Date.now(),
    }
  }

  hello(heartbeatIntervalMs: number): SourceHelloFrame {
    return {
      ...this.base("hello"),
      payload: {
        sourceName: "Daemonlet Codex Adapter",
        supportedProtocolVersions: [1],
        capabilities: ["snapshot", "heartbeat", "runs", "tasks"],
        heartbeatIntervalMs,
      },
    }
  }

  heartbeat(id: string = randomUUID()): HeartbeatFrame {
    return { ...this.base("heartbeat"), payload: { heartbeatId: id } }
  }

  event(payload: ProtocolDomainEvent): ProtocolEventFrame {
    return { ...this.base("event"), sequence: ++this.sequence, payload }
  }

  snapshot(activeRuns: ProtocolRunSnapshot[]): ProtocolSnapshotFrame {
    return { ...this.base("snapshot"), sequence: ++this.sequence, payload: { snapshotId: randomUUID(), activeRuns } }
  }
}
