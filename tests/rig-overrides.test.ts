import { describe, expect, it } from "vitest"
import { applyRigOverrides } from "../src/engine/anime25d/RigOverrides"
import type { RigDefinition, RigLayer } from "../src/engine/anime25d/types"

const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) }
const makeLayer = (name: string, group = "body"): RigLayer => ({ name, group, x: 0, y: 0, w: 1, h: 1, z: 0, depth: 1, phys: null, fade: null, side: null, strands: null, img: image })
const rig: RigDefinition = {
  canvas: { w: 100, h: 100 }, layers: [makeLayer("face", "head"), makeLayer("neck"), makeLayer("topwear")],
  anchors: { face: { x0: 20, y0: 10, x1: 80, y1: 70, cx: 50, cy: 40 }, mouth: { x0: 40, y0: 50, x1: 60, y1: 60, cx: 50, cy: 55 }, neckPivot: { cx: 50, cy: 72 }, bodyPivot: { cx: 50, cy: 100 }, neckTop: 65, neckBottom: 80, hairRootY: 15, faceScale: 1 },
  warnings: [], synth: { eye: false, mouth: false },
}

describe("rig overrides", () => {
  it("binds a cropped foreground to its source mesh while preserving only its own pixels", () => {
    const source = { ...makeLayer("back hair", "head"), x: 10, y: 20, w: 4, h: 4, phys: "hair" as const, strands: [{ x: 12, rootY: 20, tipY: 24 }], img: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) } }
    const cutout = { ...makeLayer("front hair_2"), x: 11, y: 22, w: 2, h: 1, z: 8, img: { width: 2, height: 1, data: new Uint8ClampedArray([90, 65, 60, 128, 110, 80, 75, 255]) } }
    const result = applyRigOverrides({ ...rig, layers: [cutout, source] }, { meshSources: { "front hair_2": "back hair" }, hairAttachments: { "back hair": { rootY: 20, bodyY: 24 } } })
    const front = result.layers[0]
    expect(front).toMatchObject({ x: 10, y: 20, w: 4, h: 4, z: 8, group: "head", phys: "hair", strands: source.strands, meshSource: "back hair", hairAttachment: { rootY: 20, bodyY: 24 } })
    expect([...front.img.data.slice(36, 44)]).toEqual([90, 65, 60, 128, 110, 80, 75, 255])
    expect([...front.img.data].filter((_, i) => i % 4 === 3 && i !== 39 && i !== 43).every(alpha => alpha === 0)).toBe(true)
    expect(source.img.data.every(value => value === 255)).toBe(true)
    expect(cutout.img.width).toBe(2)
  })

  it("ignores missing or cyclic mesh sources and resolves valid chains regardless of layer order", () => {
    const invalid: Array<Record<string, string>> = [{ face: "missing" }, { face: "neck", neck: "face" }, { face: "face" }]
    for (const meshSources of invalid) {
      const result = applyRigOverrides(rig, { meshSources })
      expect(result.layers.every(layer => !layer.meshSource)).toBe(true)
      expect(result.layers.map(layer => layer.img)).toEqual(rig.layers.map(layer => layer.img))
    }
    const result = applyRigOverrides(rig, { meshSources: { face: "neck", neck: "topwear" } })
    expect(result.layers.map(layer => layer.meshSource)).toEqual(["neck", "topwear", undefined])
  })

  it("places a separately matted foreground on the source mesh without copying its background", () => {
    const arm = { ...makeLayer("handwear_1"), x: 10, y: 20, w: 4, h: 4, img: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) } }
    const texture = { ...makeLayer("nativefront_1"), x: 11, y: 22, w: 2, h: 1, img: { width: 2, height: 1, data: new Uint8ClampedArray([90, 65, 60, 128, 110, 80, 75, 255]) } }
    const input = { ...rig, layers: [arm, makeLayer("topwear"), texture] }
    const result = applyRigOverrides(input, {
      maskedLayerOverlays: [{ source: "handwear_1", textureSource: "nativefront_1", name: "forearm_1", inFrontOf: "topwear", polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] }],
      deformationSources: { forearm_1: "handwear_1" },
    })
    const front = result.layers.find(layer => layer.name === "forearm_1")!
    expect(front).toMatchObject({ x: 10, y: 20, w: 4, h: 4, deformationSource: "handwear_1" })
    expect([...front.img.data.slice(36, 44)]).toEqual([90, 65, 60, 128, 110, 80, 75, 255])
    expect([...front.img.data].filter((_, i) => i % 4 === 3 && i !== 39 && i !== 43).every(alpha => alpha === 0)).toBe(true)
    expect(result.layers.map(layer => layer.name)).toEqual(["handwear_1", "topwear", "forearm_1"])
    expect(arm.img.data.every(channel => channel === 255)).toBe(true)
    expect(input.layers).toContain(texture)
  })

  it("keeps long side hair attached between head and body without changing the anchors", () => {
    const hair = { ...makeLayer("front hair_2", "head"), phys: "hair" as const }
    const input = { ...rig, layers: [...rig.layers, hair] }
    const result = applyRigOverrides(input, { groupOverrides: { "front hair_2": "body" }, hairAttachments: { "front hair_2": { rootY: 30, bodyY: 65 } } })
    expect(result.layers.at(-1)).toMatchObject({ group: "body", phys: "hair", hairAttachment: { rootY: 30, bodyY: 65 } })
    expect(result.anchors).toEqual(input.anchors)
    expect(hair).not.toHaveProperty("hairAttachment")
    for (const value of [{ rootY: 30, bodyY: 30 }, { rootY: NaN, bodyY: 65 }]) {
      expect(applyRigOverrides(input, { hairAttachments: { "front hair_2": value } }).layers.at(-1)).not.toHaveProperty("hairAttachment")
    }
  })

  it("rebuilds a cropped seam from intact source pixels and attaches it to the garment", () => {
    const source = { ...makeLayer("neck"), w: 4, h: 4, img: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) } }
    const collar = { ...makeLayer("topwear"), depth: .9 }
    const input = { ...rig, canvas: { w: 4, h: 4 }, layers: [source, collar, makeLayer("neck_2")] }
    const result = applyRigOverrides(input, {
      maskedLayerOverlays: [{ source: "neck", name: "neck_2", inFrontOf: "topwear", replaceExisting: true, featherPx: 1, polygon: [[0, 0], [1, 0], [1, .625], [0, .625]] }],
      deformationSources: { neck: "topwear" },
    })
    const seam = result.layers.find(layer => layer.name === "neck_2")!
    expect(result.layers.filter(layer => layer.name === "neck_2")).toHaveLength(1)
    expect(seam).toMatchObject({ deformationSource: "topwear", depth: .9, group: "body", synthetic: true })
    expect([0, 1, 2, 3].map(y => seam.img.data[(y * 4 + 1) * 4 + 3])).toEqual([255, 255, 128, 0])
    expect(source.img.data.every(channel => channel === 255)).toBe(true)
    expect(input.layers[2].img.width).toBe(1)
  })

  it("applies layer order, depth and group without character conditionals", () => {
    const result = applyRigOverrides(rig, { layerOrder: ["topwear", "neck", "face"], depthOverrides: { neck: 1.04 }, groupOverrides: { neck: "head" } })
    expect(result.layers.map((layer) => layer.name)).toEqual(["topwear", "neck", "face"])
    expect(result.layers[1]).toMatchObject({ depth: 1.04, group: "head", z: 1 })
  })

  it("enforces stable relative occlusion constraints without replacing the complete source order", () => {
    const result = applyRigOverrides(rig, {
      layerOrderConstraints: [
        { behind: "topwear", inFrontOf: "neck" },
        { behind: "neck", inFrontOf: "face" },
      ],
    })
    expect(result.layers.map((layer) => layer.name)).toEqual(["topwear", "neck", "face"])
    expect(result.layers.map((layer) => layer.z)).toEqual([0, 1, 2])
  })

  it("keeps all layers when relative occlusion constraints contain a cycle", () => {
    const result = applyRigOverrides(rig, {
      layerOrderConstraints: [
        { behind: "face", inFrontOf: "neck" },
        { behind: "neck", inFrontOf: "face" },
      ],
    })
    expect(result.layers.map((layer) => layer.name)).toEqual(["face", "neck", "topwear"])
  })

  it("creates a normalized masked overlay directly above its occluder", () => {
    const solid = { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]) }
    const bottomwear = { ...makeLayer("bottomwear"), w: 2, img: solid }
    const result = applyRigOverrides({ ...rig, canvas: { w: 2, h: 1 }, layers: [bottomwear, makeLayer("legwear")] }, {
      maskedLayerOverlays: [{
        source: "bottomwear",
        name: "bottomwear front",
        inFrontOf: "legwear",
        polygon: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]],
      }],
    })
    expect(result.layers.map((layer) => layer.name)).toEqual(["bottomwear", "legwear", "bottomwear front"])
    expect([...result.layers[2].img.data]).toEqual([255, 255, 255, 255, 255, 255, 255, 0])
  })

  it("can remove neutral inpaint fill while retaining colored garment pixels", () => {
    const pixels = { width: 2, height: 1, data: new Uint8ClampedArray([80, 100, 150, 255, 100, 102, 108, 255]) }
    const result = applyRigOverrides({ ...rig, canvas: { w: 2, h: 1 }, layers: [{ ...makeLayer("bottomwear"), w: 2, img: pixels }, makeLayer("legwear")] }, {
      maskedLayerOverlays: [{
        source: "bottomwear",
        name: "bottomwear front",
        inFrontOf: "legwear",
        polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
        excludeConnectedNeutral: { maxChroma: 18, minLuminance: 70, maxLuminance: 145, maxColorStep: 14 },
      }],
    })
    expect([...result.layers[2].img.data]).toEqual([80, 100, 150, 255, 100, 102, 108, 0])
  })

  it("retains neutral garment pixels that are enclosed by a colored outline", () => {
    const data = new Uint8ClampedArray(3 * 3 * 4)
    for (let index = 0; index < 9; index++) data.set(index === 4 ? [100, 102, 108, 255] : [80, 100, 150, 255], index * 4)
    const result = applyRigOverrides({ ...rig, canvas: { w: 3, h: 3 }, layers: [{ ...makeLayer("bottomwear"), w: 3, h: 3, img: { width: 3, height: 3, data } }, makeLayer("legwear")] }, {
      maskedLayerOverlays: [{
        source: "bottomwear",
        name: "bottomwear front",
        inFrontOf: "legwear",
        polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
        excludeConnectedNeutral: { maxChroma: 18, minLuminance: 70, maxLuminance: 145, maxColorStep: 14 },
      }],
    })
    expect(result.layers[2].img.data[4 * 4 + 3]).toBe(255)
  })

  it("repairs a generated streak by interpolating between intact pixels", () => {
    const data = new Uint8ClampedArray([
      10, 10, 10, 255,
      20, 20, 20, 255,
      255, 0, 0, 255,
      40, 40, 40, 255,
      50, 50, 50, 255,
    ])
    const result = applyRigOverrides({ ...rig, canvas: { w: 5, h: 1 }, layers: [{ ...makeLayer("legwear"), w: 5, img: { width: 5, height: 1, data } }] }, {
      interpolatedPatchRepairs: [{ layer: "legwear", axis: "horizontal", polygon: [[0.4, 0], [0.6, 0], [0.6, 1], [0.4, 1]] }],
    })
    expect([...result.layers[0].img.data.slice(8, 12)]).toEqual([30, 30, 30, 255])
  })
})
