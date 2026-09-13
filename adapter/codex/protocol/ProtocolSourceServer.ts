import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { isIP } from "node:net"
import { WebSocket, WebSocketServer } from "ws"
import { MAX_PROTOCOL_MESSAGE_BYTES, type ProtocolClientCommand, type ProtocolDomainEvent, type ProtocolRunSnapshot } from "../../../src/protocol/types.ts"
import { ProtocolFrameFactory } from "./ProtocolFrameFactory.ts"

export interface ProtocolSourceStateProvider {
  getSnapshot(): ProtocolRunSnapshot[]
  subscribe(listener: (event: ProtocolDomainEvent) => void): () => void
}

export type ProtocolSourceOptions = {
  provider: ProtocolSourceStateProvider
  host?: string
  port?: number
  heartbeatIntervalMs?: number
  sourceInstanceId?: string
  sessionId?: string
  maxClients?: number
}

type ClientState = {
  ready: boolean
  helloReceived: boolean
  invalidCommandTimes: number[]
  snapshotTokens: number
  snapshotRefillAt: number
}

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://[::1]:4173",
])
const INVALID_WINDOW_MS = 10_000
const INVALID_COMMAND_LIMIT = 10
const SNAPSHOT_CAPACITY = 5
const SNAPSHOT_REFILL_MS = 1_000

export function isLoopbackRemoteAddress(value: string | undefined): boolean {
  if (value === "::1") return true
  const ipv4 = value?.replace(/^::ffff:/i, "")
  return typeof ipv4 === "string" && isIP(ipv4) === 4 && ipv4.startsWith("127.")
}

function validCommand(value: unknown): value is ProtocolClientCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const command = value as Record<string, unknown>
  if (command.protocolVersion !== 1 || !isCanonicalProtocolId(command.requestId) || typeof command.commandType !== "string") return false
  if (command.commandType === "client.hello") return isCanonicalProtocolId(command.clientId) && Array.isArray(command.supportedProtocolVersions) && command.supportedProtocolVersions.includes(1)
  if (command.commandType === "snapshot.request") return typeof command.reason === "string" && ["initial", "reconnect", "sequence-gap", "manual"].includes(command.reason)
  return command.commandType === "client.ping" && typeof command.sentAt === "number" && Number.isFinite(command.sentAt)
}

const isCanonicalProtocolId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)

export class ProtocolSourceServer {
  private readonly options: ProtocolSourceOptions
  private server: WebSocketServer | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly clientStates = new Map<WebSocket, ClientState>()
  private readonly host: string
  private readonly port: number
  private readonly heartbeatIntervalMs: number
  private readonly maxClients: number
  readonly sourceInstanceId: string
  readonly sessionId: string
  readonly frames: ProtocolFrameFactory

  constructor(options: ProtocolSourceOptions) {
    this.options = options
    this.host = options.host ?? "127.0.0.1"
    if (this.host !== "127.0.0.1") throw new Error("protocol source must bind to 127.0.0.1")
    this.port = options.port ?? 4174
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
    this.maxClients = options.maxClients ?? 8
    if (!Number.isSafeInteger(this.maxClients) || this.maxClients < 1 || this.maxClients > 32) throw new Error("maxClients must be an integer from 1 through 32")
    this.sourceInstanceId = options.sourceInstanceId ?? randomUUID()
    this.sessionId = options.sessionId ?? `adapter-${randomUUID()}`
    this.frames = new ProtocolFrameFactory(this.sourceInstanceId, this.sessionId)
  }

  async start(): Promise<void> {
    if (this.server) return
    const server: WebSocketServer = new WebSocketServer({
      host: this.host,
      port: this.port,
      path: "/events",
      maxPayload: MAX_PROTOCOL_MESSAGE_BYTES,
      verifyClient: ({ req }, done) => {
        if (this.acceptHandshake(req, server)) done(true)
        else done(false, 403, "Forbidden", { "cache-control": "no-store" })
      },
    })
    server.on("connection", (socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve)
      server.once("error", reject)
    })
    this.server = server
    this.unsubscribe = this.options.provider.subscribe((event) => this.broadcast(this.frames.event(event)))
    this.heartbeatTimer = setInterval(() => this.broadcast(this.frames.heartbeat()), this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }

  private acceptHandshake(request: IncomingMessage, server: WebSocketServer): boolean {
    if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) return false
    const origin = request.headers.origin
    if (typeof origin === "string" && !DEFAULT_ALLOWED_ORIGINS.has(origin)) return false
    return server.clients.size < this.maxClients
  }

  private handleConnection(socket: WebSocket): void {
    const now = Date.now()
    const state: ClientState = {
      ready: false,
      helloReceived: false,
      invalidCommandTimes: [],
      snapshotTokens: SNAPSHOT_CAPACITY,
      snapshotRefillAt: now,
    }
    this.clientStates.set(socket, state)
    socket.once("close", () => this.clientStates.delete(socket))
    socket.on("message", (raw, isBinary) => {
      if (socket.readyState !== WebSocket.OPEN) return
      const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
      if (isBinary || bytes.byteLength > MAX_PROTOCOL_MESSAGE_BYTES) return socket.close(1003, "text JSON frames only")
      let value: unknown
      try { value = JSON.parse(bytes.toString("utf8")) } catch { return this.recordInvalid(socket, state) }
      if (!validCommand(value)) return this.recordInvalid(socket, state)
      if (value.commandType === "client.hello") {
        if (state.helloReceived) return socket.close(1008, "client hello already received")
        state.helloReceived = true
        state.ready = true
        return this.send(socket, this.frames.hello(this.heartbeatIntervalMs))
      }
      if (!state.ready) return this.recordInvalid(socket, state)
      if (value.commandType === "snapshot.request") {
        if (!this.consumeSnapshotToken(state)) return socket.close(1008, "snapshot rate limit")
        return this.broadcast(this.frames.snapshot(this.options.provider.getSnapshot()))
      }
      this.send(socket, this.frames.heartbeat(value.requestId))
    })
  }

  private recordInvalid(socket: WebSocket, state: ClientState): void {
    const now = Date.now()
    state.invalidCommandTimes = state.invalidCommandTimes.filter((at) => now - at < INVALID_WINDOW_MS)
    state.invalidCommandTimes.push(now)
    if (state.invalidCommandTimes.length >= INVALID_COMMAND_LIMIT) socket.close(1008, "invalid command limit")
  }

  private consumeSnapshotToken(state: ClientState): boolean {
    const now = Date.now()
    const elapsed = now - state.snapshotRefillAt
    if (elapsed > 0) {
      state.snapshotTokens = Math.min(SNAPSHOT_CAPACITY, state.snapshotTokens + elapsed / SNAPSHOT_REFILL_MS)
      state.snapshotRefillAt = now
    }
    if (state.snapshotTokens < 1) return false
    state.snapshotTokens--
    return true
  }

  private send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }

  private broadcast(frame: unknown): void {
    if (!this.server) return
    for (const [socket, state] of this.clientStates) if (state.ready) this.send(socket, frame)
  }

  publishSnapshot(): void { this.broadcast(this.frames.snapshot(this.options.provider.getSnapshot())) }

  get clientCount(): number {
    if (!this.server) return 0
    return [...this.server.clients].filter((socket) => socket.readyState === WebSocket.OPEN).length
  }

  get trackedClientCount(): number {
    return this.clientStates.size
  }

  get endpoint(): string {
    const address = this.server?.address()
    const port = address && typeof address === "object" ? address.port : this.port
    return `ws://${this.host}:${port}/events`
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    const server = this.server
    this.server = null
    this.clientStates.clear()
    if (!server) return
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}
