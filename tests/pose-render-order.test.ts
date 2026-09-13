import { describe, expect, it } from "vitest"
import { basePoseLayerAlpha, constrainPoseRenderSlot } from "../src/engine/anime25d/Anime25DRenderer"

describe("cross-source pose render order", () => {
  it("never reveals the relaxed Base arms between two active arm poses", () => {
    for (let step = 0; step <= 100; step++) {
      const mix = step / 100
      expect(basePoseLayerAlpha(1, mix, true, true)).toBe(0)
      expect(basePoseLayerAlpha(1, mix, false, false)).toBe(1)
      expect(basePoseLayerAlpha(1, mix, true, false)).toBeCloseTo(mix)
      expect(basePoseLayerAlpha(.5, mix, true, true)).toBeCloseTo(.5)
    }
  })
  it("keeps pose topwear behind the shared base neck", () => {
    const base = [{ name: "topwear", renderSlot: 7 }, { name: "neck", renderSlot: 8 }, { name: "neckwear", renderSlot: 9 }]
    expect(constrainPoseRenderSlot("topwear", 12, base, [{ pose: "topwear", base: "neck" }])).toBe(7.99)
    expect(constrainPoseRenderSlot("objects", 13, base, [{ pose: "topwear", base: "neck" }])).toBe(13)
  })

  it("keeps a pose memo in front of shared base hair", () => {
    const base = [{ name: "front hair", renderSlot: 10 }]
    expect(constrainPoseRenderSlot("objects", 5, base, [], [{ pose: "objects", base: "front hair" }])).toBe(10.01)
  })

  it("sandwiches the long-hair writing sleeve behind the chest and hand in front", () => {
    const base = [{ name: "back hair_1", renderSlot: 2 }, { name: "topwear", renderSlot: 10 }]
    const upperArm = constrainPoseRenderSlot(
      "handwear_2",
      15,
      base,
      [{ pose: "handwear_2", base: "topwear" }],
      [{ pose: "handwear_2", base: "back hair" }],
    )
    const writingSleeve = constrainPoseRenderSlot(
      "forearm_2",
      15,
      base,
      [{ pose: "forearm_2", base: "topwear" }],
      [{ pose: "forearm_2", base: "back hair" }],
    )
    const writingHand = constrainPoseRenderSlot("hand_2", 8, base, [], [{ pose: "hand_2", base: "topwear" }])

    expect(upperArm).toBeGreaterThan(2)
    expect(upperArm).toBeLessThan(10)
    expect(writingSleeve).toBeGreaterThan(2)
    expect(writingSleeve).toBeLessThan(10)
    expect(writingHand).toBeGreaterThan(10)
  })
})
