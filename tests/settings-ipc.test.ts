import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsIpcController } from "../electron/main/SettingsIpcController"
import type { SettingsWindowController } from "../electron/main/SettingsWindowController"
import type { CodexIntegrationController } from "../electron/main/CodexIntegrationController"
import { SETUP_IPC } from "../electron/shared/codex-integration-contract"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }))
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => mocks.handlers.set(channel, handler), removeHandler: (channel: string) => mocks.handlers.delete(channel) },
  dialog: { showOpenDialog: mocks.showOpenDialog, showSaveDialog: mocks.showSaveDialog },
  BrowserWindow: class {},
}))
const controllers: SettingsIpcController[] = []
beforeEach(() => { mocks.handlers.clear(); mocks.showOpenDialog.mockReset(); mocks.showSaveDialog.mockReset() })
afterEach(() => { controllers.splice(0).forEach((value) => value.dispose()) })

function fixture() {
  const frame = { url: "pet://app/settings.html" }, contents = { id: 7, mainFrame: frame } as WebContents
  const win = { isDestroyed: () => false, webContents: contents } as BrowserWindow
  const owner = "window-7:main-frame"
  const window = { window: win, currentOwner: () => owner, send: vi.fn() } as unknown as SettingsWindowController
  const integration = {
    getStatus: vi.fn(() => ({ step: "unknown" })), refresh: vi.fn(async () => ({ step: "unknown" })), prepareConnection: vi.fn(async () => ({ step: "prepared" })),
    selectExecutable: vi.fn(async () => ({})), selectHome: vi.fn(async () => ({})),
    planHooks: vi.fn(async () => ({ planId: "11111111-1111-4111-8111-111111111111" })), applyHookPlan: vi.fn(async () => ({ status: "applied" })), discardHookPlan: vi.fn(),
    runHostSelfTest: vi.fn(), reportHookReview: vi.fn(), startLiveObservation: vi.fn(), stopLiveObservation: vi.fn(), reportDesktopStopAttempt: vi.fn(), dismissOnboarding: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  }
  const patch = vi.fn(() => defaultDesktopSettings())
  const controller = new SettingsIpcController({ window, integration: integration as unknown as CodexIntegrationController, getSettings: defaultDesktopSettings, updateSettings: patch, resetPosition: vi.fn(), restartAdapter: vi.fn(async () => ({ restarted: false })) })
  controllers.push(controller)
  controller.register()
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  const invoke = (channel: string, args: unknown[] = [], sender = event) => mocks.handlers.get(channel)!(sender, ...args)
  return { frame, contents, window, owner, integration, controller, event, invoke, patch }
}

describe("Settings IPC authority and privacy", () => {
  it("rejects Pet, Lab, another webContents, same-URL subframes and modified URLs for every setup action", async () => {
    const f = fixture()
    const channels = [...mocks.handlers.keys()]
    for (const sender of [
      { sender: f.contents, senderFrame: { url: "pet://app/settings.html" } },
      { sender: { id: 9 } as WebContents, senderFrame: f.frame },
      { sender: f.contents, senderFrame: { url: "pet://app/pet.html" } },
      { sender: f.contents, senderFrame: { url: "pet://app/index.html" } },
      { sender: f.contents, senderFrame: null },
    ]) for (const channel of channels) expect(await f.invoke(channel, [], sender as IpcMainInvokeEvent)).toEqual({ ok: false, code: "UNTRUSTED_SENDER" })
    f.frame.url += "?smoke=1"
    expect(await f.invoke(SETUP_IPC.status)).toEqual({ ok: false, code: "UNTRUSTED_SENDER" })
    expect(f.integration.applyHookPlan).not.toHaveBeenCalled()
    expect(mocks.showOpenDialog).not.toHaveBeenCalled()
  })
  it("accepts only an action or plan ID; renderer-provided paths, after-images and commands cannot be applied", async () => {
    const f = fixture()
    expect(await f.invoke(SETUP_IPC.plan, ["install"])).toMatchObject({ ok: true })
    expect(f.integration.planHooks).toHaveBeenCalledWith("install", f.owner)
    const id = "11111111-1111-4111-8111-111111111111"
    expect(await f.invoke(SETUP_IPC.apply, [id, { after: "PRIVATE_CANARY", path: "/private/file", command: "execute" }])).toEqual({ ok: false, code: "INVALID_REQUEST" })
    expect(await f.invoke(SETUP_IPC.apply, [{ planId: id, after: "PRIVATE_CANARY" }])).toMatchObject({ ok: false })
    expect(await f.invoke(SETUP_IPC.chooseHome, ["/arbitrary/home"])).toEqual({ ok: false, code: "INVALID_REQUEST" })
    expect(await f.invoke(SETUP_IPC.chooseExecutable, ["/arbitrary/command"])).toEqual({ ok: false, code: "INVALID_REQUEST" })
    expect(await f.invoke(SETUP_IPC.apply, [id])).toMatchObject({ ok: true })
    expect(f.integration.applyHookPlan).toHaveBeenCalledExactlyOnceWith(id, f.owner)
    expect(mocks.showOpenDialog).not.toHaveBeenCalled()
  })
  it("prepares using only the trusted settings owner, without taking renderer paths or applying a Hook plan", async () => {
    const f = fixture()
    expect(await f.invoke(SETUP_IPC.prepare, ["/arbitrary/command"])).toEqual({ ok: false, code: "INVALID_REQUEST" })
    expect(await f.invoke(SETUP_IPC.prepare)).toMatchObject({ ok: true })
    expect(f.integration.prepareConnection).toHaveBeenCalledExactlyOnceWith(f.owner)
    expect(f.integration.applyHookPlan).not.toHaveBeenCalled()
    expect(mocks.showOpenDialog).not.toHaveBeenCalled()
  })
  it("uses native picker results only, rejects extra settings keys, and passes a validated appearance patch", async () => {
    const f = fixture()
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/native-selected/codex"] })
    await f.invoke(SETUP_IPC.chooseExecutable)
    expect(f.integration.selectExecutable).toHaveBeenCalledWith("/native-selected/codex", f.owner)
    expect(await f.invoke(SETUP_IPC.settingsPatch, [{ command: "PRIVATE_CANARY" }])).toMatchObject({ ok: false })
    expect(await f.invoke(SETUP_IPC.settingsPatch, [{ characterId: "gpichan", speechBubblesEnabled: false }])).toMatchObject({ ok: true })
    expect(f.patch).toHaveBeenCalledExactlyOnceWith({ characterId: "gpichan", speechBubblesEnabled: false })
  })
  it("returns only fixed error codes, limits floods and disposes all listeners/handlers", async () => {
    const f = fixture()
    f.integration.planHooks.mockRejectedValueOnce(new Error("PRIVATE_FOREIGN_COMMAND_CANARY"))
    expect(await f.invoke(SETUP_IPC.plan, ["install"])).toEqual({ ok: false, code: "SETUP_OPERATION_FAILED" })
    for (let index = 0; index < 23; index++) await f.invoke(SETUP_IPC.status)
    expect(await f.invoke(SETUP_IPC.status)).toEqual({ ok: false, code: "REQUEST_LIMITED" })
    f.controller.register()
    expect(f.integration.subscribe).toHaveBeenCalledOnce()
    const unsubscribe = f.integration.subscribe.mock.results[0].value
    f.controller.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.handlers.size).toBe(0)
  })
})
