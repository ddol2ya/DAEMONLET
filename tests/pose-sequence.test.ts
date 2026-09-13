import { describe, expect, it } from "vitest"
import { PoseSequence } from "../src/interaction/PoseSequence"

describe("PoseSequence", () => {
  it("runs BASE → ENTER → LOOP → EXIT → BASE", () => {
    const poses = new PoseSequence(100, 100)
    expect(poses.sample(0).phase).toBe("BASE")
    poses.play("ARM_RAISED", 0)
    expect(poses.sample(50).phase).toBe("ENTER")
    const loop = poses.sample(100)
    expect(loop.phase).toBe("ARM_RAISED_LOOP")
    expect(loop.values.armY).toBeCloseTo(0.72)
    poses.exit(120)
    expect(poses.sample(170).phase).toBe("EXIT")
    expect(poses.sample(220)).toEqual({ active: false, phase: "BASE", values: {} })
  })
})
