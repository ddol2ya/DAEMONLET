import { describe, expect, it } from "vitest"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import type { BehaviorTiming, Clock } from "../src/behavior/types"

class FakeClock implements Clock { constructor(public time = 0) {} now() { return this.time } }
const timing: BehaviorTiming = { boredAfterMs: 100, happyDurationMs: 50, stateBlendMs: 0, boredActionDelayMinMs: 10, boredActionDelayMaxMs: 20 }

describe("CharacterStateMachine TASK_SNAPSHOT", () => {
  it("atomically replaces tasks without HAPPY and does not restart BUSY", () => {
    const clock = new FakeClock()
    const machine = new CharacterStateMachine(timing, clock)
    expect(machine.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "A", progress: 0.2 }] })).toMatchObject({ state: "BUSY", activeTaskIds: ["A"], transitionReason: "snapshot-active-runs" })
    const stateSince = machine.getSnapshot().stateSince
    clock.time = 20
    expect(machine.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "B", progress: 0.8 }] })).toMatchObject({ state: "BUSY", activeTaskIds: ["B"], transitionReason: "snapshot-refresh", stateSince })
    clock.time = 40
    expect(machine.dispatch({ type: "TASK_SNAPSHOT", tasks: [] })).toMatchObject({ state: "NORMAL", transitionReason: "snapshot-empty" })
  })

  it("uses local snapshot time for activity and prevents immediate BORED", () => {
    const clock = new FakeClock(1_000)
    const machine = new CharacterStateMachine(timing, clock)
    machine.dispatch({ type: "TASK_SNAPSHOT", tasks: [], at: 1_000 })
    expect(machine.tick(1_099).state).toBe("NORMAL")
    expect(machine.tick(1_100).state).toBe("BORED")
  })

  it("rejects invalid progress and duplicate IDs atomically", () => {
    const machine = new CharacterStateMachine(timing, new FakeClock())
    machine.dispatch({ type: "TASK_STARTED", taskId: "existing" })
    expect(machine.dispatch({ type: "TASK_PROGRESS", taskId: "existing", progress: 2 })).toMatchObject({ staleEventCount: 1, taskProgress: { existing: undefined } })
    expect(machine.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "A" }, { taskId: " A " }] })).toMatchObject({ staleEventCount: 2, activeTaskIds: ["existing"] })
  })
})
