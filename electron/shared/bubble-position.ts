export type BubbleRect = { x: number; y: number; width: number; height: number }
export type BubbleBounds = { x0: number; y0: number; x1: number; y1: number }
export const BUBBLE_GAP = 12
export const BUBBLE_MARGIN = 8
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

/** CSS pixels / DIP only; the caller supplies its trusted available rectangle. */
export function anchoredBubbleCandidates(area: BubbleRect, face: BubbleBounds, size: { width: number; height: number }) {
  const { width, height } = size, gap = BUBBLE_GAP, margin = BUBBLE_MARGIN
  const center = (face.x0 + face.x1) / 2
  const x = clamp(center - width / 2, area.x + margin, area.x + area.width - width - margin)
  const y = clamp(face.y0, area.y + margin, area.y + area.height - height - margin)
  return [
    { side: "right" as const, x: face.x1 + gap, y, width, height },
    { side: "left" as const, x: face.x0 - gap - width, y, width, height },
    { side: "top" as const, x, y: face.y0 - height - gap, width, height },
    { side: "bottom" as const, x, y: face.y1 + gap, width, height },
  ]
}
export function fitsBubbleArea(rect: BubbleRect, area: BubbleRect): boolean {
  return rect.x >= area.x + BUBBLE_MARGIN && rect.y >= area.y + BUBBLE_MARGIN && rect.x + rect.width <= area.x + area.width - BUBBLE_MARGIN && rect.y + rect.height <= area.y + area.height - BUBBLE_MARGIN
}
