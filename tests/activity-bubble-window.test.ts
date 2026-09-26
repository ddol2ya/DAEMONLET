import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
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
  setTitle = vi.fn()
  setAlwaysOnTop = vi.fn()
  setVisibleOnAllWorkspaces = vi.fn()
  setIgnoreMouseEvents = vi.fn()
  setBounds = vi.fn((r: typeof this.bounds) => { this.bounds = { ...r } })
  hide = vi.fn(() => { const wasVisible = this.visible; this.visible = false; if (wasVisible) this.emit("hide") })
  showInactive = vi.fn(() => { this.visible = true })
  show = vi.fn(() => { this.visible = true })
  focus = vi.fn()
  getBounds() { return { ...this.bounds } }
  isDestroyed() { return this.destroyed }
  isVisible() { if (this.destroyed) throw new Error("Object has been destroyed"); return this.visible }
  isMinimized() { return this.minimized }
  async loadURL() {}
  destroy() { this.destroyed = true; this.emit("closed") }
}
const cursor = vi.hoisted(() => ({ x: 300, y: 300 }))
vi.mock("electron", () => ({ BrowserWindow: FakeWindow, screen: { getCursorScreenPoint: () => ({ ...cursor }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 900 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 900 } }) } }))
async function fixture(paintReady = true, saved = vi.fn()) {
  const { ActivityBubbleWindowController } = await import("../electron/main/ActivityBubbleWindowController")
  const hidden = vi.fn(), c = new ActivityBubbleWindowController("/preload.cjs", undefined, hidden, undefined, placement => { settings.bubblePlacement = placement; c.applySettings(settings); saved(placement) })
  const pet = new FakeWindow(); pet.visible = true
  const settings = defaultDesktopSettings()
  c.attach(pet as unknown as BrowserWindow, settings)
  const store = new ActivityStore(() => 10_000)
  store.accept({ protocolVersion: 1, source: "codex-adapter", sourceInstanceId: "one", sessionId: "wire", messageId: "message", sequence: 1, sentAt: 10_000, frameType: "event", payload: { type: "run.completed", runId: "A" } })
  c.update({ ...store.view(), revision: 1, storage: "saved", historyRecovered: false, navigation: "none" })
  const epoch = c.presentation.begin(); let sequence = 0
  const report = (phase: "hidden" | "preparing" | "shown" | "exiting", available = true) => c.presentation.report({ epoch, sequence: ++sequence, phase, available, anchor: { x0: .3, x1: .7, y0: .02, y1: .32 } })
  await report("hidden")
  const win = c.window as unknown as FakeWindow; if (paintReady) win.emit("ready-to-show")
  return { c, pet, win, report, settings, hidden, store }
}
describe("native activity window arbitration", () => {
  it("edits in the same window, commits only on Apply and retains the live chat and draft", async () => {
    const saved = vi.fn(), f = await fixture(true, saved), factory = vi.fn(), service = new SideChatService(factory)
    service.configure(true, "ko"); service.setDraft("unsent original"); service.setMode("panel"); f.c.updateChat(service.snapshot())
    const conversation = JSON.stringify(service.snapshot()), originalBounds = { ...f.win.bounds }
    f.c.beginPlacement(); const revision = f.c.placementSnapshot().revision
    expect(f.c.window).toBe(f.win); expect(f.win.bounds).not.toEqual(originalBounds)
    const dragBounds = { ...f.win.bounds }
    f.win.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 20, y: 20 })
    // The real pointer has already reached its final position before renderer IPC begins.
    Object.assign(cursor, { x: dragBounds.x + 170, y: dragBounds.y + 130 })
    const begin = f.c.placementAction({ action: "drag", revision, drag: { action: "begin" } })
    if (!begin.ok || !begin.drag?.id) throw Error("drag did not begin")
    f.c.placementAction({ action: "drag", revision, drag: { action: "end", id: begin.drag.id } })
    expect(f.win.bounds).toMatchObject({ x: dragBounds.x + 150, y: dragBounds.y + 110 })
    expect(saved).not.toHaveBeenCalled()
    f.c.placementAction({ action: "cancel", revision }); expect(f.win.bounds).toEqual(originalBounds)
    f.c.beginPlacement(); const next = f.c.placementSnapshot().revision
    expect(f.c.placementAction({ action: "apply", revision })).toEqual({ ok: false })
    f.c.placementAction({ action: "apply", revision: next })
    expect(saved).toHaveBeenCalledOnce(); expect(f.settings.bubblePlacement.mode).toBe("relative")
    expect(JSON.stringify(service.snapshot())).toBe(conversation); expect(factory).not.toHaveBeenCalled()
    f.c.destroy()
  })
  it("keeps the entire open chat interactive, including setup scrollbars and gaps", async () => {
    const f = await fixture(), service = new SideChatService(vi.fn())
    service.configure(true, "ko"); service.setMode("compact"); f.c.updateChat(service.snapshot())
    f.c.setPointerInteractive(false)
    expect(f.win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    service.setMode("hidden"); f.c.updateChat(service.snapshot()); f.c.setPointerInteractive(false)
    expect(f.win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    f.c.destroy()
  })
  it("shows a local preview with all bubbles OFF and processes dialogue expiry while editing", async () => {
    const f = await fixture(), settings = { ...f.settings, taskBubblesEnabled: false, speechBubblesEnabled: false, sideChatEnabled: false }
    f.c.applySettings(settings); expect(f.win.visible).toBe(false)
    f.c.beginPlacement(); expect(f.win.visible).toBe(true)
    await f.report("hidden"); f.c.cancelPlacement()
    expect(f.win.visible).toBe(false); expect(settings).toMatchObject({ taskBubblesEnabled: false, speechBubblesEnabled: false, sideChatEnabled: false })
    f.c.destroy()
  })
  it.each([false, true])("does not recurse when Windows hide emits before visibility settles (locked=%s)", async locked => {
    const f = await fixture()
    if (locked) f.c.setInteractionLocked(true, true)
    let hides = 0
    f.win.hide.mockImplementation(() => {
      if (++hides > 8) throw Error("recursive native hide")
      // A native notification can arrive before isVisible changes. Repeated
      // release notifications must not create another synchronous hide chain.
      f.win.emit("hide"); f.win.visible = false
    })
    expect(() => f.c.presentation.begin()).not.toThrow()
    expect(f.c.presentation.interactionLocked).toBe(false)
    expect(f.win.visible).toBe(false); expect(hides).toBeLessThanOrEqual(2)
    f.c.destroy()
  })
  it("shows loaded activity even when a hidden window never emits ready-to-show", async () => {
    const f = await fixture(false)
    expect(f.win.visible).toBe(false)
    f.win.webContents.emit("did-finish-load")
    expect(f.win.visible).toBe(true)
    expect(f.win.webContents.send).toHaveBeenCalledWith("activity:changed", expect.objectContaining({ entries: expect.any(Array) }))
    f.c.destroy()
  })
  it("keeps loaded activity hidden during speech and restores it when speech ends", async () => {
    const f = await fixture(false)
    await f.report("shown")
    f.win.webContents.emit("did-finish-load")
    expect(f.win.visible).toBe(false)
    await f.report("hidden")
    await new Promise(done => setTimeout(done, 50))
    expect(f.win.visible).toBe(true)
    f.c.destroy()
  })
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

describe("conversation inside the task surface", () => {
  it("reuses the task window for chat and expansion, retaining normal activity after hiding", async () => {
    const f = await fixture(), service = new SideChatService(() => { throw Error("No automatic backend") })
    service.configure(true, "ko"); service.setMode("compact"); f.c.updateChat(service.snapshot())
    expect(f.c.window).toBe(f.win); expect(f.win.visible).toBe(true); expect(f.win.bounds.width).toBe(360); expect(f.win.focus).toHaveBeenCalledTimes(1)
    service.setDraft("kept"); f.c.updateChat(service.snapshot()); expect(f.win.focus).toHaveBeenCalledTimes(1)
    service.setMode("panel"); f.c.updateChat(service.snapshot()); expect(f.c.window).toBe(f.win); expect(f.win.bounds.width).toBe(480)
    service.setMode("hidden"); f.c.updateChat(service.snapshot()); expect(f.c.window).toBe(f.win); expect(f.win.visible).toBe(true); expect(service.snapshot().draft).toBe("kept")
    f.c.destroy()
  })
  it("allows explicit chat with task notifications off and follows Pet visibility", async () => {
    const f = await fixture(), service = new SideChatService(() => { throw Error("No automatic backend") })
    f.c.applySettings({ ...f.settings, taskBubblesEnabled: false }); expect(f.win.visible).toBe(false)
    service.configure(true, "ko"); service.setMode("compact"); f.c.updateChat(service.snapshot()); expect(f.win.visible).toBe(true)
    f.pet.visible = false; f.pet.emit("hide"); expect(f.win.visible).toBe(false)
    f.pet.visible = true; f.pet.emit("show"); expect(f.win.visible).toBe(true)
    service.setMode("hidden"); f.c.updateChat(service.snapshot()); expect(f.win.visible).toBe(false)
    f.c.destroy()
  })
})

describe("account usage visibility and footer placement", () => {
  it("follows actual activity visibility through chat, control, placement and local chat", async () => {
    const f = await fixture(), visible = vi.fn(), off = f.c.subscribeUsageVisibility(visible)
    expect(visible).toHaveBeenLastCalledWith(true)
    f.c.setView("control", false); expect(visible).toHaveBeenLastCalledWith(false)
    f.c.setView("activity", false); expect(visible).toHaveBeenLastCalledWith(true)
    f.c.beginPlacement(); expect(visible).toHaveBeenLastCalledWith(false)
    f.c.cancelPlacement(); expect(visible).toHaveBeenLastCalledWith(true)
    f.c.setLocalChatVisible(true); expect(visible).toHaveBeenLastCalledWith(false)
    f.c.setLocalChatVisible(false); expect(visible).toHaveBeenLastCalledWith(true)
    const chat = new SideChatService(vi.fn()); chat.setMode("compact"); f.c.updateChat(chat.snapshot())
    expect(visible).toHaveBeenLastCalledWith(false)
    chat.setMode("hidden"); f.c.updateChat(chat.snapshot()); expect(visible).toHaveBeenLastCalledWith(true)
    f.win.webContents.emit("render-process-gone"); expect(visible).toHaveBeenLastCalledWith(false)
    f.win.webContents.emit("did-finish-load"); expect(visible).toHaveBeenLastCalledWith(true)
    off(); f.c.destroy()
  })
  it("keeps measured footer height in unanchored/relative layout and retains press bounds", async () => {
    const f = await fixture(); f.c.presentation.anchor = null; f.c.setContentHeight(190)
    expect(f.win.bounds.height).toBe(190)
    f.c.applySettings({ ...f.settings, bubblePlacement: { schemaVersion: 1, mode: "relative", offsetX: 20, offsetY: 20, pivotX: 0, pivotY: 0 } })
    expect(f.win.bounds.height).toBe(190)
    const before = { ...f.win.bounds }; f.c.setInteractionLocked(true, true); f.c.setContentHeight(240)
    expect(f.win.bounds).toEqual(before); f.c.setInteractionLocked(false); expect(f.win.bounds.height).toBe(240)
    f.c.destroy()
  })
})
