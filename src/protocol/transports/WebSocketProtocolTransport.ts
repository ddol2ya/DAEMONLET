import type { ProtocolClientCommand } from "../types"
import type { CharacterEventTransport, TransportStatus } from "./CharacterEventTransport"

type WebSocketLike = {
  readonly readyState: number
  binaryType: BinaryType
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

type ConnectAttempt = {
  generation: number
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  settled: boolean
}

const assertLocalEndpoint = (endpoint: string, allowRemote: boolean) => {
  const url = new URL(endpoint)
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("protocol endpoint must use ws: or wss:")
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1"
  if (!local && !allowRemote) throw new Error("remote WebSocket endpoints are disabled; use an explicit allowRemote option")
}

export class WebSocketProtocolTransport implements CharacterEventTransport {
  private socket: WebSocketLike | null = null
  private status: TransportStatus = { state: "DISCONNECTED" }
  private generation = 0
  private connectAttempt: ConnectAttempt | null = null
  private readonly messageListeners = new Set<(raw: string | ArrayBuffer) => void>()
  private readonly statusListeners = new Set<(status: TransportStatus) => void>()
  private disposed = false
  private readonly factory: WebSocketFactory

  constructor(
    readonly endpoint = "ws://127.0.0.1:4174/events",
    options: { allowRemote?: boolean; factory?: WebSocketFactory } = {},
  ) {
    assertLocalEndpoint(endpoint, options.allowRemote === true)
    this.factory = options.factory ?? ((url) => new WebSocket(url))
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("transport is disposed"))
    if (this.status.state === "OPEN") return Promise.resolve()
    if (this.connectAttempt) return this.connectAttempt.promise
    const generation = ++this.generation
    let resolveAttempt!: () => void
    let rejectAttempt!: (error: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
      resolveAttempt = resolve
      rejectAttempt = reject
    })
    const attempt: ConnectAttempt = {
      generation,
      promise,
      resolve: resolveAttempt,
      reject: rejectAttempt,
      settled: false,
    }
    this.connectAttempt = attempt
    this.setStatus({ state: "CONNECTING" })
    let socket: WebSocketLike
    try {
      socket = this.factory(this.endpoint)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.finishConnectAttempt(generation, { type: "reject", error: failure })
      this.setStatus({ state: "ERROR", reason: failure.message })
      return promise
    }
    this.socket = socket
    socket.binaryType = "arraybuffer"
    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return
      this.finishConnectAttempt(generation, { type: "resolve" })
      this.setStatus({ state: "OPEN" })
    }
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation)) return
      if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
        for (const listener of this.messageListeners) listener(event.data)
        return
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((raw) => {
          if (this.isCurrent(socket, generation)) for (const listener of this.messageListeners) listener(raw)
        })
      }
    }
    socket.onerror = () => {
      if (!this.isCurrent(socket, generation)) return
      const error = new Error("WebSocket connection error")
      this.finishConnectAttempt(generation, { type: "reject", error })
      this.socket = null
      ++this.generation
      this.detachSocket(socket)
      this.setStatus({ state: "ERROR", reason: error.message })
      if (socket.readyState < 2) {
        try { socket.close() } catch { /* closing is best-effort after an error */ }
      }
      this.setStatus({ state: "CLOSED", reason: error.message, manual: false })
    }
    socket.onclose = (event) => {
      if (!this.isCurrent(socket, generation)) return
      const reason = event.reason || `WebSocket closed (${event.code})`
      this.finishConnectAttempt(generation, { type: "reject", error: new Error(reason) })
      this.socket = null
      this.detachSocket(socket)
      this.setStatus({ state: "CLOSED", reason, manual: false })
    }
    return promise
  }

  disconnect(reason = "manual disconnect"): void {
    const socket = this.socket
    const attempt = this.connectAttempt
    if (attempt) this.finishConnectAttempt(attempt.generation, { type: "reject", error: this.createAbortError(reason) })
    ++this.generation
    this.socket = null
    if (socket) {
      this.detachSocket(socket)
      if (socket.readyState < 2) {
        try { socket.close(1000, reason.slice(0, 123)) } catch { /* status and attempt cleanup must still complete */ }
      }
    }
    this.setStatus({ state: "CLOSED", reason, manual: true })
  }

  send(command: ProtocolClientCommand): void {
    if (!this.socket || this.socket.readyState !== 1 || this.status.state !== "OPEN") throw new Error("WebSocket is not open")
    this.socket.send(JSON.stringify(command))
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
    this.disconnect("transport disposed")
    this.messageListeners.clear()
    this.statusListeners.clear()
  }

  private isCurrent(socket: WebSocketLike, generation: number): boolean {
    return !this.disposed && socket === this.socket && generation === this.generation
  }

  private finishConnectAttempt(generation: number, result: { type: "resolve" } | { type: "reject"; error: Error }): void {
    const attempt = this.connectAttempt
    if (!attempt || attempt.generation !== generation || attempt.settled) return
    attempt.settled = true
    this.connectAttempt = null
    if (result.type === "resolve") attempt.resolve()
    else attempt.reject(result.error)
  }

  private createAbortError(reason: string): Error {
    const error = new Error(reason)
    error.name = "AbortError"
    return error
  }

  private detachSocket(socket: WebSocketLike): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
  }

  private setStatus(status: TransportStatus): void {
    this.status = status
    for (const listener of this.statusListeners) listener({ ...status })
  }
}
