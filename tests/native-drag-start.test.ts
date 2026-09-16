import { expect, it } from "vitest"
import { NativeDragStart } from "../electron/main/NativeDragStart"
it("keeps the event DIP coordinates when the cursor has moved before renderer IPC", () => {
  let now = 100
  const start = new NativeDragStart(() => now)
  start.record({ x: -1400, y: 50, width: 360, height: 210 }, { x: 100, y: 30 }, true)
  now += 250
  expect(start.take()).toEqual({ x: -1300, y: 80 })
  expect(start.take()).toBeNull()
})
it("rejects stale, out-of-window, nonfinite and unaccepted down events", () => {
  let now = 0
  const start = new NativeDragStart(() => now), bounds = { x: 24, y: 30, width: 360, height: 210 }
  for (const input of [{ x: NaN, y: 0 }, { x: -1, y: 2 }, { x: 361, y: 20 }]) { start.record(bounds, input, true); expect(start.take()).toBeNull() }
  start.record(bounds, { x: 20, y: 30 }, false); expect(start.take()).toBeNull()
  start.record(bounds, { x: 20, y: 30 }, true); now = 1001; expect(start.take()).toBeNull()
})
