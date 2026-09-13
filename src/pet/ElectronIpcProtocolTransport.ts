import type { ProtocolClientCommand } from "../protocol/types"
import type { CharacterEventTransport, TransportStatus } from "../protocol/transports/CharacterEventTransport"
import type { DesktopProtocolApi, ProtocolBridgeStatus } from "../../electron/shared/ipc-contract"

export class ElectronIpcProtocolTransport implements CharacterEventTransport {
  readonly endpoint = "electron-ipc://codex-adapter/events"
  private status: TransportStatus = { state: "DISCONNECTED" }
  private readonly messageListeners = new Set<(raw: string | ArrayBuffer) => void>()
  private readonly statusListeners = new Set<(status: TransportStatus) => void>()
  private readonly unsubscribeMessage: () => void
  private readonly unsubscribeStatus: () => void
  private disposed = false

  constructor(private readonly protocol: DesktopProtocolApi) {
    this.unsubscribeMessage = protocol.onMessage((raw) => {
      for (const listener of this.messageListeners) listener(raw)
    })
    this.unsubscribeStatus = protocol.onStatus((status) => this.acceptStatus(status))
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("transport is disposed")
    if (this.status.state === "OPEN") return
    this.setStatus({ state: "CONNECTING" })
    await this.protocol.connect()
  }

  disconnect(reason = "manual disconnect"): void {
    if (this.disposed) return
    void this.protocol.disconnect().catch(() => undefined)
    this.setStatus({ state: "CLOSED", reason, manual: true })
  }

  send(command: ProtocolClientCommand): void {
    if (this.status.state !== "OPEN") throw new Error("protocol bridge is not open")
    this.protocol.send(command)
  }

  subscribeMessage(listener: (raw: string | ArrayBuffer) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener) }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener) }
  getStatus(): TransportStatus { return { ...this.status } }

  dispose(): void {
    if (this.disposed) return
    this.disconnect("transport disposed")
    this.disposed = true
    this.unsubscribeMessage()
    this.unsubscribeStatus()
    this.messageListeners.clear()
    this.statusListeners.clear()
  }

  private acceptStatus(status: ProtocolBridgeStatus): void {
    this.setStatus(status)
  }

  private setStatus(status: TransportStatus): void {
    if (this.status.state === status.state && this.status.reason === status.reason && this.status.manual === status.manual) return
    this.status = status
    for (const listener of this.statusListeners) listener({ ...status })
  }
}
