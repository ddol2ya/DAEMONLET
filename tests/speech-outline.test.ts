import { describe, expect, it } from "vitest"
import { SPEECH_OUTLINE_SIZE as N, speechOutlineFromPixels, validSpeechOutline } from "../electron/shared/speech-outline"
import { positionDesktopSpeechBubble } from "../electron/shared/speech-bubble"
import { validatePetBubblePresentation } from "../electron/shared/bubble-presentation"

const outline = () => Array.from({ length: N }, (_, y) => y < 40 ? [44, 84] : [12, 116]).flat()
const area = { x: 0, y: 24, width: 1440, height: 900 }
const anchor = { x0: 44 / N, x1: 84 / N, y0: .02, y1: .31 }
const content = { width: 110, height: 42 }

describe("speech artwork outline", () => {
  it("extracts exclusive row edges, including soft edges but excluding transparent pixels", () => {
    const rgba = new Uint8ClampedArray(N * N * 4)
    expect(speechOutlineFromPixels(rgba)).toBeNull()
    rgba[(4 * N + 20) * 4 + 3] = 8
    rgba[(4 * N + 38) * 4 + 3] = 255
    rgba[(4 * N + 10) * 4 + 3] = 7
    const result = speechOutlineFromPixels(rgba)!
    expect(result.slice(8, 10)).toEqual([20, 39])
    expect(result.slice(0, 8)).toEqual(Array(8).fill(-1))
    expect(validSpeechOutline(result)).toBe(true)
  })
  it.each([280, 299, 368, 460, 575, 690, 720])("stays close to the head, ignoring empty gutters and low wide artwork at %s DIP", size => {
    const pet = { x: 400, y: 100, width: size, height: size }
    const b = positionDesktopSpeechBubble(pet, area, anchor, { ...content, outline: outline() })
    expect(Math.abs(b.x - (pet.x + anchor.x1 * size) - 12)).toBeLessThanOrEqual(.5)
    expect(b.x).toBeLessThan(pet.x + pet.width - 60)
    expect([b.width, b.height]).toEqual([122, 54])
  })
  it("moves just beyond a raised hand in the bubble band, without reserving the full canvas", () => {
    const pet = { x: 1160, y: 100, width: 280, height: 280 }, rows = outline()
    for (let y = 5; y < 25; y++) rows[y * 2] = 26
    const b = positionDesktopSpeechBubble(pet, area, anchor, { ...content, outline: rows })
    expect(pet.x + 26 / N * pet.width - (b.x + b.width)).toBeCloseTo(12, 0)
    expect(b.x + b.width).toBeGreaterThan(pet.x + 40)
  })
  it("rejects malformed, excessive or non-finite outlines at IPC ingress", () => {
    const report = { epoch: 1, sequence: 1, available: true, phase: "shown", anchor }
    const speech = { ...content, text: "부르셨습니까?", fadeMs: 160, outline: outline() }
    expect(validatePetBubblePresentation({ ...report, speech })).not.toBeNull()
    const bad = [null, [], Array(258).fill(-1), [-1, 2, ...outline().slice(2)], [20, 20, ...outline().slice(2)], [0, 129, ...outline().slice(2)], [NaN, 2, ...outline().slice(2)], [0, Infinity, ...outline().slice(2)]]
    for (const value of bad) expect(validatePetBubblePresentation({ ...report, speech: { ...speech, outline: value } })).toBeNull()
  })
})
