import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import type { WebContents } from "electron"
import { ProtocolBridge } from "../electron/main/ProtocolBridge"
import { IPC } from "../electron/shared/ipc-contract"

const servers: WebSocketServer[] = []
const bridges: ProtocolBridge[] = []
afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

class FakeSender extends EventEmitter {
  readonly send = vi.fn()
  destroyed = false
  constructor(readonly id: number) { super() }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit("destroyed") }
}

class FakeSocket extends EventEmitter {
  readyState = 0
  readonly send = vi.fn()
  readonly close = vi.fn(() => { this.readyState = 2 })
  open() { this.readyState = 1; this.emit("open") }
  fail(message = "socket failed") { this.emit("error", new Error(message)) }
  closed(code = 1006, reason = "closed") { this.readyState = 3; this.emit("close", code, Buffer.from(reason)) }
}

function lifecycleFixture() {
  const sockets: FakeSocket[] = []
  const bridge = new ProtocolBridge("ws://127.0.0.1:4174/events", {
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as never },
  })
  bridges.push(bridge)
  return { bridge, sockets }
}

async function fixture() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/events" })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject) })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing address")
  const bridge = new ProtocolBridge(`ws://127.0.0.1:${address.port}/events`)
  bridges.push(bridge)
  return { server, bridge }
}

describe("ProtocolBridge", () => {
  it("maintains one independent socket per renderer and forwards frames", async () => {
    const { server, bridge } = await fixture()
    const one = new FakeSender(1)
    const two = new FakeSender(2)
    await Promise.all([bridge.connect(one as unknown as WebContents), bridge.connect(two as unknown as WebContents)])
    expect(server.clients.size).toBe(2)
    for (const socket of server.clients) socket.send('{"frameType":"hello"}')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(one.send).toHaveBeenCalledWith(IPC.protocolMessage, '{"frameType":"hello"}')
    expect(two.send).toHaveBeenCalledWith(IPC.protocolMessage, '{"frameType":"hello"}')
    expect(bridge.clientCount).toBe(2)
  })

  it("validates client commands and cleans up destroyed renderers", async () => {
    const { server, bridge } = await fixture()
    const sender = new FakeSender(3)
    let socket!: WebSocket
    server.once("connection", (value) => { socket = value })
    await bridge.connect(sender as unknown as WebContents)
    const received = new Promise<string>((resolve) => socket.once("message", (data) => resolve(data.toString())))
    bridge.send(sender.id, { protocolVersion: 1, commandType: "client.hello", requestId: "r", clientId: "pet", supportedProtocolVersions: [1] })
    expect(JSON.parse(await received)).toMatchObject({ commandType: "client.hello", clientId: "pet" })
    expect(() => bridge.send(sender.id, { protocolVersion: 1, commandType: "server.inject", requestId: "r" })).toThrow("invalid")
    sender.destroy()
    expect(bridge.clientCount).toBe(0)
  })

  it("rejects non-loopback endpoints", () => {
    expect(() => new ProtocolBridge("wss://example.com/events")).toThrow("loopback")
  })

  it("aborts a CONNECTING attempt on disconnect and allows retry", async () => {
    const { bridge, sockets } = lifecycleFixture()
    const sender = new FakeSender(4)
    const pending = bridge.connect(sender as unknown as WebContents)
    bridge.disconnect(sender.id, "manual disconnect")
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "manual disconnect" })
    expect(sockets[0].close).toHaveBeenCalledOnce()
    const retried = bridge.connect(sender as unknown as WebContents)
    sockets[1].open()
    await expect(retried).resolves.toBeUndefined()
  })

  it("aborts without sending to a destroyed renderer", async () => {
    const { bridge } = lifecycleFixture()
    const sender = new FakeSender(5)
    const pending = bridge.connect(sender as unknown as WebContents)
    sender.destroy()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(bridge.clientCount).toBe(0)
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.listenerCount("destroyed")).toBe(0)
  })

  it("reconnects while CONNECTING and ignores the old socket close", async () => {
    const { bridge, sockets } = lifecycleFixture()
    const sender = new FakeSender(6)
    const first = bridge.connect(sender as unknown as WebContents)
    bridge.reconnectAll()
    await expect(first).rejects.toMatchObject({ name: "AbortError", message: "reconnect" })
    sockets[1].open()
    await vi.waitFor(() => expect(bridge.openClientCount).toBe(1))
    sockets[0].closed()
    const statuses = sender.send.mock.calls.filter(([channel]) => channel === IPC.protocolStatus).map(([, value]) => value.state)
    expect(statuses.at(-1)).toBe("OPEN")
    expect(bridge.openClientCount).toBe(1)
  })

  it("rejects close-before-open and permits a later connection", async () => {
    const { bridge, sockets } = lifecycleFixture()
    const sender = new FakeSender(7)
    const first = bridge.connect(sender as unknown as WebContents)
    sockets[0].closed(1006, "handshake closed")
    await expect(first).rejects.toThrow("handshake closed")
    expect(bridge.clientCount).toBe(0)
    const second = bridge.connect(sender as unknown as WebContents)
    sockets[1].open()
    await expect(second).resolves.toBeUndefined()
  })

  it("settles once for error followed by close", async () => {
    const { bridge, sockets } = lifecycleFixture()
    const sender = new FakeSender(8)
    const pending = bridge.connect(sender as unknown as WebContents)
    sockets[0].fail("dial failed")
    sockets[0].closed(1006, "dial failed")
    await expect(pending).rejects.toThrow("dial failed")
    const statuses = sender.send.mock.calls.filter(([channel]) => channel === IPC.protocolStatus).map(([, value]) => value.state)
    expect(statuses.filter((state) => state === "ERROR")).toHaveLength(1)
    expect(statuses.filter((state) => state === "CLOSED")).toHaveLength(1)
  })

  it("rejects every CONNECTING attempt on dispose and removes listeners", async () => {
    const { bridge } = lifecycleFixture()
    const one = new FakeSender(9)
    const two = new FakeSender(10)
    const pending = [bridge.connect(one as unknown as WebContents), bridge.connect(two as unknown as WebContents)]
    bridge.dispose()
    await Promise.all(pending.map((attempt) => expect(attempt).rejects.toMatchObject({ name: "AbortError" })))
    expect(bridge.clientCount).toBe(0)
    expect(one.listenerCount("destroyed")).toBe(0)
    expect(two.listenerCount("destroyed")).toBe(0)
  })
})
