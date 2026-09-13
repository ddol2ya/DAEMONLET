import { describe, expect, it } from "vitest"
import type { RigDefinition, RigLayer } from "../src/engine/anime25d/types"
import { HitAreaResolver } from "../src/interaction/HitAreaResolver"
import { applyRigOverrides } from "../src/engine/anime25d/RigOverrides"

const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) }
const layer = (name: string, group: "head" | "body", x: number, y: number, w: number, h: number): RigLayer => ({
  name, group, x, y, w, h, z: 0, depth: 1, phys: null, fade: null, side: null, strands: null, img: image,
})
const rig: RigDefinition = {
  canvas: { w: 200, h: 300 },
  layers: [layer("face", "head", 50, 30, 100, 120), layer("topwear", "body", 35, 145, 130, 140)],
  anchors: {
    face: { x0: 60, y0: 40, x1: 140, y1: 130, cx: 100, cy: 85 },
    mouth: { x0: 90, y0: 100, x1: 110, y1: 112, cx: 100, cy: 106 },
    neckPivot: { cx: 100, cy: 145 }, bodyPivot: { cx: 100, cy: 300 }, neckTop: 130, neckBottom: 160, hairRootY: 50, faceScale: 1,
  },
  warnings: [], synth: { eye: false, mouth: false },
}

describe("HitAreaResolver", () => {
  const resolver = new HitAreaResolver(rig)
  it("prioritizes face anchors", () => expect(resolver.resolve(100, 80)).toBe("face"))
  it("uses head layer union", () => expect(resolver.resolve(52, 35)).toBe("head"))
  it("uses body layer union", () => expect(resolver.resolve(100, 230)).toBe("torso"))
  it("returns background outside model bounds", () => expect(resolver.resolve(5, 5)).toBe("background"))

  it("does not let waist-length back hair steal the torso center", () => {
    const longHairRig = { ...rig, layers: [...rig.layers, layer("back hair", "head", 20, 5, 160, 285)] }
    const longHairResolver = new HitAreaResolver(longHairRig)
    expect(longHairResolver.resolve(100, 230)).toBe("torso")
    expect(longHairResolver.resolve(100, 25)).toBe("head")
  })

  it("separates an inpainted scalp from face input without moving rig anchors", () => {
    const authored = applyRigOverrides(rig, { interactionAreas: { face: { x0: 60, x1: 140, y0: 75, y1: 135 } } })
    const authoredResolver = new HitAreaResolver(authored)
    expect(authoredResolver.resolve(100, 50)).toBe("head")
    expect(authoredResolver.resolve(100, 100)).toBe("face")
    expect(authoredResolver.resolve(100, 230)).toBe("torso")
    expect(authored.anchors).toEqual(rig.anchors)
    expect(resolver.resolve(100, 50)).toBe("face")
  })

  it("falls back from malformed authored input bounds", () => {
    const invalid = new HitAreaResolver({ ...rig, interactionAreas: { face: { x0: NaN, x1: 10, y0: 0, y1: 10 }, torso: { x0: 100, x1: 0, y0: 0, y1: 100 } } })
    expect(invalid.areas).toEqual(resolver.areas)
  })
})
