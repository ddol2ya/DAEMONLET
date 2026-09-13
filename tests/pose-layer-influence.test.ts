import { describe, expect, it } from "vitest"
import { computePoseLayerInfluenceWeight, sampleBreathingMotion } from "../src/engine/anime25d/Anime25DRenderer"

describe("pose layer joint influence", () => {
  const origin = { x: 0.16, y: 0.88 }
  const influence = { axisX: 0.85, axisY: 0.53, start: 0.07, end: 0.18 }

  it("locks the writing shoulder while fully moving the hand", () => {
    expect(computePoseLayerInfluenceWeight(0.7, 0.1, origin, influence)).toBe(0)
    expect(computePoseLayerInfluenceWeight(0.7, 0.55, origin, influence)).toBe(1)
  })

  it("feathers the sleeve around the elbow and defaults to rigid motion", () => {
    const sleeve = computePoseLayerInfluenceWeight(0.4, 0.68, origin, influence)
    expect(sleeve).toBeGreaterThan(0)
    expect(sleeve).toBeLessThan(1)
    expect(computePoseLayerInfluenceWeight(0.2, 0.8, origin)).toBe(1)
  })

})

describe("idle breathing motion", () => {
  it("oscillates around the authored neutral pose with a smaller delayed head response", () => {
    const inhale = sampleBreathingMotion(3.8 / 4)
    const exhale = sampleBreathingMotion(3.8 * 3 / 4)

    expect(inhale.breath).toBeCloseTo(1.6)
    expect(exhale.breath).toBeCloseTo(-1.6)
    expect(Math.abs(inhale.breathHead)).toBeLessThan(Math.abs(inhale.breath))
    expect(Math.abs(exhale.breathHead)).toBeLessThan(Math.abs(exhale.breath))
  })
})
