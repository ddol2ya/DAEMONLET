import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { parseBehaviorManifest } from "../src/behavior/BehaviorManifest"
import { CharacterBehaviorController, type CharacterBehaviorRuntime } from "../src/behavior/CharacterBehaviorController"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import { IdleActionScheduler } from "../src/behavior/IdleActionScheduler"
import { ParameterMixer } from "../src/interaction/ParameterMixer"
import { mapBehaviorTrigger } from "../src/dialogue/DialogueTriggerMapper"
import type { BehaviorLifecycleEvent } from "../src/behavior/BehaviorLifecycleEvent"
const profile=()=>({...parseBehaviorManifest(JSON.parse(readFileSync("tests/fixtures/profiles/finite/behavior.json","utf8"))).value,sourceUrl:null,warnings:[],usedDefault:false})
function setup() {
  let now=0;const clock={now:()=>now},p=profile(),mixer=new ParameterMixer(),events:BehaviorLifecycleEvent[]=[]
  const runtime:CharacterBehaviorRuntime={loadPoseById:async()=>{},enterPose:async()=>{},exitPose:()=>{},getActivePoseId:()=>null,getPoseDiagnostics:()=>({id:null,loadStatus:"unavailable",state:"BASE"}),setBehaviorStateParameters:(v,_,w)=>mixer.setSource("state",v,11,w),setBehaviorActionParameters:(v,_,w)=>mixer.setSource("action",v,14,w),clearBehaviorStateParameters:()=>mixer.removeSource("state"),clearBehaviorActionParameters:()=>mixer.removeSource("action")}
  const controller=new CharacterBehaviorController(runtime,new CharacterStateMachine(p.timing,clock),p,{clock,random:()=>0})
  controller.subscribeLifecycle(e=>events.push(e))
  return {controller,events,mixer,tick:(t:number)=>{now=t;controller.tick()},send:(type:any,taskId="A",reason?:string)=>controller.dispatch({type,taskId,reason} as any)}
}
describe("finite outcomes and scheduler ownership",()=>{
  it("settles HAPPY while preserving semantic duration and releases on a new Run",()=>{
    const t=setup();t.send("TASK_STARTED");t.send("TASK_COMPLETED");t.tick(500)
    expect(t.controller.getDiagnostics().stateParameters.body).not.toBe(0)
    for(const time of [940,1500,2500,3499]) {t.tick(time);expect(t.controller.getDiagnostics().semantic.state).toBe("HAPPY");expect(t.controller.getDiagnostics().stateParameters.body).toBe(0)}
    t.send("TASK_STARTED","B");expect(t.controller.getDiagnostics().semantic.state).toBe("BUSY")
    t.tick(3800);expect(t.controller.getDiagnostics().stateParameters.mouthForm).toBeUndefined()
  })
  it("reacts only to the final accepted failure and consumes it once",()=>{
    const t=setup();t.send("TASK_STARTED","A");t.send("TASK_STARTED","B");t.send("TASK_FAILED","A")
    expect(t.events.filter(e=>e.type==="action.started")).toHaveLength(0)
    t.send("TASK_FAILED","B");for(let i=1;i<=800;i++)t.tick(i)
    t.send("TASK_FAILED","B");t.tick(900)
    expect(t.events.filter(e=>e.type==="action.started")).toHaveLength(1)
    expect(t.events.filter(e=>e.type==="action.completed")).toHaveLength(1)
    expect(t.controller.getDiagnostics().actionParameters).toEqual({})
  })
  it.each(["user-interrupted","interrupted","recovery-not-confirmed","stale-adapter-state","session-ended"])("quietly exits %s without failure or celebration",reason=>{
    const t=setup();t.send("TASK_STARTED");t.send("TASK_CANCELLED","A",reason);t.tick(800)
    expect(t.controller.getDiagnostics().semantic.state).toBe("NORMAL")
    expect(t.events.filter(e=>e.type==="action.started")).toHaveLength(0)
  })
  it("cancels a BORED action once without triggering dialogue or late timers",()=>{
    const t=setup();t.tick(60000);t.tick(64200);expect(t.events.filter(e=>e.type==="action.started")).toHaveLength(1)
    t.send("USER_ACTIVITY");t.controller.dispose();t.tick(100000)
    const cancelled=t.events.filter(e=>e.type==="action.cancelled")
    expect(cancelled).toHaveLength(1);expect(mapBehaviorTrigger(cancelled[0])).toBeNull()
  })
  it("bounds seeded history and does not catch up a suspended scheduler in a burst",()=>{
    const p=profile();p.timing.boredActionDelayMinMs=0;p.timing.boredActionDelayMaxMs=0
    const create=()=>{let seed=13;return new IdleActionScheduler(()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296})}
    const a=create(),b=create();for(const s of [a,b]) {s.start(p.states.BORED.actions!,p.timing,0);for(let i=0;i<500;i++)s.tick(i*3000)}
    expect(a.getSnapshot().history).toHaveLength(64);expect(a.getSnapshot().history).toEqual(b.getSnapshot().history)
    const s=new IdleActionScheduler(()=>0);s.start(p.states.BORED.actions!,p.timing,0);s.tick(0);s.tick(86400000);expect(s.getSnapshot().history).toHaveLength(2)
    s.cancel();s.tick(90000000);expect(s.getSnapshot().current).toBeNull()
  })
})
