import { describe, expect, it } from "vitest"
import { alignClosedEye, deformEyeAperture, eyeFrameOffset, isValidEyeBlinkProfile } from "../src/engine/anime25d/EyeBlink"
import { applyRigOverrides } from "../src/engine/anime25d/RigOverrides"
import type { EyeBlinkProfile, RigDefinition } from "../src/engine/anime25d/types"

const profile: EyeBlinkProfile = {
  center: { cx: 70, cy: 40 }, angleDeg: 0, u0: -20, u1: 20,
  upper: [-8, -10, -8], lower: [8, 10, 8], closed: [1, 3, 1],
  closedSource: { cx: 65, cy: 38 }, closedTarget: { cx: 70, cy: 43 }, closedRotationDeg: 15,
}
const world = (u: number, v: number, p = profile): [number, number] => {
  const [dx, dy] = eyeFrameOffset(u, v, p)
  return [p.center.cx + dx, p.center.cy + dy]
}
const expectPoint = (actual: number[], expected: number[]) => actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9))

describe("pose-local blink geometry", () => {
  it("retains the exact source coordinates with fully open eyes", () => {
    for (const angleDeg of [-35, 0, 17.8, 60]) {
      const p = { ...profile, angleDeg }
      for (const point of [[45.3, 21.8], [70, 40], [96.4, 72.5]]) {
        expect(deformEyeAperture(point[0], point[1], 1, p)).toEqual(point)
      }
    }
  })

  it("rotates the entire blink with the face instead of flattening it in screen Y", () => {
    for (const angleDeg of [-30, 11.8, 45]) for (const openness of [0, .1, .3, .5, .8]) {
      const p = { ...profile, angleDeg }
      for (const [u, v] of [[-17, -7], [0, 0], [12, 6]]) {
        const source = world(u, v, p), flat = deformEyeAperture(...world(u, v), openness, profile)
        expectPoint(deformEyeAperture(...source, openness, p), world(flat[0] - profile.center.cx, flat[1] - profile.center.cy, p))
      }
    }
  })

  it("preserves upper and lower eyeliner thickness while shrinking the empty aperture", () => {
    const p = { ...profile, angleDeg: 17.8 }
    for (const openness of [.1, .25, .5, .75]) {
      for (const [a, b] of [[-10, -12], [10, 12]]) {
        const first = deformEyeAperture(...world(0, a, p), openness, p)
        const second = deformEyeAperture(...world(0, b, p), openness, p)
        expect(Math.hypot(first[0] - second[0], first[1] - second[1])).toBeCloseTo(2, 9)
      }
      const top = deformEyeAperture(...world(0, -10, p), openness, p)
      const bottom = deformEyeAperture(...world(0, 10, p), openness, p)
      expect(Math.hypot(top[0] - bottom[0], top[1] - bottom[1])).toBeCloseTo(20 * (openness - .08) / .92)
    }
  })

  it("brings both boundaries to the pose's closed curve at the texture handoff", () => {
    for (const [u, upper, lower, closed] of [[-20, -8, 8, 1], [0, -10, 10, 3], [20, -8, 8, 1]]) {
      const target = world(u, closed)
      expectPoint(deformEyeAperture(...world(u, upper), .08, profile), target)
      expectPoint(deformEyeAperture(...world(u, lower), .08, profile), target)
    }
  })

  it("aligns the closed sprite without changing its width or stroke thickness", () => {
    expectPoint(alignClosedEye(65, 38, profile), [70, 43])
    const a = alignClosedEye(60, 35, profile), b = alignClosedEye(72, 40, profile)
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(13)
  })

  it("keeps gaze tangent/normal to the same face frame", () => {
    const p = { ...profile, angleDeg: 90 }
    expectPoint(eyeFrameOffset(11, 0, p), [0, 11])
    expectPoint(eyeFrameOffset(0, 6, p), [-6, 0])
  })

  it("rejects malformed profiles before they can create invalid mesh vertices", () => {
    expect(isValidEyeBlinkProfile(profile)).toBe(true)
    for (const value of [null, {}, { ...profile, upper: [] }, { ...profile, lower: [2] }, { ...profile, closed: [1, NaN, 2] }, { ...profile, u1: -20 }, { ...profile, lower: [-9, 10, 8] }, { ...profile, closedTarget: { cx: Infinity, cy: 1 } }]) {
      expect(isValidEyeBlinkProfile(value)).toBe(false)
    }
    const eye = { x0: 50, x1: 90, y0: 30, y1: 50, icx: 70, icy: 40, closeY: 43, blink: { ...profile, upper: [] } }
    const rig = { canvas: { w: 128, h: 128 }, layers: [], anchors: { eyeL: eye }, warnings: [], synth: { eye: false, mouth: false } } as unknown as RigDefinition
    expect(applyRigOverrides(rig, {}).anchors.eyeL).not.toHaveProperty("blink")
    expect(rig.anchors.eyeL).toHaveProperty("blink")
  })
})
