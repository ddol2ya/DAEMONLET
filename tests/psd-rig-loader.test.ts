import { initializeCanvas, writePsd, type Layer, type Psd } from "ag-psd"
import { describe, expect, it } from "vitest"
import { PsdRigLoader } from "../src/engine/anime25d/PsdRigLoader"

const W = 160
const H = 220

initializeCanvas(
  (() => { throw new Error("Canvas access is not expected for useImageData tests") }) as unknown as (width: number, height: number) => HTMLCanvasElement,
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }) as ImageData,
)

function rectangleLayer(name: string, rectangles: Array<[number, number, number, number]>, color: [number, number, number] = [80, 90, 110]): Layer {
  const data = new Uint8ClampedArray(W * H * 4)
  for (const [x0, y0, x1, y1] of rectangles) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * W + x) * 4
    data[offset] = color[0]
    data[offset + 1] = color[1]
    data[offset + 2] = color[2]
    data[offset + 3] = 255
  }
  return { name, left: 0, top: 0, right: W, bottom: H, imageData: { width: W, height: H, data } }
}

describe("PsdRigLoader integration", () => {
  it("parses a PSD ArrayBuffer and calls the actual rigger", () => {
    const psd: Psd = {
      width: W,
      height: H,
      children: [
        rectangleLayer("back hair", [[28, 12, 132, 150]]),
        rectangleLayer("topwear", [[30, 125, 130, 218]]),
        rectangleLayer("face", [[42, 28, 118, 126]], [235, 210, 200]),
        rectangleLayer("mouth", [[72, 98, 88, 104]], [120, 35, 45]),
        rectangleLayer("eyewhite", [[53, 62, 68, 70], [92, 62, 107, 70]], [250, 250, 250]),
        rectangleLayer("irides", [[57, 61, 65, 70], [96, 61, 104, 70]], [40, 130, 180]),
        rectangleLayer("eyelash", [[51, 57, 69, 61], [90, 57, 108, 61]], [20, 20, 28]),
        rectangleLayer("front hair", [[35, 10, 125, 58]]),
      ],
    }
    const buffer = writePsd(psd, { generateThumbnail: false })
    const result = new PsdRigLoader().loadArrayBuffer(buffer, "synthetic.psd")
    expect(result.model.rig.layers.length).toBeGreaterThanOrEqual(10)
    expect(result.model.rig.anchors.face.cx).toBeGreaterThan(70)
    expect(result.model.rig.anchors.eyeL).toBeDefined()
    expect(result.model.rig.anchors.eyeR).toBeDefined()
    expect(result.model.rig.layers.some((layer) => layer.strands?.length)).toBe(true)
    expect(result.model.rig.synth.eye).toBe(true)
    expect(result.model.rig.synth.mouth).toBe(true)
    expect(result.model.missingRequiredLayers).toEqual([])
  })
})
