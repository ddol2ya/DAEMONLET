import type { WindowDragRequest, WindowDragReply } from "../../electron/shared/window-drag"

export function isMoveGesture(event: Pick<PointerEvent, "button" | "altKey" | "ctrlKey" | "metaKey" | "pointerType" | "getModifierState">, rightAlt = false) {
  return event.button === 0 && event.pointerType === "mouse" && event.altKey && !event.ctrlKey && !event.metaKey && !rightAlt && !event.getModifierState("AltGraph")
}
/** Capture only a modifier gesture beginning on painted character pixels. */
export class ModifierDragController {
  private active: { pointer: number; id: Promise<string | null>; point: { x: number; y: number } } | null = null
  private frame: number | null = null
  private rightAlt = false
  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: {
    platform: string
    allowed(): boolean
    hit(x: number, y: number): boolean
    request(value: WindowDragRequest): Promise<WindowDragReply>
    lock(value: boolean, point?: { x: number; y: number }): void
  }) {
    canvas.addEventListener("pointerdown", this.down, true)
    canvas.addEventListener("pointermove", this.move, true)
    canvas.addEventListener("pointerup", this.up, true)
    canvas.addEventListener("pointercancel", this.cancelEvent, true)
    canvas.addEventListener("lostpointercapture", this.cancelEvent, true)
    window.addEventListener("keydown", this.key, true); window.addEventListener("keyup", this.key, true)
    window.addEventListener("blur", this.cancel)
  }
  private consume(event: Event) { event.preventDefault(); event.stopImmediatePropagation() }
  private down = (event: PointerEvent) => {
    if (this.active || !this.options.allowed() || !isMoveGesture(event, this.rightAlt)) return
    let hit = false
    try { hit = this.options.hit(event.clientX, event.clientY) } catch { return }
    if (!hit) return
    this.consume(event)
    this.options.lock(true)
    const active = this.active = { pointer: event.pointerId, point: { x: event.clientX, y: event.clientY }, id: this.options.request({ action: "begin" }).then(r => r.id).catch(() => null) }
    this.canvas.setPointerCapture(event.pointerId)
    void active.id.then(id => { if (!id && this.active === active) this.cancel() })
  }
  private move = (event: PointerEvent) => {
    const active = this.active
    if (!active || active.pointer !== event.pointerId) return
    this.consume(event); active.point = { x: event.clientX, y: event.clientY }
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      void active.id.then(async id => { if (id && this.active === active) { const reply = await this.options.request({ action: "move", id }); if (!reply.id && this.active === active) this.cancel() } }).catch(this.cancel)
    })
  }
  private up = (event: PointerEvent) => {
    if (!this.active || this.active.pointer !== event.pointerId) return
    this.consume(event); this.active.point = { x: event.clientX, y: event.clientY }; this.finish("end")
  }
  private cancelEvent = (event: PointerEvent) => { if (this.active?.pointer === event.pointerId) { this.consume(event); this.cancel() } }
  private key = (event: KeyboardEvent) => {
    if (this.options.platform === "win32" && event.code === "AltRight") this.rightAlt = event.type === "keydown"
    if (event.type === "keydown" && event.key === "Escape" && this.active) { this.consume(event); this.cancel() }
  }
  cancel = () => { this.rightAlt = false; this.finish("cancel") }
  private finish(action: "end" | "cancel") {
    const active = this.active
    if (!active) return
    this.active = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (this.canvas.hasPointerCapture(active.pointer)) this.canvas.releasePointerCapture(active.pointer)
    void active.id.then(id => id ? this.options.request({ action, id }) : null).catch(() => {}).finally(() => { if (!this.active) this.options.lock(false, active.point) })
  }
  dispose() {
    this.cancel()
    this.canvas.removeEventListener("pointerdown", this.down, true); this.canvas.removeEventListener("pointermove", this.move, true)
    this.canvas.removeEventListener("pointerup", this.up, true); this.canvas.removeEventListener("pointercancel", this.cancelEvent, true); this.canvas.removeEventListener("lostpointercapture", this.cancelEvent, true)
    window.removeEventListener("keydown", this.key, true); window.removeEventListener("keyup", this.key, true); window.removeEventListener("blur", this.cancel)
  }
}
