import type { Anime25DModelData, Bounds, RigLayer } from "./types"

export class Anime25DModel {
  constructor(readonly data: Anime25DModelData) {}

  get rig() {
    return this.data.rig
  }

  boundsForGroup(group: "head" | "body"): Bounds | null {
    return unionLayerBounds(this.rig.layers.filter((layer) => layer.group === group))
  }
}

export function unionLayerBounds(layers: RigLayer[]): Bounds | null {
  if (!layers.length) return null
  return layers.reduce<Bounds>((bounds, layer) => ({
    x0: Math.min(bounds.x0, layer.x), y0: Math.min(bounds.y0, layer.y),
    x1: Math.max(bounds.x1, layer.x + layer.w), y1: Math.max(bounds.y1, layer.y + layer.h),
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
}
