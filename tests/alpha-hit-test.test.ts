import { describe, expect, it, vi } from "vitest"
import { AlphaHitTestController, nextAlphaHitTestState } from "../src/pet/AlphaHitTestController"
import type { Anime25DRuntime } from "../src/engine/anime25d/Anime25DRuntime"
import { containTransform, viewportToModel } from "../src/engine/anime25d/coordinate"

describe("alpha hit test logic", () => {
  it("converts contained CSS coordinates to drawing-buffer/model coordinates", () => {
    const transform = containTransform(460, 460, 200, 400)
    expect(transform.scale).toBeCloseTo(1.15)
    expect(transform.renderedWidth).toBeCloseTo(230)
    expect(transform.renderedHeight).toBeCloseTo(460)
    expect(transform.offsetX).toBeCloseTo(115)
    expect(transform.offsetY).toBeCloseTo(0)
    expect(viewportToModel(115, 0, 460, 460, 200, 400)).toMatchObject({ x: 0, y: 0, inside: true })
    expect(viewportToModel(10, 10, 460, 460, 200, 400).inside).toBe(false)
  })

  it("enters at 0.10 and requires two low-alpha samples to leave", () => {
    let state = { interactive: false, leaveSamples: 0 }
    state = nextAlphaHitTestState(state, 0.09)
    expect(state.interactive).toBe(false)
    state = nextAlphaHitTestState(state, 0.1)
    expect(state.interactive).toBe(true)
    state = nextAlphaHitTestState(state, 0.04)
    expect(state).toEqual({ interactive: true, leaveSamples: 1 })
    state = nextAlphaHitTestState(state, 0.03)
    expect(state).toEqual({ interactive: false, leaveSamples: 0 })
  })

  it("resets leave hysteresis when alpha rises", () => {
    expect(nextAlphaHitTestState({ interactive: true, leaveSamples: 1 }, 0.05)).toEqual({ interactive: true, leaveSamples: 0 })
  })

  it("locks interaction/layout and fails safe on context loss", () => {
    const canvas = new EventTarget() as unknown as HTMLCanvasElement
    const runtime = { sampleRenderedAlpha: () => ({ alpha: 0, interactive: false }) } as unknown as Anime25DRuntime
    const passthrough: boolean[] = []
    const locks: boolean[] = []
    const failures: string[] = []
    const controller = new AlphaHitTestController(canvas, runtime, {
      setMousePassthrough: async (ignore) => { passthrough.push(ignore) },
      setInteractionLocked: (locked) => { locks.push(locked) },
      reportAlphaFailure: (message) => { failures.push(message) },
    }, 0)
    canvas.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 1, clientY: 1 }))
    canvas.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 1, clientY: 1 }))
    expect(passthrough.at(-1)).toBe(true)
    canvas.dispatchEvent(new Event("pointerdown"))
    expect(locks.at(-1)).toBe(true)
    expect(passthrough.at(-1)).toBe(false)
    canvas.dispatchEvent(new Event("pointerup"))
    expect(locks.at(-1)).toBe(false)
    controller.setLayoutMode(true)
    expect(passthrough.at(-1)).toBe(false)
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
    expect(failures.at(-1)).toBe("WebGL context lost")
    expect(passthrough.at(-1)).toBe(false)
    controller.dispose()
  })

  it.each([
    { alpha: 0, expected: true, label: "transparent" },
    { alpha: 1, expected: false, label: "opaque" },
  ])("resamples $label release coordinates immediately", ({ alpha, expected }) => {
    const canvas = new EventTarget() as unknown as HTMLCanvasElement
    const sample = vi.fn(() => ({ alpha, interactive: alpha > 0 }))
    const passthrough = vi.fn(async () => {})
    const controller = new AlphaHitTestController(canvas, { sampleRenderedAlpha: sample } as unknown as Anime25DRuntime, {
      setMousePassthrough: passthrough,
      setInteractionLocked: vi.fn(),
      reportAlphaFailure: vi.fn(),
    }, 1_000)
    canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 3, clientX: 10, clientY: 20 }))
    canvas.dispatchEvent(Object.assign(new Event("pointerup"), { pointerId: 3, clientX: 30, clientY: 40 }))
    expect(sample).toHaveBeenCalledWith(30, 40, expect.anything())
    expect(passthrough).toHaveBeenLastCalledWith(expected)
    controller.dispose()
  })

  it("clears pointer cancel and unexpected capture loss exactly once", () => {
    const canvas = new EventTarget() as unknown as HTMLCanvasElement
    const locks = vi.fn()
    const passthrough = vi.fn(async () => {})
    const controller = new AlphaHitTestController(canvas, { sampleRenderedAlpha: () => ({ alpha: 1, interactive: true }) } as unknown as Anime25DRuntime, {
      setMousePassthrough: passthrough,
      setInteractionLocked: locks,
      reportAlphaFailure: vi.fn(),
    })
    canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 1, clientX: 1, clientY: 1 }))
    canvas.dispatchEvent(Object.assign(new Event("lostpointercapture"), { pointerId: 1 }))
    canvas.dispatchEvent(Object.assign(new Event("lostpointercapture"), { pointerId: 1 }))
    expect(locks.mock.calls.filter(([value]) => value === false)).toHaveLength(1)
    expect(passthrough).toHaveBeenLastCalledWith(false)
    canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 2, clientX: 2, clientY: 2 }))
    canvas.dispatchEvent(Object.assign(new Event("pointercancel"), { pointerId: 2 }))
    expect(locks).toHaveBeenLastCalledWith(false)
    controller.dispose()
  })

  it("coalesces passthrough IPC and catches a rejected update", async () => {
    const canvas = new EventTarget() as unknown as HTMLCanvasElement
    const failure = vi.fn()
    const passthrough = vi.fn(async () => { throw new Error("IPC unavailable") })
    const controller = new AlphaHitTestController(canvas, { sampleRenderedAlpha: () => ({ alpha: 1, interactive: true }) } as unknown as Anime25DRuntime, {
      setMousePassthrough: passthrough,
      setInteractionLocked: vi.fn(),
      reportAlphaFailure: failure,
    }, 0)
    canvas.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 1, clientY: 1 }))
    canvas.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 2, clientY: 2 }))
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce())
    expect(passthrough).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it("clears an active pointer when layout mode or context is lost", () => {
    const canvas = new EventTarget() as unknown as HTMLCanvasElement
    const locks = vi.fn()
    const passthrough = vi.fn(async () => {})
    const controller = new AlphaHitTestController(canvas, { sampleRenderedAlpha: () => ({ alpha: 1, interactive: true }) } as unknown as Anime25DRuntime, {
      setMousePassthrough: passthrough,
      setInteractionLocked: locks,
      reportAlphaFailure: vi.fn(),
    })
    canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 4, clientX: 1, clientY: 1 }))
    controller.setLayoutMode(true)
    expect(locks).toHaveBeenLastCalledWith(false)
    canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 5, clientX: 1, clientY: 1 }))
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
    expect(locks).toHaveBeenLastCalledWith(false)
    expect(passthrough).toHaveBeenLastCalledWith(false)
    controller.dispose()
  })
})
