import { afterEach, describe, expect, it, vi } from "vitest"
import { ModifierDragController } from "../src/pet/ModifierDragController"

afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const host = new EventTarget(), canvas = new EventTarget() as EventTarget & { captured: number | null; setPointerCapture(id: number): void; hasPointerCapture(id: number): boolean; releasePointerCapture(id: number): void }
  canvas.captured = null; canvas.setPointerCapture = id => { canvas.captured = id }; canvas.hasPointerCapture = id => canvas.captured === id; canvas.releasePointerCapture = () => { canvas.captured = null }
  let frame: FrameRequestCallback | null = null
  vi.stubGlobal("window", host); vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1 }); vi.stubGlobal("cancelAnimationFrame", () => { frame = null })
  const request = vi.fn(async (value: { action: string }) => ({ id: ["end", "cancel"].includes(value.action) ? null : "11111111-1111-1111-1111-111111111111" })), lock = vi.fn(), hit = vi.fn(() => true)
  const controller = new ModifierDragController(canvas as unknown as HTMLCanvasElement, { platform: "win32", allowed: () => true, hit, request, lock })
  const pointer = (type: string, patch = {}) => { const event = Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, button: 0, altKey: true, ctrlKey: false, metaKey: false, pointerType: "mouse", clientX: 10, clientY: 20, getModifierState: () => false, ...patch }); canvas.dispatchEvent(event); return event }
  return { host, canvas, request, lock, hit, controller, pointer, frame: () => { frame?.(0); frame = null } }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
describe("modifier gesture capture", () => {
  it("uses pointerdown modifiers without a prior keydown, retains capture after Alt release and does not emit normal input", async () => {
    const f = fixture()
    expect(f.pointer("pointerdown").defaultPrevented).toBe(true); expect(f.canvas.captured).toBe(1)
    f.pointer("pointermove", { altKey: false }); f.frame(); await settle()
    expect(f.request.mock.calls.map(x => x[0].action)).toEqual(["begin", "move"])
    expect(f.pointer("pointerup", { altKey: false }).defaultPrevented).toBe(true)
    await settle(); expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ action: "end" })); expect(f.lock).toHaveBeenLastCalledWith(false, { x: 10, y: 20 })
    f.controller.dispose()
  })
  it("leaves ordinary petting and transparent pixels alone, including Alt pressed midway", () => {
    const f = fixture()
    expect(f.pointer("pointerdown", { altKey: false }).defaultPrevented).toBe(false)
    expect(f.pointer("pointermove").defaultPrevented).toBe(false); expect(f.request).not.toHaveBeenCalled()
    f.hit.mockReturnValue(false); expect(f.pointer("pointerdown").defaultPrevented).toBe(false)
    expect(f.request).not.toHaveBeenCalled(); f.controller.dispose()
  })
  it.each(["pointercancel", "lostpointercapture", "blur", "Escape"])("cancels %s and releases capture without a click", async reason => {
    const f = fixture(); f.pointer("pointerdown")
    if (reason === "blur") f.host.dispatchEvent(new Event("blur"))
    else if (reason === "Escape") f.host.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape", code: "Escape" }))
    else f.pointer(reason)
    await settle(); expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ action: "cancel" })); expect(f.canvas.captured).toBe(null)
    expect(f.lock.mock.calls.at(-1)?.[0]).toBe(false); f.controller.dispose()
  })
  it("ignores other pointers and cancels a begin that returns after release", async () => {
    const f = fixture(); let resolve!: (value: { id: string }) => void
    f.request.mockReturnValueOnce(new Promise(yes => { resolve = yes }))
    f.pointer("pointerdown"); expect(f.pointer("pointerup", { pointerId: 2 }).defaultPrevented).toBe(false)
    f.controller.cancel(); resolve({ id: "11111111-1111-1111-1111-111111111111" }); await settle()
    expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ action: "cancel" })); f.controller.dispose()
  })
})
