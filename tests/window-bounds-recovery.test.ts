import { describe, expect, it } from "vitest"
import { isSufficientlyVisible, recoverWindowBounds, type DesktopBounds, type DisplayLike } from "../electron/shared/desktop-settings"

const primary: DisplayLike = { id: 1, scaleFactor: 2, workArea: { x: 0, y: 0, width: 1440, height: 900 } }
const left: DisplayLike = { id: 2, scaleFactor: 1, workArea: { x: -1920, y: -80, width: 1920, height: 1080 } }
const saved = (overrides: Partial<DesktopBounds> = {}): DesktopBounds => ({ x: 900, y: 300, width: 460, height: 460, displayId: 1, ...overrides })

describe("multi-monitor bounds recovery", () => {
  it("keeps bounds on an existing saved display", () => {
    expect(recoverWindowBounds(saved(), [primary, left], primary)).toEqual(saved())
  })

  it("keeps sufficiently visible negative-coordinate bounds when the saved display was removed", () => {
    const bounds = saved({ x: -500, y: 100, displayId: 99 })
    expect(recoverWindowBounds(bounds, [primary, left], primary)).toEqual({ ...bounds, displayId: 2 })
  })

  it("recovers a fully off-screen window to the primary bottom right", () => {
    expect(recoverWindowBounds(saved({ x: 9000, y: 9000, displayId: 99 }), [primary], primary)).toEqual({ x: 956, y: 416, width: 460, height: 460, displayId: 1 })
  })

  it("accepts either 25 percent area or an 80x80 visible region", () => {
    expect(isSufficientlyVisible(saved({ x: 1320, y: 780 }), primary.workArea)).toBe(true)
    expect(isSufficientlyVisible(saved({ x: 1370, y: 850 }), primary.workArea)).toBe(false)
  })

  it("recovers after a work area change and preserves DIP semantics", () => {
    const smaller = { ...primary, workArea: { x: 0, y: 0, width: 1000, height: 700 } }
    expect(recoverWindowBounds(saved({ x: 1300, y: 700 }), [smaller], smaller)).toMatchObject({ x: 516, y: 216, displayId: 1 })
  })
})
