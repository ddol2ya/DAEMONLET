import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"
import { ActivityStore } from "../electron/main/activity/ActivityStore"

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler = vi.fn()
  send = vi.fn()
}
class FakeWindow extends EventEmitter {
  webContents = new FakeWebContents()
  visible = false
  minimized = false
  destroyed = false
  bounds = { x: 200, y: 200, width: 460, height: 460 }
  setAlwaysOnTop = vi.fn()
  setVisibleOnAllWorkspaces = vi.fn()
  setIgnoreMouseEvents = vi.fn()
  setBounds = vi.fn((r: typeof this.bounds) => { this.bounds = { ...r } })
  hide = vi.fn(() => { const wasVisible = this.visible; this.visible = false; if (wasVisible) this.emit("hide") })
  showInactive = vi.fn(() => { this.visible = true })
  getBounds() { return { ...this.bounds } }
  isDestroyed() { return this.destroyed }
  isVisible() { if (this.destroyed) throw new Error("Object has been destroyed"); return this.visible }
  isMinimized() { return this.minimized }
  async loadURL() {}
  destroy() { this.destroyed = true; this.emit("closed") }
}
vi.mock("electron", () => ({ BrowserWindow: FakeWindow, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 900 } }) } }))
async function fixture() {
  const { ActivityBubbleWindowController } = await import("../electron/main/ActivityBubbleWindowController")
  const hidden = vi.fn(), c = new ActivityBubbleWindowController("/preload.cjs", undefined, hidden)
  const pet = new FakeWindow(); pet.visible = true
  const settings = defaultDesktopSettings()
  c.attach(pet as unknown as BrowserWindow, settings)
  const store = new ActivityStore(() => 10_000)
  store.accept({ protocolVersion: 1, source: "codex-adapter", sourceInstanceId: "one", sessionId: "wire", messageId: "message", sequence: 1, sentAt: 10_000, frameType: "event", payload: { type: "run.completed", runId: "A" } })
  c.update({ ...store.view(), revision: 1, storage: "saved", historyRecovered: false, navigation: "none" })
  const epoch = c.presentation.begin(); let sequence = 0
  const report = (phase: "hidden" | "preparing" | "shown" | "exiting", available = true) => c.presentation.report({ epoch, sequence: ++sequence, phase, available, anchor: { x0: .3, x1: .7, y0: .02, y1: .32 } })
  await report("hidden")
  const win = c.window as unknown as FakeWindow; win.emit("ready-to-show")
  return { c, pet, win, report, settings, hidden, store }
}
describe("native activity window arbitration", () => {
  it("hides before the permit while explicit controls stay visible in their own slot", async () => {
    const f = await fixture()
    expect(f.win.visible).toBe(true)
    const permit = f.report("preparing")
    expect(f.win.visible).toBe(false)
    expect(await permit).toMatchObject({ granted: true })
    f.c.setView("control", false); expect(f.win.visible).toBe(true)
    const calls = f.hidden.mock.calls.length
    await f.report("exiting"); expect(f.win.visible).toBe(true)
    expect(f.hidden).toHaveBeenCalledTimes(calls)
    f.c.applySettings({ ...f.settings, visible: false })
    expect(f.win.visible).toBe(false); expect(f.hidden.mock.calls.length).toBeGreaterThan(calls)
    f.c.destroy()
  })
  it("retains a card pressed before its last result disappears and hides after input settles", async () => {
    const f = await fixture()
    f.win.webContents.emit("before-mouse-event", {}, { type: "mouseDown" })
    f.c.update({ ...new ActivityStore().view(), revision: 2, storage: "saved", historyRecovered: false, navigation: "none" })
    expect(f.win.visible).toBe(true)
    f.c.presentation.setInteractionLocked(false)
    expect(f.win.visible).toBe(false)
    expect(f.c.window).toBe(f.win)
    f.c.destroy()
  })
  it("holds bounds during down/up but lets an open menu grow after release", async () => {
    const f = await fixture(), old = f.win.getBounds()
    f.win.webContents.emit("before-mouse-event", {}, { type: "mouseDown" })
    f.c.setContentHeight(180)
    expect(f.win.getBounds()).toEqual(old)
    f.c.setInteractionLocked(true, false) // Menu stays open after the press ends.
    expect(f.win.getBounds().height).toBe(180)
    expect(f.c.presentation.interactionLocked).toBe(true)
    f.c.setInteractionLocked(false); f.c.destroy()
  })
  it("does not read a destroyed native handle when a locked window closes during quit", async () => {
    const f = await fixture()
    f.c.setInteractionLocked(true, true)
    expect(() => f.c.destroy()).not.toThrow()
    expect(f.c.window).toBeNull()
    expect(f.win.destroyed).toBe(true)
  })
  it("suppresses automatic cards for layout, minimization, no layout geometry and Pet renderer loss", async () => {
    const f = await fixture()
    f.c.setLayoutMode(true); expect(f.win.visible).toBe(false)
    f.c.setLayoutMode(false); expect(f.win.visible).toBe(true)
    f.pet.minimized = true; f.pet.emit("minimize"); expect(f.win.visible).toBe(false)
    f.pet.minimized = false; f.pet.emit("restore"); expect(f.win.visible).toBe(true)
    await f.report("hidden", false); expect(f.win.visible).toBe(false)
    await f.report("hidden"); expect(f.win.visible).toBe(true)
    f.pet.webContents.emit("render-process-gone"); expect(f.win.visible).toBe(false)
    await f.report("hidden"); expect(f.win.visible).toBe(false) // Old epoch cannot recover it.
    const epoch = f.c.presentation.begin()
    await f.c.presentation.report({ epoch, sequence: 1, available: true, phase: "hidden", anchor: { x0: .3, x1: .7, y0: .02, y1: .32 } })
    expect(f.win.visible).toBe(true)
    f.c.destroy()
    expect(f.pet.listenerCount("move") + f.pet.webContents.listenerCount("render-process-gone")).toBe(0)
  })
  it("shows speech in a fixed, click-through companion independently of task settings and tracks Pet lifecycle", async () => {
    const f = await fixture()
    f.c.applySettings({ ...f.settings, taskBubblesEnabled: false })
    const epoch = f.c.presentation.begin()
    await f.c.presentation.report({ epoch, sequence: 1, available: true, phase: "shown", anchor: { x0: .3, x1: .7, y0: .02, y1: .32 }, speech: { text: "확인할게.", width: 90, height: 42, fadeMs: 160 } })
    const speech = f.c.speech.window as unknown as FakeWindow
    speech.webContents.emit("did-finish-load")
    expect(speech.isVisible()).toBe(true)
    expect(f.win.isVisible()).toBe(false)
    expect(speech.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
    const before = speech.getBounds()
    f.pet.bounds = { ...f.pet.bounds, width: 280, height: 280 }; f.pet.emit("resize")
    expect(speech.getBounds()).toMatchObject({ width: before.width, height: before.height })
    expect(speech.getBounds().x).not.toBe(before.x)
    f.c.setLayoutMode(true); expect(speech.isVisible()).toBe(false)
    f.c.setLayoutMode(false); expect(speech.isVisible()).toBe(true)
    f.pet.minimized = true; f.pet.emit("minimize"); expect(speech.isVisible()).toBe(false)
    f.pet.minimized = false; f.pet.emit("restore"); expect(speech.isVisible()).toBe(true)
    f.c.applySettings({ ...f.settings, speechBubblesEnabled: false }); expect(speech.isVisible()).toBe(false)
    f.c.applySettings(f.settings); expect(speech.isVisible()).toBe(true)
    f.pet.webContents.emit("render-process-gone"); expect(speech.isVisible()).toBe(false)
    f.c.destroy(); expect(speech.destroyed).toBe(true)
  })
  it("holds a line through animation and fade, while following actual Pet moves and scale changes", async () => {
    const f = await fixture(), epoch = f.c.presentation.begin()
    const anchor = { x0: .3, x1: .7, y0: .02, y1: .32 }
    const speech = { text: "확인할게.", width: 90, height: 42, fadeMs: 160, outline: Array(128).fill([40, 85]).flat() }
    let sequence = 0
    const report = (geometry = anchor, line = speech, phase: "shown" | "exiting" | "hidden" = "shown") => f.c.presentation.report({ epoch, sequence: ++sequence, available: true, phase, anchor: geometry, speech: line })
    await report()
    const win = f.c.speech.window as unknown as FakeWindow; win.webContents.emit("did-finish-load")
    const opening = win.getBounds(); win.setBounds.mockClear()
    const movingAnchor = { x0: .2, x1: .8, y0: .09, y1: .4 }
    const movingSpeech = { ...speech, outline: Array(128).fill([25, 105]).flat() }
    await report(movingAnchor, movingSpeech)
    await report(movingAnchor, movingSpeech, "exiting")
    expect(win.getBounds()).toEqual(opening)
    expect(win.setBounds).not.toHaveBeenCalled()
    f.pet.bounds = { ...f.pet.bounds, x: f.pet.bounds.x + 35, y: f.pet.bounds.y + 40 }; f.pet.emit("move")
    expect(win.getBounds()).toEqual({ ...opening, x: opening.x + 35, y: opening.y + 40 })
    f.pet.bounds = { ...f.pet.bounds, width: 299, height: 299 }; f.pet.emit("resize")
    const scaled = win.getBounds()
    expect([scaled.width, scaled.height]).toEqual([opening.width, opening.height])
    expect(scaled.x).not.toBe(opening.x + 35)
    await report(anchor, speech)
    expect(win.getBounds()).toEqual(scaled)
    f.c.destroy()
  })
  it("captures fresh geometry for a new line and when the same line is shown again after hiding", async () => {
    const f = await fixture(), epoch = f.c.presentation.begin()
    const anchor = { x0: .3, x1: .7, y0: .02, y1: .32 }
    const speech = { text: "확인할게.", width: 90, height: 42, fadeMs: 160, outline: Array(128).fill([40, 85]).flat() }
    let sequence = 0
    const report = (text: string, x1: number, phase: "shown" | "hidden" = "shown") => f.c.presentation.report({ epoch, sequence: ++sequence, available: true, phase, anchor, speech: { ...speech, text, outline: Array(128).fill([40, x1]).flat() } })
    await report(speech.text, 85)
    const win = f.c.speech.window as unknown as FakeWindow; win.webContents.emit("did-finish-load")
    const opening = win.getBounds()
    await report("완료했습니다.", 105)
    expect(win.getBounds().x).toBeGreaterThan(opening.x)
    await report("완료했습니다.", 105, "hidden")
    expect(win.isVisible()).toBe(false)
    await report("완료했습니다.", 85)
    expect(win.getBounds()).toEqual(opening)
    f.c.destroy()
  })
})
