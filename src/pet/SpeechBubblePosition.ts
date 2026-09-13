import type { Bounds } from "../engine/anime25d/types"
import { anchoredBubbleCandidates, fitsBubbleArea, BUBBLE_GAP, BUBBLE_MARGIN } from "../../electron/shared/bubble-position"

export type BubblePosition = { x: number; y: number; width: number; height: number; side: "right" | "left" | "top" | "bottom"; tailX: number; tailY: number }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** All units are viewport CSS pixels (Electron DIP), independent of devicePixelRatio. */
export function positionSpeechBubble(viewport: { width: number; height: number }, face: Bounds, bubble: { width: number; height: number; minWidth?: number }): BubblePosition {
  const margin = BUBBLE_MARGIN
  const gap = BUBBLE_GAP
  let width = Math.min(bubble.width, Math.max(0, viewport.width - margin * 2))
  const height = Math.min(bubble.height, Math.max(0, viewport.height - margin * 2))
  const center = (face.x0 + face.x1) / 2
  const area = { x: 0, y: 0, width: viewport.width, height: viewport.height - 6 }
  const full = anchoredBubbleCandidates(area, face, { width, height }).slice(0, 3).find(r => fitsBubbleArea(r, area))
  if (full) return { ...full, tailX: clamp(center - full.x, 14, Math.max(14, width - 14)), tailY: clamp((face.y0 + face.y1) / 2 - full.y, 12, Math.max(12, height - 12)) }
  let side: BubblePosition["side"] = "right"
  let x = face.x1 + gap
  let y = face.y0 - height * 0.65
  if (x + width > viewport.width - margin) {
    side = "left"
    x = face.x0 - gap - width
    if (x < margin) {
      side = "top"
      x = center - width / 2
      y = face.y0 - height - gap
      // A head near the top edge has no room above it. Wrap the text in
      // the wider side gutter instead of clamping a full-width box over hair.
      if (y < margin) {
        const rightRoom = Math.max(0, viewport.width - margin - face.x1 - gap)
        const leftRoom = Math.max(0, face.x0 - gap - margin)
        // A gutter must fit a whole word as well as padding. Otherwise choose
        // the space below the head instead of splitting a Korean ending.
        const readableWidth = Math.min(width, Math.max(76, bubble.minWidth ?? 76))
        if (Math.max(rightRoom, leftRoom) >= readableWidth) {
          side = rightRoom >= leftRoom ? "right" : "left"
          width = Math.min(width, Math.max(rightRoom, leftRoom))
          x = side === "right" ? face.x1 + gap : face.x0 - gap - width
          y = face.y0
        } else {
          side = "bottom"
          y = face.y1 + gap
        }
      }
    }
  }
  x = clamp(x, margin, viewport.width - width - margin)
  // Reserve the six pixel tail inside the window as well.
  y = clamp(y, margin, viewport.height - height - margin - 6)
  return { x, y, width, height, side, tailX: clamp(center - x, 14, Math.max(14, width - 14)), tailY: clamp((face.y0 + face.y1) / 2 - y, 12, Math.max(12, height - 12)) }
}
