import type { ActivityEntry, ActivitySnapshot } from "./activity-contract"
import { intersectionArea } from "./desktop-settings"
import type { BubbleAnchor } from "./bubble-presentation"
import { anchoredBubbleCandidates, fitsBubbleArea } from "./bubble-position"

type Rect = { x: number; y: number; width: number; height: number }
export const ACTIVITY_BUBBLE_SIZE = { width: 276, height: 100 }
export const ACTIVITY_BUBBLE_COMPACT_SIZE = { width: 64, height: 44 }
export const TASK_CONTROL_BUBBLE_SIZE = { width: 360, height: 300 }
export const TASK_CONTROL_BUBBLE_COMPACT_SIZE = { width: 260, height: 52 }

export function positionAnchoredActivityBubble(pet: Rect, area: Rect, anchor: BubbleAnchor, collapsed: boolean, measuredHeight: number): Rect {
  const size = { ...(collapsed ? ACTIVITY_BUBBLE_COMPACT_SIZE : ACTIVITY_BUBBLE_SIZE), height: measuredHeight }
  const face = { x0: pet.x + anchor.x0 * pet.width, x1: pet.x + anchor.x1 * pet.width, y0: pet.y + anchor.y0 * pet.height, y1: pet.y + anchor.y1 * pet.height }
  const candidate = anchoredBubbleCandidates(area, face, size).find(r => fitsBubbleArea(r, area))
  if (candidate) return { x: Math.round(candidate.x), y: Math.round(candidate.y), width: size.width, height: size.height }
  return positionActivityBubble(pet, area, collapsed)
}

/** Never put the companion over the Pet canvas (including its dialogue), if space permits. */
export function positionActivityBubble(pet: Rect, area: Rect, collapsed: boolean, control = false, expandedSize?: { width: number; height: number }): Rect {
  const size = collapsed ? control ? TASK_CONTROL_BUBBLE_COMPACT_SIZE : ACTIVITY_BUBBLE_COMPACT_SIZE : expandedSize ?? (control ? TASK_CONTROL_BUBBLE_SIZE : ACTIVITY_BUBBLE_SIZE)
  const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height), gap = 8
  const centerX = pet.x + (pet.width - width) / 2, centerY = pet.y + (pet.height - height) / 2
  const clamp = (r: Rect): Rect => ({ ...r, x: Math.round(Math.max(area.x, Math.min(r.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(r.y, area.y + area.height - height))) })
  const candidates = [
    { x: centerX, y: pet.y - height - gap, width, height },
    { x: pet.x + pet.width + gap, y: centerY, width, height },
    { x: pet.x - width - gap, y: centerY, width, height },
    { x: centerX, y: pet.y + pet.height + gap, width, height },
  ].map(clamp)
  return candidates.reduce((best, candidate) => intersectionArea(candidate, pet) < intersectionArea(best, pet) ? candidate : best)
}

export function activityBubbleEntries(snapshot: Pick<ActivitySnapshot, "entries">): ActivityEntry[] {
  const priority = (r: ActivityEntry) => r.state === "waiting" ? 0 : r.unread && r.state === "failed" ? 1 : r.unread ? 2 : 3
  return snapshot.entries.filter(r => r.state === "waiting" || r.state === "running" || r.unread)
    .sort((a, b) => priority(a) - priority(b) || b.lastObservedAt - a.lastObservedAt || a.activityId.localeCompare(b.activityId))
}
