import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { App, BrowserWindow } from "electron"
import { DockResidencyController } from "../electron/main/DockResidencyController"

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  let dock = false
  const app = Object.assign(new EventEmitter(), { setActivationPolicy: vi.fn((policy: string) => { dock = policy === "regular" }) })
  const window = () => Object.assign(new EventEmitter(), { visible: true, destroyed: false, isDestroyed() { return this.destroyed }, isVisible() { return this.visible }, isMinimized: () => false })
  const pet = window(), settings = window(), lab = window(); lab.visible = false
  const state = { created: true, reachable: false }
  const recovered = vi.fn()
  const controller = new DockResidencyController({ app: app as unknown as App,
    windows: () => [pet, settings, lab] as unknown as BrowserWindow[], utilityWindows: () => [settings, lab] as unknown as BrowserWindow[],
    dockVisible: () => dock, trayCreated: () => state.created, trayVisible: () => state.reachable, recovered })
  controller.start()
  return { app, pet, settings, lab, state, recovered, controller, showDockExternally: () => { dock = true } }
}
it("returns to menu-bar residency when the last recovery/utility window closes, with the pet still visible", async () => {
  const f = fixture(); f.controller.requestFallback()
  expect(f.app.setActivationPolicy).toHaveBeenLastCalledWith("regular")
  f.lab.visible = true; f.lab.emit("show"); f.settings.visible = false; f.settings.emit("hide"); await Promise.resolve()
  expect(f.app.setActivationPolicy).toHaveBeenLastCalledWith("regular")
  f.lab.visible = false; f.lab.destroyed = true; f.lab.emit("closed"); await Promise.resolve()
  expect(f.pet.visible).toBe(true); expect(f.app.setActivationPolicy).toHaveBeenLastCalledWith("accessory")
  f.settings.visible = true; f.settings.emit("show"); await Promise.resolve()
  expect(f.app.setActivationPolicy).toHaveBeenLastCalledWith("regular")
  f.controller.dispose()
})
it("clears temporary fallback after the menu-bar item becomes reachable without closing user windows", () => {
  const f = fixture(); f.controller.requestFallback(); f.state.reachable = true
  vi.advanceTimersByTime(2000)
  expect(f.recovered).toHaveBeenCalledOnce(); expect(f.settings.visible).toBe(true)
  expect(f.app.setActivationPolicy).toHaveBeenLastCalledWith("accessory")
  f.state.reachable = false; vi.advanceTimersByTime(2000)
  expect(f.app.setActivationPolicy).toHaveBeenLastCalledWith("accessory")
  f.controller.dispose()
})
it("keeps a Dock escape route for actual Tray creation failure", () => {
  const f = fixture(); f.state.created = false; f.settings.visible = false
  f.controller.requestFallback(); expect(f.app.setActivationPolicy).toHaveBeenLastCalledWith("regular")
  f.controller.dispose()
})
it("keeps normal tray operation accessory and removes event/timer work on shutdown", async () => {
  const f = fixture(); f.state.reachable = true
  f.settings.emit("hide"); await Promise.resolve()
  expect(f.app.setActivationPolicy.mock.calls).toEqual([["accessory"]])
  f.controller.dispose(); f.settings.emit("show"); vi.advanceTimersByTime(10000); await Promise.resolve()
  expect(f.app.listenerCount("browser-window-created")).toBe(0)
  expect(f.settings.listenerCount("show")).toBe(0)
  expect(f.app.setActivationPolicy).toHaveBeenCalledOnce()
})

it("reconciles native Dock visibility changed outside the cached activation policy", () => {
  const f = fixture(); f.showDockExternally(); vi.advanceTimersByTime(2000)
  expect(f.app.setActivationPolicy.mock.calls).toEqual([["accessory"], ["accessory"]])
  f.controller.dispose()
})
