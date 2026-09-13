import { describe, expect, it } from "vitest"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import { createDefaultBehaviorProfile } from "../src/behavior/BehaviorManifest"
import { mapBehaviorTrigger, mapLifecycleTrigger, mapMotionTrigger } from "../src/dialogue/DialogueTriggerMapper"
import type { CharacterTaskEvent } from "../src/behavior/types"
import { taskEventLifecycle } from "../src/lifecycle/CharacterLifecycleEvent"
import { PROTOCOL_TASK_KINDS } from "../src/protocol/types"

const setup = () => {
  const machine = new CharacterStateMachine(createDefaultBehaviorProfile().timing, { now: () => 10 })
  const dispatch = (event: CharacterTaskEvent) => { const timed = { ...event, at: event.at ?? 10 }; const snapshot = machine.dispatch(timed); const lifecycle = taskEventLifecycle(timed, timed.at); return lifecycle ? mapLifecycleTrigger(lifecycle, snapshot) : null }
  return { machine, dispatch }
}

describe("dialogue outcome policy", () => {
  it.each(["user-interrupted", "interrupted"])("speaks for %s without HAPPY", (reason) => {
    const t = setup(); t.dispatch({ type: "TASK_STARTED", taskId: "run" })
    expect(t.dispatch({ type: "TASK_CANCELLED", taskId: "run", reason })).toBe("run.cancelled.user")
    expect(t.machine.getSnapshot()).toMatchObject({ state: "NORMAL", lastOutcome: { kind: "cancelled", reason } })
  })
  it.each(["session-ended", "recovery-not-confirmed", "stale-adapter-state", "model-unload", "adapter restart", "unknown", undefined])("keeps cancellation case %# silent", (reason) => {
    const t = setup(); t.dispatch({ type: "TASK_STARTED", taskId: "run" })
    expect(t.dispatch({ type: "TASK_CANCELLED", taskId: "run", reason })).toBeNull()
  })
  it("gates global outcomes until the last run and treats absent confidence as observed", () => {
    const t = setup()
    expect(t.dispatch({ type: "TASK_STARTED", taskId: "A" })).toBe("run.started")
    expect(t.dispatch({ type: "TASK_STARTED", taskId: "B" })).toBeNull()
    expect(t.dispatch({ type: "TASK_COMPLETED", taskId: "A", confidence: "authoritative" })).toBeNull()
    expect(t.machine.getSnapshot()).toMatchObject({ state: "BUSY", lastOutcome: { taskId: "A", confidence: "authoritative" } })
    expect(t.dispatch({ type: "TASK_COMPLETED", taskId: "B" })).toBe("run.completed.observed")
    expect(t.machine.getSnapshot().state).toBe("HAPPY")
  })
  it("gates non-final failures and maps final failure codes without text", () => {
    const t = setup(); t.dispatch({ type: "TASK_STARTED", taskId: "A" }); t.dispatch({ type: "TASK_STARTED", taskId: "B" })
    expect(t.dispatch({ type: "TASK_FAILED", taskId: "A", code: "auth" })).toBeNull()
    expect(t.dispatch({ type: "TASK_FAILED", taskId: "B", code: "rate-limit" })).toBe("run.failed")
  })
  it("ignores unknown/stale terminals, snapshot and reset without inventing an outcome", () => {
    const t = setup()
    expect(t.dispatch({ type: "TASK_COMPLETED", taskId: "unknown" })).toBeNull()
    expect(t.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "run" }] })).toBeNull()
    expect(t.machine.getSnapshot().lastOutcome).toBeNull()
    t.dispatch({ type: "TASK_COMPLETED", taskId: "run", confidence: "authoritative", at: 20 })
    const before = t.machine.getSnapshot().lastOutcome
    expect(t.dispatch({ type: "TASK_COMPLETED", taskId: "run", at: 30 })).toBeNull()
    expect(t.machine.getSnapshot().lastOutcome).toEqual(before)
    t.dispatch({ type: "RESET" }); expect(t.machine.getSnapshot().lastOutcome).toBeNull()
  })
  it.each(PROTOCOL_TASK_KINDS)("maps %s only while its run is BUSY", (kind) => {
    const t = setup(); const event = { type: "task.started" as const, runId: "run", taskId: "task", kind, at: 10 }
    expect(mapLifecycleTrigger(event, t.machine.getSnapshot())).toBeNull()
    t.dispatch({ type: "TASK_STARTED", taskId: "run" })
    expect(mapLifecycleTrigger(event, t.machine.getSnapshot())).toBe(`task.started.${kind}`)
    expect(mapLifecycleTrigger({ ...event, type: "task.failed" }, t.machine.getSnapshot())).toBeNull()
    expect(mapLifecycleTrigger({ ...event, type: "task.completed" }, t.machine.getSnapshot())).toBeNull()
  })
  it("maps only real idle transitions and action starts", () => {
    expect(mapBehaviorTrigger({ type: "semantic.changed", previous: "NORMAL", current: "BORED", reason: "idle-timeout", at: 0 })).toBe("state.bored")
    expect(mapBehaviorTrigger({ type: "semantic.changed", previous: "NORMAL", current: "BORED", reason: "snapshot-refresh", at: 0 })).toBeNull()
    expect(mapBehaviorTrigger({ type: "action.started", actionId: "bored-look-away", kind: "bored", at: 0 })).toBe("behavior.bored-look-away")
    expect(mapBehaviorTrigger({ type: "action.completed", actionId: "bored-sigh", kind: "bored", at: 0 })).toBeNull()
  })
  it.each([["HEAD_TAP", "interaction.head-tap"], ["TORSO_TAP", "interaction.torso-tap"], ["HOLD", "interaction.face-hold"], ["PET", "interaction.pet"], ["HOLD_START", "interaction.face-hold"], ["PET_START", "interaction.pet"]] as const)("maps %s once and ignores loop/completion/cancellation", (interactionId, trigger) => {
    expect(mapMotionTrigger({ type: "interaction.started", interactionId, at: 0 })).toBe(trigger)
    expect(mapMotionTrigger({ type: "interaction.completed", interactionId, at: 0 })).toBeNull()
    expect(mapMotionTrigger({ type: "interaction.cancelled", interactionId, reason: "cancelled", at: 0 })).toBeNull()
    for (let i = 0; i < 20; i++) for (const loop of ["HOLD_LOOP", "PET_LOOP", "DRAG"]) expect(mapMotionTrigger({ type: "interaction.started", interactionId: loop, at: i })).toBeNull()
  })
})
