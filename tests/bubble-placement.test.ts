import { describe, expect, it } from "vitest"
import { automaticBubblePlacement, bubblePlacementReference, parseBubblePlacement, positionRelativeBubble, relativeBubblePlacement } from "../electron/shared/bubble-placement"
import { defaultDesktopSettings, normalizeDesktopSettings, validateDesktopSettingsPatch } from "../electron/shared/desktop-settings"
import { BubblePresentationCoordinator } from "../electron/main/BubblePresentationCoordinator"
import { WindowBoundsStore } from "../electron/main/WindowBoundsStore"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pet = { x: 400, y: 400, width: 400, height: 400 }, area = { x: 0, y: 0, width: 1600, height: 1200 }
describe("one relative placement for every bubble", () => {
  it("roundtrips relative intent through a new store while retaining unrelated settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bubble-placement-test-"))
    try {
      const saved = { ...defaultDesktopSettings(), language: "en" as const, sideChatEnabled: false, characterId: "external-pack", bubblePlacement: relativeBubblePlacement(pet, { x: 800, y: 400, width: 360, height: 210 }) }
      await new WindowBoundsStore(directory).save(saved)
      expect((await new WindowBoundsStore(directory).load(() => true)).value).toEqual(saved)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it("keeps the same attached edge for short speech, task and expanded chat", () => {
    const placement = relativeBubblePlacement(pet, { x: 800, y: 500, width: 280, height: 200 })
    expect(placement).toMatchObject({ pivotX: 0, pivotY: .5 })
    for (const size of [{ width: 160, height: 60 }, { width: 276, height: 100 }, { width: 360, height: 340 }, { width: 480, height: 640 }]) {
      const box = positionRelativeBubble(pet, area, size, placement)
      expect(box.x).toBe(800); expect(box.y + box.height / 2).toBe(600)
    }
  })
  it("follows the stable Pet center through moves and scale changes, independent of rig or physical DPI", () => {
    const placement = relativeBubblePlacement(pet, { x: 460, y: 200, width: 280, height: 180 })
    for (const scaleFactor of [1, 1.5, 2]) {
      const moved = { x: -900, y: 400, width: 600, height: 600 }, monitor = { ...area, x: -1600, scaleFactor }
      const result = positionRelativeBubble(moved, monitor, { width: 480, height: 320 }, placement)
      expect(result.x + result.width / 2).toBe(-600); expect(result.y + result.height).toBe(480)
    }
  })
  it("clamps presentation after monitor removal or a long answer without mutating stored intent", () => {
    const placement = relativeBubblePlacement(pet, { x: 1700, y: 300, width: 280, height: 100 }), original = structuredClone(placement)
    const small = positionRelativeBubble(pet, { x: 0, y: 0, width: 320, height: 240 }, { width: 480, height: 640 }, placement)
    expect(small).toEqual({ x: 0, y: 0, width: 320, height: 240 }); expect(placement).toEqual(original)
    const restored = positionRelativeBubble(pet, { x: 1600, y: 0, width: 1600, height: 1200 }, { width: 280, height: 100 }, placement)
    expect(restored.x).toBe(1700); expect(bubblePlacementReference(pet, placement).x).toBe(1700)
  })
  it("defaults old and corrupt placement to auto while retaining OFF, language, packs and Pet bounds", () => {
    const old = { ...defaultDesktopSettings(), characterId: "external-pack", language: "en", sideChatEnabled: false, scale: .8 }
    for (const bad of [undefined, null, { schemaVersion: 2, mode: "auto" }, { schemaVersion: 1, mode: "relative", offsetX: NaN, offsetY: 0, pivotX: 0, pivotY: 0 }, { schemaVersion: 1, mode: "relative", offsetX: 10001, offsetY: 0, pivotX: 0, pivotY: 0 }]) {
      const settings = normalizeDesktopSettings({ ...old, bubblePlacement: bad }, () => true).value
      expect(settings).toMatchObject({ characterId: "external-pack", language: "en", sideChatEnabled: false, scale: .8, bubblePlacement: automaticBubblePlacement() })
    }
    expect(parseBubblePlacement({ schemaVersion: 1, mode: "auto", path: "/private" })).toBe(null)
    expect(validateDesktopSettingsPatch({ bubblePlacement: { schemaVersion: 1, mode: "relative", offsetX: Infinity } })).toBe(null)
  })
  it("processes real dialogue expiry during preview without replay or task-state mutation", async () => {
    const c = new BubblePresentationCoordinator(() => {}), epoch = c.begin(), anchor = { x0: .3, x1: .7, y0: .1, y1: .3 }
    await c.report({ epoch, sequence: 1, available: true, phase: "shown", anchor, speech: { text: "original", width: 160, height: 60, fadeMs: 100 } })
    c.setPlacementEditing(true)
    expect(c.canShowActivity).toBe(false)
    expect((await c.report({ epoch, sequence: 2, available: true, phase: "preparing", anchor })).granted).toBe(false)
    await c.report({ epoch, sequence: 3, available: true, phase: "hidden", anchor })
    c.setPlacementEditing(false)
    expect(c.speech).toBe(null)
    c.dispose()
  })
})
