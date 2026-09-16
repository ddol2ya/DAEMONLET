import type { WindowDragRequest, WindowDragReply } from "./window-drag"
export type BubblePlacement = { schemaVersion: 1; mode: "auto" } | { schemaVersion: 1; mode: "relative"; offsetX: number; offsetY: number; pivotX: number; pivotY: number }
type Rect = { x: number; y: number; width: number; height: number }
export const automaticBubblePlacement = (): BubblePlacement => ({ schemaVersion: 1, mode: "auto" })
export function parseBubblePlacement(value: unknown): BubblePlacement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== 1) return null
  if (v.mode === "auto" && Object.keys(v).sort().join() === "mode,schemaVersion") return automaticBubblePlacement()
  if (v.mode !== "relative" || Object.keys(v).sort().join() !== "mode,offsetX,offsetY,pivotX,pivotY,schemaVersion") return null
  if (![v.offsetX, v.offsetY, v.pivotX, v.pivotY].every(n => typeof n === "number" && Number.isFinite(n))) return null
  if (Math.abs(v.offsetX as number) > 10000 || Math.abs(v.offsetY as number) > 10000 || (v.pivotX as number) < 0 || (v.pivotX as number) > 1 || (v.pivotY as number) < 0 || (v.pivotY as number) > 1) return null
  return { ...v } as BubblePlacement
}
export function relativeBubblePlacement(pet: Rect, box: Rect): BubblePlacement {
  const dx = box.x + box.width / 2 - pet.x - pet.width / 2, dy = box.y + box.height / 2 - pet.y - pet.height / 2
  const horizontal = Math.abs(dx) > Math.abs(dy)
  const pivotX = horizontal ? dx >= 0 ? 0 : 1 : .5, pivotY = horizontal ? .5 : dy >= 0 ? 0 : 1
  return { schemaVersion: 1, mode: "relative", offsetX: box.x + box.width * pivotX - pet.x - pet.width / 2, offsetY: box.y + box.height * pivotY - pet.y - pet.height / 2, pivotX, pivotY }
}
export function bubblePlacementReference(pet: Rect, placement: BubblePlacement): Rect {
  return placement.mode === "auto" ? pet : { x: pet.x + pet.width / 2 + placement.offsetX, y: pet.y + pet.height / 2 + placement.offsetY, width: 1, height: 1 }
}
/** Clamping is presentation only. Never save this rectangle back as user intent. */
export function positionRelativeBubble(pet: Rect, area: Rect, size: Pick<Rect, "width" | "height">, placement: BubblePlacement): Rect {
  if (placement.mode !== "relative") throw Error("relative placement required")
  const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height)
  const x = pet.x + pet.width / 2 + placement.offsetX - width * placement.pivotX, y = pet.y + pet.height / 2 + placement.offsetY - height * placement.pivotY
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width, height }
}
export const PLACEMENT_IPC = { get: "desktop.bubble-placement.get", action: "desktop.bubble-placement.action", changed: "desktop.bubble-placement.changed", menu: "desktop.bubble-placement.menu" } as const
export type PlacementSnapshot = { editing: boolean; revision: number }
export type PlacementAction = { action: "apply" | "cancel"; revision: number } | { action: "drag"; revision: number; drag: WindowDragRequest }
export type PlacementResult = { ok: true; value: PlacementSnapshot; drag?: WindowDragReply } | { ok: false }
export interface BubblePlacementApi { get(): Promise<PlacementSnapshot>; action(value: PlacementAction): Promise<PlacementResult>; onChanged(listener: (value: PlacementSnapshot) => void): () => void }
