import { describe, expect, it } from "vitest"
import { DEFAULT_POLICIES, ParameterMixer } from "../src/interaction/ParameterMixer"

describe("ParameterMixer", () => {
  it("adds sources and clamps the final value", () => {
    const mixer = new ParameterMixer()
    mixer.setSource("idle", { angleX: 0.7 })
    mixer.setSource("interaction", { angleX: 0.6 })
    expect(mixer.evaluate().angleX).toBe(1)
  })

  it("uses minimum eye openness so blink survives interactions", () => {
    const mixer = new ParameterMixer()
    mixer.setSource("blink", { eyeOpenL: 0.1 })
    mixer.setSource("pet", { eyeOpenL: 0.45 })
    expect(mixer.evaluate().eyeOpenL).toBe(0.1)
  })

  it("uses the highest priority override", () => {
    const mixer = new ParameterMixer()
    mixer.setSource("pose", { irisScale: 0.8 }, 10)
    mixer.setSource("manual", { irisScale: 1.2 }, 100)
    expect(mixer.evaluate().irisScale).toBe(1.2)
  })

  it("supports max and weighted policies", () => {
    const mixer = new ParameterMixer({ ...DEFAULT_POLICIES, mouthOpen: "max", mouthScale: "weighted" })
    mixer.setSource("talk", { mouthOpen: 0.35, mouthScale: 1.5 }, 1, 0.5)
    mixer.setSource("manual", { mouthOpen: 0.8 }, 2)
    expect(mixer.evaluate().mouthOpen).toBe(0.8)
    expect(mixer.evaluate().mouthScale).toBe(1.25)
  })

  it("lets a higher-priority manual source override additive parameters", () => {
    const mixer = new ParameterMixer()
    mixer.setSource("idle", { angleX: 0.3 }, 0)
    mixer.setSource("pose", { angleX: 0.4 }, 15)
    mixer.setSource("manual", { angleX: { value: -0.2, mode: "override" } }, 100)
    expect(mixer.evaluate().angleX).toBeCloseTo(-0.2)
  })

  it("uses pointer override without adding pose gaze", () => {
    const mixer = new ParameterMixer()
    mixer.setSource("pose", { eyeX: 0.35, angleX: 0.2 }, 15)
    mixer.setSource("pointer", { eyeX: { value: -0.6, mode: "override" }, angleX: { value: -0.3, mode: "override" } }, 20)
    expect(mixer.evaluate()).toMatchObject({ eyeX: -0.6, angleX: -0.3 })
  })

  it("interpolates multiply from identity and preserves stable equal-priority order", () => {
    const mixer = new ParameterMixer({ ...DEFAULT_POLICIES, irisScale: "multiply" })
    mixer.setSource("scale", { irisScale: 0.5 }, 1, 0.5)
    mixer.setSource("first", { angleX: { value: 0.25, mode: "override" } }, 10)
    mixer.setSource("second", { angleX: { value: 0.75, mode: "override" } }, 10)
    expect(mixer.evaluate()).toMatchObject({ irisScale: 0.75, angleX: 0.75 })
    mixer.setSource("first", { angleX: { value: -0.5, mode: "override" } }, 10)
    expect(mixer.evaluate().angleX).toBe(0.75)
  })

  it("keeps interaction add and blink min semantics with explicit modes", () => {
    const mixer = new ParameterMixer()
    mixer.setSource("idle", { angleZ: 0.1, eyeOpenL: 0.72 })
    mixer.setSource("interaction", { angleZ: 0.2, eyeOpenL: 0.46 }, 40)
    mixer.setSource("blink", { eyeOpenL: { value: 0.08, mode: "min" } }, 50)
    expect(mixer.evaluate().angleZ).toBeCloseTo(0.3)
    expect(mixer.evaluate().eyeOpenL).toBe(0.08)
  })
})
