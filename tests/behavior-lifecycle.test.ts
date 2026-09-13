import { describe, expect, it, vi } from "vitest"
import { createDefaultBehaviorProfile } from "../src/behavior/BehaviorManifest"
import { CharacterBehaviorController, type CharacterBehaviorRuntime } from "../src/behavior/CharacterBehaviorController"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import type { BehaviorLifecycleEvent } from "../src/behavior/BehaviorLifecycleEvent"

function setup() {
  let now = 0
  const clock = { now: () => now }
  const profile = createDefaultBehaviorProfile()
  profile.timing = { ...profile.timing, boredAfterMs: 100, boredActionDelayMinMs: 10, boredActionDelayMaxMs: 10 }
  const action = { id: "bored-look-away", durationMs: 50, motion: { loopDurationMs: 50, parameters: {} } }
  profile.states.BORED.actions = [action]
  profile.failureReaction = { ...action, id: "failure" }
  const runtime: CharacterBehaviorRuntime = {
    loadPoseById: async () => {}, enterPose: async () => {}, exitPose: () => {}, getActivePoseId: () => null,
    getPoseDiagnostics: () => ({ id: null, loadStatus: "unavailable", state: "BASE" }),
    setBehaviorStateParameters: () => {}, setBehaviorActionParameters: () => {}, clearBehaviorStateParameters: () => {}, clearBehaviorActionParameters: () => {},
  }
  const controller = new CharacterBehaviorController(runtime, new CharacterStateMachine(profile.timing, clock), profile, { clock, random: () => 0 })
  const events: BehaviorLifecycleEvent[] = []
  controller.subscribeLifecycle((event) => events.push(event))
  return { controller, profile, events, tick: (at: number) => { now = at; controller.tick() } }
}

describe("behavior lifecycle", () => {
  it("emits semantic and bored action start/end exactly once across many frames", () => {
    const t = setup(); t.tick(100); t.tick(110)
    for (let at = 111; at < 160; at++) t.tick(at)
    expect(t.events.map((event) => event.type)).toEqual(["semantic.changed", "action.started"])
    t.tick(160); t.tick(161)
    expect(t.events.map((event) => event.type)).toEqual(["semantic.changed", "action.started", "action.completed"])
    t.controller.dispose()
  })
  it("emits a transient failure once, and does not replay it on model change", () => {
    const t = setup()
    t.controller.dispatch({ type: "TASK_STARTED", taskId: "run" })
    t.controller.dispatch({ type: "TASK_FAILED", taskId: "run" })
    t.tick(50)
    expect(t.events.filter((event) => event.type === "action.started")).toHaveLength(1)
    expect(t.events.filter((event) => event.type === "action.completed")).toHaveLength(1)
    t.events.length = 0
    t.controller.prepareForModelChange(); t.controller.configure(t.profile, [], false)
    expect(t.events).toEqual([])
    t.controller.dispose()
  })
  it("does not synthesize lifecycle from same-state snapshots, profile configuration or subscriptions", () => {
    const t = setup()
    t.controller.dispatch({ type: "TASK_SNAPSHOT", tasks: [] })
    t.controller.configure(t.profile, [], false)
    const off = t.controller.subscribe(vi.fn()); t.controller.getDiagnostics(); off()
    expect(t.events).toEqual([])
    t.controller.dispose(); t.controller.dispatch({ type: "TASK_STARTED", taskId: "late" }); t.tick(500)
    expect(t.events).toEqual([])
  })
})
