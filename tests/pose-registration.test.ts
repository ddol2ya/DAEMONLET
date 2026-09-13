import { describe, expect, it } from "vitest"
import type { RigAnchors } from "../src/engine/anime25d/types"
import { registerPose } from "../src/pose/PoseRegistration"

const anchors = (eyeL: [number, number], eyeR: [number, number], neck: [number, number]): RigAnchors => ({
  face: { x0: 0, y0: 0, x1: 100, y1: 100, cx: 50, cy: 50 },
  eyeL: { x0: 0, y0: 0, x1: 1, y1: 1, icx: eyeL[0], icy: eyeL[1], closeY: eyeL[1] },
  eyeR: { x0: 0, y0: 0, x1: 1, y1: 1, icx: eyeR[0], icy: eyeR[1], closeY: eyeR[1] },
  mouth: { x0: 0, y0: 0, x1: 1, y1: 1, cx: 50, cy: 70 },
  neckPivot: { cx: neck[0], cy: neck[1] }, bodyPivot: { cx: 50, cy: 200 }, neckTop: 90, neckBottom: 120, hairRootY: 0, faceScale: 1,
})
const limits = { strategy: "eyes-and-neck" as const, maxScaleDelta: 0.1, maxRotationDeg: 5, maxAnchorErrorPx: 3 }

describe("pose registration", () => {
  it("accepts identity and translation", () => {
    const base = anchors([30, 40], [70, 40], [50, 110])
    expect(registerPose(base, base, limits).accepted).toBe(true)
    const translated = registerPose(base, anchors([40, 60], [80, 60], [60, 130]), limits)
    expect(translated.accepted).toBe(true)
    expect(translated.transform.translationX).toBeCloseTo(-10)
    expect(translated.transform.translationY).toBeCloseTo(-20)
  })

  it("accepts small scale/rotation and rejects exceeded tolerances", () => {
    const base = anchors([30, 40], [70, 40], [50, 110])
    const angle = 2 * Math.PI / 180
    const rotate = (x: number, y: number): [number, number] => [50 + (x - 50) * Math.cos(angle) - (y - 40) * Math.sin(angle), 40 + (x - 50) * Math.sin(angle) + (y - 40) * Math.cos(angle)]
    const left = rotate(29, 40)
    const right = rotate(71, 40)
    const neck = rotate(50, 113.5)
    expect(registerPose(base, anchors(left, right, neck), limits).accepted).toBe(true)
    const rejected = registerPose(base, anchors([10, 40], [90, 40], [50, 110]), limits)
    expect(rejected.accepted).toBe(false)
    expect(rejected.errorCode).toBe("POSE_ASSET_REGISTRATION_FAILED")
  })

  it("treats a different PSD resolution as the expected canvas scale", () => {
    const base = anchors([30, 40], [70, 40], [50, 110])
    const highResolution = anchors([37.5, 50], [87.5, 50], [62.5, 137.5])
    const result = registerPose(base, highResolution, limits, { base: { w: 1024, h: 1024 }, pose: { w: 1280, h: 1280 } })
    expect(result.scale).toBeCloseTo(.8)
    expect(result.scaleDelta).toBeCloseTo(0)
    expect(result.accepted).toBe(true)
  })
})
