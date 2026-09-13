import type { RigLayer } from "./types"

export type HeadFollow = NonNullable<RigLayer["headFollow"]>

export function isValidHeadFollow(value: unknown): value is HeadFollow {
  if (!value || typeof value !== "object") return false
  const p = value as HeadFollow
  return !!p.center && Number.isFinite(p.center.cx) && Number.isFinite(p.center.cy) && Number.isFinite(p.radius) && p.radius > 0 && Number.isFinite(p.falloffRadius) && p.falloffRadius > p.radius
}

export function headFollowWeight(x: number, y: number, profile?: HeadFollow) {
  if (!profile) return 0
  const distance = Math.hypot(x-profile.center.cx,y-profile.center.cy)
  const t = Math.max(0,Math.min(1,(profile.falloffRadius-distance)/(profile.falloffRadius-profile.radius)))
  return t*t*(3-2*t)
}
