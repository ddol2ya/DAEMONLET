import { describe, expect, it } from "vitest"
import { clientToModel, modelToClient, modelToViewport, viewportToModel } from "../src/engine/anime25d/coordinate"
import { positionSpeechBubble } from "../src/pet/SpeechBubblePosition"
import { positionDesktopSpeechBubble } from "../electron/shared/speech-bubble"

describe("speech bubble geometry", () => {
  it.each([[280,280],[460,460],[720,720],[1000,500],[300,720]])("round-trips model and client coordinates at %s x %s", (width, height) => {
    const point = modelToViewport(350, 480, width, height, 800, 1200)
    const model = viewportToModel(point.x, point.y, width, height, 800, 1200)
    expect(model.inside).toBe(true)
    expect(model.x).toBeCloseTo(350); expect(model.y).toBeCloseTo(480)
    const rect = { left: 42, top: 65, width, height }
    const client = modelToClient(350, 480, rect, 800, 1200)
    const inverse = clientToModel(client.x, client.y, rect, 800, 1200)
    expect(inverse.x).toBeCloseTo(350); expect(inverse.y).toBeCloseTo(480)
  })
  it("prefers right, falls back left, then above the face", () => {
    const viewport = { width: 460, height: 460 }, bubble = { width: 180, height: 60 }
    expect(positionSpeechBubble(viewport, { x0: 50, x1: 100, y0: 200, y1: 250 }, bubble).side).toBe("right")
    expect(positionSpeechBubble(viewport, { x0: 300, x1: 400, y0: 200, y1: 250 }, bubble).side).toBe("left")
    expect(positionSpeechBubble(viewport, { x0: 120, x1: 340, y0: 200, y1: 300 }, bubble)).toMatchObject({ side: "top", x: 140, y: 128 })
  })
  it.each([280,299,368,460,575,690,720])("clamps the bubble and tail inside %s DIP", (size) => {
    for (const center of [0, size/2, size]) {
      const p = positionSpeechBubble({ width: size, height: size }, { x0: center - 60, x1: center + 60, y0: center, y1: center + 120 }, { width: 240, height: 64 })
      expect(p.x).toBeGreaterThanOrEqual(8); expect(p.y).toBeGreaterThanOrEqual(8)
      expect(p.x + p.width).toBeLessThanOrEqual(size - 8)
      expect(p.y + p.height + 6).toBeLessThanOrEqual(size - 8)
      expect(p.tailX).toBeGreaterThanOrEqual(14); expect(p.tailX).toBeLessThanOrEqual(p.width - 14)
    }
  })
  it.each([280,299,368,460,575,690,720])("wraps beside Gpichan's full head at %s DIP instead of covering the hair", size => {
    const head = { x0: 439 * size / 1280, x1: 838 * size / 1280, y0: 10 * size / 1280, y1: 366 * size / 1280 }
    const p = positionSpeechBubble({ width: size, height: size }, head, { width: 240, height: 110 })
    expect(p.x >= head.x1 + 12 || p.x + p.width <= head.x0 - 12 || p.y + p.height + 6 <= head.y0 || p.y >= head.y1 + 12).toBe(true)
    expect(p.width).toBeGreaterThanOrEqual(76)
    expect(p.x + p.width).toBeLessThanOrEqual(size - 8)
  })

  it.each([280, 320, 460])("keeps Toki dialogue outside the head and readable at %s DIP", size => {
    const head = { x0: 450 * size / 1280, x1: 830 * size / 1280, y0: 20 * size / 1280, y1: 385 * size / 1280 }
    const p = positionSpeechBubble({ width: size, height: size }, head, { width: 230, height: 92 })
    expect(p.width).toBeGreaterThanOrEqual(76)
    expect(p.x >= head.x1 + 12 || p.x + p.width <= head.x0 - 12).toBe(true)
    expect(p.tailY).toBeGreaterThanOrEqual(12)
  })

  it("recomputes when face or viewport changes", () => {
    const face = { x0: 50, x1: 100, y0: 200, y1: 250 }, bubble = { width: 180, height: 60 }
    const initial = positionSpeechBubble({ width: 460, height: 460 }, face, bubble)
    expect(positionSpeechBubble({ width: 280, height: 280 }, face, bubble)).not.toEqual(initial)
    expect(positionSpeechBubble({ width: 460, height: 460 }, { ...face, x0: 300, x1: 400 }, bubble)).not.toEqual(initial)
  })
  it("uses the space below a high head when a side gutter would split a whole word", () => {
    const face = { x0: 96, x1: 184, y0: 8, y1: 96 }
    const p = positionSpeechBubble({ width: 280, height: 280 }, face, { width: 210, height: 70, minWidth: 128 })
    expect(p.side).toBe('bottom')
    expect(p.width).toBeGreaterThanOrEqual(128)
    expect(p.y).toBeGreaterThanOrEqual(face.y1 + 12)
    expect(p.x + p.width).toBeLessThanOrEqual(272)
  })
  it("keeps a wide-enough side gutter for natural word wrapping", () => {
    const p = positionSpeechBubble({ width: 460, height: 460 }, { x0: 160, x1: 295, y0: 10, y1: 150 }, { width: 230, height: 70, minWidth: 128 })
    expect(['left', 'right']).toContain(p.side)
    expect(p.width).toBeGreaterThanOrEqual(128)
  })
})

describe("desktop speech area", () => {
  const anchor = { x0: .35, x1: .65, y0: .02, y1: .33 }
  const area = { x: 0, y: 24, width: 1440, height: 900 }
  const content = { width: 230, height: 62 }
  it.each([280, 299, 368, 460, 575, 690, 720])("keeps text size and head clearance when Pet is %s DIP", size => {
    const pet = { x: 550, y: 120, width: size, height: size }
    const b = positionDesktopSpeechBubble(pet, area, anchor, content)
    expect([b.width, b.height]).toEqual([242, 74])
    expect(b.x >= pet.x + size || b.x + b.width <= pet.x || b.y + b.height <= pet.y || b.y >= pet.y + size).toBe(true)
    expect(b.x >= pet.x + anchor.x1 * size || b.x + b.width <= pet.x + anchor.x0 * size || b.y + b.height <= pet.y + anchor.y0 * size).toBe(true)
  })
  it.each([{ x: 0, y: 24 }, { x: 1160, y: 24 }, { x: 0, y: 644 }, { x: 1160, y: 644 }])("fits at display corner %j without moving below the head", point => {
    const pet = { ...point, width: 280, height: 280 }
    const b = positionDesktopSpeechBubble(pet, area, anchor, content)
    expect(b.x).toBeGreaterThanOrEqual(area.x + 8)
    expect(b.y).toBeGreaterThanOrEqual(area.y + 8)
    expect(b.x + b.width).toBeLessThanOrEqual(area.x + area.width - 8)
    expect(b.y + b.height).toBeLessThanOrEqual(area.y + area.height - 8)
    expect(b.x >= pet.x + anchor.x1 * pet.width || b.x + b.width <= pet.x + anchor.x0 * pet.width).toBe(true)
  })
  it("clears the entire body for tall text and moves around explicit controls", () => {
    const pet = { x: 550, y: 120, width: 280, height: 280 }
    const controls = { x: 850, y: 120, width: 360, height: 300 }
    const b = positionDesktopSpeechBubble(pet, area, anchor, { width: 240, height: 140 }, controls)
    expect(b.x + b.width).toBeLessThanOrEqual(pet.x)
    expect([b.width, b.height]).toEqual([252, 152])
  })
  it("follows movement into a display with negative desktop coordinates", () => {
    const pet = { x: -1400, y: -250, width: 460, height: 460 }
    const display = { x: -1920, y: -400, width: 1920, height: 1080 }
    const b = positionDesktopSpeechBubble(pet, display, anchor, content)
    const moved = positionDesktopSpeechBubble({ ...pet, x: pet.x + 60, y: pet.y + 70 }, display, anchor, content)
    expect(moved).toEqual({ ...b, x: b.x + 60, y: b.y + 70 })
  })
})
