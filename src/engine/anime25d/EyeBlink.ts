import type { EyeBlinkProfile } from "./types"

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function isValidEyeBlinkProfile(value: unknown): value is EyeBlinkProfile {
  if (!value || typeof value !== "object") return false
  const p = value as Partial<EyeBlinkProfile>
  if (![p.angleDeg, p.u0, p.u1, p.closedRotationDeg].every(Number.isFinite) || !(p.u1! > p.u0!)) return false
  if (![p.center, p.closedSource, p.closedTarget].every(point => point && Number.isFinite(point.cx) && Number.isFinite(point.cy))) return false
  const curves = [p.upper, p.lower, p.closed]
  if (!curves.every(curve => Array.isArray(curve) && curve.length >= 2 && curve.length <= 256 && curve.every(Number.isFinite))) return false
  return curves.every(curve => curve!.length === p.upper!.length) && p.lower!.every((value, index) => value > p.upper![index])
}

function sample(values: number[], u: number, profile: EyeBlinkProfile) {
  const position = clamp((u - profile.u0) / (profile.u1 - profile.u0), 0, 1) * (values.length - 1)
  const index = Math.min(values.length - 2, Math.floor(position))
  return values[index] + (values[index + 1] - values[index]) * (position - index)
}

export function eyeFrameOffset(x: number, y: number, profile: EyeBlinkProfile): [number, number] {
  const angle = profile.angleDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
  return [x * c - y * s, x * s + y * c]
}

/** Collapse the aperture in the face's own frame, retaining line thickness outside it. */
export function deformEyeAperture(x: number, y: number, eyeOpen: number, profile: EyeBlinkProfile): [number, number] {
  if (eyeOpen >= 1) return [x, y]
  const angle = profile.angleDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
  const dx = x - profile.center.cx, dy = y - profile.center.cy
  const u = dx * c + dy * s, v = -dx * s + dy * c
  const upper = sample(profile.upper, u, profile), lower = sample(profile.lower, u, profile)
  const closed = sample(profile.closed, u, profile)
  const aperture = clamp((eyeOpen - 0.08) / 0.92, 0, 1)
  const along = clamp((v - upper) / Math.max(0.01, lower - upper), 0, 1)
  const boundary = upper + (lower - upper) * along
  const shifted = v + (closed - boundary) * (1 - aperture)
  return [profile.center.cx + u * c - shifted * s, profile.center.cy + u * s + shifted * c]
}

/** Align only this pose's closed-lid texture; the face transform is applied later. */
export function alignClosedEye(x: number, y: number, profile: EyeBlinkProfile): [number, number] {
  const angle = profile.closedRotationDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
  const dx = x - profile.closedSource.cx, dy = y - profile.closedSource.cy
  return [profile.closedTarget.cx + dx * c - dy * s, profile.closedTarget.cy + dx * s + dy * c]
}
