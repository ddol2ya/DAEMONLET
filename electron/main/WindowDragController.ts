import { randomUUID } from "node:crypto"
import type { EventEmitter } from "node:events"
import type { BrowserWindow, Point, Rectangle } from "electron"
import { DRAG_THRESHOLD_DIP, type WindowDragRequest } from "../shared/window-drag"

const finitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 1_000_000 && Math.abs(p.y) < 1_000_000
export function placeInside(bounds: Rectangle, area: Rectangle): Rectangle {
  return { ...bounds, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height)))) }
}

/** One owned window, native DIP cursor samples, and a commit-only persistence boundary. */
export class WindowDragController {
  private gesture: { id: string; window: BrowserWindow; start: Rectangle; cursor: Point; moved: boolean; sampledAt: number; detach(): void } | null = null
  get active() { return this.gesture !== null }
  constructor(private readonly options: {
    window(): BrowserWindow | null
    cursor(): Point
    startCursor?(): Point | null
    workArea(cursor: Point): Rectangle
    allowed(): boolean
    lock(active: boolean): void
    finish(bounds: Rectangle, committed: boolean): void
    now?: () => number
  }) {}
  request(request: WindowDragRequest) {
    if (request.action === "begin") return { id: this.begin() }
    if (!this.gesture || this.gesture.id !== request.id) return { id: null }
    if (request.action === "cancel") this.cancel()
    else if (request.action === "end") this.end()
    else this.move()
    return { id: this.gesture?.id ?? null }
  }
  private begin() {
    const window = this.options.window(), cursor = this.options.startCursor ? this.options.startCursor() : this.options.cursor()
    if (this.gesture || !this.options.allowed() || !window || window.isDestroyed() || !window.isVisible() || !cursor || !finitePoint(cursor)) return null
    const start = window.getBounds(), id = randomUUID(), cancel = () => this.cancel()
    const input = (_event: unknown, input: { type: string; key?: string }) => { if (input.type === "keyDown" && input.key === "Escape") this.cancel() }
    const mouse = (_event: unknown, input: { type: string; button?: string }) => { if (input.type === "mouseUp" && input.button === "left") this.end() }
    const events = ["blur", "hide", "closed"] as const
    for (const event of events) (window as EventEmitter).on(event, cancel)
    window.webContents.on("render-process-gone", cancel); window.webContents.on("did-start-navigation", cancel)
    window.webContents.on("before-input-event", input); window.webContents.on("before-mouse-event", mouse)
    this.gesture = { id, window, start: { ...start }, cursor: { ...cursor }, moved: false, sampledAt: -Infinity, detach: () => {
      for (const event of events) (window as EventEmitter).removeListener(event, cancel)
      window.webContents.removeListener("render-process-gone", cancel); window.webContents.removeListener("did-start-navigation", cancel)
      window.webContents.removeListener("before-input-event", input); window.webContents.removeListener("before-mouse-event", mouse)
    } }
    this.options.lock(true)
    return id
  }
  private move(final = false) {
    const g = this.gesture
    if (!g || g.window.isDestroyed() || !this.options.allowed()) { this.cancel(); return }
    const now = (this.options.now ?? Date.now)()
    if (!final && now - g.sampledAt < 16) return
    g.sampledAt = now
    const point = this.options.cursor()
    if (!finitePoint(point)) { this.cancel(); return }
    const dx = point.x - g.cursor.x, dy = point.y - g.cursor.y
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_DIP) return
    g.moved = true
    g.window.setBounds({ ...g.start, x: Math.round(g.start.x + dx), y: Math.round(g.start.y + dy) }, false)
  }
  private end() {
    this.move(true)
    const g = this.gesture
    if (!g) return
    const bounds = g.moved ? placeInside(g.window.getBounds(), this.options.workArea(this.options.cursor())) : g.start
    g.window.setBounds(bounds, false)
    this.finish(g, bounds, g.moved)
  }
  cancel() {
    const g = this.gesture
    if (!g) return
    if (!g.window.isDestroyed()) g.window.setBounds(g.start, false)
    this.finish(g, g.start, false)
  }
  private finish(g: NonNullable<WindowDragController["gesture"]>, bounds: Rectangle, committed: boolean) {
    g.detach(); this.gesture = null
    this.options.lock(false)
    this.options.finish(bounds, committed)
  }
}
