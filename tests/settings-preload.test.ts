import { describe, expect, it, vi } from "vitest"
import { SETUP_IPC, type SettingsDesktopApi } from "../electron/shared/codex-integration-contract"

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(async (): Promise<unknown> => ({ ok: true, value: {} })), on: vi.fn(), removeListener: vi.fn() }))
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener } }))

describe("Settings preload", () => {
  it("exposes a frozen narrow API without shell, filesystem, protocol, raw invoke or Electron events", async () => {
    await import("../electron/preload/settings-preload")
    expect(mocks.expose.mock.calls.map(([name]) => name).sort()).toEqual(["appLanguage", "settingsDesktop", "updateDesktop"])
    const [name, api] = mocks.expose.mock.calls.find(([name]) => name === "settingsDesktop")! as [string, SettingsDesktopApi]
    expect(name).toBe("settingsDesktop")
    expect(Object.isFrozen(api)).toBe(true)
    const updateApi = mocks.expose.mock.calls.find(([name]) => name === "updateDesktop")![1]
    expect(Object.isFrozen(updateApi)).toBe(true)
    expect(Object.keys(updateApi).sort()).toEqual(["act", "onChanged", "onOpen", "snapshot"])
    expect(Object.isFrozen(api.packUpdates)).toBe(true)
    expect(Object.keys(api.packUpdates).sort()).toEqual(["act", "list", "onChanged"])
    expect(Object.isFrozen(api.characters)).toBe(true)
    expect(Object.keys(api.characters).sort()).toEqual(["list", "select", "onChanged", "onProgress", "chooseImport", "commitImport", "cancelImport", "remove", "rollback"].sort())
    expect(Object.keys(api).sort()).toEqual(["packUpdates", "characters", "getStatus", "refreshStatus", "prepareConnection", "chooseCodexExecutable", "chooseCodexHome", "planHooks", "applyHookPlan", "discardHookPlan", "runHostSelfTest", "reportHookReview", "startLiveObservation", "stopLiveObservation", "reportDesktopStopAttempt", "dismissOnboarding", "getSettings", "updateSettings", "resetPetPosition", "setBubblePlacement", "restartAdapter", "exportDiagnostics", "onStatusChanged", "onSettingsChanged"].sort())
    for (const forbidden of ["invoke", "ipcRenderer", "shell", "readFile", "writeFile", "protocol", "reportReady", "setMousePassthrough"]) expect(api).not.toHaveProperty(forbidden)
    await api.setBubblePlacement("adjust")
    expect(mocks.invoke).toHaveBeenCalledWith(SETUP_IPC.bubblePlacement, "adjust")
    await api.prepareConnection()
    expect(mocks.invoke).toHaveBeenCalledWith(SETUP_IPC.prepare)
    await api.applyHookPlan("one-main-plan-id")
    expect(mocks.invoke).toHaveBeenCalledWith(SETUP_IPC.apply, "one-main-plan-id")
    const listener = vi.fn()
    const unsubscribe = api.onStatusChanged(listener)
    const wrapped = mocks.on.mock.calls.find(([channel]) => channel === SETUP_IPC.statusChanged)![1]
    wrapped({ sensitive: "PRIVATE_IPC_EVENT_CANARY" }, { step: "observed" })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ step: "observed" })
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith(SETUP_IPC.statusChanged, wrapped)
    mocks.invoke.mockResolvedValueOnce({ ok: false, code: "PLAN_STALE" })
    await expect(api.applyHookPlan("expired")).rejects.toThrow("PLAN_STALE")
  })
})
