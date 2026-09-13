import type { ProtocolClientCommand } from "../types"

export type TransportState = "DISCONNECTED" | "CONNECTING" | "OPEN" | "CLOSED" | "ERROR"
export type TransportStatus = {
  state: TransportState
  reason?: string
  manual?: boolean
}

export interface CharacterEventTransport {
  readonly endpoint: string | null
  connect(): Promise<void>
  disconnect(reason?: string): void
  send(command: ProtocolClientCommand): void
  subscribeMessage(listener: (raw: string | ArrayBuffer) => void): () => void
  subscribeStatus(listener: (status: TransportStatus) => void): () => void
  getStatus(): TransportStatus
  dispose(): void
}
