import { randomUUID } from "node:crypto"
import { connect, type Socket } from "node:net"
import { join } from "node:path"
import { homedir } from "node:os"
import { DesktopIpcProjection } from "./DesktopIpcProjection"
import { validateControlSocket } from "./AppServerSocketClient"

export const DESKTOP_IPC_VERSIONS = {
  initialize: 0,
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-stream-following-changed": 1,
  "thread-stream-following-status-requested": 1,
  "thread-stream-state-changed": 11,
  "client-status-changed": 0,
} as const
const MAX_FRAME = 512 * 1024 * 1024
const MAX_REQUEST = 128 * 1024
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v))
export type DesktopMessage = Record<string, unknown>
export type DesktopResponse = { result: unknown; handledByClientId: string }
export interface DesktopIpc {
  readonly lastCloseReason?: string | null
  request(method: "thread-owner-discovery" | "thread-follower-start-turn" | "thread-follower-steer-turn" | "thread-follower-interrupt-turn", params: Record<string, unknown>, targetClientId?: string, timeoutMs?: number): Promise<DesktopResponse>
  follow(conversationId: string, ownerClientId: string, following: boolean): void
  onBroadcast(listener: (message: DesktopMessage) => void): () => void
  close(): void
}

/** Codex's desktop/IDE coordination transport; no router creation or ownership takeover. */
export class DesktopIpcClient implements DesktopIpc {
  private clientId = "initializing-client"
  private closed = false
  private closeReason: string | null = null
  private header = Buffer.alloc(4)
  private headerBytes = 0
  private frame: DesktopIpcProjection | null = null
  private frameSize = 0
  private frameBytes = 0
  private readonly pending = new Map<string, { method: string; target?: string; resolve: (value: DesktopResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<(message: DesktopMessage) => void>()
  private constructor(private readonly socket: Socket, private readonly onClosed: () => void) {
    socket.on("data", chunk => { try { this.read(chunk) } catch (error) { this.close(error instanceof Error ? error.message : "PROTOCOL_UNSUPPORTED") } })
    socket.on("error", () => this.close("CONNECT_FAILED"))
    socket.on("close", () => this.close())
  }
  static async connect(onClosed: () => void, home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<DesktopIpcClient> {
    // Codex Desktop uses a fixed local named pipe on Windows. It is not a
    // filesystem socket and cannot pass Unix lstat/uid/mode checks.
    const path = process.platform === "win32"
      ? "\\\\.\\pipe\\codex-ipc"
      : await validateControlSocket(join(home, "ipc", "ipc.sock"))
    const socket = connect(path), client = new DesktopIpcClient(socket, onClosed)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("CONNECT_FAILED")) }, 2500)
        socket.once("connect", () => { clearTimeout(timer); resolve() })
        socket.once("error", () => { clearTimeout(timer); reject(new Error("CONNECT_FAILED")) })
      })
      const initialized = await client.sendRequest("initialize", { clientType: "daemonlet" }, undefined, 2500)
      if (!record(initialized.result) || typeof initialized.result.clientId !== "string" || initialized.result.clientId.length > 100) throw new Error("PROTOCOL_UNSUPPORTED")
      client.clientId = initialized.result.clientId
      return client
    } catch (error) { client.close(); throw error }
  }
  request(method: Parameters<DesktopIpc["request"]>[0], params: Record<string, unknown>, targetClientId?: string, timeoutMs = 5000): Promise<DesktopResponse> {
    return this.sendRequest(method, params, targetClientId, timeoutMs)
  }
  private sendRequest(method: keyof typeof DESKTOP_IPC_VERSIONS, params: Record<string, unknown>, targetClientId: string | undefined, timeoutMs: number): Promise<DesktopResponse> {
    if (this.closed || this.pending.size >= 64) return Promise.reject(new Error("UNAVAILABLE"))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("OUTCOME_UNKNOWN")) }, timeoutMs)
      timer.unref()
      this.pending.set(requestId, { method, target: targetClientId, resolve, reject, timer })
      try { this.write({ type: "request", requestId, sourceClientId: this.clientId, version: DESKTOP_IPC_VERSIONS[method], method, params, ...(targetClientId ? { targetClientId } : {}), timeoutMs }) }
      catch { clearTimeout(timer); this.pending.delete(requestId); reject(new Error("CONNECT_FAILED")) }
    })
  }
  follow(conversationId: string, ownerClientId: string, following: boolean): void {
    this.write({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: this.clientId, targetClientIds: [ownerClientId], version: DESKTOP_IPC_VERSIONS["thread-stream-following-changed"], params: { conversationId, hostId: "local", following } })
  }
  onBroadcast(listener: (message: DesktopMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private write(value: DesktopMessage): void {
    if (this.closed || !this.socket.writable) throw new Error("CONNECT_FAILED")
    const body = Buffer.from(JSON.stringify(value))
    if (body.length > MAX_REQUEST || this.socket.writableLength > MAX_REQUEST * 2) throw new Error("INVALID_REQUEST")
    const frame = Buffer.allocUnsafe(4 + body.length)
    frame.writeUInt32LE(body.length, 0); body.copy(frame, 4)
    this.socket.write(frame)
  }
  private read(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length && !this.closed) {
      if (!this.frame) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count); this.headerBytes += count; offset += count
        if (this.headerBytes < 4) return
        const size = this.header.readUInt32LE(0); this.headerBytes = 0
        if (size === 0 || size > MAX_FRAME) throw new Error(`PROTOCOL_FRAME_LIMIT:${size}`)
        this.frame = new DesktopIpcProjection(); this.frameSize = size; this.frameBytes = 0
      }
      const count = Math.min(this.frameSize - this.frameBytes, chunk.length - offset)
      this.frame.write(chunk.subarray(offset, offset + count)); this.frameBytes += count; offset += count
      if (this.frameBytes < this.frameSize) continue
      const frame = this.frame; this.frame = null; this.frameBytes = 0
      const value: unknown = frame.finish()
      if (!record(value)) throw new Error("PROTOCOL_UNSUPPORTED")
      this.handle(value)
    }
  }
  private handle(message: DesktopMessage): void {
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      // We are a follower only. Never claim ownership or handle approvals/tools.
      this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }); return
    }
    if (message.type === "request" && typeof message.requestId === "string") {
      this.write({ type: "response", requestId: message.requestId, resultType: "error", error: "no-handler-for-request" }); return
    }
    if (message.type === "broadcast") {
      if (message.targetClientIds !== undefined && (!Array.isArray(message.targetClientIds) || !message.targetClientIds.includes(this.clientId))) return
      for (const listener of this.listeners) listener(message)
      return
    }
    if (message.type !== "response" || typeof message.requestId !== "string") return
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId); clearTimeout(pending.timer)
    if (message.resultType === "error") { pending.reject(new Error(message.error === "no-client-found" ? "STALE_TARGET" : ["client-disconnected", "request-timeout", "server-closed"].includes(String(message.error)) ? "OUTCOME_UNKNOWN" : "ACTION_FAILED")); return }
    if (message.resultType !== "success" || message.method !== pending.method || typeof message.handledByClientId !== "string" || message.handledByClientId.length > 100 || pending.target && message.handledByClientId !== pending.target) { pending.reject(new Error("PROTOCOL_UNSUPPORTED")); return }
    pending.resolve({ result: message.result, handledByClientId: message.handledByClientId })
  }
  get lastCloseReason(): string | null { return this.closeReason }
  close(reason = "SOCKET_CLOSED"): void {
    if (this.closed) return
    this.closed = true; this.closeReason = reason; this.frame = null; this.socket.destroy()
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("OUTCOME_UNKNOWN")) }
    this.pending.clear(); this.listeners.clear(); this.onClosed()
  }
}
