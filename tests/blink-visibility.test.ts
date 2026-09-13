import { describe, expect, it } from "vitest"
import { DEFAULT_PARAMETERS } from "../src/engine/anime25d/Anime25DParameters"
import { computeLayerFadeAlpha, shouldUseEyeWhiteStencil } from "../src/engine/anime25d/Anime25DRenderer"

describe("blink layer visibility", () => {
  it("keeps one complete mouth across neutral, open, smile and blended expressions", () => {
    for (const mouthOpen of [0,.25,.5,1]) for (const mouthForm of [-1,0,.25,.5,1]) {
      const parameters = { ...DEFAULT_PARAMETERS, mouthOpen, mouthForm }
      const weights = (["neutral","open","smile"] as const).map(mouthExpression => computeLayerFadeAlpha({fade:null,side:null,mouthExpression},parameters))
      expect(weights.reduce((sum,value)=>sum+value,0)).toBeCloseTo(1)
      expect(weights.every(value=>value>=0&&value<=1)).toBe(true)
    }
    expect(computeLayerFadeAlpha({fade:null,side:null,mouthExpression:"open"},{...DEFAULT_PARAMETERS,mouthOpen:1})).toBe(1)
    expect(computeLayerFadeAlpha({fade:null,side:null,mouthExpression:"smile"},{...DEFAULT_PARAMETERS,mouthForm:1})).toBe(1)
  })

  it.each([[1, 1, 0], [0.75, 1, 0], [0.5, 1, 0], [0.3, 1, 0], [0.25, 1, 0], [0.15, 1, 0], [0.11, 0.5, 0.5], [0.08, 0, 1], [0, 0, 1]])("keeps one opaque lid until the final closure at eyeOpen=%s", (eyeOpen, open, close) => {
    const parameters = { ...DEFAULT_PARAMETERS, eyeOpenL: eyeOpen, eyeOpenR: eyeOpen }
    expect(computeLayerFadeAlpha({ fade: "eyeOpen", side: "L" }, parameters)).toBeCloseTo(open)
    expect(computeLayerFadeAlpha({ fade: "eyeClose", side: "L" }, parameters)).toBeCloseTo(close)
  })

  it("supports independent left/right blink values", () => {
    const parameters = { ...DEFAULT_PARAMETERS, eyeOpenL: 0, eyeOpenR: 1 }
    expect(computeLayerFadeAlpha({ fade: "eyeOpen", side: "L" }, parameters)).toBe(0)
    expect(computeLayerFadeAlpha({ fade: "eyeOpen", side: "R" }, parameters)).toBe(1)
  })

  it("does not stencil irises when See-through omitted the eye-white mask", () => {
    expect(shouldUseEyeWhiteStencil("L", new Set())).toBe(false)
    expect(shouldUseEyeWhiteStencil("L", new Set(["L"]))).toBe(true)
    expect(shouldUseEyeWhiteStencil("R", new Set(["L"]))).toBe(false)
  })
})
