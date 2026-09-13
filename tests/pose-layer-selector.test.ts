import { describe, expect, it } from "vitest"
import type { RigDefinition, RigLayer } from "../src/engine/anime25d/types"
import { selectPoseLayers } from "../src/pose/PoseLayerSelector"

const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) }
const layer = (name: string, group: string): RigLayer => ({ name, group, x: 0, y: 0, w: 1, h: 1, z: 0, depth: 1, phys: null, fade: null, side: null, strands: null, img: image })
const rig = (layers: RigLayer[]): RigDefinition => ({
  canvas: { w: 100, h: 100 }, layers,
  anchors: { face: { x0: 0, y0: 0, x1: 1, y1: 1, cx: .5, cy: .5 }, mouth: { x0: 0, y0: 0, x1: 1, y1: 1, cx: .5, cy: .5 }, neckPivot: { cx: .5, cy: 2 }, bodyPivot: { cx: .5, cy: 99 }, neckTop: 1, neckBottom: 2, hairRootY: 0, faceScale: 1 },
  warnings: [], synth: { eye: false, mouth: false },
})
const config = { sharedFromBase: ["face", "front hair"], replaceFromBase: ["topwear", "handwear"], useFromPose: ["topwear", "handwear"], addFromPose: ["objects"] }

describe("pose layer selection", () => {
  it("keeps head layers base-only and selects local pose layers", () => {
    const result = selectPoseLayers(
      rig([layer("face", "head"), layer("front hair", "head"), layer("topwear", "body"), layer("handwear_1", "body"), layer("handwear_2", "body")]),
      rig([layer("face", "head"), layer("topwear", "body"), layer("handwear_1", "body"), layer("objects", "body")]),
      config,
    )
    expect(result.errors).toEqual([])
    expect(result.baseShared).toEqual(["face", "front hair"])
    expect(result.poseReplace).toEqual(["topwear", "handwear_1"])
    expect(result.poseAdditive).toEqual(["objects"])
    expect(result.renderBehindBase).toEqual([])
    expect(result.renderInFrontOfBase).toEqual([])
    expect(result.poseReplace).not.toContain("face")
  })

  it("reports collisions, missing semantics, and pose identity layers", () => {
    const result = selectPoseLayers(rig([layer("face", "head")]), rig([layer("face", "head")]), {
      sharedFromBase: ["face"], replaceFromBase: ["face", "topwear"], useFromPose: ["face"], addFromPose: ["objects"],
    })
    expect(result.errors.join(" ")).toMatch(/both shared and replaced/)
    expect(result.errors.join(" ")).toMatch(/was not found/)
    expect(result.errors.join(" ")).toMatch(/identity layer/)
  })

  it("treats a generated front overlay as part of its source semantic layer", () => {
    const result = selectPoseLayers(
      rig([layer("face", "head"), layer("bottomwear", "body"), layer("bottomwear front", "body")]),
      rig([layer("bottomwear", "body")]),
      { sharedFromBase: ["face"], replaceFromBase: ["bottomwear"], useFromPose: ["bottomwear"], addFromPose: [] },
    )
    expect(result.baseReplace).toEqual(["bottomwear", "bottomwear front"])
  })

  it("can select one directional generated part without replacing its sibling", () => {
    const result = selectPoseLayers(
      rig([layer("face", "head"), layer("handwear_1", "body"), layer("handwear_2", "body")]),
      rig([layer("handwear_1", "body"), layer("handwear_2", "body")]),
      { sharedFromBase: ["face", "handwear_1"], replaceFromBase: ["handwear_2"], useFromPose: ["handwear_2"], addFromPose: [] },
    )
    expect(result.errors).toEqual([])
    expect(result.baseShared).toEqual(["face", "handwear_1"])
    expect(result.baseReplace).toEqual(["handwear_2"])
    expect(result.poseReplace).toEqual(["handwear_2"])
  })
})
