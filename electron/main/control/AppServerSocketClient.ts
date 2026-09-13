import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { WebSocket } from "ws"
import { AppServerJsonlClient } from "../../../adapter/codex/app-server/AppServerJsonlClient"

export type ControlRpc = {
  request(method: string, params?: unknown, timeout?: number): Promise<unknown>
  onNotification(listener: (method: string, params: unknown) => void): () => void
  onServerRequest(listener: (request: Record<string, unknown>) => void): () => void
  close(): void
}
export async function validateControlSocket(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0") || path.includes(":") || Buffer.byteLength(path) > 103 || resolve(path) !== path) throw new Error("UNSAFE_SOCKET")
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { throw new Error(error.code === "ENOENT" ? "CONNECT_FAILED" : "UNSAFE_SOCKET") })
  if ( !info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error("UNSAFE_SOCKET")
  // Permit macOS's /var → /private/var alias, while pinning the resolved socket inode.
  const parent = await realpath(dirname(path))
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o022) !== 0) throw new Error("UNSAFE_SOCKET")
  const canonical = resolve(parent, path.slice(path.lastIndexOf("/") + 1))
  const pinned = await lstat(canonical)
  if (Buffer.byteLength(canonical) > 103 || !pinned.isSocket() || pinned.dev !== info.dev || pinned.ino !== info.ino) throw new Error("UNSAFE_SOCKET")
  return canonical
}

/** Connects only to a user-owned Unix socket; never spawns Codex, reads tokens, or starts a daemon. */
export async function connectAppServerSocket(path: string, onClosed: () => void): Promise<ControlRpc> {
  if (process.platform === "win32") throw new Error("UNAVAILABLE")
  const canonical = await validateControlSocket(path)
  const ws = new WebSocket(`ws+unix://${canonical}:/`, { handshakeTimeout: 5000, maxPayload: 1024 * 1024, perMessageDeflate: false })
  const readable = new PassThrough()
  const writable = new Writable({ write(chunk, _encoding, callback) {
    try { if (ws.readyState !== WebSocket.OPEN) throw new Error("closed"); ws.send(chunk.toString().trimEnd()); callback() } catch { callback(new Error("control socket closed")) }
  } })
  const client = new AppServerJsonlClient({ readable, writable, maxLineBytes: 1024 * 1024, requestTimeoutMs: 8000 })
  let closed = false
  const close = () => { if (closed) return; closed = true; client.close(); readable.destroy(); writable.destroy(); ws.terminate(); onClosed() }
  ws.on("message", (data, binary) => {
    if (binary) { close(); return }
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)
    // The transport is one message per frame. Do not allow embedded JSONL frames.
    if (buffer.includes(0x0a) || buffer.includes(0x0d)) { close(); return }
    readable.write(buffer); readable.write("\n")
  })
  ws.on("error", () => close())
  ws.once("close", close)
  try {
    await new Promise<void>((resolveOpen, reject) => {
      ws.once("open", resolveOpen)
      ws.once("error", () => reject(new Error("CONNECT_FAILED")))
      ws.once("close", () => reject(new Error("CONNECT_FAILED")))
    })
    // Experimental turn pagination lets us request only IDs/statuses, never transcript items.
    await client.request("initialize", { clientInfo: { name: "daemonlet_task_control", title: "Daemonlet Task Control", version: "0.6.0" }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta", "turn/diff/updated", "item/plan/delta"] } })
    await client.notify("initialized")
    return { request: (method, params, timeout) => client.request(method, params, timeout), onNotification: listener => client.onNotification(listener), onServerRequest: listener => client.onServerRequest(listener), close }
  } catch { close(); throw new Error("CONNECT_FAILED") }
}
