import { describe, expect, it } from "vitest"
import { activityBubbleEntries, positionActivityBubble, positionAnchoredActivityBubble } from "../electron/shared/activity-bubble"
import { defaultDesktopSettings, intersectionArea, normalizeDesktopSettings, validateDesktopSettingsPatch } from "../electron/shared/desktop-settings"
import type { ActivityEntry } from "../electron/shared/activity-contract"

const row = (activityId: string, state: ActivityEntry["state"], unread = false): ActivityEntry => ({ activityId, name: activityId, state, unread, revision: 1, firstObservedAt: 1, lastObservedAt: 1, endedAt: null, acknowledgedAt: null, confidence: null, category: null, freshness: "observed" })
describe("task companion selection and layout", () => {
  it("prioritizes waiting and unread failures while hiding acknowledged history", () => {
    const entries = [row("activity-1", "running"), row("activity-2", "completed"), row("activity-3", "completed", true), row("activity-4", "waiting"), row("activity-5", "failed", true), row("activity-6", "unknown"), row("activity-7", "cancelled")]
    expect(activityBubbleEntries({ entries }).map(r => r.activityId)).toEqual(["activity-4", "activity-5", "activity-3", "activity-1"])
    expect(entries[0].activityId).toBe("activity-1")
    expect(activityBubbleEntries({ entries: [row("activity-1", "completed")] })).toEqual([])
  })
  it.each([false, true])("keeps the %s companion on-screen and outside the complete Pet canvas", collapsed => {
    for (const xOffset of [-1600, 0, 1600]) for (const yOffset of [-1000, 0]) {
      const area = { x: xOffset, y: yOffset, width: 1440, height: 900 }
      for (const x of [0, 500, 980]) for (const y of [0, 200, 440]) {
        const pet = { x: xOffset + x, y: yOffset + y, width: 460, height: 460 }
        const result = positionActivityBubble(pet, area, collapsed)
        expect(intersectionArea(result, pet)).toBe(0)
        expect(intersectionArea(result, area)).toBe(result.width * result.height)
      }
    }
  })
  it("prefers above, follows movement, and clamps on a display smaller than the card", () => {
    const area = { x: 0, y: 0, width: 1440, height: 900 }
    const pet = { x: 500, y: 400, width: 460, height: 460 }
    const result = positionActivityBubble(pet, area, false)
    expect(result.y + result.height).toBe(pet.y - 8)
    expect(positionActivityBubble({ ...pet, x: 550 }, area, false).x).toBe(result.x + 50)
    expect(positionActivityBubble(pet, { x: -40, y: -20, width: 200, height: 100 }, false)).toEqual({ x: -40, y: -20, width: 200, height: 100 })
  })
  it("anchors compact cards beside the current head across negative displays and work-area edges", () => {
    const anchor = { x0: .32, x1: .67, y0: .03, y1: .33 }
    for (const xOffset of [-1600, 0, 1600]) for (const size of [280, 320, 460, 720]) for (const height of [73, 93, 220]) {
      const area = { x: xOffset, y: -900, width: 1440, height: 860 }
      for (const x of [area.x, area.x + area.width - size]) for (const y of [area.y, area.y + area.height - size]) {
        const pet = { x, y, width: size, height: size }
        const head = { x: x + anchor.x0 * size, y: y + anchor.y0 * size, width: (anchor.x1 - anchor.x0) * size, height: (anchor.y1 - anchor.y0) * size }
        const card = positionAnchoredActivityBubble(pet, area, anchor, false, height)
        expect(intersectionArea(card, head)).toBe(0)
        expect(intersectionArea(card, area)).toBe(card.width * card.height)
        expect(card.height).toBe(height)
      }
    }
  })
  it("migrates and persists its toggle independently of character dialogue", () => {
    const { taskBubblesEnabled: _, ...old } = { ...defaultDesktopSettings(), speechBubblesEnabled: false }
    const migrated = normalizeDesktopSettings(old)
    expect(migrated).toMatchObject({ migrated: true, value: { speechBubblesEnabled: false, taskBubblesEnabled: true, bounds: old.bounds } })
    expect(normalizeDesktopSettings({ ...migrated.value, taskBubblesEnabled: false }).value).toMatchObject({ speechBubblesEnabled: false, taskBubblesEnabled: false })
    expect(validateDesktopSettingsPatch({ taskBubblesEnabled: false })).toEqual({ taskBubblesEnabled: false })
    expect(validateDesktopSettingsPatch({ taskBubblesEnabled: "true" })).toBeNull()
  })
})
