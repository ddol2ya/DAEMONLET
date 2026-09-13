import { blendPoseLayerTransforms, samplePoseMotion, weightPoseLayerTransforms } from "./PoseMotion"
import { blendBehaviorParameters } from "../behavior/BehaviorMotion"
import { sampleMotionEnvelope } from "../motion/MotionSampler"
import type { PoseTransitionSample } from "./PoseTransition"
import type { PoseMotion, PoseRuntimeState } from "./types"

/** Hold a stroke while exiting; repeated reactions blend into a fresh gesture. */
export class PoseMotionPlayback {
  private elapsedMs = 0
  private previous: PoseRuntimeState = "BASE"
  private lastAt = 0
  private lastSample: ReturnType<typeof samplePoseMotion> | null = null
  private restartFrom: ReturnType<typeof samplePoseMotion> | null = null
  private restartElapsedMs = 0

  reset() { this.elapsedMs = 0; this.previous = "BASE"; this.lastAt = 0; this.lastSample = null; this.restartFrom = null; this.restartElapsedMs = 0 }

  restart(now: number) {
    if (!this.lastSample || this.previous === "BASE") return
    this.restartFrom = this.lastSample
    this.restartElapsedMs = 0
    this.elapsedMs = 0
    this.lastAt = now
  }

  sample(motion: PoseMotion, pose: PoseTransitionSample, now: number) {
    if (!pose.active) this.reset()
    else if (this.previous === "ACTIVE_LOOP" && pose.state === "ACTIVE_LOOP") {
      const dt = Math.max(0, now - this.lastAt)
      this.elapsedMs += dt
      this.restartElapsedMs += dt
    }
    this.previous = pose.state
    this.lastAt = now
    let sampled = samplePoseMotion(motion, this.elapsedMs)
    if (this.restartFrom) {
      const t = Math.min(1, this.restartElapsedMs / 100), mix = t * t * (3 - 2 * t)
      sampled = { parameters: blendBehaviorParameters(this.restartFrom.parameters, sampled.parameters, mix), layers: blendPoseLayerTransforms(this.restartFrom.layers, sampled.layers, mix) }
      if (t === 1) this.restartFrom = null
    }
    this.lastSample = sampled
    const weight = pose.progress * sampleMotionEnvelope(motion, this.elapsedMs)
    const layers = weightPoseLayerTransforms(sampled.layers, weight)
    return { parameters: sampled.parameters, layers, weight }
  }
}
