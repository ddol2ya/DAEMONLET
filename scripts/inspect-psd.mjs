#!/usr/bin/env node

import { basename, resolve } from "node:path"
import { readFileSync } from "node:fs"
import { initializeCanvas, readPsd } from "ag-psd"
import "../src/engine/anime25d/upstream/rigger.js"

initializeCanvas(
  () => { throw new Error("Canvas is not used by the PSD inspector") },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
)

const [psdArgument, overridesArgument] = process.argv.slice(2)
if (!psdArgument) {
  console.error("Usage: node scripts/inspect-psd.mjs <file.psd> [rig-overrides.json]")
  process.exit(2)
}

const psdPath = resolve(psdArgument)
const overrides = overridesArgument ? JSON.parse(readFileSync(resolve(overridesArgument), "utf8")) : {}
const parsed = readPsd(readFileSync(psdPath), { useImageData: true, skipThumbnail: true, skipCompositeImageData: true })

const cloneLayer = (layer) => ({
  ...layer,
  imageData: layer.imageData ? { width: layer.imageData.width, height: layer.imageData.height, data: new Uint8ClampedArray(layer.imageData.data) } : undefined,
  children: layer.children?.map(cloneLayer),
})
const cleaned = { ...parsed, children: parsed.children?.map(cloneLayer) }
const normalized = (name) => globalThis.Rigger.normName(name)
const thresholds = overrides.cleanupThresholds ?? {}
globalThis.Rigger.cleanPsdLayers(cleaned, { cleanupThresholds: thresholds })

const alphaCount = (layer) => {
  let count = 0
  for (let index = 3; index < (layer.imageData?.data.length ?? 0); index += 4) if (layer.imageData.data[index]) count++
  return count
}

const rawLayers = (parsed.children ?? []).filter((layer) => layer.imageData)
const cleanedLayers = (cleaned.children ?? []).filter((layer) => layer.imageData)
const layers = rawLayers.map((layer, order) => ({
  name: layer.name || "unnamed",
  normalizedName: normalized(layer.name || "unnamed"),
  order,
  bounds: [layer.left ?? 0, layer.top ?? 0, layer.right ?? 0, layer.bottom ?? 0],
  alphaBefore: alphaCount(layer),
  alphaAfter: alphaCount(cleanedLayers[order]),
}))
const neck = layers.find((layer) => layer.normalizedName === "neck")
const warnings = []
if (!neck) warnings.push("neck layer missing")
else if (!neck.alphaAfter) warnings.push("neck layer empty after cleanup")
if (!layers.some((layer) => layer.normalizedName.startsWith("eye_close"))) warnings.push("dedicated eye_close missing; runtime will use generic fallback")

console.log(JSON.stringify({
  source: basename(psdPath),
  canvas: [parsed.width, parsed.height],
  layers,
  warnings,
}, null, 2))
