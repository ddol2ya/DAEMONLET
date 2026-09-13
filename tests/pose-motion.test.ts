import { describe, expect, it } from "vitest"
import { samplePoseMotion, samplePoseMotionTrack } from "../src/pose/PoseMotion"

describe("pose-local motion", () => {
  it("samples constant and looping sine tracks deterministically", () => {
    expect(samplePoseMotionTrack({ type: "constant", value: 0.22 }, 900, 1100)).toBe(0.22)
    const track = { type: "sine" as const, amplitude: 2.5, phase: 0, offset: 0.5 }
    expect(samplePoseMotionTrack(track, 0, 1000)).toBeCloseTo(0.5)
    expect(samplePoseMotionTrack(track, 250, 1000)).toBeCloseTo(3)
    expect(samplePoseMotionTrack(track, 1250, 1000)).toBeCloseTo(3)
  })

  it("returns parameter and layer-local transform samples without pose-id branches", () => {
    const sample = samplePoseMotion({
      loopDurationMs: 1000,
      parameters: { eyeY: { type: "constant", value: 0.22 } },
      layers: { handwear_2: {
        origin: { x: 0.16, y: 0.88 },
        influence: { axisX: 0.85, axisY: 0.53, start: 0.07, end: 0.18 },
        translateX: { type: "sine", amplitude: 2, phase: 0, offset: 0 },
        rotationDeg: { type: "constant", value: 1.5 },
      } },
    }, 250)
    expect(sample.parameters.eyeY).toBe(0.22)
    expect(sample.layers.handwear_2).toEqual({
      translateX: 2,
      translateY: 0,
      rotationDeg: 1.5,
      scale: 1,
      origin: { x: 0.16, y: 0.88 },
      influence: { axisX: 0.85, axisY: 0.53, start: 0.07, end: 0.18 },
    })
  })
})
