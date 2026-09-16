import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import { WindowDragController } from "../electron/main/WindowDragController"
import { validWindowDragRequest } from "../electron/shared/window-drag"
import { isMoveGesture } from "../src/pet/ModifierDragController"

function fixture() {
  const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter; bounds: { x: number; y: number; width: number; height: number }; setBounds: ReturnType<typeof vi.fn>; isDestroyed(): boolean; isVisible(): boolean; getBounds(): typeof window.bounds }
  window.webContents = new EventEmitter(); window.bounds = { x: 100, y: 100, width: 460, height: 460 }
  window.isDestroyed = () => false; window.isVisible = () => true; window.getBounds = () => ({ ...window.bounds })
  window.setBounds = vi.fn(value => { window.bounds = { ...value }; window.emit("move") })
  const cursor = { x: 200, y: 200 }, finish = vi.fn(), lock = vi.fn(), capture = vi.fn()
  let now = 0
  const controller = new WindowDragController({ window: () => window as unknown as BrowserWindow, cursor: () => cursor,
    workArea: p => p.x < 0 ? { x: -1920, y: 0, width: 1920, height: 1080 } : { x: 0, y: 0, width: 1280, height: 800 }, allowed: () => true, lock, finish, now: () => now })
  window.on("move", () => { if (!controller.active) capture(window.bounds) })
  return { window, cursor, controller, finish, lock, capture, tick: () => { now += 20 } }
}
describe("owned window movement transaction", () => {
  it("suppresses click-only movement, starts at four DIP and commits once on release", () => {
    const f = fixture(), id = f.controller.request({ action: "begin" }).id!
    Object.assign(f.cursor, { x: 203, y: 200 }); f.controller.request({ action: "move", id })
    expect(f.window.bounds.x).toBe(100); expect(f.finish).not.toHaveBeenCalled()
    f.tick(); f.cursor.x = 204; f.controller.request({ action: "move", id })
    expect(f.window.bounds.x).toBe(104); expect(f.capture).not.toHaveBeenCalled()
    f.cursor.x = 500; f.controller.request({ action: "end", id })
    expect(f.finish).toHaveBeenCalledExactlyOnceWith({ x: 400, y: 100, width: 460, height: 460 }, true)
    expect(f.lock.mock.calls.map(x => x[0])).toEqual([true, false])
  })
  it.each(["cancel", "blur", "hide", "render-process-gone", "did-start-navigation"])("rolls back %s without persisting an intermediate position", reason => {
    const f = fixture(), id = f.controller.request({ action: "begin" }).id!
    f.cursor.x = 600; f.controller.request({ action: "move", id })
    if (reason === "cancel") f.controller.cancel()
    else if (reason.includes("-") && !["blur", "hide"].includes(reason)) f.window.webContents.emit(reason)
    else f.window.emit(reason)
    expect(f.window.bounds.x).toBe(100); expect(f.finish).toHaveBeenCalledWith(f.window.bounds, false); expect(f.capture).not.toHaveBeenCalled()
    expect(f.controller.active).toBe(false)
  })
  it("ignores a cancelled gesture's late messages and does not mix monitor DPI with cursor DIP", () => {
    const f = fixture(), old = f.controller.request({ action: "begin" }).id!
    f.controller.cancel()
    const id = f.controller.request({ action: "begin" }).id!
    Object.assign(f.cursor, { x: -1000, y: 400 })
    f.controller.request({ action: "move", id: old }); expect(f.window.bounds.x).toBe(100)
    f.controller.request({ action: "move", id }); expect(f.window.bounds.x).toBe(-1100)
    f.controller.request({ action: "end", id }); expect(f.finish).toHaveBeenLastCalledWith({ x: -1100, y: 300, width: 460, height: 460 }, true)
  })
  it("limits samples, clamps only the final position, and rejects non-finite native coordinates", () => {
    const f = fixture(), id = f.controller.request({ action: "begin" }).id!
    f.cursor.x = 1300; f.controller.request({ action: "move", id }); expect(f.window.bounds.x).toBe(1200)
    for (let n = 0; n < 100; n++) f.controller.request({ action: "move", id })
    expect(f.window.setBounds).toHaveBeenCalledOnce()
    f.controller.request({ action: "end", id }); expect(f.window.bounds.x).toBe(820)
    const next = f.controller.request({ action: "begin" }).id!
    f.cursor.x = Infinity; f.tick(); f.controller.request({ action: "move", id: next })
    expect(f.controller.active).toBe(false); expect(f.window.bounds.x).toBe(820)
  })
  it("requires a bounded request and exposes no window/coordinate/command payload", () => {
    for (const request of [null, { action: "begin", x: 10 }, { action: "move", id: "old" }, { action: "end", id: "a".repeat(36), windowId: 1 }, { action: "begin", command: "x" }]) expect(validWindowDragRequest(request)).toBe(false)
    expect(validWindowDragRequest({ action: "begin" })).toBe(true)
  })
})
describe("modifier is decided at pointerdown", () => {
  const mouse = { button: 0, altKey: true, ctrlKey: false, metaKey: false, pointerType: "mouse", getModifierState: () => false }
  it("accepts Alt/Option while rejecting ordinary input, AltGr, right Alt and other controls", () => {
    expect(isMoveGesture(mouse)).toBe(true)
    for (const patch of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { button: 2 }, { pointerType: "touch" }, { getModifierState: () => true }]) expect(isMoveGesture({ ...mouse, ...patch })).toBe(false)
    expect(isMoveGesture(mouse, true)).toBe(false)
  })
})
