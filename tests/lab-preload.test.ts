import { describe, expect, it, vi } from "vitest"
import { IPC } from "../electron/shared/ipc-contract"

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async (channel: string): Promise<unknown> => channel === IPC.protocolConnect ? { ok: true } : undefined),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, send: mocks.send, on: mocks.on, removeListener: mocks.removeListener },
}))

describe("Motion Lab preload", () => {
  it("exposes platform, typed protocol and read/select character APIs", async () => {
    await import("../electron/preload/lab-preload")
    expect(mocks.exposeInMainWorld.mock.calls.map(([name]) => name).sort()).toEqual(["appLanguage", "motionLabDesktop"])
    const [name, api] = mocks.exposeInMainWorld.mock.calls.find(([name]) => name === "motionLabDesktop")! as [string, Record<string, unknown>]
    expect(name).toBe("motionLabDesktop")
    expect(Object.keys(api).sort()).toEqual(["characters", "platform", "protocol"])
    expect(Object.keys(api.protocol as object).sort()).toEqual(["connect", "disconnect", "onMessage", "onStatus", "send"])
    expect(api).not.toHaveProperty("getSettings")
    expect(Object.keys(api.characters as object).sort()).toEqual(["list", "onChanged", "select"])
    expect(api).not.toHaveProperty("ipcRenderer")
    const protocol = api.protocol as { connect(): Promise<void>; disconnect(): Promise<void>; send(value: unknown): void }
    await protocol.connect()
    await protocol.disconnect()
    protocol.send({ protocolVersion: 1, commandType: "snapshot.request", requestId: "r", reason: "initial" })
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.protocolConnect)
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.protocolDisconnect)
    expect(mocks.send).toHaveBeenCalledWith(IPC.protocolSend, expect.not.objectContaining({ endpoint: expect.anything() }))
    mocks.invoke.mockResolvedValueOnce({ ok: false, name: "AbortError", message: "reconnect" })
    await expect(protocol.connect()).rejects.toMatchObject({ name: "AbortError", message: "reconnect" })
  })
})
