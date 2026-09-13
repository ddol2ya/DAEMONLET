import { unionLayerBounds } from "../engine/anime25d/Anime25DModel"
import type { Bounds, HitArea, RigDefinition } from "../engine/anime25d/types"

export type HitAreas = { face: Bounds; head: Bounds; torso: Bounds }

function pad(bounds: Bounds, amount: number): Bounds {
  const width = bounds.x1 - bounds.x0
  const height = bounds.y1 - bounds.y0
  return { x0: bounds.x0 - width * amount, x1: bounds.x1 + width * amount, y0: bounds.y0 - height * amount, y1: bounds.y1 + height * amount }
}

function contains(bounds: Bounds, x: number, y: number) {
  return x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1
}

export class HitAreaResolver {
  readonly areas: HitAreas

  constructor(rig: RigDefinition) {
    const faceHeight = rig.anchors.face.y1 - rig.anchors.face.y0
    const scalpLayers = rig.layers.filter((layer) => layer.group === "head" && !layer.name.startsWith("back hair"))
    const visualScalp = unionLayerBounds(scalpLayers) ?? rig.anchors.face
    // Back-hair tails can extend to the waist. Keep the interactive head region
    // around the face/scalp instead of using the complete head-group union.
    const head = {
      x0: Math.min(visualScalp.x0, rig.anchors.face.x0 - faceHeight * 0.22),
      x1: Math.max(visualScalp.x1, rig.anchors.face.x1 + faceHeight * 0.22),
      y0: Math.min(visualScalp.y0, rig.anchors.face.y0 - faceHeight * 0.35),
      y1: Math.min(visualScalp.y1, rig.anchors.face.y1 + faceHeight * 0.18),
    }
    const torso = unionLayerBounds(rig.layers.filter((layer) => layer.group === "body")) ?? {
      x0: rig.anchors.face.x0,
      x1: rig.anchors.face.x1,
      y0: rig.anchors.neckPivot.cy,
      y1: rig.canvas.h,
    }
    this.areas = { face: pad(rig.anchors.face, 0.05), head: pad(head, 0.025), torso: pad(torso, 0.025) }
    // Inpainted face layers may extend beneath the scalp. Authoring can narrow
    // the input region without changing the anchors that deform the artwork.
    for (const name of ["face", "head", "torso"] as const) {
      const area = rig.interactionAreas?.[name]
      if (area && [area.x0, area.x1, area.y0, area.y1].every(Number.isFinite) && area.x1 > area.x0 && area.y1 > area.y0) this.areas[name] = { ...area }
    }
  }

  resolve(x: number, y: number): HitArea {
    if (contains(this.areas.face, x, y)) return "face"
    if (contains(this.areas.head, x, y)) return "head"
    if (contains(this.areas.torso, x, y)) return "torso"
    return "background"
  }
}
