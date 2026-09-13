#!/usr/bin/env node

import { readRgba } from "./characters/png-rgba.mjs"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { initializeCanvas, writePsd } from "ag-psd"

const [metadataArgument, outputArgument, overridesArgument] = process.argv.slice(2)
if (!metadataArgument || !outputArgument) {
  console.error("Usage: node scripts/build-seethrough-psd.mjs <layers.json> <output.psd> [rig-overrides.json]")
  process.exit(2)
}

initializeCanvas(
  () => { throw new Error("Canvas is not used by this imageData-only exporter") },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }),
)

const metadataPath = resolve(metadataArgument)
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
const overrides = overridesArgument ? JSON.parse(readFileSync(resolve(overridesArgument), "utf8")) : {}
const composite = new Uint8ClampedArray(metadata.width * metadata.height * 4)

const normalized = (name) => name.normalize("NFKC").trim().toLowerCase()
const baseName = (name) => normalized(name).replace(/[-_]([lr])$/i, "").replace(/_\d+$/, "")

function applyLayerOrder(layers, order = []) {
  if (!order.length) return layers
  const rank = new Map(order.map((name, index) => [normalized(name), index]))
  return layers
    .map((layer, original) => ({
      layer,
      original,
      rank: rank.get(normalized(layer.name)) ?? rank.get(baseName(layer.name)),
    }))
    .sort((a, b) => {
      if (a.rank === undefined && b.rank === undefined) return a.original - b.original
      if (a.rank === undefined) return 1
      if (b.rank === undefined) return -1
      return a.rank - b.rank || a.original - b.original
    })
    .map(({ layer }) => layer)
}

function decodePng(path, width, height) {
  const bytes = readRgba(path)
  if (bytes.length !== width * height * 4) throw new Error(`Unexpected RGBA size for ${path}: ${bytes.length}`)
  return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function sourceOver(source, sourceWidth, sourceHeight, left, top) {
  for (let sy = 0; sy < sourceHeight; sy++) for (let sx = 0; sx < sourceWidth; sx++) {
    const dx = left + sx
    const dy = top + sy
    if (dx < 0 || dy < 0 || dx >= metadata.width || dy >= metadata.height) continue
    const sourceIndex = (sy * sourceWidth + sx) * 4
    const destIndex = (dy * metadata.width + dx) * 4
    const sourceAlpha = source[sourceIndex + 3] / 255
    const destAlpha = composite[destIndex + 3] / 255
    const outputAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha)
    if (outputAlpha <= 0) continue
    for (let channel = 0; channel < 3; channel++) {
      composite[destIndex + channel] = Math.round((source[sourceIndex + channel] * sourceAlpha + composite[destIndex + channel] * destAlpha * (1 - sourceAlpha)) / outputAlpha)
    }
    composite[destIndex + 3] = Math.round(outputAlpha * 255)
  }
}

const metadataDirectory = dirname(metadataPath)
const children = applyLayerOrder(metadata.layers, overrides.layerOrder).map((layer) => {
  const width = layer.right - layer.left
  const height = layer.bottom - layer.top
  const data = decodePng(resolve(metadataDirectory, layer.filename), width, height)
  sourceOver(data, width, height, layer.left, layer.top)
  return {
    name: layer.name,
    left: layer.left,
    top: layer.top,
    right: layer.right,
    bottom: layer.bottom,
    opacity: 1,
    blendMode: "normal",
    imageData: { width, height, data },
  }
})

const buffer = writePsd({
  width: metadata.width,
  height: metadata.height,
  imageData: { width: metadata.width, height: metadata.height, data: composite },
  children,
})
writeFileSync(resolve(outputArgument), Buffer.from(buffer))
console.log(`Wrote ${resolve(outputArgument)} (${children.length} layers, ${metadata.width}x${metadata.height})`)
