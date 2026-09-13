import { describe, expect, it, vi } from "vitest"
import { WebSocketProtocolTransport } from "../src/protocol/transports/WebSocketProtocolTransport"

class FakeSocket {
  readyState = 0
  binaryType: BinaryType = "blob"
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  close = vi.fn((code = 1000, reason = "") => {
    this.readyState = 3
    this.onclose?.({ code, reason } as CloseEvent)
  })
  send(data: string) { this.sent.push(data) }
  open() { this.readyState = 1; this.onopen?.(new Event("open")) }
  message(data: string | ArrayBuffer) { this.onmessage?.({ data } as MessageEvent) }
  error() { this.onerror?.(new Event("error")) }
  unexpectedClose() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "lost" } as CloseEvent) }
}

describe("WebSocketProtocolTransport", () => {
  it("connects once, sends only while open, and distinguishes manual close", async () => {
    const sockets: FakeSocket[] = []
    const transport = new WebSocketProtocolTransport(undefined, { factory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket } })
    const statuses: string[] = []
    transport.subscribeStatus((status) => statuses.push(`${status.state}:${status.manual ?? ""}`))
    const first = transport.connect()
    const second = transport.connect()
    expect(first).toBe(second)
    expect(sockets).toHaveLength(1)
    expect(() => transport.send({ protocolVersion: 1, commandType: "client.ping", requestId: "r", sentAt: 0 })).toThrow("not open")
    sockets[0].open()
    await first
    transport.send({ protocolVersion: 1, commandType: "client.ping", requestId: "r", sentAt: 0 })
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ commandType: "client.ping" })
    transport.disconnect("done")
    expect(statuses.at(-1)).toBe("CLOSED:true")
  })

  it("ignores stale socket callbacks and forwards text/binary policy to the client", async () => {
    const sockets: FakeSocket[] = []
    const transport = new WebSocketProtocolTransport(undefined, { factory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket } })
    const messages = vi.fn()
    const statuses = vi.fn()
    transport.subscribeMessage(messages)
    transport.subscribeStatus(statuses)
    const connecting = transport.connect()
    sockets[0].open()
    await connecting
    sockets[0].message("hello")
    sockets[0].message(new ArrayBuffer(2))
    expect(messages).toHaveBeenCalledTimes(2)
    transport.disconnect()
    sockets[0].message("stale")
    expect(messages).toHaveBeenCalledTimes(2)
  })

  it("reports an unexpected close and rejects remote endpoints by default", async () => {
    expect(() => new WebSocketProtocolTransport("ws://example.com/events")).toThrow("remote WebSocket endpoints are disabled")
    const socket = new FakeSocket()
    const transport = new WebSocketProtocolTransport("ws://localhost:4174/events", { factory: () => socket })
    const listener = vi.fn()
    transport.subscribeStatus(listener)
    const connecting = transport.connect()
    socket.open()
    await connecting
    socket.unexpectedClose()
    expect(listener).toHaveBeenLastCalledWith({ state: "CLOSED", reason: "lost", manual: false })
  })

  it("rejects a CONNECTING attempt with AbortError on disconnect and permits a fresh retry", async () => {
    const sockets: FakeSocket[] = []
    const transport = new WebSocketProtocolTransport(undefined, { factory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket } })
    const first = transport.connect()
    const staleOpen = sockets[0].onopen
    const staleClose = sockets[0].onclose
    const staleMessage = sockets[0].onmessage

    transport.disconnect("user cancelled")
    await expect(first).rejects.toMatchObject({ name: "AbortError", message: "user cancelled" })
    expect(transport.getStatus()).toEqual({ state: "CLOSED", reason: "user cancelled", manual: true })
    expect(sockets[0].close).toHaveBeenCalledOnce()

    staleOpen?.(new Event("open"))
    staleMessage?.({ data: "stale" } as MessageEvent)
    staleClose?.({ code: 1006, reason: "stale close" } as CloseEvent)
    expect(transport.getStatus()).toEqual({ state: "CLOSED", reason: "user cancelled", manual: true })

    const second = transport.connect()
    expect(sockets).toHaveLength(2)
    sockets[1].open()
    await expect(second).resolves.toBeUndefined()
    expect(transport.getStatus()).toEqual({ state: "OPEN" })
  })

  it("rejects and closes an in-flight attempt on dispose, then refuses future connects", async () => {
    const socket = new FakeSocket()
    const transport = new WebSocketProtocolTransport(undefined, { factory: () => socket })
    const messages = vi.fn()
    const statuses = vi.fn()
    transport.subscribeMessage(messages)
    transport.subscribeStatus(statuses)
    const connecting = transport.connect()
    const staleMessage = socket.onmessage
    transport.dispose()

    await expect(connecting).rejects.toMatchObject({ name: "AbortError", message: "transport disposed" })
    expect(socket.close).toHaveBeenCalledOnce()
    staleMessage?.({ data: "stale" } as MessageEvent)
    expect(messages).not.toHaveBeenCalled()
    await expect(transport.connect()).rejects.toThrow("transport is disposed")
  })

  it("clears a factory failure so a later connect creates a new socket", async () => {
    const socket = new FakeSocket()
    let attempts = 0
    const transport = new WebSocketProtocolTransport(undefined, { factory: () => {
      attempts++
      if (attempts === 1) throw new Error("factory failed")
      return socket
    } })

    await expect(transport.connect()).rejects.toThrow("factory failed")
    expect(transport.getStatus()).toEqual({ state: "ERROR", reason: "factory failed" })
    const retry = transport.connect()
    socket.open()
    await expect(retry).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it("settles exactly once when error is followed by close and leaves a retry path", async () => {
    const sockets: FakeSocket[] = []
    const transport = new WebSocketProtocolTransport(undefined, { factory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket } })
    const statuses: string[] = []
    transport.subscribeStatus((status) => statuses.push(status.state))
    const connecting = transport.connect()
    const staleClose = sockets[0].onclose
    sockets[0].error()

    await expect(connecting).rejects.toThrow("WebSocket connection error")
    staleClose?.({ code: 1006, reason: "late close" } as CloseEvent)
    expect(statuses.filter((state) => state === "ERROR")).toHaveLength(1)
    expect(statuses.filter((state) => state === "CLOSED")).toHaveLength(1)
    expect(transport.getStatus()).toEqual({ state: "CLOSED", reason: "WebSocket connection error", manual: false })

    const retry = transport.connect()
    sockets[1].open()
    await expect(retry).resolves.toBeUndefined()
  })

  it("turns an OPEN-socket error into one unexpected close flow", async () => {
    const socket = new FakeSocket()
    const transport = new WebSocketProtocolTransport(undefined, { factory: () => socket })
    const statuses: string[] = []
    transport.subscribeStatus((status) => statuses.push(status.state))
    const connecting = transport.connect()
    socket.open()
    await connecting
    const staleClose = socket.onclose
    socket.error()
    staleClose?.({ code: 1006, reason: "late close" } as CloseEvent)
    expect(statuses.slice(-2)).toEqual(["ERROR", "CLOSED"])
    expect(statuses.filter((state) => state === "CLOSED")).toHaveLength(1)
  })
})
