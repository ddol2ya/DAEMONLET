import { afterEach, describe, expect, it, vi } from "vitest"
import { PoseAssetLoader } from "../src/pose/PoseAssetLoader"
import { parsePoseManifest } from "../src/pose/PoseManifest"
import { PsdRigLoader } from "../src/engine/anime25d/PsdRigLoader"
import { applyRigOverrides } from "../src/engine/anime25d/RigOverrides"
import { Anime25DRuntime } from "../src/engine/anime25d/Anime25DRuntime"
import type { RigDefinition, RigLayer, RigLoadResult } from "../src/engine/anime25d/types"
import type { PoseManifest } from "../src/pose/types"

const layer = (name: string, x = 0, width = 2): RigLayer => ({
  name, x, y: 0, w: width, h: 2, z: 0, depth: 1, group: name === "face" ? "head" : "body",
  phys: null, fade: null, side: null, strands: null,
  img: { width, height: 2, data: new Uint8ClampedArray(width * 2 * 4).fill(255) },
})
const rig = (shift = 0): RigDefinition => ({
  canvas: { w: 100, h: 100 }, warnings: [], synth: { eye: false, mouth: false },
  layers: [layer("topwear"), layer("face"), layer("handwear_1")],
  anchors: {
    face: { x0: 20, y0: 10, x1: 80, y1: 50, cx: 50, cy: 30 },
    eyeL: { x0: 28, y0: 25, x1: 34, y1: 31, icx: 31 + shift, icy: 28, closeY: 30 },
    eyeR: { x0: 66, y0: 25, x1: 72, y1: 31, icx: 69 + shift, icy: 28 + shift, closeY: 30 },
    mouth: { x0: 46, y0: 40, x1: 54, y1: 44, cx: 50 + shift, cy: 42 },
    neckPivot: { cx: 50 + shift, cy: 58 }, bodyPivot: { cx: 50, cy: 95 },
    neckTop: 50, neckBottom: 60, hairRootY: 0, faceScale: 1,
  },
})
const manifest = (): PoseManifest => ({
  schemaVersion: 1, id: "waiting", label: "Waiting", source: "source.png", psd: "model.psd",
  strategy: "independent-model", registration: { strategy: "identity", maxScaleDelta: 0, maxRotationDeg: 0, maxAnchorErrorPx: 0 },
  layers: { sharedFromBase: [], replaceFromBase: [], useFromPose: [], addFromPose: [] },
  transition: { enterMs: 280, exitMs: 240, swapStart: 0, swapEnd: 1 },
})
const setup = (model: RigDefinition) => {
  const psd = new PsdRigLoader()
  vi.spyOn(psd, "loadArrayBuffer").mockReturnValue({ model: { rig: model } } as RigLoadResult)
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))))
  return new PoseAssetLoader(psd)
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("independent pose models", () => {
  it("keeps the source face and body in their own coordinates despite a different idle face", async () => {
    const idle = rig(), own = rig(15)
    const asset = await setup(own).load("http://localhost/waiting/pose.json", idle, { manifest: manifest() })
    expect(asset.registration).toMatchObject({ accepted: true, scale: 1, rotationDeg: 0, eyeResidualError: 0, neckResidualError: 0 })
    expect(asset.registration.transform).toMatchObject({ translationX: 0, translationY: 0 })
    expect(asset.result.model.rig.anchors).toBe(own.anchors)
    expect(asset.selection.baseShared).toEqual([])
    expect(asset.selection.baseReplace).toEqual(idle.layers.map(part => part.name))
    expect(asset.selection.poseReplace).toEqual(own.layers.map(part => part.name))
    expect(asset.selection.errors).toEqual([])
    expect(asset.selection.independentModel).toBe(true)
  })

  it("rejects mismatched canvas dimensions instead of silently scaling a whole character", async () => {
    const own = rig(); own.canvas.w = 200
    await expect(setup(own).load("http://localhost/waiting/pose.json", rig(), { manifest: manifest() })).rejects.toThrow(/matching canvas dimensions/)
  })

  it("still rejects head artwork in the existing semantic swap strategy", async () => {
    const definition: PoseManifest = { ...manifest(), strategy: "semantic-layer-swap",
      registration: { strategy: "eyes-and-neck", maxScaleDelta: .1, maxRotationDeg: 5, maxAnchorErrorPx: 15 },
      layers: { sharedFromBase: [], replaceFromBase: ["face"], useFromPose: ["face"], addFromPose: [] },
    }
    const asset = await setup(rig()).load("http://localhost/old/pose.json", rig(), { manifest: definition })
    expect(asset.selection.errors).toContain("pose head/identity layer 'face' cannot be rendered by semantic-layer-swap")
    expect(asset.selection.independentModel).toBeUndefined()
  })

  it("requires the explicit identity contract and forbids foreign Base selectors", () => {
    expect(parsePoseManifest(manifest()).warnings).toEqual([])
    expect(() => parsePoseManifest({ ...manifest(), registration: { ...manifest().registration, strategy: "eyes-and-neck" } })).toThrow(/identity/)
    expect(() => parsePoseManifest({ ...manifest(), layers: { ...manifest().layers, sharedFromBase: ["face"] } })).toThrow(/whole rig/)
    expect(() => parsePoseManifest({ ...manifest(), strategy: "semantic-layer-swap" })).toThrow(/eyes-and-neck/)
  })

  it("validates motion selectors against the complete visible model", async () => {
    const definition = manifest()
    definition.motion = { loopDurationMs: 1000, parameters: {}, layers: { missing_arm: { translateX: { type: "constant", value: 2 } } } }
    const loader = setup(rig())
    const asset = await loader.load("http://localhost/waiting/pose.json", rig(), { manifest: definition })
    expect(asset.selection.errors).toContain("pose motion layer selector 'missing_arm' is not selected for rendering")
    expect(loader.cachedAssetCount).toBe(0)
  })

  it("removes reference artwork only after skin and sleeve inherit its mesh and deformation", () => {
    const source = rig()
    source.layers = [layer("topwear"), layer("arm_mesh_1", 10, 8), layer("handwear_1", 12), layer("sleeve_back_1", 14)]
    const before = structuredClone(source)
    const result = applyRigOverrides(source, {
      deformationSources: { arm_mesh_1: "topwear" },
      meshSources: { handwear_1: "arm_mesh_1", sleeve_back_1: "arm_mesh_1" },
      excludeAfterMeshResolution: ["arm_mesh_1"],
    })
    expect(result.layers.map(part => part.name)).toEqual(["topwear", "handwear_1", "sleeve_back_1"])
    for (const part of result.layers.slice(1)) expect(part).toMatchObject({ x: 10, w: 8, meshSource: "arm_mesh_1", deformationSource: "topwear" })
    expect(source).toEqual(before)
  })

  it("places the speech bubble relative to the displayed independent face and restores idle geometry", () => {
    const runtime = Object.create(Anime25DRuntime.prototype) as Anime25DRuntime
    const idle = rig(), own = rig(15)
    own.anchors.face = { ...own.anchors.face, cx: 65, cy: 40 }
    Object.assign(runtime, { model: { rig: idle }, poseAsset: { selection: { independentModel: true }, result: { model: { rig: own } } }, poseDiagnostics: { mix: 1 } })
    expect(runtime.getBaseFaceGeometry()?.face).toEqual(own.anchors.face)
    Object.assign(runtime, { poseDiagnostics: { mix: 0 } })
    expect(runtime.getBaseFaceGeometry()?.face).toEqual(idle.anchors.face)
  })
})
