import type { ProtocolClientCommand, ProtocolFrame } from "../types"
import type { CharacterEventTransport, TransportStatus } from "./CharacterEventTransport"

export class InMemoryProtocolTransport implements CharacterEventTransport {
  readonly endpoint = "memory://protocol-loopback"
  private status: TransportStatus = { state: "DISCONNECTED" }
  private readonly messageListeners = new Set<(raw: string | ArrayBuffer) => void>()
  private readonly statusListeners = new Set<(status: TransportStatus) => void>()
  private readonly commandListeners = new Set<(command: ProtocolClientCommand) => void>()
  private readonly commands: ProtocolClientCommand[] = []
  private disposed = false

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("transport is disposed")
    if (this.status.state === "OPEN") return
    this.setStatus({ state: "CONNECTING" })
    await Promise.resolve()
    if (this.disposed) throw new Error("transport is disposed")
    this.setStatus({ state: "OPEN" })
  }

  disconnect(reason = "manual disconnect"): void {
    if (this.status.state === "DISCONNECTED" || this.status.state === "CLOSED") return
    this.setStatus({ state: "CLOSED", reason, manual: true })
  }

  drop(reason = "simulated connection drop"): void {
    if (this.status.state !== "OPEN") return
    this.setStatus({ state: "CLOSED", reason, manual: false })
  }

  send(command: ProtocolClientCommand): void {
    if (this.status.state !== "OPEN") throw new Error("transport is not open")
    const copy = structuredClone(command)
    this.commands.push(copy)
    for (const listener of this.commandListeners) listener(structuredClone(copy))
  }

  inject(value: string | ArrayBuffer | ProtocolFrame | unknown): void {
    if (this.status.state !== "OPEN") return
    const raw = typeof value === "string" || value instanceof ArrayBuffer ? value : JSON.stringify(value)
    for (const listener of this.messageListeners) listener(raw)
  }

  subscribeCommand(listener: (command: ProtocolClientCommand) => void): () => void {
    this.commandListeners.add(listener)
    return () => this.commandListeners.delete(listener)
  }

  getSentCommands(): ProtocolClientCommand[] {
    return structuredClone(this.commands)
  }

  clearSentCommands(): void {
    this.commands.length = 0
  }

  subscribeMessage(listener: (raw: string | ArrayBuffer) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  getStatus(): TransportStatus {
    return { ...this.status }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.status.state === "OPEN" || this.status.state === "CONNECTING") this.setStatus({ state: "CLOSED", reason: "disposed", manual: true })
    this.messageListeners.clear()
    this.statusListeners.clear()
    this.commandListeners.clear()
  }

  private setStatus(status: TransportStatus): void {
    this.status = status
    for (const listener of this.statusListeners) listener({ ...status })
  }
}
