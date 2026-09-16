import { afterEach, describe, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import { BubblePresentationIpcController } from "../electron/main/BubblePresentationIpcController"
import type { ActivityBubbleWindowController } from "../electron/main/ActivityBubbleWindowController"
import { BUBBLE_IPC } from "../electron/shared/bubble-presentation"
import { PLACEMENT_IPC } from "../electron/shared/bubble-placement"
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), listeners: new Map<string, (...args: any[]) => any>() }))
vi.mock("electron", () => ({ ipcMain: { handle: (c: string, f: (...args: any[]) => any) => mocks.handlers.set(c, f), removeHandler: (c: string) => mocks.handlers.delete(c), on: (c: string, f: (...args: any[]) => any) => mocks.listeners.set(c, f), removeListener: (c: string) => mocks.listeners.delete(c) } }))
afterEach(() => { mocks.handlers.clear(); mocks.listeners.clear() })
function fixture() {
  const window = (role: string) => {
    const frame = { url: `pet://app/${role}.html`, processId: 1, routingId: 2 }
    const webContents = { id: role === "pet" ? 1 : 2, mainFrame: frame }
    return { win: { isDestroyed: () => false, webContents } as unknown as BrowserWindow, sender: { sender: webContents, senderFrame: frame }, frame }
  }
  const pet = window("pet"), activity = window("activity-bubble")
  const bubble = { petWindow: pet.win, window: activity.win, placementSnapshot: vi.fn(() => ({ editing: true, revision: 1 })), placementAction: vi.fn(() => ({ ok: true })), presentation: { begin: vi.fn(() => 1), report: vi.fn(() => Promise.resolve({ granted: true })), setInteractionLocked: vi.fn() }, setInteractionLocked: vi.fn(), setPointerInteractive: vi.fn(), setContentHeight: vi.fn() }
  let at = 0
  const ipc = new BubblePresentationIpcController(bubble as unknown as ActivityBubbleWindowController, undefined, () => at); ipc.register()
  return { bubble, pet, activity, ipc, advance: () => { at += 1000 } }
}
const report = { epoch: 1, sequence: 1, available: true, phase: "preparing", anchor: { x0: .3, y0: .05, x1: .7, y1: .35 } }
describe("narrow presentation IPC", () => {
  it("limits preview actions to the exact existing task main frame and bounds their frequency", () => {
    const f = fixture(), action = mocks.handlers.get(PLACEMENT_IPC.action)!, request = { action: "cancel", revision: 1 }
    for (const sender of [f.pet.sender, { ...f.activity.sender, senderFrame: { ...f.activity.frame } }, { ...f.activity.sender, senderFrame: null }]) expect(action(sender, request)).toEqual({ ok: false })
    expect(action(f.activity.sender, request, "extra")).toEqual({ ok: false })
    expect(f.bubble.placementAction).not.toHaveBeenCalled()
    for (let i = 0; i < 120; i++) expect(action(f.activity.sender, request)).toEqual({ ok: true })
    expect(action(f.activity.sender, request)).toEqual({ ok: false }); f.ipc.dispose()
  })
  it("reserves presentation state for the exact Pet main frame", async () => {
    const f = fixture(), call = mocks.handlers.get(BUBBLE_IPC.report)!
    for (const sender of [f.activity.sender, { ...f.pet.sender, senderFrame: { ...f.pet.frame } }, { ...f.pet.sender, senderFrame: null }]) expect(await call(sender, report)).toMatchObject({ granted: false })
    expect(f.bubble.presentation.report).not.toHaveBeenCalled()
    expect(await call(f.pet.sender, report)).toMatchObject({ granted: true })
    expect(f.bubble.presentation.report).toHaveBeenCalledExactlyOnceWith(report)
    f.pet.frame.url += "?extra=1"
    expect(await call(f.pet.sender, report)).toMatchObject({ granted: false })
  })
  it("bounds height, geometry, state, arity and request frequency without accepting screen coordinates", async () => {
    const f = fixture(), call = mocks.handlers.get(BUBBLE_IPC.report)!, height = mocks.listeners.get(BUBBLE_IPC.height)!
    for (const value of [{ ...report, text: "body" }, { ...report, anchor: { ...report.anchor, x0: Infinity } }, { ...report, anchor: { ...report.anchor, x0: -1 } }]) expect(await call(f.pet.sender, value)).toMatchObject({ granted: false })
    expect(await call(f.pet.sender, report, "extra")).toMatchObject({ granted: false })
    for (let i = 0; i < 30; i++) await call(f.pet.sender, report)
    expect(await call(f.pet.sender, report)).toMatchObject({ granted: false })
    expect(f.bubble.presentation.report).toHaveBeenCalledTimes(30)
    f.advance(); await call(f.pet.sender, report); expect(f.bubble.presentation.report).toHaveBeenCalledTimes(31)
    for (const h of [NaN, 0, 43, 481, 73.5, { height: 73 }]) height(f.activity.sender, h)
    height(f.pet.sender, 73); expect(f.bubble.setContentHeight).not.toHaveBeenCalled()
    height(f.activity.sender, 73); expect(f.bubble.setContentHeight).toHaveBeenCalledExactlyOnceWith(73)
  })
  it("allows boolean input policy only from the activity window and removes all handlers", () => {
    const f = fixture(), lock = mocks.listeners.get(BUBBLE_IPC.interaction)!
    lock(f.pet.sender, true, true); lock(f.activity.sender, "true", false); lock(f.activity.sender, true); lock(f.activity.sender, false, true)
    expect(f.bubble.setInteractionLocked).not.toHaveBeenCalled()
    lock(f.activity.sender, true, true); expect(f.bubble.setInteractionLocked).toHaveBeenCalledExactlyOnceWith(true, true)
    f.ipc.dispose(); expect(mocks.handlers.size + mocks.listeners.size).toBe(0)
  })
})
