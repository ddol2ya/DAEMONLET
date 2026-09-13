import { describe, expect, it } from "vitest"
import { deformMouthPoint, isValidMouthMorphProfile, mouthFrameOffset, mouthMorphWeights } from "../src/engine/anime25d/MouthMorph"
import { applyRigOverrides } from "../src/engine/anime25d/RigOverrides"
import type { MouthMorphProfile, RigDefinition } from "../src/engine/anime25d/types"

const profile: MouthMorphProfile = {
  center: { cx: 80, cy: 60 }, angleDeg: 0,
  neutral: { u0: -12, u1: 12, upper: [0, -1, 0], lower: [0, -1, 0] },
  smile: { u0: -14, u1: 14, upper: [-2, 2, -2], lower: [-2, 2, -2] },
  open: { u0: -10, u1: 10, upper: [-1, -4, -1], lower: [1, 5, 1] },
}
const world = (u: number, v: number, p=profile): [number, number] => {
  const [x, y] = mouthFrameOffset(u, v, p); return [p.center.cx+x, p.center.cy+y]
}
const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 8))

describe("continuous own-pose mouth contours", () => {
  it("preserves each authored endpoint and clamps overshooting inputs", () => {
    for (const [expression, open, form] of [["neutral", 0, 0], ["smile", 0, 1], ["open", 1, 0]] as const) {
      for (const angleDeg of [-30, 0, 17, 70]) {
        const p = { ...profile, angleDeg }
        for (const xy of [[73.2, 59.1], [80, 60], [93, 68]]) close(deformMouthPoint(xy[0], xy[1], expression, open, form, p), xy)
      }
    }
    expect(mouthMorphWeights(-10, 0)).toEqual(mouthMorphWeights(0, 0))
    expect(mouthMorphWeights(9, 0)).toEqual(mouthMorphWeights(1, 0))
  })
  it("aligns neutral and smile strokes to the same contour at every blend", () => {
    for (const form of [.1, .25, .5, .75, .9]) {
      close(deformMouthPoint(...world(0, -1), "neutral", 0, form, profile), deformMouthPoint(...world(0, 2), "smile", 0, form, profile))
    }
  })
  it("keeps lip thickness while changing the opening", () => {
    for (const open of [.2, .4, .6, .8]) {
      const top = deformMouthPoint(...world(0, -4), "open", open, 0, profile)
      const outside = deformMouthPoint(...world(0, -5.5), "open", open, 0, profile)
      expect(Math.hypot(top[0]-outside[0], top[1]-outside[1])).toBeCloseTo(1.5)
      const bottom = deformMouthPoint(...world(0, 5), "open", open, 0, profile)
      expect(bottom[1]-top[1]).toBeCloseTo(9*mouthMorphWeights(open, 0).aperture)
      const weights = mouthMorphWeights(open, 0)
      if (weights.aperture >= .16) expect(weights.neutral+weights.smile).toBe(0)
    }
  })
  it("retains the opening of a surprised neutral mouth throughout the handover", () => {
    const p={...profile,neutral:{...profile.neutral,upper:[-1,-2,-1],lower:[1,2,1]}}
    close(deformMouthPoint(...world(0,-2),"neutral",0,0,p),world(0,-2))
    close(deformMouthPoint(...world(0,2),"neutral",0,0,p),world(0,2))
    expect(mouthMorphWeights(0,.5,p)).toMatchObject({neutral:1,open:0,smile:0})
    expect(mouthMorphWeights(0,1,p)).toMatchObject({neutral:0,open:0,smile:1})
    expect(mouthMorphWeights(1,0,p)).toMatchObject({neutral:0,open:1,smile:0})
    let previousGap=4
    for(const open of [.05,.1,.2,.3,.5,1]){
      const top=deformMouthPoint(...world(0,-4),"open",open,0,p)
      const bottom=deformMouthPoint(...world(0,5),"open",open,0,p)
      expect(bottom[1]-top[1]).toBeGreaterThanOrEqual(previousGap)
      previousGap=bottom[1]-top[1]
      close(deformMouthPoint(...world(0,-2),"neutral",open,0,p),top)
      close(deformMouthPoint(...world(0,2),"neutral",open,0,p),bottom)
    }
  })
  it("rotates the morph with the face and keeps all weights normalized", () => {
    for (const open of [0, .1, .4, .7, 1]) for (const form of [0, .1, .5, 1]) {
      const w = mouthMorphWeights(open, form); expect(w.neutral+w.open+w.smile).toBeCloseTo(1)
      for (const expression of ["neutral", "open", "smile"] as const) {
        const p = { ...profile, angleDeg: 35 }, xy = world(3, 2, p)
        const flat = deformMouthPoint(...world(3, 2), expression, open, form, profile)
        close(deformMouthPoint(...xy, expression, open, form, p), world(flat[0]-80, flat[1]-60, p))
      }
    }
  })
  it("drops malformed external profiles without mutating the input rig", () => {
    expect(isValidMouthMorphProfile(profile)).toBe(true)
    for (const p of [null, {}, { ...profile, angleDeg: NaN }, { ...profile, open: { ...profile.open, u1: -10 } }, { ...profile, smile: { ...profile.smile, lower: [] } }]) expect(isValidMouthMorphProfile(p)).toBe(false)
    const rig = { canvas: { w: 128, h: 128 }, layers: [], anchors: { mouth: { cx: 80, cy: 60, x0: 60, x1: 100, y0: 50, y1: 70, morph: { ...profile, angleDeg: NaN } } }, warnings: [], synth: { eye: false, mouth: false } } as unknown as RigDefinition
    expect(applyRigOverrides(rig, {}).anchors.mouth).not.toHaveProperty("morph")
    expect(rig.anchors.mouth).toHaveProperty("morph")
  })
})
