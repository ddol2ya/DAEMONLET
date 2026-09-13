import type { HitArea } from "../engine/anime25d/types"
import { DEFAULT_GESTURE_CONFIG, type GestureConfig, type GestureEvent } from "./types"

type PointerState = {
  x0: number
  y0: number
  x: number
  y: number
  startedAt: number
  area: HitArea
  dragging: boolean
  holding: boolean
  petting: boolean
  minX: number
  maxX: number
}

export class GestureRecognizer {
  private pointer: PointerState | null = null

  constructor(private readonly config: GestureConfig = DEFAULT_GESTURE_CONFIG) {}

  start(x: number, y: number, now: number, area: HitArea): GestureEvent[] {
    this.pointer = { x0: x, y0: y, x, y, startedAt: now, area, dragging: false, holding: false, petting: false, minX: x, maxX: x }
    return []
  }

  update(now: number): GestureEvent[] {
    const pointer = this.pointer
    if (!pointer || pointer.dragging || pointer.holding || now - pointer.startedAt < this.config.holdMs) return []
    pointer.holding = true
    return [this.event("hold-start", pointer, now)]
  }

  move(x: number, y: number, now: number): GestureEvent[] {
    const pointer = this.pointer
    if (!pointer) return []
    pointer.x = x
    pointer.y = y
    pointer.minX = Math.min(pointer.minX, x)
    pointer.maxX = Math.max(pointer.maxX, x)
    const distance = Math.hypot(x - pointer.x0, y - pointer.y0)
    const events: GestureEvent[] = []

    if (!pointer.dragging && distance >= this.config.dragThresholdPx) {
      // A hold is a started interaction. Close it before changing gesture
      // ownership so HOLD_LOOP can never be orphaned by a drag transition.
      if (pointer.holding) {
        events.push(this.event("hold-end", pointer, now))
        pointer.holding = false
      }
      pointer.dragging = true
      events.push(this.event("drag-start", pointer, now))
    }
    if (pointer.dragging) events.push(this.event("drag", pointer, now))
    else if (pointer.holding) events.push(this.event("hold-loop", pointer, now))

    const travel = pointer.maxX - pointer.minX
    if ((pointer.area === "head" || pointer.area === "face") && pointer.dragging && travel >= this.config.petHorizontalTravelPx) {
      if (!pointer.petting) {
        pointer.petting = true
        events.push(this.event("pet-start", pointer, now))
      }
      events.push(this.event("pet-loop", pointer, now))
    }
    return events
  }

  end(x: number, y: number, now: number): GestureEvent[] {
    const pointer = this.pointer
    if (!pointer) return []
    pointer.x = x
    pointer.y = y
    const events: GestureEvent[] = []
    if (pointer.petting) events.push(this.event("pet-end", pointer, now))
    else if (pointer.dragging) events.push(this.event("drag-end", pointer, now))
    else if (pointer.holding) events.push(this.event("hold-end", pointer, now))
    else if (!pointer.holding) events.push(this.event("tap", pointer, now))
    this.pointer = null
    return events
  }

  cancel(now: number): GestureEvent[] {
    const pointer = this.pointer
    if (!pointer) return []
    const events = [this.event(pointer.petting ? "pet-end" : pointer.holding ? "hold-end" : pointer.dragging ? "drag-end" : "cancel", pointer, now)]
    this.pointer = null
    return events
  }

  reset(): void {
    this.pointer = null
  }

  private event(type: GestureEvent["type"], pointer: PointerState, now: number): GestureEvent {
    return { type, x: pointer.x, y: pointer.y, dx: pointer.x - pointer.x0, dy: pointer.y - pointer.y0, elapsed: now - pointer.startedAt, area: pointer.area }
  }
}
