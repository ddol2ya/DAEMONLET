import { initializeCanvas } from "ag-psd"
import { PsdRigLoader } from "./PsdRigLoader"
import type { RigOverrides } from "./RigOverrides"

initializeCanvas(() => { throw new Error("Raster canvas is unavailable in the decoder") },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }))
const loader = new PsdRigLoader()
self.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; name: string; overrides: RigOverrides }>) => {
  try {
    const { buffer, name, overrides } = event.data
    const { model, preprocessing } = loader.loadArrayBuffer(buffer, name, overrides)
    const result = { preprocessing, model: { sourceName: model.sourceName, rig: model.rig,
      psdLayers: model.psdLayers, missingRequiredLayers: model.missingRequiredLayers, assetDiagnostics: model.assetDiagnostics } }
    const transfer = [...new Set(model.rig.layers.map(layer => layer.img.data.buffer as ArrayBuffer))]
    self.postMessage({ result }, { transfer })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
