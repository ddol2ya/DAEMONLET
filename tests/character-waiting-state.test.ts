import { describe, expect, it } from "vitest"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import { createDefaultBehaviorProfile } from "../src/behavior/BehaviorManifest"

const setup = () => new CharacterStateMachine(createDefaultBehaviorProfile().timing, { now: () => 100 })

describe("task waiting and resumption", () => {
  it("waits only when every active task is paused, and recomputes after another task finishes", () => {
    const machine = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    machine.dispatch({ type: "TASK_STARTED", taskId: "B" })
    expect(machine.dispatch({ type: "TASK_WAITING", taskId: "A" }).state).toBe("BUSY")
    expect(machine.dispatch({ type: "TASK_WAITING", taskId: "B", reason: "approval" })).toMatchObject({ state: "WAITING", waitingTaskIds: ["A", "B"] })
    expect(machine.dispatch({ type: "TASK_STARTED", taskId: "A" }).state).toBe("WAITING")
    expect(machine.dispatch({ type: "TASK_PROGRESS", taskId: "A", progress: .5 }).state).toBe("WAITING")
    expect(machine.dispatch({ type: "TASK_STARTED", taskId: "C" }).state).toBe("BUSY")
    expect(machine.dispatch({ type: "TASK_COMPLETED", taskId: "C" }).state).toBe("WAITING")
    expect(machine.dispatch({ type: "TASK_RESUMED", taskId: "A" }).state).toBe("BUSY")
    expect(machine.dispatch({ type: "TASK_CANCELLED", taskId: "A" })).toMatchObject({ state: "WAITING", waitingTaskIds: ["B"] })
  })

  it("does not treat activity, elapsed idle time, or connection loss as an answer", () => {
    const machine = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    machine.dispatch({ type: "TASK_WAITING", taskId: "A" })
    machine.dispatch({ type: "USER_ACTIVITY", source: "pointer" })
    machine.dispatch({ type: "CONNECTION_CHANGED", connected: false })
    expect(machine.tick(1_000_000)).toMatchObject({ state: "WAITING", activeTaskIds: ["A"], waitingTaskIds: ["A"], lastOutcome: null })
    expect(machine.dispatch({ type: "TASK_RESUMED", taskId: "missing" })).toMatchObject({ state: "WAITING", lastEventAccepted: false })
  })

  it("restores wait status atomically from snapshots and clears it without a false completion", () => {
    const machine = setup()
    expect(machine.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "A", waitingFor: "user-input" }] })).toMatchObject({ state: "WAITING", waitingTaskIds: ["A"] })
    expect(machine.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "A" }] })).toMatchObject({ state: "BUSY", waitingTaskIds: [] })
    machine.dispatch({ type: "TASK_WAITING", taskId: "A" })
    expect(machine.dispatch({ type: "TASK_SNAPSHOT", tasks: [] })).toMatchObject({ state: "NORMAL", waitingTaskIds: [], lastOutcome: null })
    expect(machine.dispatch({ type: "TASK_WAITING", taskId: "A" }).lastEventAccepted).toBe(false)
  })
})
