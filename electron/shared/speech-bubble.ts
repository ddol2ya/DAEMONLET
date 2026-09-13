import type { BubbleAnchor } from "./bubble-presentation"
import { anchoredBubbleCandidates, fitsBubbleArea, BUBBLE_GAP, BUBBLE_MARGIN, type BubbleRect } from "./bubble-position"
import { SPEECH_OUTLINE_SIZE, type SpeechOutline } from "./speech-outline"

export const SPEECH_WINDOW_PADDING = 6
const overlap = (a: BubbleRect, b: BubbleRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/** Text size is DIP, while only its head anchor follows the scaled Pet. */
export function positionDesktopSpeechBubble(pet: BubbleRect, area: BubbleRect, anchor: BubbleAnchor, content: { width: number; height: number; outline?: SpeechOutline }, avoid?: BubbleRect): BubbleRect {
  const size = { width: Math.min(content.width + SPEECH_WINDOW_PADDING * 2, area.width - BUBBLE_MARGIN * 2), height: Math.min(content.height + SPEECH_WINDOW_PADDING * 2, area.height - BUBBLE_MARGIN * 2) }
  if (content.outline) {
    const face = { x0: pet.x + anchor.x0 * pet.width, x1: pet.x + anchor.x1 * pet.width, y0: pet.y + anchor.y0 * pet.height, y1: pet.y + anchor.y1 * pet.height }
    const rows = outlineRects(pet, content.outline)
    const nearby = anchoredBubbleCandidates(area, face, size).slice(0, 3)
    // Use only artwork beside the bubble's vertical band. Wide hips, long
    // hair ends and empty window gutters must not move a head-level bubble.
    for (const candidate of nearby.slice(0, 2)) {
      const band = rows.filter(row => row.y < candidate.y + size.height + BUBBLE_GAP && row.y + row.height > candidate.y - BUBBLE_GAP)
      const left = band.length ? Math.min(...band.map(row => row.x)) : face.x0
      const right = band.length ? Math.max(...band.map(row => row.x + row.width)) : face.x1
      candidate.x = candidate.side === "right" ? right + BUBBLE_GAP : left - BUBBLE_GAP - size.width
    }
    const close = nearby.find(r => fitsBubbleArea(r, area) && rows.every(row => !overlap(r, row)) && (!avoid || !overlap(r, avoid)))
    if (close) return { x: Math.round(close.x), y: Math.round(close.y), ...size }
  }
  // Conservative fallback for missing geometry or no nearby screen space.
  const bounds = { x0: pet.x, x1: pet.x + pet.width, y0: pet.y, y1: pet.y + pet.height }
  const candidates = [
    ...anchoredBubbleCandidates(area, { ...bounds, y0: pet.y + anchor.y0 * pet.height }, size).slice(0, 2),
    ...anchoredBubbleCandidates(area, bounds, size).slice(2),
  ]
  const clear = candidates.find(r => fitsBubbleArea(r, area) && !overlap(r, pet) && (!avoid || !overlap(r, avoid)))
  const clamped = candidates.map(r => ({ ...r, x: Math.max(area.x + BUBBLE_MARGIN, Math.min(r.x, area.x + area.width - size.width - BUBBLE_MARGIN)), y: Math.max(area.y + BUBBLE_MARGIN, Math.min(r.y, area.y + area.height - size.height - BUBBLE_MARGIN)) }))
  const score = (r: BubbleRect) => overlap(r, pet) + (avoid ? overlap(r, avoid) : 0)
  const best = clear ?? clamped.reduce((a, b) => score(a) <= score(b) ? a : b)
  return { x: Math.round(best.x), y: Math.round(best.y), ...size }
}

function outlineRects(pet: BubbleRect, outline: SpeechOutline): BubbleRect[] {
  const n = SPEECH_OUTLINE_SIZE, rows: BubbleRect[] = []
  for (let y = 0; y < n; y++) if (outline[y * 2] >= 0) rows.push({ x: pet.x + outline[y * 2] * pet.width / n, y: pet.y + y * pet.height / n, width: (outline[y * 2 + 1] - outline[y * 2]) * pet.width / n, height: pet.height / n })
  return rows
}
