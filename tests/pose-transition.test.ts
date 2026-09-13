import { describe, expect, it } from "vitest"
import { PoseTransition } from "../src/pose/PoseTransition"

const config = { enterMs: 1000, exitMs: 500, swapStart: 0.25, swapEnd: 0.75 }

describe("PoseTransition", () => {
  it("runs BASE → ENTERING → ACTIVE_LOOP → EXITING → BASE", () => {
    const transition = new PoseTransition(config)
    expect(transition.sample(0).state).toBe("BASE")
    transition.enter(0)
    expect(transition.sample(500).state).toBe("ENTERING")
    expect(transition.sample(1000).state).toBe("ACTIVE_LOOP")
    transition.exit(1000)
    expect(transition.sample(1250).state).toBe("EXITING")
    expect(transition.sample(1500).state).toBe("BASE")
  })

  it("reverses continuously while entering or exiting", () => {
    const transition = new PoseTransition(config)
    transition.enter(0)
    const entering = transition.sample(400).progress
    transition.exit(400)
    expect(transition.sample(400).progress).toBeCloseTo(entering)
    const exiting = transition.sample(450).progress
    transition.enter(450)
    expect(transition.sample(450).progress).toBeCloseTo(exiting)
    expect(transition.sample(2000).state).toBe("ACTIVE_LOOP")
  })

  it("is time based, pauseable, resettable, and stable for 20 cycles", () => {
    const transition = new PoseTransition(config)
    transition.pauseAt(.5)
    expect(transition.sample(9999)).toMatchObject({ state: "ENTERING", progress: .5, mix: .5, paused: true })
    transition.reset()
    for (let cycle = 0; cycle < 20; cycle++) {
      const start = cycle * 2000
      transition.enter(start)
      expect(transition.sample(start + 1000).state).toBe("ACTIVE_LOOP")
      transition.exit(start + 1000)
      expect(transition.sample(start + 1500)).toMatchObject({ state: "BASE", progress: 0, mix: 0 })
    }
  })

  it("resumes from a QA pause in either direction", () => {
    const entering = new PoseTransition(config)
    entering.pauseAt(.5)
    entering.enter(1_000)
    expect(entering.sample(1_000)).toMatchObject({ state: "ENTERING", progress: .5, paused: false })
    expect(entering.sample(1_500).progress).toBeGreaterThan(.5)

    const exiting = new PoseTransition(config)
    exiting.pauseAt(.5)
    exiting.exit(1_000)
    expect(exiting.sample(1_000)).toMatchObject({ state: "EXITING", progress: .5, paused: false })
    expect(exiting.sample(1_500).progress).toBeLessThan(.5)

    const pausedExit = new PoseTransition(config)
    pausedExit.pauseAt(.5, "exit")
    expect(pausedExit.sample(9_999)).toMatchObject({ state: "EXITING", progress: .5, mix: .5, paused: true })
  })
})
