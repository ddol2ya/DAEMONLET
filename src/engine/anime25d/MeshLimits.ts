import type { RigDefinition, RigLayer } from "./types"

/** Shared by import validation and the renderer, so Uint16 indices cannot wrap. */
export function meshGridFor(layer: RigLayer, rig: RigDefinition) {
  const eye = layer.side === "L" ? rig.anchors.eyeL : layer.side === "R" ? rig.anchors.eyeR : undefined
  const detailedEye = eye?.blink && layer.fade === "eyeOpen" && !layer.name.startsWith("irides")
  const detailedMouth = rig.anchors.mouth?.morph && layer.mouthExpression
  const cell = detailedMouth ? Math.max(0.6, rig.canvas.w / 1280) : detailedEye ? 2 * Math.max(0.6, rig.canvas.w / 1280) : layer.headFollow ? 12 * Math.max(.6, rig.canvas.w / 1280) : (layer.phys ? 30 : 42) * Math.max(0.6, rig.canvas.w / 768)
  const nx = Math.max(2, Math.round(layer.w / cell)), ny = Math.max(2, Math.round(layer.h / cell))
  const vertexCount = (nx + 1) * (ny + 1)
  if (!Number.isSafeInteger(vertexCount) || vertexCount > 65_535) throw new Error("PACK_LIMIT")
  return { nx, ny, vertexCount }
}
