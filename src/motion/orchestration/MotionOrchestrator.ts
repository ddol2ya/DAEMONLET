import type { CharacterSemanticState, Clock } from "../../behavior/types"
import type { FaceBounds } from "../../engine/anime25d/types"
import { ParameterMixer } from "../../interaction/ParameterMixer"
import { BlinkController, type BlinkDiagnostics } from "../sources/BlinkController"
import { GazeController } from "../sources/GazeController"
import { IdleGazeController, type IdleGazeDiagnostics } from "../sources/IdleGazeController"
import { IdleMotionSource } from "../sources/IdleMotionSource"
import { MotionSourceHost } from "./MotionSourceHost"
import type { MotionSourceLease } from "./types"

export type GazeMode = "CENTER" | "IDLE" | "POINTER" | "POSE"

export type GazeDiagnostics = {
  mode: GazeMode
  pointerActive: boolean
  idle: IdleGazeDiagnostics
  pointer: ReturnType<GazeController["getDiagnostics"]>
}

export class MotionOrchestrator {
  readonly blink: BlinkController
  readonly idleGaze: IdleGazeController
  readonly pointerGaze = new GazeController()
  private readonly idle = new IdleMotionSource()
  private idleLease: MotionSourceLease | null = null
  private blinkLease: MotionSourceLease | null = null
  private idleGazeLease: MotionSourceLease | null = null
  private pointerGazeLease: MotionSourceLease | null = null
  private gazeMode: GazeMode = "CENTER"
  private pointerActive = false
  private gazeTakeoverFromCurrent = false
  private pointerReleaseAt: number | null = null

  constructor(
    private readonly host: MotionSourceHost,
    private readonly mixer: ParameterMixer,
    clock: Clock,
    random?: () => number,
    private readonly ownerId = "runtime:procedural",
  ) {
    this.blink = new BlinkController({ clock, random })
    this.idleGaze = new IdleGazeController({ clock, random })
  }

  setGazeTakeoverFromCurrent(enabled: boolean): void {
    this.gazeTakeoverFromCurrent = enabled
    this.pointerReleaseAt = null
  }

  updateBaseSources(input: {
    now: number
    dt: number
    semanticState: CharacterSemanticState
    pointerTarget: { x: number; y: number } | null
    face: FaceBounds | null
    poseActive: boolean
  }): void {
    this.ensureLease("idle", 0).update(this.idle.sample(input.now))
    const wasPointerActive = this.pointerActive
    this.pointerActive = Boolean(input.pointerTarget && input.face)
    if (input.pointerTarget && input.face) {
      if (this.gazeTakeoverFromCurrent && !wasPointerActive) {
        const current = this.mixer.evaluate({ exclude: "interaction" })
        this.pointerGaze.reset({ eyeX: current.eyeX, eyeY: current.eyeY, headX: current.angleX, headY: current.angleY })
      }
      this.pointerReleaseAt = null
      this.idleGazeLease?.release()
      this.idleGazeLease = null
      const targetEyeX = clamp((input.pointerTarget.x - input.face.cx) / ((input.face.x1 - input.face.x0) * 0.7), -1, 1)
      const targetEyeY = clamp((input.pointerTarget.y - input.face.cy) / ((input.face.y1 - input.face.y0) * 0.7), -1, 1)
      const gaze = this.pointerGaze.update(targetEyeX, targetEyeY, input.dt)
      this.ensureLease("pointer-gaze", 20).update({ eyeX: gaze.eyeX, eyeY: gaze.eyeY, angleX: gaze.headX, angleY: gaze.headY }, {
        weight: 1, modes: { eyeX: "override", eyeY: "override", angleX: "override", angleY: "override" },
      })
      this.gazeMode = "POINTER"
      return
    }

    if (this.gazeTakeoverFromCurrent && wasPointerActive) this.pointerReleaseAt = input.now
    const releaseProgress = this.pointerReleaseAt === null ? 1 : Math.min(1, Math.max(0, (input.now - this.pointerReleaseAt) / 300))
    if (releaseProgress < 1 && this.pointerGazeLease?.active()) {
      const gaze = this.pointerGaze.getDiagnostics()
      this.pointerGazeLease.update({ eyeX: gaze.eyeX, eyeY: gaze.eyeY, angleX: gaze.headX, angleY: gaze.headY }, {
        weight: 1 - releaseProgress * releaseProgress * (3 - 2 * releaseProgress),
        modes: { eyeX: "override", eyeY: "override", angleX: "override", angleY: "override" },
      })
    } else {
      this.pointerGazeLease?.release()
      this.pointerGazeLease = null
      this.pointerReleaseAt = null
    }
    const idle = this.idleGaze.update({ now: input.now, semanticState: input.semanticState, pointerActive: false })
    if (idle.active) {
      this.ensureLease("idle-gaze", 12).update({ eyeX: idle.eyeX, eyeY: idle.eyeY, angleX: idle.headX, angleY: idle.headY }, {
        modes: { eyeX: "override", eyeY: "override", angleX: "override", angleY: "override" },
      })
      this.gazeMode = "IDLE"
    } else {
      this.idleGazeLease?.release()
      this.idleGazeLease = null
      this.gazeMode = input.poseActive ? "POSE" : "CENTER"
    }
  }

  updateBlink(now: number, enabled: boolean): void {
    const baseline = this.mixer.evaluate({ exclude: "auto-blink" })
    const output = this.blink.update({
      now,
      baselineEyeOpenL: baseline.eyeOpenL,
      baselineEyeOpenR: baseline.eyeOpenR,
      enabled,
    })
    if (enabled) {
      this.ensureLease("auto-blink", 10).update({ eyeOpenL: { value: output.eyeOpenL, mode: "min" }, eyeOpenR: { value: output.eyeOpenR, mode: "min" } })
    } else {
      this.blinkLease?.release()
      this.blinkLease = null
    }
  }

  notifyPointerActivity(now: number): void {
    this.idleGaze.notifyPointerActivity(now)
  }

  reset(now?: number): void {
    for (const lease of [this.idleLease, this.blinkLease, this.idleGazeLease, this.pointerGazeLease]) lease?.release()
    this.idleLease = null
    this.blinkLease = null
    this.idleGazeLease = null
    this.pointerGazeLease = null
    this.blink.reset(now)
    this.idleGaze.reset(now)
    this.pointerGaze.reset()
    this.gazeMode = "CENTER"
    this.pointerActive = false
    this.pointerReleaseAt = null
  }

  getBlinkDiagnostics(now?: number): BlinkDiagnostics {
    return this.blink.getDiagnostics(now)
  }

  getGazeDiagnostics(now?: number): GazeDiagnostics {
    return {
      mode: this.gazeMode,
      pointerActive: this.pointerActive,
      idle: this.idleGaze.getDiagnostics(now),
      pointer: this.pointerGaze.getDiagnostics(),
    }
  }

  private ensureLease(slot: "idle" | "auto-blink" | "idle-gaze" | "pointer-gaze", priority: number): MotionSourceLease {
    const field = slot === "idle" ? "idleLease" : slot === "auto-blink" ? "blinkLease" : slot === "idle-gaze" ? "idleGazeLease" : "pointerGazeLease"
    let lease = this[field]
    if (!lease?.active()) {
      lease = this.host.acquire({ slot, ownerId: this.ownerId, priority })
      this[field] = lease
    }
    return lease
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
