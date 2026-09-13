import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { sampleMotionTrack, sampleMotionEnvelope } from "../src/motion/MotionSampler"
import { parseBehaviorManifest } from "../src/behavior/BehaviorManifest"
import { parsePoseManifest } from "../src/pose/PoseManifest"
import { ParameterMixer } from "../src/interaction/ParameterMixer"
import type { MotionTrack } from "../src/motion/types"
const load = (p: string) => JSON.parse(readFileSync(p,"utf8"))
const track: MotionTrack = { type:"keyframes", interpolation:"smoothstep", frames:[{atMs:0,value:0},{atMs:200,value:.4},{atMs:450,value:.4},{atMs:1000,value:0}] }
function parse(kind: "behavior" | "pose", motion: unknown) {
  const data = load(kind === "behavior" ? "public/characters/gpichan/behavior.json" : "public/characters/gpichan/poses/writing/pose.json")
  if (kind === "behavior") { data.states.NORMAL.motion=motion; return parseBehaviorManifest(data) }
  data.motion=motion; return parsePoseManifest(data)
}
describe("bounded motion expressions", () => {
  it("preserves legacy constant and sine results including negative elapsed", () => {
    for (const t of [-250,0,250,1000,1000000000]) {
      expect(sampleMotionTrack({type:"constant",value:.4},t,1000)).toBe(.4)
      expect(sampleMotionTrack({type:"sine",amplitude:.3,phase:.8,offset:.1},t,1000)).toBe(.1+Math.sin(((t%1000+1000)%1000)/1000*Math.PI*2+.8)*.3)
    }
  })
  it("holds a writing rest and joins a smooth loop without a position jump", () => {
    expect(sampleMotionTrack(track,200,1000)).toBe(.4)
    expect(sampleMotionTrack(track,325,1000)).toBe(.4)
    expect(sampleMotionTrack(track,450,1000)).toBe(.4)
    expect(sampleMotionTrack(track,999.999,1000)).toBeCloseTo(0,8)
    expect(sampleMotionTrack(track,1000,1000)).toBe(0)
    expect(sampleMotionTrack(track,1000.001,1000)).toBeCloseTo(0,8)
  })
  it("clamps once at its final sample and does not restart after a long suspend", () => {
    const once: MotionTrack = {type:"keyframes",interpolation:"linear",frames:[{atMs:0,value:0},{atMs:1000,value:.25}]}
    expect(sampleMotionTrack(once,-50,1000,"once")).toBe(0)
    expect(sampleMotionTrack(once,500,1000,"once")).toBe(.125)
    for (const t of [1000,1200,1000000000]) expect(sampleMotionTrack(once,t,1000,"once")).toBe(.25)
  })
  it("has deterministic results at shared elapsed times across 30/60/120 Hz", () => {
    for (const elapsed of [0,100,200,500,1000,1400]) {
      const results = [30,60,120].map(hz => { for(let t=0;t<elapsed;t+=1000/hz) sampleMotionTrack(track,t,1000); return sampleMotionTrack(track,elapsed,1000) })
      expect(new Set(results).size).toBe(1)
    }
  })
  it("releases a finite envelope without zeroing a lower-priority eye or scale", () => {
    const motion = {loopDurationMs:750,playback:"once" as const,envelope:{attackMs:100,releaseMs:250}}
    const mixer = new ParameterMixer()
    mixer.setSource("lower",{eyeOpenL:.63,mouthScale:1.2,eyeX:.2})
    for (const t of [0,50,100,500,625,750,2000]) {
      const weight=sampleMotionEnvelope(motion,t)
      mixer.setSource("reaction",{eyeOpenL:.3,mouthScale:1.5,eyeX:.1},14,weight)
      const p=mixer.evaluate()
      expect(p.eyeOpenL).toBeCloseTo(.63+(.3-.63)*weight)
      expect(p.mouthScale).toBeCloseTo(1.2+(1.5-1.2)*weight)
      expect(p.eyeX).toBeCloseTo(.2+.1*weight)
    }
    expect(sampleMotionEnvelope(motion,750)).toBe(0)
  })
  for (const kind of ["behavior","pose"] as const) describe(kind, () => {
    it("parses the same opt-in playback, envelope and bounded tracks", () => {
      expect(parse(kind,{loopDurationMs:1000,playback:"once",envelope:{attackMs:100,releaseMs:200},parameters:{eyeX:track},layers:{}}).warnings).not.toEqual(expect.arrayContaining([expect.stringContaining("playback"),expect.stringContaining("envelope")]))
    })
    it.each([0,-1,NaN,Infinity,60001])("rejects invalid extended duration %s", duration => {
      expect(()=>parse(kind,{loopDurationMs:duration,playback:"once",parameters:{eyeX:track}})).toThrow()
    })
    it.each([
      [{atMs:0,value:0}],
      [{atMs:1,value:0},{atMs:1000,value:0}],
      [{atMs:0,value:0},{atMs:1000,value:0},{atMs:200,value:0}],
      [{atMs:0,value:0},{atMs:200,value:0},{atMs:200,value:0},{atMs:1000,value:0}],
      [{atMs:0,value:0},{atMs:1000,value:2}],
      [{atMs:0,value:0},{atMs:1000,value:NaN}],
      [{atMs:0,value:0},{atMs:1001,value:0}],
      Array.from({length:33},(_,i)=>({atMs:i*1000/32,value:0})),
    ])("rejects malformed or out-of-range keyframes %#", frames => {
      expect(()=>parse(kind,{loopDurationMs:1000,parameters:{eyeX:{type:"keyframes",interpolation:"smoothstep",frames}}})).toThrow()
    })
    it("rejects invalid envelopes and non-continuous loop endpoints", () => {
      for(const envelope of [{attackMs:-1,releaseMs:100},{attackMs:600,releaseMs:600},{attackMs:0,releaseMs:0},{attackMs:Infinity,releaseMs:10}]) {
        expect(()=>parse(kind,{loopDurationMs:1000,envelope,parameters:{}})).toThrow()
      }
      expect(()=>parse(kind,{loopDurationMs:1000,parameters:{eyeX:{type:"keyframes",interpolation:"linear",frames:[{atMs:0,value:0},{atMs:1000,value:.4}]}}})).toThrow()
    })
  })
})
