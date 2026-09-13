import { createServer } from "node:net"
import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"

/** A connected, empty desktop for isolated visual QA. It cannot own or run tasks. */
export async function startSmokeDesktopPresence(home) {
  const directory = join(home, "ipc"), sockets = new Set()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let buffer = Buffer.alloc(0)
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 128 * 1024) { socket.destroy(); return }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0)
        if (size > 128 * 1024) { socket.destroy(); return }
        if (buffer.length < size + 4) return
        let request
        try { request = JSON.parse(buffer.subarray(4, size + 4).toString()) } catch { socket.destroy(); return }
        buffer = buffer.subarray(size + 4)
        if (request.type !== "request") continue
        const response = request.method === "initialize"
          ? { type: "response", requestId: request.requestId, method: "initialize", handledByClientId: "smoke-presence", resultType: "success", result: { clientId: "smoke-follower" } }
          : { type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" }
        const body = Buffer.from(JSON.stringify(response)), frame = Buffer.alloc(4 + body.length)
        frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame)
      }
    })
  })
  const path = join(directory, "ipc.sock")
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve) })
  await chmod(path, 0o600)
  return async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
}
