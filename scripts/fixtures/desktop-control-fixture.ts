import { createServer, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { windowsDesktopPipe } from "../../electron/shared/desktop-ipc-endpoint.mjs"

/** Synthetic desktop owner for protocol/UI verification; refuses non-fixture homes. */
export async function createDesktopControlFixture(options: { home?: string; fragmented?: boolean } = {}) {
  const home = options.home ?? await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "2dl-desktop-fixture-"))
  if (!home.split(/[\\/]/).some(part => /^2dl-desktop-(fixture|home)-/.test(part))) throw new Error("Desktop fixture requires an isolated test home")
  if (process.platform === "win32" && process.env.ELECTRON_SMOKE_TEST !== "1") throw new Error("Windows fixture requires explicit smoke isolation")
  const ipcDir = join(home, "ipc"), databasePath = join(home, "state_5.sqlite")
  const socketPath = process.platform === "win32" ? windowsDesktopPipe(home, { ELECTRON_SMOKE_TEST: "1" }) : join(ipcDir, "ipc.sock")
  for (const path of [databasePath, socketPath]) if (await access(path).then(() => true, () => false)) throw new Error("Desktop fixture path already exists")
  await mkdir(ipcDir, { recursive: true, mode: 0o700 }); await mkdir(join(home, "sessions"), { recursive: true, mode: 0o700 })
  let owner = randomUUID()
  const ids = [randomUUID(), randomUUID()], turns = [randomUUID(), randomUUID()]
  const owned = new Set<string>(ids), states = new Map<string, any>(), revisions = new Map<string, number>(), sockets = new Map<Socket, { id: string; follows: Set<string> }>()
  const calls: Array<{ method: string; params: any; targetClientId?: string }> = [], discoveryReplies: unknown[] = []
  const paths: string[] = []
  const withheldSnapshots = new Set<string>()
  const db = new DatabaseSync(databasePath)
  try {
    db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, source TEXT, updated_at INTEGER, archived INTEGER, first_user_message TEXT, preview TEXT)")
    for (const [index, id] of ids.entries()) {
      const path = join(home, "sessions", `rollout-desktop-${id}.jsonl`); paths.push(path)
      await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id, source: "vscode" } })}\n`, { mode: 0o600 })
      db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, path, `/synthetic/desktop-${index + 1}`, `데스크톱 작업 ${index + 1}`, null, "vscode", Date.now() / 1000 - index, 0, "PRIVATE_TRANSCRIPT_CANARY", "PRIVATE_PREVIEW_CANARY")
      states.set(id, { id, title: `데스크톱 작업 ${index + 1}`, cwd: `/synthetic/desktop-${index + 1}`, threadRuntimeStatus: { type: index === 0 ? "active" : "idle", activeFlags: [] }, requests: [], turns: [{ turnId: turns[index], status: index === 0 ? "inProgress" : "completed", turnStartedAtMs: Date.now(), params: { input: [{ text: "PRIVATE_TRANSCRIPT_CANARY" }] }, items: [{ type: "agentMessage", text: "PRIVATE_TRANSCRIPT_CANARY" }] }] })
      revisions.set(id, 1)
    }
  } finally { db.close() }
  const send = (socket: Socket, value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32LE(body.length); body.copy(frame, 4)
    if (options.fragmented) { socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2, 7)); socket.write(frame.subarray(7)) }
    else socket.write(frame)
  }
  let afterNextSnapshot: ((id: string) => void) | null = null
  const snapshot = (socket: Socket, id: string) => {
    const client = sockets.get(socket)
    if (!client || !owned.has(id) || withheldSnapshots.has(id)) return
    send(socket, { type: "broadcast", sourceClientId: owner, targetClientIds: [client.id], method: "thread-stream-state-changed", version: 11, params: { hostId: "local", conversationId: id, change: { type: "snapshot", revision: revisions.get(id), conversationState: states.get(id) } } })
    const after = afterNextSnapshot; afterNextSnapshot = null; after?.(id)
  }
  const broadcastState = (id: string) => { revisions.set(id, (revisions.get(id) ?? 0) + 1); for (const [socket, client] of sockets) if (client.follows.has(id)) snapshot(socket, id) }
  const server = createServer(socket => {
    const client = { id: randomUUID(), follows: new Set<string>() }; sockets.set(socket, client)
    let buffer = Buffer.alloc(0)
    socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket))
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (length > 256 * 1024) { socket.destroy(); return }
        if (buffer.length < length + 4) return
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString()); buffer = buffer.subarray(4 + length)
        if (message.type === "client-discovery-response") { discoveryReplies.push(message.response); continue }
        if (message.type === "broadcast") {
          if (message.method === "thread-stream-following-changed" && message.version === 1 && message.targetClientIds?.[0] === owner) {
            const id = message.params.conversationId
            if (message.params.following) { client.follows.add(id); snapshot(socket, id) } else client.follows.delete(id)
          }
          continue
        }
        if (message.type !== "request") continue
        const { method, params = {} } = message
        calls.push({ method, params, targetClientId: message.targetClientId })
        const ok = (result: unknown) => send(socket, { type: "response", requestId: message.requestId, method, resultType: "success", handledByClientId: method === "initialize" ? client.id : owner, result })
        const error = (value: string) => send(socket, { type: "response", requestId: message.requestId, resultType: "error", error: value })
        if (method === "initialize") { ok({ clientId: client.id }); continue }
        const id = params.conversationId
        if (!owned.has(id) || message.targetClientId && message.targetClientId !== owner) { error("no-client-found"); continue }
        if (method === "thread-owner-discovery" && message.version === 1 && params.hostId === "local") { ok({ supportsUntrustedAppInput: true }); continue }
        const state = states.get(id), turn = state.turns.at(-1)
        if (method === "thread-follower-interrupt-turn" && message.version === 4 && params.expectedTurnId === turn.turnId && params.mode === "user-stop") {
          turn.status = "interrupted"; state.threadRuntimeStatus = { type: "idle", activeFlags: [] }; state.requests = []; broadcastState(id); ok({ ok: true, interruptedTurnId: turn.turnId }); continue
        }
        if (method === "thread-follower-steer-turn" && message.version === 1 && state.threadRuntimeStatus.type === "active" && params.restoreMessage?.context?.prompt === params.input?.[0]?.text) { ok({ result: { turnId: turn.turnId } }); continue }
        if (method === "thread-follower-start-turn" && message.version === 2 && state.threadRuntimeStatus.type === "idle" && params.turnStart?.request?.threadId === id && params.turnStart?.context?.inheritThreadSettings === true) {
          const next = { turnId: randomUUID(), status: "inProgress", turnStartedAtMs: Date.now() }; state.turns.push(next); state.threadRuntimeStatus = { type: "active", activeFlags: [] }; broadcastState(id); ok({ result: { turn: { id: next.turnId, status: next.status } } }); continue
        }
        error("invalid-follower-request")
      }
    })
  })
  const cleanFiles = async () => {
    if (!options.home) await rm(home, { recursive: true, force: true })
    else { for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, ...paths]) await rm(path, { force: true }); await rm(ipcDir, { recursive: true, force: true }) }
  }
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve) }); if (process.platform !== "win32") await chmod(socketPath, 0o600) }
  catch (error) { server.close(); await cleanFiles(); throw error }
  return {
    home, socketPath, ids, get owner() { return owner }, turns, states, calls, discoveryReplies, owned,
    withholdSnapshots(id: string, withhold: boolean) { if (withhold) withheldSnapshots.add(id); else withheldSnapshots.delete(id) },
    changeOwner() {
      const old = owner; owner = randomUUID()
      for (const id of ids) revisions.set(id, 0)
      for (const socket of sockets.keys()) send(socket, { type: "broadcast", method: "client-status-changed", version: 0, params: { clientId: old, status: "disconnected" } })
      return old
    },
    broadcastState,
    afterNextSnapshot: (callback: (id: string) => void) => { afterNextSnapshot = callback },
    clientCount: () => sockets.size,
    sendToClients: (message: unknown) => { for (const socket of sockets.keys()) send(socket, message) },
    dropConnections: () => { for (const socket of sockets.keys()) socket.destroy() },
    async pauseBroker() {
      for (const socket of sockets.keys()) socket.destroy()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    },
    async resumeBroker() {
      if (server.listening) return
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve) })
      if (process.platform !== "win32") await chmod(socketPath, 0o600)
    },
    async close() {
      for (const socket of sockets.keys()) socket.destroy()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      await cleanFiles()
    },
  }
}
