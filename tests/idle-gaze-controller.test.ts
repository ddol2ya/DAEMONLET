import { describe, expect, it } from "vitest"
import { IdleGazeController } from "../src/motion/sources/IdleGazeController"

class FakeClock {
  constructor(public time = 0) {}
  now() { return this.time }
}

const config = {
  pointerReleaseDelayMs: 100,
  targetHoldMinMs: 1000,
  targetHoldMaxMs: 1000,
  eyeXMin: -0.4,
  eyeXMax: 0.4,
  eyeYMin: -0.2,
  eyeYMax: 0.15,
}

describe("IdleGazeController", () => {
  it("activates only in NORMAL after the release delay and stays in bounds", () => {
    const clock = new FakeClock()
    const gaze = new IdleGazeController({ clock, random: () => 1, config })
    expect(gaze.update({ now: 99, semanticState: "NORMAL", pointerActive: false }).active).toBe(false)
    expect(gaze.update({ now: 100, semanticState: "NORMAL", pointerActive: false }).active).toBe(true)
    expect(gaze.getDiagnostics().targetEyeX).toBeCloseTo(0.4)
    expect(gaze.getDiagnostics().targetEyeY).toBeCloseTo(0.15)
  })

  it.each(["BORED", "BUSY", "HAPPY"] as const)("disables idle gaze in %s", (semanticState) => {
    const clock = new FakeClock()
    const gaze = new IdleGazeController({ clock, random: () => 1, config: { ...config, pointerReleaseDelayMs: 0 } })
    expect(gaze.update({ now: 20, semanticState, pointerActive: false }).active).toBe(false)
  })

  it("suppresses immediately for pointer activity and resumes after the delay", () => {
    const clock = new FakeClock()
    const gaze = new IdleGazeController({ clock, random: () => 1, config: { ...config, pointerReleaseDelayMs: 100 } })
    expect(gaze.update({ now: 100, semanticState: "NORMAL", pointerActive: false }).active).toBe(true)
    expect(gaze.update({ now: 110, semanticState: "NORMAL", pointerActive: true }).active).toBe(false)
    expect(gaze.update({ now: 209, semanticState: "NORMAL", pointerActive: false }).active).toBe(false)
    expect(gaze.update({ now: 210, semanticState: "NORMAL", pointerActive: false }).active).toBe(true)
  })

  it("moves eyes faster than the lower-amplitude head follow", () => {
    const clock = new FakeClock()
    const gaze = new IdleGazeController({ clock, random: () => 1, config: { ...config, pointerReleaseDelayMs: 0 } })
    gaze.update({ now: 0, semanticState: "NORMAL", pointerActive: false })
    const output = gaze.update({ now: 50, semanticState: "NORMAL", pointerActive: false })
    expect(Math.abs(output.eyeX)).toBeGreaterThan(Math.abs(output.headX))
  })

  it("uses frame-independent smoothing at 30, 60 and 120Hz", () => {
    const sample = (hz: number) => {
      const clock = new FakeClock()
      const gaze = new IdleGazeController({ clock, random: () => 1, config: { ...config, pointerReleaseDelayMs: 0, targetHoldMinMs: 2000, targetHoldMaxMs: 2000 } })
      gaze.update({ now: 0, semanticState: "NORMAL", pointerActive: false })
      for (let frame = 1; frame <= hz; frame++) gaze.update({ now: frame * 1000 / hz, semanticState: "NORMAL", pointerActive: false })
      return gaze.getDiagnostics()
    }
    const outputs = [sample(30), sample(60), sample(120)]
    expect(Math.max(...outputs.map((value) => value.eyeX)) - Math.min(...outputs.map((value) => value.eyeX))).toBeLessThan(0.002)
    expect(Math.max(...outputs.map((value) => value.headX)) - Math.min(...outputs.map((value) => value.headX))).toBeLessThan(0.002)
  })

  it("reset returns every output to center", () => {
    const clock = new FakeClock()
    const gaze = new IdleGazeController({ clock, random: () => 1, config: { ...config, pointerReleaseDelayMs: 0 } })
    gaze.update({ now: 100, semanticState: "NORMAL", pointerActive: false })
    gaze.reset(100)
    expect(gaze.getDiagnostics()).toMatchObject({ active: false, eyeX: 0, eyeY: 0, headX: 0, headY: 0 })
  })
})
