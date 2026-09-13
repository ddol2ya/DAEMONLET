import { PROTOCOL_VERSION, type ProtocolFrame, type ProtocolTraceDecision, type ProtocolTraceEntry, type ProtocolTraceExport } from "./types"

export class ProtocolTrace {
  private readonly entries: ProtocolTraceEntry[] = []

  constructor(private readonly capacity = 512) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("trace capacity must be a positive safe integer")
  }

  add(receivedAt: number, decision: ProtocolTraceDecision, frame?: Partial<ProtocolFrame>, reason?: string): void {
    const sentAt = typeof frame?.sentAt === "number" ? frame.sentAt : null
    this.entries.push({
      receivedAt,
      messageId: typeof frame?.messageId === "string" ? frame.messageId : null,
      frameType: typeof frame?.frameType === "string" ? frame.frameType : null,
      sequence: "sequence" in (frame ?? {}) && typeof (frame as { sequence?: unknown }).sequence === "number" ? (frame as { sequence: number }).sequence : null,
      decision,
      ...(reason ? { reason } : {}),
      ...(sentAt !== null ? { latencyMs: receivedAt - sentAt } : {}),
    })
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
  }

  getEntries(): ProtocolTraceEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  export(exportedAt: number): ProtocolTraceExport {
    return { protocolVersion: PROTOCOL_VERSION, exportedAt, entries: this.getEntries() }
  }

  clear(): void {
    this.entries.length = 0
  }
}
