import { describe, expect, it } from "vitest"
import { containTransform, viewportToModel } from "../src/engine/anime25d/coordinate"

describe("coordinate conversion", () => {
  it("maps a fitted canvas point into model coordinates", () => {
    const point = viewportToModel(400, 300, 800, 600, 400, 300)
    expect(point).toEqual({ x: 200, y: 150, inside: true })
  })

  it("accounts for letterboxing after resize", () => {
    const transform = containTransform(1000, 500, 400, 400)
    expect(transform).toEqual({ scale: 1.25, renderedWidth: 500, renderedHeight: 500, offsetX: 250, offsetY: 0 })
    expect(viewportToModel(250, 250, 1000, 500, 400, 400)).toMatchObject({ x: 0, y: 200, inside: true })
    expect(viewportToModel(100, 250, 1000, 500, 400, 400).inside).toBe(false)
  })
})
