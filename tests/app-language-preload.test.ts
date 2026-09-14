import { describe, expect, it, vi } from "vitest"
import { APP_LANGUAGE_CHANGED, type AppLanguageApi } from "../electron/shared/app-language"
const fake = vi.hoisted(() => ({ expose: vi.fn(), on: vi.fn(), invoke: vi.fn(), send: vi.fn() }))
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: fake.expose }, ipcRenderer: { on: fake.on, invoke: fake.invoke, send: fake.send } }))
import { exposeAppLanguage } from "../electron/preload/app-language"
describe("receive-only language preload", () => {
  it("validates updates, hides Electron events and unsubscribes without adding write privileges", () => {
    exposeAppLanguage()
    const [name, api] = fake.expose.mock.calls.at(-1) as [string, AppLanguageApi]
    expect(name).toBe("appLanguage"); expect(Object.isFrozen(api)).toBe(true)
    expect(Object.keys(api).sort()).toEqual(["current", "onChanged"])
    const [channel, receive] = fake.on.mock.calls.at(-1)!
    expect(channel).toBe(APP_LANGUAGE_CHANGED)
    const listener = vi.fn(), unsubscribe = api.onChanged(listener)
    receive({ privateEvent: true }, "en")
    expect(api.current()).toBe("en"); expect(listener).toHaveBeenCalledExactlyOnceWith()
    for (const value of ["en", "fr", {}, null, "en-US"]) receive({}, value)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe(); receive({}, "ko")
    expect(api.current()).toBe("ko"); expect(listener).toHaveBeenCalledOnce()
    expect(fake.invoke).not.toHaveBeenCalled(); expect(fake.send).not.toHaveBeenCalled()
  })
})
