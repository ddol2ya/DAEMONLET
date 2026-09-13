import { describe, expect, it, vi } from "vitest"
import type { DesktopProtocolApi, ProtocolBridgeStatus } from "../electron/shared/ipc-contract"
import { ElectronIpcProtocolTransport } from "../src/pet/ElectronIpcProtocolTransport"
import { CharacterEventProtocolClient } from "../src/protocol/CharacterEventProtocolClient"

function desktopFixture() {
  const status = new Set<(value: ProtocolBridgeStatus) => void>()
  const messages = new Set<(value: string) => void>()
  const send = vi.fn()
  const api: DesktopProtocolApi = {
    connect: vi.fn(async () => { for (const listener of status) listener({ state: "OPEN" }) }),
    disconnect: vi.fn(async () => {}),
    send,
    onMessage: (listener) => { messages.add(listener); return () => messages.delete(listener) },
    onStatus: (listener) => { status.add(listener); return () => status.delete(listener) },
  }
  return { api, status, messages, send }
}

describe("ElectronIpcProtocolTransport", () => {
  it("connects, sends typed commands, and forwards server frames", async () => {
    const fixture = desktopFixture()
    const transport = new ElectronIpcProtocolTransport(fixture.api)
    const received = vi.fn()
    transport.subscribeMessage(received)
    await transport.connect()
    expect(transport.getStatus().state).toBe("OPEN")
    const command = { protocolVersion: 1 as const, commandType: "snapshot.request" as const, requestId: "request", reason: "initial" as const }
    transport.send(command)
    expect(fixture.send).toHaveBeenCalledWith(command)
    for (const listener of fixture.messages) listener('{"frameType":"hello"}')
    expect(received).toHaveBeenCalledWith('{"frameType":"hello"}')
    transport.dispose()
  })

  it("does not expose or accept an endpoint from the renderer", () => {
    const transport = new ElectronIpcProtocolTransport(desktopFixture().api)
    expect(transport.endpoint).toBe("electron-ipc://codex-adapter/events")
    expect(() => transport.send({ protocolVersion: 1, commandType: "snapshot.request", requestId: "r", reason: "initial" })).toThrow("not open")
    transport.dispose()
  })

  it("does not let a stale rejected invoke overwrite a newer bridge OPEN status", async () => {
    const fixture = desktopFixture()
    let rejectConnect!: (error: Error) => void
    fixture.api.connect = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectConnect = reject }))
    const transport = new ElectronIpcProtocolTransport(fixture.api)
    const pending = transport.connect()
    for (const listener of fixture.status) listener({ state: "CONNECTING" })
    for (const listener of fixture.status) listener({ state: "OPEN" })
    rejectConnect(new DOMException("reconnect", "AbortError"))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(transport.getStatus().state).toBe("OPEN")
    transport.dispose()
  })

  it("clears a bridged connect abort so the protocol client can reconnect", async () => {
    const fixture = desktopFixture()
    let rejectFirst!: (error: Error) => void
    fixture.api.connect = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject }))
      .mockImplementationOnce(async () => { for (const listener of fixture.status) listener({ state: "OPEN" }) })
    const transport = new ElectronIpcProtocolTransport(fixture.api)
    const reconnectTimers: Array<() => void> = []
    const client = new CharacterEventProtocolClient(transport, {
      random: () => 0.5,
      setTimer: ((callback: () => void) => { reconnectTimers.push(callback); return reconnectTimers.length as never }) as never,
      clearTimer: vi.fn(),
    })
    const first = client.connect()
    for (const listener of fixture.status) listener({ state: "CLOSED", reason: "reconnect", manual: false })
    rejectFirst(new DOMException("reconnect", "AbortError"))
    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    expect(client.getDiagnostics().connectionState).toBe("RECONNECTING")
    await expect(client.connect()).resolves.toBeUndefined()
    expect(fixture.api.connect).toHaveBeenCalledTimes(2)
    expect(client.getDiagnostics().connectionState).toBe("HANDSHAKING")
    client.dispose()
  })
})
