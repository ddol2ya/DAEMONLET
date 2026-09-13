import type { Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"
import type { HitArea, InteractionId } from "../engine/anime25d/types"
import type { UserActivitySource } from "../behavior/types"
import { GestureRecognizer } from "./GestureRecognizer"
import type { GestureEvent, PointerGestureSignal, ContinuousInteractionId } from "./types"

let nextGestureId = 1

export class InteractionController {
  private readonly gestures = new GestureRecognizer()
  private holdTimer = 0
  private pointerRevision = 0
  private activePointerId: number | null = null
  private lastActivityAt = Number.NEGATIVE_INFINITY
  private activitySource: UserActivitySource = "pointer"
  private gestureId: number | null = null
  private continuousId: ContinuousInteractionId | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly runtime: Anime25DRuntime,
    private readonly onUserActivity?: (source: UserActivitySource) => void,
    private readonly onGesture?: (signal: PointerGestureSignal) => boolean,
  ) {
    canvas.addEventListener("pointerdown", this.onPointerDown)
    canvas.addEventListener("pointermove", this.onPointerMove)
    canvas.addEventListener("pointerup", this.onPointerUp)
    canvas.addEventListener("pointercancel", this.onPointerCancel)
    canvas.addEventListener("pointerleave", this.onPointerLeave)
    canvas.addEventListener("lostpointercapture", this.onLostPointerCapture)
  }

  destroy() {
    this.finishPointer({ reason: "controller-destroy", clearTarget: true, cancelGesture: true })
    this.canvas.removeEventListener("pointerdown", this.onPointerDown)
    this.canvas.removeEventListener("pointermove", this.onPointerMove)
    this.canvas.removeEventListener("pointerup", this.onPointerUp)
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel)
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave)
    this.canvas.removeEventListener("lostpointercapture", this.onLostPointerCapture)
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (this.activePointerId !== null) return
    this.activitySource = event.pointerType === "touch" ? "touch" : "pointer"
    this.notifyActivity(this.activitySource, false)
    const model = this.runtime.clientToModel(event.clientX, event.clientY)
    const area = this.resolveArea(model.x, model.y, model.inside)
    this.activePointerId = event.pointerId
    this.canvas.setPointerCapture(event.pointerId)
    this.runtime.setPointerTarget(model.x, model.y)
    this.runtime.updateInputDiagnostics({ x: model.x, y: model.y }, area, "pointerdown")
    this.pointerRevision = this.runtime.getModelRevision()
    this.gestures.start(event.clientX, event.clientY, performance.now(), area)
    this.gestureId = nextGestureId++
    this.onGesture?.({ type: "begin", gestureId: this.gestureId })
    window.clearTimeout(this.holdTimer)
    this.holdTimer = window.setTimeout(() => {
      if (this.pointerRevision !== this.runtime.getModelRevision()) this.finishPointer({ reason: "model-revision-mismatch", clearTarget: true, cancelGesture: true })
      else this.handle(this.gestures.update(performance.now()))
    }, 480)
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return
    if (this.activePointerId !== null && this.pointerRevision !== this.runtime.getModelRevision()) {
      this.finishPointer({ reason: "model-revision-mismatch", clearTarget: true, cancelGesture: true })
      return
    }
    const model = this.runtime.clientToModel(event.clientX, event.clientY)
    const area = this.resolveArea(model.x, model.y, model.inside)
    if (model.inside) this.notifyActivity(event.pointerType === "touch" ? "touch" : "pointer")
    if (model.inside) this.runtime.setPointerTarget(model.x, model.y)
    else this.runtime.clearPointerTarget()
    // Native forwarded/captured moves can report buttons=0 before pointerup.
    // The captured pointer's lifetime owns the gesture until up/cancel/loss.
    const pressed = this.activePointerId !== null
    this.runtime.updateInputDiagnostics(model.inside ? { x: model.x, y: model.y } : null, area, pressed ? "move" : "hover")
    if (pressed) this.handle(this.gestures.move(event.clientX, event.clientY, performance.now()))
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return
    const model = this.runtime.clientToModel(event.clientX, event.clientY)
    if (this.pointerRevision !== this.runtime.getModelRevision()) {
      this.finishPointer({ reason: "model-revision-mismatch", clearTarget: true, cancelGesture: true })
    } else {
      window.clearTimeout(this.holdTimer)
      this.holdTimer = 0
      this.activePointerId = null
      this.handle(this.gestures.end(event.clientX, event.clientY, performance.now()))
      this.endGesture("released")
      const clearTarget = event.pointerType === "touch" || !model.inside
      if (clearTarget) this.runtime.clearPointerTarget()
      else this.runtime.setPointerTarget(model.x, model.y)
      this.runtime.updateInputDiagnostics(clearTarget ? null : { x: model.x, y: model.y }, clearTarget ? "background" : this.resolveArea(model.x, model.y, true), "pointerup")
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
  }

  private readonly onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return
    this.finishPointer({ reason: "pointer-cancel", clearTarget: true, cancelGesture: true })
  }

  private readonly onPointerLeave = (event: PointerEvent) => {
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return
    if (this.activePointerId === null) {
      this.runtime.clearPointerTarget()
      this.runtime.updateInputDiagnostics(null, "background", "leave")
    }
  }

  private readonly onLostPointerCapture = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return
    this.finishPointer({ reason: "lost-pointer-capture", clearTarget: true, cancelGesture: true })
  }

  private finishPointer(options: { reason: string; clearTarget: boolean; cancelGesture: boolean }) {
    window.clearTimeout(this.holdTimer)
    this.holdTimer = 0
    const pointerId = this.activePointerId
    this.activePointerId = null
    this.endGesture(options.reason)
    if (options.cancelGesture) {
      this.gestures.reset()
      this.runtime.cancelInteraction(options.reason)
    }
    if (options.clearTarget) this.runtime.clearPointerTarget()
    this.runtime.updateInputDiagnostics(null, "background", options.reason)
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId)
  }

  private handle(events: GestureEvent[]) {
    const petting = this.continuousId === "PET" || events.some(event => event.type.startsWith("pet-"))
    for (const event of events) {
      this.notifyActivity(this.activitySource)
      this.runtime.updateInputDiagnostics(this.runtime.getDiagnostics().pointerModel, event.area, event.type)
      let interaction: InteractionId | null = null
      if (event.type === "tap" && (event.area === "head" || event.area === "face")) interaction = "HEAD_TAP"
      if (event.type === "tap" && event.area === "torso") interaction = "TORSO_TAP"
      if (event.type === "hold-start" && event.area === "face") interaction = "HOLD_START"
      if (event.type === "hold-loop" && event.area === "face") interaction = "HOLD_LOOP"
      if (event.type === "hold-end" && event.area === "face") interaction = "HOLD_END"
      if (event.type === "drag" && event.area === "head") interaction = "DRAG"
      if (event.type === "pet-start") interaction = "PET_START"
      if (event.type === "pet-loop") interaction = "PET_LOOP"
      if (event.type === "pet-end") interaction = "PET_END"
      if (interaction === "DRAG" && petting) continue
      if (interaction && (interaction.startsWith("PET_") || interaction.startsWith("HOLD_")) && this.gestureId !== null) {
        const interactionId = interaction.startsWith("PET_") ? "PET" : "HOLD"
        const phase = interaction.endsWith("START") ? "start" : interaction.endsWith("END") ? "end" : "loop"
        if (phase === "start") this.continuousId = interactionId
        const handled = this.onGesture?.({ type: "continuous", gestureId: this.gestureId, interactionId, phase })
        if (phase === "end") this.continuousId = null
        if (handled) {
          if (phase === "start") this.runtime.cancelInteraction("continuous-takeover")
          continue
        }
      }
      if (interaction) this.runtime.triggerInteraction(interaction)
    }
  }

  private endGesture(reason: string): void {
    const gestureId = this.gestureId
    this.gestureId = null
    this.continuousId = null
    if (gestureId !== null) this.onGesture?.({ type: "end", gestureId, reason })
  }

  private resolveArea(x: number, y: number, inside: boolean): HitArea {
    if (!inside) return "background"
    return this.runtime.getHitAreaResolver()?.resolve(x, y) ?? "background"
  }

  private notifyActivity(source: UserActivitySource, throttled = true) {
    const now = performance.now()
    if (throttled && now - this.lastActivityAt < 250) return
    this.lastActivityAt = now
    this.onUserActivity?.(source)
  }
}
