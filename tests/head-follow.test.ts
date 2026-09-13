import { describe, expect, it } from "vitest"
import { headFollowWeight, isValidHeadFollow } from "../src/engine/anime25d/HeadFollow"
import { applyRigOverrides } from "../src/engine/anime25d/RigOverrides"
import type { RigDefinition } from "../src/engine/anime25d/types"

const profile = { center: { cx: 540, cy: 195 }, radius: 80, falloffRadius: 185 }
describe("hand contact with the head", () => {
  it("fully follows the head at the fingers while leaving the shoulder attached to the body", () => {
    expect(headFollowWeight(540,195,profile)).toBe(1)
    expect(headFollowWeight(507,215,profile)).toBe(1)
    expect(headFollowWeight(464,405,profile)).toBe(0)
    expect(headFollowWeight(360,510,profile)).toBe(0)
    const weights = [80,100,120,140,165,185].map(d=>headFollowWeight(540+d,195,profile))
    expect(weights.every((w,i)=>!i||w<=weights[i-1])).toBe(true)
    expect(headFollowWeight(540,195)).toBe(0)
  })
  it("inherits the same contact field for the skin and sleeve sharing an arm mesh", () => {
    const arm = { name:"arm",x:0,y:0,w:1,h:1,z:0,depth:.86,group:"body",phys:null,fade:null,side:null,strands:null,img:{width:1,height:1,data:new Uint8ClampedArray([230,200,190,255])} }
    const rig = { canvas:{w:1280,h:1280},layers:[arm,{...arm,name:"skin"},{...arm,name:"sleeve"}],anchors:{},warnings:[],synth:{eye:false,mouth:false} } as unknown as RigDefinition
    const result = applyRigOverrides(rig,{headFollow:{arm:profile},meshSources:{skin:"arm",sleeve:"arm"}})
    expect(result.layers.every(l=>JSON.stringify(l.headFollow)===JSON.stringify(profile))).toBe(true)
    expect(rig.layers.every(l=>!l.headFollow)).toBe(true)
  })
  it("rejects invalid external fields", () => {
    expect(isValidHeadFollow(profile)).toBe(true)
    for (const value of [null,{}, {...profile,radius:-1}, {...profile,falloffRadius:80}, {...profile,center:{cx:NaN,cy:0}}]) expect(isValidHeadFollow(value)).toBe(false)
  })
})
