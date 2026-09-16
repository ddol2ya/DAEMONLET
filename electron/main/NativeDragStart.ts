import type { Point, Rectangle } from "electron"
/** Capture the original event, not the later global cursor after an IPC round trip. */
export class NativeDragStart {
  private point: (Point & { at: number }) | null = null
  constructor(private readonly now: () => number = Date.now) {}
  record(bounds: Rectangle, input: { x: number; y: number }, accepted: boolean) {
    this.point = accepted && Number.isFinite(input.x) && Number.isFinite(input.y) && input.x >= 0 && input.y >= 0 && input.x <= bounds.width && input.y <= bounds.height
      ? { x: bounds.x + input.x, y: bounds.y + input.y, at: this.now() } : null
  }
  take(): Point | null { const point = this.point; this.point = null; return point && this.now() - point.at <= 1000 ? { x: point.x, y: point.y } : null }
}
