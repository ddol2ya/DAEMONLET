import { WebSocket, type RawData } from "ws"
import type { WebContents } from "electron"
import { MAX_PROTOCOL_MESSAGE_BYTES, type ProtocolClientCommand } from "../../src/protocol/types"
import { IPC, type ProtocolBridgeStatus } from "../shared/ipc-contract"
import { validateProtocolClientCommand } from "../shared/runtime-validation"

type Connection = {
  generation: number
  socket: WebSocket
  sender: WebContents
  manual: boolean
  opened: boolean
  settled: boolean
  resolve: () => void
  reject: (error: Error) => void
  onDestroyed: () => void
  senderListenerRemoved: boolean
  source: string | null
  snapshotCount: number
}

type ProtocolBridgeOptions = {
  createSocket?: (endpoint: string) => WebSocket
}

export class ProtocolBridge {
  readonly endpoint: string
  private readonly connections = new Map<number, Connection>()
  private generation = 0
  private readonly createSocket: (endpoint: string) => WebSocket

  constructor(endpoint = "ws://127.0.0.1:4174/events", options: ProtocolBridgeOptions = {}) {
    const url = new URL(endpoint)
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new Error("ProtocolBridge endpoint must be loopback ws")
    this.endpoint = endpoint
    this.createSocket = options.createSocket ?? ((value) => new WebSocket(value, { maxPayload: MAX_PROTOCOL_MESSAGE_BYTES, perMessageDeflate: false }))
  }

  connect(sender: WebContents): Promise<void> {
    if (sender.isDestroyed()) return Promise.reject(this.abortError("renderer destroyed"))
    this.disconnect(sender.id, "reconnect")
    this.status(sender, { state: "CONNECTING" })
    let resolveAttempt!: () => void
    let rejectAttempt!: (error: Error) => void
    const promise = new Promise<void>((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject })
    let socket: WebSocket
    try {
      socket = this.createSocket(this.endpoint)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.status(sender, { state: "ERROR", reason: failure.message })
      this.status(sender, { state: "CLOSED", reason: failure.message, manual: false })
      rejectAttempt(failure)
      return promise
    }
    const generation = ++this.generation
    let connection!: Connection
    const onDestroyed = () => this.abortConnection(connection, "renderer destroyed", false)
    connection = {
      generation,
      socket,
      sender,
      manual: false,
      opened: false,
      settled: false,
      resolve: resolveAttempt,
      reject: rejectAttempt,
      onDestroyed,
      senderListenerRemoved: false,
      source: null,
      snapshotCount: 0,
    }
    this.connections.set(sender.id, connection)
    sender.once("destroyed", onDestroyed)
    socket.once("open", () => {
      if (!this.isCurrent(connection)) {
        this.finishAttempt(connection, { type: "reject", error: this.abortError("stale connection") })
        return
      }
      connection.opened = true
      this.finishAttempt(connection, { type: "resolve" })
      this.status(sender, { state: "OPEN" })
    })
    socket.on("message", (data: RawData, binary: boolean) => {
      if (!this.isCurrent(connection)) return
      const raw = binary ? null : data.toString("utf8")
      if (raw === null || Buffer.byteLength(raw) > MAX_PROTOCOL_MESSAGE_BYTES) {
        socket.close(1009, "unsupported or oversized frame")
        return
      }
      this.observeFrame(connection, raw)
      if (!sender.isDestroyed()) sender.send(IPC.protocolMessage, raw)
    })
    socket.once("error", (error: Error) => {
      this.finishAttempt(connection, { type: "reject", error })
      if (!this.isCurrent(connection)) return
      this.status(sender, { state: "ERROR", reason: error.message })
    })
    socket.once("close", (code: number, reason: Buffer) => {
      const message = reason.toString() || `WebSocket closed (${code})`
      this.finishAttempt(connection, { type: "reject", error: new Error(message) })
      const current = this.isCurrent(connection)
      if (current) this.connections.delete(sender.id)
      this.cleanupSenderListener(connection)
      if (current) this.status(sender, { state: "CLOSED", reason: message, manual: connection.manual })
    })
    return promise
  }

  send(senderId: number, value: unknown): void {
    const command = validateProtocolClientCommand(value)
    if (!command) throw new Error("invalid protocol client command")
    const connection = this.connections.get(senderId)
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) throw new Error("protocol bridge is not open")
    connection.socket.send(JSON.stringify(command satisfies ProtocolClientCommand))
  }

  disconnect(senderId: number, reason = "manual disconnect"): void {
    const connection = this.connections.get(senderId)
    if (!connection) return
    this.abortConnection(connection, reason, true)
  }

  reconnectAll(): void {
    const senders = [...this.connections.values()].map((connection) => connection.sender)
    for (const sender of senders) void this.connect(sender).catch(() => undefined)
  }

  dispose(): void {
    for (const id of [...this.connections.keys()]) this.disconnect(id, "bridge disposed")
  }

  get clientCount(): number { return this.connections.size }

  get openClientCount(): number {
    return [...this.connections.values()].filter((connection) => connection.opened && connection.socket.readyState === WebSocket.OPEN).length
  }

  getDiagnostics(): { clientCount: number; openClientCount: number; sources: string[]; snapshotCount: number } {
    const connections = [...this.connections.values()]
    return {
      clientCount: connections.length,
      openClientCount: this.openClientCount,
      sources: [...new Set(connections.flatMap((connection) => connection.source ? [connection.source] : []))],
      snapshotCount: connections.reduce((total, connection) => total + connection.snapshotCount, 0),
    }
  }

  private isCurrent(connection: Connection): boolean {
    return this.connections.get(connection.sender.id) === connection
  }

  private finishAttempt(connection: Connection, result: { type: "resolve" } | { type: "reject"; error: Error }): void {
    if (connection.settled) return
    connection.settled = true
    if (result.type === "resolve") connection.resolve()
    else connection.reject(result.error)
  }

  private abortConnection(connection: Connection, reason: string, sendStatus: boolean): void {
    const current = this.isCurrent(connection)
    if (current) this.connections.delete(connection.sender.id)
    connection.manual = true
    this.finishAttempt(connection, { type: "reject", error: this.abortError(reason) })
    this.cleanupSenderListener(connection)
    if (connection.socket.readyState < WebSocket.CLOSING) {
      try { connection.socket.close(1000, reason.slice(0, 123)) } catch { /* attempt and listener cleanup already completed */ }
    }
    if (current && sendStatus) this.status(connection.sender, { state: "CLOSED", reason, manual: true })
  }

  private cleanupSenderListener(connection: Connection): void {
    if (connection.senderListenerRemoved) return
    connection.senderListenerRemoved = true
    connection.sender.removeListener("destroyed", connection.onDestroyed)
  }

  private abortError(reason: string): Error {
    const error = new Error(reason)
    error.name = "AbortError"
    return error
  }

  private observeFrame(connection: Connection, raw: string): void {
    try {
      const frame = JSON.parse(raw) as Record<string, unknown>
      if (frame.frameType === "hello" && typeof frame.source === "string") connection.source = frame.source
      if (frame.frameType === "snapshot") connection.snapshotCount++
    } catch { /* renderer performs authoritative frame validation */ }
  }

  private status(sender: WebContents, value: ProtocolBridgeStatus): void {
    if (!sender.isDestroyed()) sender.send(IPC.protocolStatus, value)
  }
}
