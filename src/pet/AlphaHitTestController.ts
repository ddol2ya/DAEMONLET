import type { AlphaHitTestResult, Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"

export type AlphaHitTestState = {
  interactive: boolean
  leaveSamples: number
}

export type AlphaThresholds = { enter: number; leave: number; leaveConfirmation: number }
export const DEFAULT_ALPHA_THRESHOLDS: AlphaThresholds = { enter: 0.1, leave: 0.04, leaveConfirmation: 2 }

export function nextAlphaHitTestState(
  state: AlphaHitTestState,
  alpha: number,
  thresholds: AlphaThresholds = DEFAULT_ALPHA_THRESHOLDS,
): AlphaHitTestState {
  if (!state.interactive) return alpha >= thresholds.enter ? { interactive: true, leaveSamples: 0 } : { interactive: false, leaveSamples: 0 }
  if (alpha > thresholds.leave) return { interactive: true, leaveSamples: 0 }
  const leaveSamples = state.leaveSamples + 1
  return leaveSamples >= thresholds.leaveConfirmation ? { interactive: false, leaveSamples: 0 } : { interactive: true, leaveSamples }
}

type AlphaHitTestDesktop = {
  setMousePassthrough(ignore: boolean): Promise<void>
  setInteractionLocked(locked: boolean): void
  reportAlphaFailure(message: string): void
}

export class AlphaHitTestController {
  private state: AlphaHitTestState = { interactive: true, leaveSamples: 0 }
  private locked = false
  private layout = false
  private contextLost = false
  private lastSampleAt = Number.NEGATIVE_INFINITY
  private activePointerId: number | null = null
  private lastPointerPosition: { x: number; y: number } | null = null
  private requestedPassthrough: boolean | null = null
  private passthroughErrorReported = false
  private disposed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly runtime: Anime25DRuntime,
    private readonly desktop: AlphaHitTestDesktop,
    private readonly minimumIntervalMs = 1000 / 30,
  ) {
    canvas.addEventListener("pointermove", this.onPointerMove)
    canvas.addEventListener("pointerdown", this.onPointerDown)
    canvas.addEventListener("pointerup", this.onPointerEnd)
    canvas.addEventListener("pointercancel", this.onPointerCancel)
    canvas.addEventListener("lostpointercapture", this.onLostPointerCapture)
    canvas.addEventListener("webglcontextlost", this.onContextLost)
    canvas.addEventListener("webglcontextrestored", this.onContextRestored)
  }

  setLayoutMode(enabled: boolean): void {
    this.layout = enabled
    this.releaseInteractionLock()
    this.state = { interactive: true, leaveSamples: 0 }
    this.requestPassthrough(false)
  }

  reset(): void {
    this.state = { interactive: true, leaveSamples: 0 }
    this.lastSampleAt = Number.NEGATIVE_INFINITY
    this.releaseInteractionLock()
    this.requestPassthrough(false)
  }
  setExternalDrag(active: boolean, point?: { x: number; y: number }): void {
    this.releaseInteractionLock()
    if (active) { this.locked = true; this.desktop.setInteractionLocked(true); this.requestPassthrough(false); return }
    try {
      this.state = { interactive: !point || this.sample(point.x, point.y).alpha >= DEFAULT_ALPHA_THRESHOLDS.enter, leaveSamples: 0 }
      this.requestPassthrough(!this.state.interactive)
    } catch { this.requestPassthrough(false) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener("pointermove", this.onPointerMove)
    this.canvas.removeEventListener("pointerdown", this.onPointerDown)
    this.canvas.removeEventListener("pointerup", this.onPointerEnd)
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel)
    this.canvas.removeEventListener("lostpointercapture", this.onLostPointerCapture)
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost)
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored)
    this.releaseInteractionLock()
    this.requestPassthrough(false)
  }

  private sample(clientX: number, clientY: number): AlphaHitTestResult {
    return this.runtime.sampleRenderedAlpha(clientX, clientY, { radius: 3, threshold: DEFAULT_ALPHA_THRESHOLDS.enter })
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    this.lastPointerPosition = { x: event.clientX, y: event.clientY }
    if (this.locked || this.layout || this.contextLost || this.disposed) return
    const now = performance.now()
    if (now - this.lastSampleAt < this.minimumIntervalMs) return
    this.lastSampleAt = now
    try {
      const result = this.sample(event.clientX, event.clientY)
      this.state = nextAlphaHitTestState(this.state, result.alpha)
      this.requestPassthrough(!this.state.interactive)
    } catch (error) {
      this.contextLost = true
      this.releaseInteractionLock()
      this.requestPassthrough(false)
      this.desktop.reportAlphaFailure(error instanceof Error ? error.message : String(error))
    }
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.activePointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0
    this.lastPointerPosition = { x: event.clientX, y: event.clientY }
    this.locked = true
    this.desktop.setInteractionLocked(true)
    this.requestPassthrough(false)
  }

  private readonly onPointerEnd = (event: PointerEvent) => {
    if (!this.matchesActivePointer(event)) return
    const position = {
      x: Number.isFinite(event.clientX) ? event.clientX : this.lastPointerPosition?.x ?? 0,
      y: Number.isFinite(event.clientY) ? event.clientY : this.lastPointerPosition?.y ?? 0,
    }
    this.releaseInteractionLock()
    if (this.layout || this.contextLost || this.disposed) {
      this.state = { interactive: true, leaveSamples: 0 }
      this.requestPassthrough(false)
      return
    }
    try {
      const result = this.sample(position.x, position.y)
      this.state = { interactive: result.alpha >= DEFAULT_ALPHA_THRESHOLDS.enter, leaveSamples: 0 }
      this.lastSampleAt = performance.now()
      this.requestPassthrough(!this.state.interactive)
    } catch (error) {
      this.contextLost = true
      this.state = { interactive: true, leaveSamples: 0 }
      this.requestPassthrough(false)
      this.desktop.reportAlphaFailure(error instanceof Error ? error.message : String(error))
    }
  }

  private readonly onPointerCancel = (event: PointerEvent) => {
    if (!this.matchesActivePointer(event)) return
    this.releaseInteractionLock()
    this.state = { interactive: true, leaveSamples: 0 }
    this.requestPassthrough(false)
  }

  private readonly onLostPointerCapture = (event: PointerEvent) => {
    if (!this.matchesActivePointer(event)) return
    this.releaseInteractionLock()
    this.state = { interactive: true, leaveSamples: 0 }
    this.requestPassthrough(false)
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault()
    this.contextLost = true
    this.releaseInteractionLock()
    this.requestPassthrough(false)
    this.desktop.reportAlphaFailure("WebGL context lost")
  }

  private readonly onContextRestored = () => {
    this.contextLost = false
    this.reset()
  }

  private matchesActivePointer(event: PointerEvent): boolean {
    if (this.activePointerId === null) return false
    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0
    return pointerId === this.activePointerId
  }

  private releaseInteractionLock(): void {
    const wasLocked = this.locked || this.activePointerId !== null
    this.locked = false
    this.activePointerId = null
    if (wasLocked) this.desktop.setInteractionLocked(false)
  }

  private requestPassthrough(ignore: boolean): void {
    if (this.requestedPassthrough === ignore) return
    this.requestedPassthrough = ignore
    void this.desktop.setMousePassthrough(ignore).then(() => {
      this.passthroughErrorReported = false
    }).catch((error) => {
      if (this.requestedPassthrough === ignore) this.requestedPassthrough = null
      if (this.passthroughErrorReported || this.disposed) return
      this.passthroughErrorReported = true
      this.desktop.reportAlphaFailure(`Mouse passthrough update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
