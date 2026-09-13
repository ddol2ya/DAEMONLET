import { describe, expect, it } from "vitest"
import { MotionOrchestrator } from "../src/motion/orchestration/MotionOrchestrator"
import { MotionSourceHost } from "../src/motion/orchestration/MotionSourceHost"
import { ParameterMixer } from "../src/interaction/ParameterMixer"
const face={cx:50,cy:50,x0:0,y0:0,x1:100,y1:100}
function setup(enabled=false) { const mixer=new ParameterMixer(),host=new MotionSourceHost(mixer),o=new MotionOrchestrator(host,mixer,{now:()=>0},()=>.2);o.setGazeTakeoverFromCurrent(enabled);return {mixer,host,o} }
const input=(now:number,pointerTarget: {x:number;y:number}|null,dt=0)=>({now,dt,pointerTarget,face,semanticState:"NORMAL" as const,poseActive:false})
describe("Bell pointer takeover",()=>{
  it("starts at the current gaze, then lets eyes lead the head",()=>{
    const {mixer,o}=setup(true);mixer.setSource("idle-gaze",{eyeX:-.3,eyeY:.1,angleX:-.08,angleY:0},12)
    o.updateBaseSources(input(0,{x:100,y:50}))
    expect(mixer.evaluate().eyeX).toBe(-.3)
    o.updateBaseSources(input(16,{x:100,y:50},.016))
    const p=o.pointerGaze.getDiagnostics()
    expect(p.eyeX).toBeGreaterThan(-.3)
    expect((p.eyeX+.3)/(1/1.4+.3)).toBeGreaterThan((p.headX+.08)/((1/1.4)*.55+.08))
  })
  it("releases to underlying sources smoothly and clears the pointer lease",()=>{
    const {mixer,host,o}=setup(true);o.updateBaseSources(input(0,{x:100,y:50},.5))
    const before=mixer.evaluate().eyeX
    o.updateBaseSources(input(10,null))
    expect(mixer.evaluate().eyeX).toBe(before)
    o.updateBaseSources(input(160,null))
    expect(mixer.evaluate().eyeX).toBeCloseTo(before*.5)
    o.updateBaseSources(input(310,null))
    expect(host.diagnostics().filter(d=>d.status==="active"&&d.slot==="pointer-gaze")).toHaveLength(0)
  })
  it("keeps legacy defaults when the Bell option is absent",()=>{
    const {mixer,o}=setup();mixer.setSource("idle-gaze",{eyeX:-.3},12)
    o.updateBaseSources(input(0,{x:100,y:50}))
    expect(mixer.evaluate().eyeX).toBe(0)
    o.updateBaseSources(input(10,null))
    expect(o.getGazeDiagnostics().pointerActive).toBe(false)
  })
})
