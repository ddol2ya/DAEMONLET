import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import type { ProtocolDomainEvent, ProtocolRunSnapshot } from "../src/protocol/types.ts"
import { isLoopbackRemoteAddress, ProtocolSourceServer, type ProtocolSourceStateProvider } from "../adapter/codex/protocol/ProtocolSourceServer.ts"

class Provider implements ProtocolSourceStateProvider {
  listeners = new Set<(event: ProtocolDomainEvent) => void>()
  snapshot: ProtocolRunSnapshot[] = [{ runId: "run", tasks: [] }]
  getSnapshot() { return this.snapshot }
  subscribe(listener: (event: ProtocolDomainEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event: ProtocolDomainEvent) { for (const listener of this.listeners) listener(event) }
}

const servers: ProtocolSourceServer[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

const connect = async (url: string, origin?: string) => {
  const socket = new WebSocket(url, origin === undefined ? undefined : { origin })
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
  return socket
}
const rejectedStatus = async (url: string, origin?: string) => {
  const socket = new WebSocket(url, origin === undefined ? undefined : { origin })
  sockets.push(socket)
  return new Promise<number>((resolve, reject) => {
    let rejected = false
    socket.once("unexpected-response", (_request, response) => {
      rejected = true
      const status = response.statusCode ?? 0
      response.resume()
      resolve(status)
    })
    socket.once("open", () => reject(new Error("unexpected WebSocket connection")))
    socket.once("error", (error) => { if (!rejected) reject(error) })
  })
}
const closeResult = (socket: WebSocket) => new Promise<{ code: number; reason: string }>((resolve) => {
  socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
})
const collect = (socket: WebSocket) => {
  const frames: Array<Record<string, unknown>> = []
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())))
  return frames
}
const waitFor = async (predicate: () => boolean) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error("timed out waiting for frame")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("ProtocolSourceServer", () => {
  it("serves hello, events, heartbeats, and broadcasts a sequenced snapshot to every client", async () => {
    const provider = new Provider()
    const server = new ProtocolSourceServer({ provider, port: 0, heartbeatIntervalMs: 1_000, sourceInstanceId: "instance", sessionId: "session" })
    servers.push(server)
    await server.start()
    const a = await connect(server.endpoint)
    const b = await connect(server.endpoint)
    const framesA = collect(a)
    const framesB = collect(b)
    a.send(JSON.stringify({ protocolVersion: 1, commandType: "client.hello", requestId: "hello-a", clientId: "a", supportedProtocolVersions: [1] }))
    b.send(JSON.stringify({ protocolVersion: 1, commandType: "client.hello", requestId: "hello-b", clientId: "b", supportedProtocolVersions: [1] }))
    await waitFor(() => framesA.some((frame) => frame.frameType === "hello") && framesB.some((frame) => frame.frameType === "hello"))
    a.send(JSON.stringify({ protocolVersion: 1, commandType: "snapshot.request", requestId: "snapshot-a", reason: "manual" }))
    await waitFor(() => framesA.some((frame) => frame.frameType === "snapshot") && framesB.some((frame) => frame.frameType === "snapshot"))
    const snapshotA = framesA.find((frame) => frame.frameType === "snapshot")
    const snapshotB = framesB.find((frame) => frame.frameType === "snapshot")
    expect(snapshotA?.sequence).toBe(snapshotB?.sequence)
    provider.emit({ type: "run.started", runId: "run-2" })
    await waitFor(() => framesA.some((frame) => frame.frameType === "event") && framesB.some((frame) => frame.frameType === "event"))
    const event = framesA.find((frame) => frame.frameType === "event")
    expect(event?.sequence).toBe(Number(snapshotA?.sequence) + 1)
    expect(server.clientCount).toBe(2)
  })

  it("refuses non-loopback binds", () => {
    expect(() => new ProtocolSourceServer({ provider: new Provider(), host: "0.0.0.0" })).toThrow("127.0.0.1")
  })

  it("allows only the browser origin allowlist while preserving no-Origin native clients", async () => {
    const server = new ProtocolSourceServer({ provider: new Provider(), port: 0 })
    servers.push(server)
    await server.start()
    await connect(server.endpoint, "http://127.0.0.1:4173")
    await connect(server.endpoint, "http://localhost:4173")
    await connect(server.endpoint)
    expect(server.clientCount).toBe(3)
    for (const origin of ["https://evil.example", "http://example.com", "null", "file://"]) {
      expect(await rejectedStatus(server.endpoint, origin)).toBe(403)
    }
    expect(server.clientCount).toBe(3)
  })

  it("recognizes only loopback remote-address representations", () => {
    for (const address of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "::ffff:127.0.0.1", "::ffff:127.0.0.2"]) expect(isLoopbackRemoteAddress(address)).toBe(true)
    for (const address of [undefined, "0.0.0.0", "126.255.255.255", "128.0.0.1", "192.0.2.1", "::ffff:192.0.2.1"]) expect(isLoopbackRemoteAddress(address)).toBe(false)
  })

  it("allows a no-Origin native client from another IPv4 loopback address", async () => {
    const server = new ProtocolSourceServer({ provider: new Provider(), port: 0 })
    servers.push(server)
    await server.start()
    const socket = new WebSocket(server.endpoint, { localAddress: "127.0.0.2" })
    sockets.push(socket)
    try {
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRNOTAVAIL") return
      throw error
    }
    expect(server.clientCount).toBe(1)
  })

  it("rejects excess clients at the handshake and releases bounded client state on close", async () => {
    const server = new ProtocolSourceServer({ provider: new Provider(), port: 0, maxClients: 1 })
    servers.push(server)
    await server.start()
    const first = await connect(server.endpoint)
    expect(server.trackedClientCount).toBe(1)
    expect(await rejectedStatus(server.endpoint)).toBe(403)
    expect(server.clientCount).toBe(1)
    const closed = closeResult(first)
    first.close()
    await closed
    await waitFor(() => server.trackedClientCount === 0)
    await connect(server.endpoint)
    expect(server.clientCount).toBe(1)
    expect(() => new ProtocolSourceServer({ provider: new Provider(), maxClients: 33 })).toThrow("1 through 32")
  })

  it("closes a ready client that sends a second hello", async () => {
    const server = new ProtocolSourceServer({ provider: new Provider(), port: 0 })
    servers.push(server)
    await server.start()
    const socket = await connect(server.endpoint)
    const frames = collect(socket)
    const hello = { protocolVersion: 1, commandType: "client.hello", requestId: "hello", clientId: "client", supportedProtocolVersions: [1] }
    socket.send(JSON.stringify(hello))
    await waitFor(() => frames.some((frame) => frame.frameType === "hello"))
    const closed = closeResult(socket)
    socket.send(JSON.stringify({ ...hello, requestId: "hello-again" }))
    expect(await closed).toEqual({ code: 1008, reason: "client hello already received" })
  })

  it("broadcasts normal snapshots and closes snapshot bursts", async () => {
    const server = new ProtocolSourceServer({ provider: new Provider(), port: 0 })
    servers.push(server)
    await server.start()
    const socket = await connect(server.endpoint)
    const frames = collect(socket)
    socket.send(JSON.stringify({ protocolVersion: 1, commandType: "client.hello", requestId: "hello", clientId: "client", supportedProtocolVersions: [1] }))
    await waitFor(() => frames.some((frame) => frame.frameType === "hello"))
    socket.send(JSON.stringify({ protocolVersion: 1, commandType: "snapshot.request", requestId: "snapshot-invalid", reason: ["manual"] }))
    socket.send(JSON.stringify({ protocolVersion: 1, commandType: "client.ping", requestId: "ping-after-invalid", sentAt: 1 }))
    await waitFor(() => frames.some((frame) => frame.frameType === "heartbeat" && (frame.payload as { heartbeatId?: string }).heartbeatId === "ping-after-invalid"))
    expect(frames.some((frame) => frame.frameType === "snapshot")).toBe(false)
    socket.send(JSON.stringify({ protocolVersion: 1, commandType: "snapshot.request", requestId: "snapshot-normal", reason: "sequence-gap" }))
    await waitFor(() => frames.some((frame) => frame.frameType === "snapshot"))
    const closed = closeResult(socket)
    for (let index = 0; index < 5; index++) {
      socket.send(JSON.stringify({ protocolVersion: 1, commandType: "snapshot.request", requestId: `snapshot-${index}`, reason: "manual" }))
    }
    expect(await closed).toEqual({ code: 1008, reason: "snapshot rate limit" })
  })

  it("closes malformed and otherwise invalid command floods", async () => {
    const server = new ProtocolSourceServer({ provider: new Provider(), port: 0 })
    servers.push(server)
    await server.start()
    const socket = await connect(server.endpoint)
    const closed = closeResult(socket)
    for (let index = 0; index < 10; index++) socket.send(index % 2 === 0 ? "{" : JSON.stringify({ protocolVersion: 1, commandType: "unknown", requestId: `invalid-${index}` }))
    expect(await closed).toEqual({ code: 1008, reason: "invalid command limit" })
  })

  it("uses a rolling invalid-command window across the connection-time boundary", async () => {
    const server = new ProtocolSourceServer({ provider: new Provider(), port: 0 })
    servers.push(server)
    await server.start()
    const socket = await connect(server.endpoint)
    const frames = collect(socket)
    socket.send(JSON.stringify({ protocolVersion: 1, commandType: "client.hello", requestId: "hello", clientId: "client", supportedProtocolVersions: [1] }))
    await waitFor(() => frames.some((frame) => frame.frameType === "hello"))
    const base = Date.now()
    const now = vi.spyOn(Date, "now")
    try {
      now.mockReturnValue(base + 9_999)
      for (let index = 0; index < 9; index++) socket.send("{")
      socket.send(JSON.stringify({ protocolVersion: 1, commandType: "client.ping", requestId: "boundary-ping", sentAt: 1 }))
      await waitFor(() => frames.some((frame) => frame.frameType === "heartbeat" && (frame.payload as { heartbeatId?: string }).heartbeatId === "boundary-ping"))
      now.mockReturnValue(base + 10_001)
      const closed = closeResult(socket)
      socket.send("{")
      expect(await closed).toEqual({ code: 1008, reason: "invalid command limit" })
    } finally {
      now.mockRestore()
    }
  })
})
