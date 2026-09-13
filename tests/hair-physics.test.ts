import { describe, expect, it } from "vitest"
import { blendSpringOffset, rootWeightedAmount, stepSpring } from "../src/engine/anime25d/HairPhysicsConfig"

describe("hair physics math", () => {
  it("locks roots and increases movement toward the tip", () => {
    expect(rootWeightedAmount(0.2, 0.3, 2)).toBe(0)
    expect(rootWeightedAmount(0.7, 0.3, 2)).toBeGreaterThan(0)
    expect(rootWeightedAmount(1, 0.3, 2)).toBe(1)
  })

  it("clamps softness interpolation instead of extrapolating", () => {
    expect(blendSpringOffset(2, 8, 2)).toBe(8)
    expect(blendSpringOffset(2, 8, -1)).toBe(2)
  })

  it("keeps impulses finite and inside maximum displacement", () => {
    let spring = { x: 0, v: 120, dx: 0 }
    for (let index = 0; index < 600; index++) spring = stepSpring(spring, 0, 50, 10, 18, 1 / 120)
    expect(Number.isFinite(spring.x)).toBe(true)
    expect(Number.isFinite(spring.v)).toBe(true)
    expect(Math.abs(spring.x)).toBeLessThanOrEqual(18)
    expect(Math.abs(spring.x)).toBeLessThan(0.01)
  })

  it("has similar peaks and settle time at 30/60/120Hz", () => {
    const simulate = (fps: number) => {
      let spring = { x: 0, v: 38, dx: 0 }
      let peak = 0
      let settledAt = 5
      for (let frame = 0; frame < fps * 5; frame++) {
        spring = stepSpring(spring, 0, 48, 9.5, 22, 1 / fps)
        peak = Math.max(peak, Math.abs(spring.x))
        if (frame > fps * 0.25 && Math.abs(spring.x) < 0.02 && Math.abs(spring.v) < 0.08) {
          settledAt = frame / fps
          break
        }
      }
      return { peak, settledAt, spring }
    }
    const samples = [30, 60, 120].map(simulate)
    expect(Math.max(...samples.map((sample) => sample.peak)) - Math.min(...samples.map((sample) => sample.peak))).toBeLessThan(0.08)
    expect(Math.max(...samples.map((sample) => sample.settledAt)) - Math.min(...samples.map((sample) => sample.settledAt))).toBeLessThan(0.08)
    for (const sample of samples) expect(Number.isFinite(sample.spring.x)).toBe(true)
  })

  it("preserves rest and safely substeps a long frame", () => {
    expect(stepSpring({ x: 0, v: 0, dx: 0 }, 0, 48, 9.5, 22, 1 / 30)).toEqual({ x: 0, v: 0, dx: 0 })
    const result = stepSpring({ x: 0, v: 800, dx: 0 }, 0, 48, 9.5, 22, 0.2)
    expect(Number.isFinite(result.x)).toBe(true)
    expect(Math.abs(result.x)).toBeLessThanOrEqual(22)
  })
})
