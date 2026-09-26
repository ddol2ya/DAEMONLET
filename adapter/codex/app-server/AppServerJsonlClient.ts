import { EventEmitter, once } from "node:events"
import type { Readable, Writable } from "node:stream"


type JsonObject = Record<string, unknown>

// Logical RPC closure can precede a pipe/socket's final error and close events.
// This guard belongs to the stream, not the client: it retains no RPC state and
// is removed only at physical close. Shared duplex streams get one guard.
const guardedStreams = new WeakSet<Readable | Writable>()
const ignoreLateStreamError = () => {}
function guardUntilStreamClosed(stream: Readable | Writable): void {
  if (stream.closed || guardedStreams.has(stream)) return
  guardedStreams.add(stream)
  stream.on("error", ignoreLateStreamError)
  stream.once("close", () => {
    stream.removeListener("error", ignoreLateStreamError)
    guardedStreams.delete(stream)
  })
}

export type JsonlClientOptions = {
  readable: Readable
  writable: Writable
  requestTimeoutMs?: number
  maxLineBytes?: number
}

export class AppServerRpcError extends Error {
  constructor(readonly code: number | null) { super("app-server request failed") }
}

export class AppServerJsonlClient {
  private readonly options: JsonlClientOptions
  private readonly events = new EventEmitter()
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private closed = false
  private readonly writeAbort = new AbortController()
  private readonly onData = (chunk: Buffer | string) => this.pushChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  private readonly onEnd = () => this.close(new Error("app-server stdout ended"))
  private readonly onStreamError = (error: Error) => this.close(error)
  lastError: string | null = null
  lastNotification: string | null = null
  handshakeState: "NEW" | "INITIALIZING" | "READY" | "CLOSED" = "NEW"

  constructor(options: JsonlClientOptions) {
    this.options = options
    options.readable.on("data", this.onData)
    options.readable.once("end", this.onEnd)
    options.readable.once("error", this.onStreamError)
    options.writable.once("error", this.onStreamError)
  }

  get pendingRequestCount(): number { return this.pending.size }

  onClose(listener: () => void): () => void {
    this.events.on("close", listener)
    return () => this.events.off("close", listener)
  }
  async respondToServerRequest(id: unknown, result: unknown): Promise<void> {
    if (typeof id !== "number" && typeof id !== "string") return
    await this.write({ id, result })
  }
  async rejectServerRequest(id: unknown): Promise<void> {
    if (typeof id !== "number" && typeof id !== "string") return
    await this.write({ id, error: { code: -32601, message: "Side chat does not support server requests" } })
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.events.on("notification", listener)
    return () => this.events.off("notification", listener)
  }

  onServerRequest(listener: (request: JsonObject) => void): () => void {
    this.events.on("request", listener)
    return () => this.events.off("request", listener)
  }

  private pushChunk(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    const max = this.options.maxLineBytes ?? 1024 * 1024
    if (this.buffer.byteLength > max && !this.buffer.includes(0x0a)) {
      this.lastError = "app-server JSONL line exceeded maximum size"
      return this.close(new Error(this.lastError))
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) break
      let line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.byteLength === 0) continue
      if (line.byteLength > max) {
        this.lastError = "app-server JSONL line exceeded maximum size"
        this.close(new Error(this.lastError))
        return
      }
      this.processLine(line.toString("utf8"))
    }
  }

  private processLine(line: string): void {
    let value: unknown
    try { value = JSON.parse(line) } catch {
      this.lastError = "app-server emitted malformed JSONL"
      this.events.emit("malformed")
      return
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    const message = value as JsonObject
    if (typeof message.id === "number" && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) && !Object.hasOwn(message, "method")) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (Object.hasOwn(message, "error")) pending.reject(new AppServerRpcError(typeof (message.error as JsonObject)?.code === "number" && Number.isSafeInteger((message.error as JsonObject).code) ? (message.error as JsonObject).code as number : null))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
      this.events.emit("request", message)
      return
    }
    if (typeof message.method === "string") {
      this.lastNotification = message.method
      this.events.emit("notification", message.method, message.params)
    }
  }

  private async write(message: JsonObject): Promise<void> {
    if (this.closed) throw new Error("app-server client is closed")
    const line = `${JSON.stringify(message)}\n`
    if (!this.options.writable.write(line, "utf8")) await once(this.options.writable, "drain", { signal: this.writeAbort.signal })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  async request(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 15_000): Promise<unknown> {
    const id = this.nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`app-server request timed out: ${method}`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { method, resolve, reject, timer })
    })
    // Return the response promise immediately so close/error rejection is always
    // observed, including when the transport breaks while a write is draining.
    void this.write({ id, method, ...(params === undefined ? {} : { params }) }).catch((error) => {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error("app-server write failed"))
      }
    })
    return result
  }

  async initialize(clientInfo: { name: string; title: string; version: string }, profile: "observer" | "side-chat" = "observer", timeoutMs?: number): Promise<unknown> {
    if (this.handshakeState !== "NEW") throw new Error("app-server client was already initialized")
    this.handshakeState = "INITIALIZING"
    const result = await this.request("initialize", {
      clientInfo,
      capabilities: {
        experimentalApi: profile === "side-chat",
        requestAttestation: false,
        optOutNotificationMethods: [
          ...(profile === "observer" ? ["item/agentMessage/delta"] : []),
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
          "turn/diff/updated",
          "item/plan/delta",
        ],
      },
    }, timeoutMs)
    await this.notify("initialized")
    this.handshakeState = "READY"
    return result
  }

  close(reason = new Error("app-server client closed")): void {
    if (this.closed) return
    this.closed = true
    this.writeAbort.abort()
    this.options.readable.removeListener("data", this.onData)
    this.options.readable.removeListener("end", this.onEnd)
    guardUntilStreamClosed(this.options.readable)
    guardUntilStreamClosed(this.options.writable)
    this.options.readable.removeListener("error", this.onStreamError)
    this.options.writable.removeListener("error", this.onStreamError)
    this.buffer = Buffer.alloc(0)
    this.handshakeState = "CLOSED"
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
    this.events.emit("close")
    this.events.removeAllListeners()
  }
}
