import type { MotionContributionFrame } from "../orchestration/types"

export class IdleMotionSource {
  sample(now: number): MotionContributionFrame {
    const seconds = now / 1000
    return {
      angleX: 0.1 * Math.sin(seconds * 0.42) + 0.035 * Math.sin(seconds * 1.13),
      angleY: 0.055 * Math.sin(seconds * 0.31 + 1.7),
      angleZ: 0.04 * Math.sin(seconds * 0.23 + 0.5),
      body: 0.07 * Math.sin(seconds * 0.19 + 2.1),
    }
  }
}
