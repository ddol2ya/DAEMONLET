import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { CharacterSession } from "../src/runtime/CharacterSession"
import { loadBuiltInCharacter } from "../src/runtime/loadBuiltInCharacter"
import { createDefaultBehaviorProfile, parseBehaviorManifest } from "../src/behavior/BehaviorManifest"
import { parseDialogueManifest } from "../src/dialogue/DialogueManifest"
import { MockTaskEventSource } from "../src/behavior/MockTaskEventSource"
import { dialogueProfile } from "./helpers/dialogue"

vi.mock("../src/engine/anime25d/Anime25DRuntime", async () => {
  const { MotionLifecycleBus } = await import("../src/motion/orchestration/MotionLifecycleBus")
  return { Anime25DRuntime: class {
    lifecycle = new MotionLifecycleBus()
    revision=1
    getModelRevision(){return this.revision}
    changeModel(){this.revision++;for(const listener of this.listeners)listener()}
    cancelInteraction() {}
    listeners=new Set<()=>void>()
    pose:{id:string|null;state:string}={id:null,state:'BASE'}
    subscribe(listener:()=>void) { this.listeners.add(listener);return () => this.listeners.delete(listener) }
    getPoseDiagnostics() { return {...this.pose,loadStatus:'ready'} }
    publishPose(id:string|null,state:string){this.pose={id,state};for(const listener of this.listeners)listener()}
    getActivePoseId() { return this.pose.state === 'BASE' ? null : this.pose.id }
    async transitionToPose(id:string) { this.publishPose(id,'ACTIVE_LOOP') }
    async warmPoseAssets() { return [] }
    setBehaviorStateParameters() {} setBehaviorActionParameters() {}
    clearBehaviorStateParameters() {} clearBehaviorActionParameters() {}
    cancelPendingPoseLoad() {} exitPose() { this.publishPose(null,'BASE') } start() {} stop() {} unload() {}
  } }
})
vi.mock("../src/interaction/InteractionController", () => ({ InteractionController: class { destroy() {} } }))
vi.mock("../src/pose/PoseManifest", () => ({ loadCharacterCatalog: vi.fn(async () => ({ characters: ["bell", "momo", "longhair", "gpichan", "asuma-toki"].map((id) => ({ id })), warnings: [] })) }))
vi.mock("../src/runtime/loadBuiltInCharacter", () => ({ loadBuiltInCharacter: vi.fn() }))

const sessions: CharacterSession[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(loadBuiltInCharacter).mockImplementation(async (_runtime, model) => ({ behavior: createDefaultBehaviorProfile(), poses: [], dialogue: dialogueProfile((m) => { m.triggers["run.started"]!.lines = [model.id] }) }) as never)
})
afterEach(() => { sessions.splice(0).forEach((s) => s.dispose()); vi.useRealTimers(); vi.clearAllMocks() })
const session = () => { const s = new CharacterSession({} as HTMLCanvasElement); sessions.push(s); return s }

describe("character session dialogue ownership", () => {
  it.each([
    ["recovery-not-confirmed", false], ["stale-adapter-state", false], ["session-ended", false],
    ["user-interrupted", true], ["interrupted", true],
  ] as const)("routes %s through the actual pose-bound Gpichan voice", async (reason, userInterrupted) => {
    const characterJson = (file:string) => JSON.parse(readFileSync(new URL(`../public/characters/gpichan/${file}`, import.meta.url), 'utf8'))
    const behavior = { ...parseBehaviorManifest(characterJson('behavior.json')).value, sourceUrl:null, warnings:[], usedDefault:false }
    const dialogue = { manifest:parseDialogueManifest(characterJson('dialogue.ko.json')), warnings:[] }
    const poses = (characterJson('character.json').poses as string[]).map(path => ({ id:path.split('/')[1] }))
    vi.mocked(loadBuiltInCharacter).mockResolvedValueOnce({ behavior, dialogue, poses } as never)
    const s = session(), source = new MockTaskEventSource()
    s.connectTaskSource(source)
    await s.loadCharacter('gpichan')
    source.dispatch({ type:'TASK_STARTED', taskId:'run' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.runtime.getActivePoseId()).toBe('writing')
    expect(s.dialogue.getSnapshot().triggerId).toBe('run.started')

    source.dispatch({ type:'TASK_CANCELLED', taskId:'run', reason })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.behavior.machine.getSnapshot()).toMatchObject({ state:'NORMAL', activeTaskIds:[], lastEventAccepted:true, lastOutcome:{ kind:'cancelled', reason } })
    expect(s.runtime.getActivePoseId()).toBe(userInterrupted ? 'cancelled' : null)
    const spoken = s.dialogue.getSnapshot().history.filter(entry => entry.decision === 'shown' && entry.triggerId === 'run.cancelled.user')
    expect(spoken).toHaveLength(userInterrupted ? 1 : 0)
    if (userInterrupted) expect(s.dialogue.getSnapshot()).toMatchObject({ visible:true, triggerId:'run.cancelled.user' })
    else expect(s.behavior.getDiagnostics().currentReaction).toBeNull()
  })

  it("binds dialogue to settled renderer poses and releases the observer on dispose", async () => {
    const s=session()
    vi.mocked(loadBuiltInCharacter).mockResolvedValueOnce({behavior:createDefaultBehaviorProfile(),poses:[],dialogue:dialogueProfile(m=>{m.poseTriggers={base:'state.normal',writing:'run.started',waiting:'state.waiting'}})} as never)
    await s.loadCharacter('bell')
    const runtime=s.runtime as unknown as {publishPose(id:string|null,state:string):void;listeners:Set<()=>void>}
    expect(s.dialogue.getSnapshot().triggerId).toBe('state.normal')
    runtime.publishPose('writing','ENTERING')
    expect(s.dialogue.getSnapshot().triggerId).toBe('state.normal')
    runtime.publishPose('writing','ACTIVE_LOOP')
    expect(s.dialogue.getSnapshot().triggerId).toBe('run.started')
    runtime.publishPose('waiting','SWITCHING')
    expect(s.dialogue.getSnapshot().triggerId).toBe('run.started')
    runtime.publishPose('waiting','ACTIVE_LOOP')
    expect(s.dialogue.getSnapshot().triggerId).toBe('state.waiting')
    s.dispose()
    expect(runtime.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps one lifecycle listener across 21 switches and clears timers/voice", async () => {
    const s = session(); const source = new MockTaskEventSource(); s.connectTaskSource(source)
    for (let i = 0; i < 21; i++) {
      const id = ["bell", "momo", "longhair"][i % 3]
      await s.loadCharacter(id)
      expect(s.runtime.lifecycle.listenerCount).toBe(1)
      expect(s.dialogue.getSnapshot()).toMatchObject({ characterId: id, visible: false, queueLength: 0 })
      expect(vi.getTimerCount()).toBe(0)
      source.dispatch({ type: "RESET" }); source.dispatch({ type: "TASK_STARTED", taskId: `run-${i}` })
      expect(s.dialogue.getSnapshot().text).toBe(id)
    }
    s.dispose()
    expect(s.runtime.lifecycle.listenerCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("disconnects lifecycle and behavior together when switching source", async () => {
    const s = session(); await s.loadCharacter("bell")
    const old = new MockTaskEventSource(), next = new MockTaskEventSource()
    s.connectTaskSource(old); s.connectTaskSource(next)
    old.dispatch({ type: "TASK_STARTED", taskId: "old" })
    expect(s.behavior.machine.getSnapshot().activeTaskIds).toEqual([])
    expect(s.dialogue.getSnapshot().visible).toBe(false)
    next.dispatch({ type: "TASK_STARTED", taskId: "next" })
    expect(s.dialogue.getSnapshot().text).toBe("bell")
  })
  it("keeps motion usable with a missing dialogue profile and preserves the active character on load failure", async () => {
    const s = session()
    vi.mocked(loadBuiltInCharacter).mockResolvedValueOnce({ behavior: createDefaultBehaviorProfile(), poses: [], dialogue: { manifest: null, warnings: ["unavailable"] } } as never)
    await s.loadCharacter("momo")
    expect(s.dialogue.getSnapshot().enabled).toBe(false)
    s.behavior.dispatch({ type: "TASK_STARTED", taskId: "run" })
    expect(s.behavior.machine.getSnapshot().state).toBe("BUSY")
    await s.loadCharacter("bell"); s.dialogue.triggerDebug("interaction.pet")
    const previous = s.dialogue.getSnapshot()
    const activeTasks = s.behavior.machine.getSnapshot().activeTaskIds
    vi.mocked(loadBuiltInCharacter).mockRejectedValueOnce(new Error("base failed"))
    await expect(s.loadCharacter("longhair")).rejects.toThrow("base failed")
    expect(s.dialogue.getSnapshot()).toEqual(previous)
    expect(s.behavior.machine.getSnapshot().activeTaskIds).toEqual(activeTasks)
    s.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("does not apply a superseded asynchronous character profile", async () => {
    const s = session()
    let finish!: (value: never) => void
    vi.mocked(loadBuiltInCharacter).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const first = s.loadCharacter("bell")
    const firstResult = first.catch((error) => error)
    await Promise.resolve(); await Promise.resolve()
    await s.loadCharacter("momo")
    finish({ behavior: createDefaultBehaviorProfile(), poses: [], dialogue: dialogueProfile() } as never)
    expect(await firstResult).toHaveProperty("name", "AbortError")
    expect(s.dialogue.getSnapshot().characterId).toBe("momo")
  })
})


describe("continuous reactions through the actual session controllers", () => {
  const loaded = async (characterId = 'gpichan') => {
    const data=(name:string)=>JSON.parse(readFileSync(new URL(characterId === 'gpichan' ? `../public/characters/gpichan/${name}` : `./fixtures/profiles/continuous/${name}`,import.meta.url),'utf8'))
    vi.mocked(loadBuiltInCharacter).mockResolvedValueOnce({behavior:{...parseBehaviorManifest(data('behavior.json')).value,sourceUrl:null,warnings:[],usedDefault:false},dialogue:{manifest:parseDialogueManifest(data('dialogue.ko.json')),warnings:[]},poses:data('character.json').poses.map((file:string)=>({id:file.split('/')[1]}))} as never)
    const s=session(),source=new MockTaskEventSource();s.connectTaskSource(source);await s.loadCharacter(characterId)
    const start=(id:'PET'|'HOLD',gestureId=1)=>{
      s.behavior.handlePointerGesture({type:'begin',gestureId})
      s.behavior.handlePointerGesture({type:'continuous',phase:'start',gestureId,interactionId:id})
    }
    return {s,source,start}
  }
  it.each([
    ['gpichan', 'released'], ['asuma-toki', 'released'],
    ['gpichan', 'completed'], ['asuma-toki', 'completed'],
  ] as const)('preserves %s dialogue ownership when a tap-to-hold gesture is %s', async (characterId, ending) => {
    const { s, source, start } = await loaded(characterId)
    source.dispatch({ type: 'TASK_STARTED', taskId: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    const started = s.dialogue.getSnapshot().history.filter(entry => entry.triggerId === 'run.started')
    expect(started.some(entry => entry.decision === 'shown')).toBe(true)
    s.runtime.lifecycle.emit({ type: 'interaction.started', interactionId: 'HEAD_TAP', at: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.runtime.getActivePoseId()).toBe('head-tap')

    s.behavior.advance(480)
    start('HOLD')
    s.runtime.lifecycle.emit({ type: 'interaction.cancelled', interactionId: 'HEAD_TAP', reason: 'continuous-takeover', at: 480 })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.runtime.getActivePoseId()).toBe('writing')
    expect(s.dialogue.getSnapshot().triggerId).toBe('interaction.face-hold')
    for (let i = 0; i < 10; i++) s.behavior.handlePointerGesture({ type: 'continuous', gestureId: 1, interactionId: 'HOLD', phase: 'loop' })
    expect(s.dialogue.getSnapshot().history.filter(entry => entry.decision === 'shown' && entry.triggerId === 'interaction.face-hold')).toHaveLength(1)
    expect(s.dialogue.getSnapshot().history.filter(entry => entry.triggerId === 'run.started')).toEqual(started)

    if (ending === 'completed') {
      source.dispatch({ type: 'TASK_COMPLETED', taskId: 'work' })
      await vi.advanceTimersByTimeAsync(0)
    }
    s.behavior.handlePointerGesture({ type: 'end', gestureId: 1, reason: 'released' })
    s.behavior.advance(1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(s.behavior.getContinuousInteraction()).toBeNull()
    expect(s.runtime.getActivePoseId()).toBe(ending === 'completed' ? 'happy' : 'writing')
    if (ending === 'completed') {
      expect(s.dialogue.getSnapshot()).toMatchObject({ visible: true, triggerId: 'run.completed.observed' })
      expect(s.behavior.machine.getSnapshot()).toMatchObject({ activeTaskIds: [], lastOutcome: { kind: 'completed' } })
    } else {
      expect(s.dialogue.getSnapshot().visible).toBe(false)
      expect(s.behavior.machine.getSnapshot()).toMatchObject({ state: 'BUSY', activeTaskIds: ['work'], lastOutcome: null })
    }
    expect(s.dialogue.getSnapshot().history.filter(entry => entry.triggerId === 'run.started')).toEqual(started)
  })

  it('binds the new pose to one owned cue and preserves a later task outcome on release', async()=>{
    const {s,source,start}=await loaded()
    start('PET');await vi.advanceTimersByTimeAsync(0)
    expect(s.runtime.getActivePoseId()).toBe('head-pet')
    expect(s.dialogue.getSnapshot().triggerId).toBe('interaction.pet')
    for(let i=0;i<10;i++)s.behavior.handlePointerGesture({type:'continuous',gestureId:1,interactionId:'PET',phase:'loop'})
    expect(s.dialogue.getSnapshot().history.filter(e=>e.decision==='shown'&&e.triggerId==='interaction.pet')).toHaveLength(1)
    source.dispatch({type:'TASK_STARTED',taskId:'work'});source.dispatch({type:'TASK_COMPLETED',taskId:'work'});await vi.advanceTimersByTimeAsync(0)
    s.behavior.handlePointerGesture({type:'end',gestureId:1,reason:'released'})
    expect(s.dialogue.getSnapshot().triggerId).toBe('run.completed.observed')
    expect(s.runtime.getActivePoseId()).toBe('happy')
  })
  it.each(['layout','model','dispose'] as const)('cleans the reaction, presentation and late loops on %s',async reason=>{
    const {s,start}=await loaded();start('HOLD')
    expect(s.dialogue.getSnapshot().triggerId).toBe('interaction.face-hold')
    if(reason==='layout')s.setInteractionEnabled(false)
    else if(reason==='model')(s.runtime as unknown as {changeModel():void}).changeModel()
    else s.dispose()
    s.behavior.handlePointerGesture({type:'continuous',gestureId:1,interactionId:'HOLD',phase:'loop'})
    expect(s.behavior.getContinuousInteraction()).toBeNull()
    expect(s.dialogue.getSnapshot().visible).toBe(false)
  })
})
