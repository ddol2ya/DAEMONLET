import { describe, expect, it, vi } from "vitest"
import { Anime25DRuntime } from "../src/engine/anime25d/Anime25DRuntime"
import { ParameterMixer } from "../src/interaction/ParameterMixer"
import { MotionSourceHost } from "../src/motion/orchestration/MotionSourceHost"

function eyeRuntime() {
  const mixer = new ParameterMixer()
  const sourceHost = new MotionSourceHost(mixer, () => 0)
  const runtime = Object.create(Anime25DRuntime.prototype) as any
  runtime.autoBlink = true
  runtime.clock = { now: () => 0 }
  runtime.motionOrchestrator = { updateBlink: vi.fn() }
  runtime.qaBlinkLease = null
  runtime.sourceHost = sourceHost
  runtime.runtimeOwnerId = "eye-test"
  runtime.diagnostics = { autoBlink: true }
  runtime.listeners = new Set()
  return { runtime, mixer, sourceHost }
}

describe("QA eye openness", () => {
  it("uses absolute override values and restores the previous eye source on clear", () => {
    const { runtime, mixer, sourceHost } = eyeRuntime()
    const behavior = sourceHost.acquire({ slot: "behavior", ownerId: "behavior", priority: 11 })
    behavior.update({ eyeOpenL: { value: 0.72, mode: "override" }, eyeOpenR: { value: 0.72, mode: "override" } })

    runtime.setBlinkTest(1, 1)
    expect(mixer.evaluate()).toMatchObject({ eyeOpenL: 1, eyeOpenR: 1 })

    behavior.update({ eyeOpenL: { value: 0.46, mode: "override" }, eyeOpenR: { value: 0.46, mode: "override" } })
    runtime.setBlinkTest(0.5, 0.5)
    expect(mixer.evaluate()).toMatchObject({ eyeOpenL: 0.5, eyeOpenR: 0.5 })

    runtime.setBlinkTest(0, 1)
    expect(mixer.evaluate()).toMatchObject({ eyeOpenL: 0, eyeOpenR: 1 })
    runtime.setBlinkTest(1, 0)
    expect(mixer.evaluate()).toMatchObject({ eyeOpenL: 1, eyeOpenR: 0 })

    runtime.clearBlinkTest()
    const restored = mixer.evaluate()
    expect(restored.eyeOpenL).toBeCloseTo(0.46)
    expect(restored.eyeOpenR).toBeCloseTo(0.46)
  })

  it("keeps automatic blink contributions on the min policy", () => {
    const { sourceHost } = eyeRuntime()
    const blink = sourceHost.acquire({ slot: "auto-blink", ownerId: "blink", priority: 10 })
    blink.update({ eyeOpenL: { value: 0.2, mode: "min" }, eyeOpenR: { value: 0.3, mode: "min" } })
    expect(sourceHost.diagnostics().at(-1)?.modeOverrides).toMatchObject({ eyeOpenL: "min", eyeOpenR: "min" })
  })
})
