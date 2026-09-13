import type { MouthMorphProfile, MouthShape, RigLayer } from "./types"

type Expression = NonNullable<RigLayer["mouthExpression"]>
const clamp = (x: number) => Math.max(0, Math.min(1, x))
const smooth = (x: number) => { const t = clamp(x); return t*t*(3-2*t) }
const mix = (a: number, b: number, t: number) => a+(b-a)*t

export function mouthMorphWeights(mouthOpen: number, mouthForm: number, profile?: MouthMorphProfile) {
  const smile = smooth(mouthForm)
  const aperture = smooth(mouthOpen)*(1-smile)
  // The open artwork already supplies both lip contours. Hand over while its
  // aperture is still subpixel instead of superimposing two complete mouths.
  const open = smooth(aperture/.16)
  if (profile?.neutral.lower.some((value,i)=>value-profile.neutral.upper[i]>.2)) {
    const closed = smooth((smile-.84)/.16)
    return { aperture, neutral: (1-closed)*(1-open), open: (1-closed)*open, smile: closed }
  }
  return { aperture, neutral: (1-open)*(1-smile), open, smile: (1-open)*smile }
}

function sample(values: number[], t: number) {
  const index = clamp(t)*(values.length-1), left = Math.floor(index)
  return mix(values[left], values[Math.min(left+1, values.length-1)], index-left)
}

export function mouthFrameOffset(u: number, v: number, profile: MouthMorphProfile): [number, number] {
  const angle = profile.angleDeg*Math.PI/180, c = Math.cos(angle), s = Math.sin(angle)
  return [u*c-v*s, u*s+v*c]
}

export function deformMouthPoint(x: number, y: number, expression: Expression, mouthOpen: number, mouthForm: number, profile: MouthMorphProfile): [number, number] {
  const shape = profile[expression], angle = profile.angleDeg*Math.PI/180
  const c = Math.cos(angle), s = Math.sin(angle), dx = x-profile.center.cx, dy = y-profile.center.cy
  const u = dx*c+dy*s, v = -dx*s+dy*c, t = (u-shape.u0)/(shape.u1-shape.u0)
  const smile = smooth(mouthForm), { aperture } = mouthMorphWeights(mouthOpen, mouthForm)
  const closedTop = mix(sample(profile.neutral.upper, t), sample(profile.smile.upper, t), smile)
  const closedBottom = mix(sample(profile.neutral.lower, t), sample(profile.smile.lower, t), smile)
  const targetTop = mix(closedTop, sample(profile.open.upper, t), aperture)
  const targetBottom = mix(closedBottom, sample(profile.open.lower, t), aperture)
  const u0 = mix(mix(profile.neutral.u0, profile.smile.u0, smile), profile.open.u0, aperture)
  const u1 = mix(mix(profile.neutral.u1, profile.smile.u1, smile), profile.open.u1, aperture)
  const sourceTop = sample(shape.upper, t), sourceBottom = sample(shape.lower, t)
  let mappedV: number
  if (expression !== "open" && sourceBottom-sourceTop < .1) mappedV = v-sourceTop+(targetTop+targetBottom)/2
  else if (v <= sourceTop) mappedV = v-sourceTop+targetTop
  else if (v >= sourceBottom) mappedV = v-sourceBottom+targetBottom
  else mappedV = mix(targetTop, targetBottom, (v-sourceTop)/(sourceBottom-sourceTop))
  const [ox, oy] = mouthFrameOffset(mix(u0, u1, t), mappedV, profile)
  return [profile.center.cx+ox, profile.center.cy+oy]
}

function validShape(value: unknown, closed: boolean): value is MouthShape {
  if (!value || typeof value !== "object") return false
  const p = value as MouthShape
  return Number.isFinite(p.u0) && Number.isFinite(p.u1) && p.u1 > p.u0 &&
    Array.isArray(p.upper) && p.upper.length >= 2 && p.upper.length <= 129 &&
    Array.isArray(p.lower) && p.lower.length === p.upper.length &&
    p.upper.every(Number.isFinite) && p.lower.every((v, i) => Number.isFinite(v) && (closed ? v >= p.upper[i] : v > p.upper[i]))
}

export function isValidMouthMorphProfile(value: unknown): value is MouthMorphProfile {
  if (!value || typeof value !== "object") return false
  const p = value as MouthMorphProfile
  return !!p.center && Number.isFinite(p.center.cx) && Number.isFinite(p.center.cy) && Number.isFinite(p.angleDeg) &&
    validShape(p.neutral, true) && validShape(p.open, false) && validShape(p.smile, true)
}
