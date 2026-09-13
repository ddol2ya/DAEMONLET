import { describe, expect, it } from "vitest"
import { PoseMotionPlayback } from "../src/pose/PoseMotionPlayback"
import { PoseTransition } from "../src/pose/PoseTransition"
import { samplePoseMotion } from "../src/pose/PoseMotion"
import type { PoseMotion } from "../src/pose/types"
const motion: PoseMotion = { loopDurationMs:1000,transition:"continuous",parameters:{eyeOpenL:{type:"constant",value:.7}},layers:{hand:{translateX:{type:"sine",amplitude:2,phase:0,offset:0},scale:{type:"constant",value:1.2}}} }
function setup() { const p=new PoseMotionPlayback(), transition=new PoseTransition({enterMs:100,exitMs:80,swapStart:.42,swapEnd:.58}); transition.enter(0); p.sample(motion,transition.sample(0),0); p.sample(motion,transition.sample(100),100); return {p,transition} }
describe("continuous pose playback",()=>{
  it("exits from a sampled stroke and fades scale toward identity",()=>{
    const {p,transition}=setup()
    const active=p.sample(motion,transition.sample(350),350)
    expect(active.layers.hand.translateX).toBeCloseTo(2)
    transition.exit(350)
    const first=p.sample(motion,transition.sample(350),350)
    expect(first).toEqual(active)
    const half=p.sample(motion,transition.sample(390),390)
    expect(half.layers.hand.translateX).toBeCloseTo(1)
    expect(half.layers.hand.scale).toBeCloseTo(1.1)
    expect(half.parameters.eyeOpenL).toBe(.7)
    expect(half.weight).toBe(.5)
    const base=p.sample(motion,transition.sample(430),430)
    expect(base.weight).toBe(0)
    expect(base.layers.hand.scale).toBe(1)
  })
  it("retargets an exit into enter without restarting the stroke",()=>{
    const {p,transition}=setup()
    p.sample(motion,transition.sample(350),350);transition.exit(350)
    const exiting=p.sample(motion,transition.sample(370),370)
    transition.enter(370)
    expect(p.sample(motion,transition.sample(370),370)).toEqual(exiting)
    p.sample(motion,transition.sample(470),470)
    expect(p.sample(motion,transition.sample(720),720).layers.hand.translateX).toBeCloseTo(0)
  })
  it("interrupts at enter 25/50/75% and reaches Base without a late stroke",()=>{
    for (const elapsed of [25,50,75]) {
      const p=new PoseMotionPlayback(), transition=new PoseTransition({enterMs:100,exitMs:80,swapStart:.42,swapEnd:.58})
      transition.enter(0);p.sample(motion,transition.sample(0),0)
      const entering=p.sample(motion,transition.sample(elapsed),elapsed)
      transition.exit(elapsed)
      expect(p.sample(motion,transition.sample(elapsed),elapsed)).toEqual(entering)
      expect(p.sample(motion,transition.sample(500),500).weight).toBe(0)
    }
  })
  it("reset discards an old model's stroke",()=>{
    const {p,transition}=setup();p.sample(motion,transition.sample(350),350);p.reset();transition.reset();transition.enter(500)
    expect(p.sample(motion,transition.sample(550),550).layers.hand.translateX).toBe(0)
  })
  it("leaves legacy sampling without a transition option unchanged",()=>{
    const legacy={...motion};delete legacy.transition
    expect(samplePoseMotion(legacy,250).layers.hand.translateX).toBe(2)
  })
  it("replays a completed reaction from its current frame and freezes that blend on exit",()=>{
    const once:PoseMotion={loopDurationMs:400,playback:"once",transition:"continuous",parameters:{brow:{type:"keyframes",interpolation:"smoothstep",frames:[{atMs:0,value:0},{atMs:100,value:.4},{atMs:400,value:0}]}},layers:{hand:{translateY:{type:"keyframes",interpolation:"smoothstep",frames:[{atMs:0,value:0},{atMs:100,value:-8},{atMs:400,value:0}]}}}}
    const p=new PoseMotionPlayback(), transition=new PoseTransition({enterMs:100,exitMs:80,swapStart:.42,swapEnd:.58})
    transition.pauseAt(1)
    p.sample(once,transition.sample(0),0)
    const settled=p.sample(once,transition.sample(500),500)
    p.restart(500)
    expect(p.sample(once,transition.sample(500),500)).toEqual(settled)
    const replay=p.sample(once,transition.sample(550),550)
    expect(replay.layers.hand.translateY).toBeLessThan(-1)
    transition.exit(550)
    expect(p.sample(once,transition.sample(550),550)).toEqual(replay)
    const exiting=p.sample(once,transition.sample(590),590)
    expect(exiting.parameters).toEqual(replay.parameters)
    expect(exiting.layers.hand.translateY).toBeCloseTo(replay.layers.hand.translateY*.5)
    p.reset();transition.reset();transition.pauseAt(1)
    expect(p.sample(once,transition.sample(600),600).layers.hand.translateY).toBe(0)
  })
})
