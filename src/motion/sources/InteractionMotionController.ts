import type { Anime25DParameter, InteractionId } from "../../engine/anime25d/types"
import { MotionLifecycleBus } from "../orchestration/MotionLifecycleBus"
import { MotionSourceHost } from "../orchestration/MotionSourceHost"
import type { MotionContributionFrame, MotionSourceLease } from "../orchestration/types"

type ActiveInteraction = {
  id: InteractionId
  lifecycleId: string
  startedAt: number
  duration: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export class InteractionMotionController {
  private activeInteraction: ActiveInteraction | null = null
  private lease: MotionSourceLease | null = null

  constructor(
    private readonly host: MotionSourceHost,
    private readonly lifecycle: MotionLifecycleBus,
    private readonly ownerId: string,
  ) {}

  start(id: InteractionId, now: number): void {
    const lifecycleId = id.startsWith("HOLD_") ? "HOLD" : id.startsWith("PET_") ? "PET" : id
    if (this.activeInteraction?.lifecycleId === lifecycleId) {
      if (id === "HOLD_LOOP" && this.activeInteraction.id === "HOLD_LOOP") return
      if (id === "PET_LOOP" && this.activeInteraction.id === "PET_LOOP") return
      if (id === "DRAG" && this.activeInteraction.id === "DRAG") {
        this.activeInteraction.startedAt = now
        return
      }
      this.activeInteraction = { id, lifecycleId, startedAt: now, duration: this.durationFor(id) }
      if (id === "HEAD_TAP" || id === "TORSO_TAP") this.lifecycle.emit({ type: "interaction.started", interactionId: lifecycleId, at: now })
      return
    }
    this.cancel("superseded", now)
    this.activeInteraction = { id, lifecycleId, startedAt: now, duration: this.durationFor(id) }
    this.lifecycle.emit({ type: "interaction.started", interactionId: lifecycleId, at: now })
  }

  update(now: number, scale = 1): { state: string; completed: boolean } {
    const active = this.activeInteraction
    if (!active) {
      this.releaseLease()
      return { state: "IDLE", completed: false }
    }
    const progress = clamp((now - active.startedAt) / active.duration, 0, 1)
    const envelope = Math.sin(progress * Math.PI)
    let values: MotionContributionFrame = {}
    if (active.id === "HEAD_TAP") values = { angleY: -0.34 * envelope, angleZ: 0.12 * envelope, eyeOpenL: 1 - 0.48 * envelope, eyeOpenR: 1 - 0.48 * envelope }
    if (active.id === "HOLD_START") values = { eyeOpenL: 1 - 0.5 * progress, eyeOpenR: 1 - 0.5 * progress, mouthForm: 0.12 * progress }
    if (active.id === "HOLD_LOOP") values = { eyeOpenL: 0.5, eyeOpenR: 0.5, mouthForm: 0.12 + Math.sin(now / 240) * 0.025 }
    if (active.id === "HOLD_END") values = { eyeOpenL: 0.5 + 0.5 * progress, eyeOpenR: 0.5 + 0.5 * progress, mouthForm: 0.12 * (1 - progress) }
    if (active.id === "TORSO_TAP") values = { body: 0.36 * envelope, angleY: -0.12 * envelope }
    if (active.id === "PET_START" || active.id === "PET_LOOP") values = {
      eyeOpenL: 0.46, eyeOpenR: 0.46, angleZ: Math.sin(now / 72) * 0.09, mouthForm: 0.2, bangC: Math.sin(now / 90) * 0.12,
    }
    if (active.id === "PET_END") values = { eyeOpenL: 0.62 + 0.38 * progress, eyeOpenR: 0.62 + 0.38 * progress, mouthForm: 0.16 * (1 - progress) }
    if (active.id === "DRAG") values = { angleZ: 0.08 * envelope }
    if (scale !== 1) for (const [name, contribution] of Object.entries(values)) {
      const parameter = name as Anime25DParameter
      const value = typeof contribution === "number" ? contribution : contribution.value
      values[parameter] = parameter === "eyeOpenL" || parameter === "eyeOpenR" ? 1 + (value - 1) * scale : value * scale
    }
    this.ensureLease().update(values)

    if (active.id === "HOLD_START" && progress >= 1) {
      this.activeInteraction = { id: "HOLD_LOOP", lifecycleId: active.lifecycleId, startedAt: now, duration: Number.POSITIVE_INFINITY }
      return { state: "HOLD_LOOP", completed: false }
    }
    if (progress >= 1) {
      this.activeInteraction = null
      this.releaseLease()
      this.lifecycle.emit({ type: "interaction.completed", interactionId: active.lifecycleId, at: now })
      return { state: "IDLE", completed: true }
    }
    return { state: active.id, completed: false }
  }

  cancel(reason = "cancelled", now = typeof performance === "undefined" ? Date.now() : performance.now()): void {
    const active = this.activeInteraction
    this.activeInteraction = null
    this.releaseLease()
    if (active) this.lifecycle.emit({ type: "interaction.cancelled", interactionId: active.lifecycleId, reason, at: now })
  }

  reset(reason: string, now?: number): void {
    this.cancel(reason, now)
  }

  getActiveId(): InteractionId | null {
    return this.activeInteraction?.id ?? null
  }

  private ensureLease(): MotionSourceLease {
    if (!this.lease?.active()) this.lease = this.host.acquire({ slot: "interaction", ownerId: this.ownerId, priority: 40 })
    return this.lease
  }

  private releaseLease(): void {
    this.lease?.release()
    this.lease = null
  }

  private durationFor(id: InteractionId): number {
    if (id === "HOLD_START") return 180
    if (id === "HOLD_LOOP") return Number.POSITIVE_INFINITY
    if (id === "HOLD_END") return 360
    if (id === "PET_LOOP") return Number.POSITIVE_INFINITY
    if (id === "PET_END") return 520
    return 680
  }
}
