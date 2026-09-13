import { describe, expect, it } from "vitest"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import type { BehaviorTiming, Clock } from "../src/behavior/types"

class FakeClock implements Clock {
  constructor(public time = 0) {}
  now() { return this.time }
  advance(ms: number) { this.time += ms }
}

const timing: BehaviorTiming = {
  boredAfterMs: 1_000,
  happyDurationMs: 350,
  stateBlendMs: 50,
  boredActionDelayMinMs: 100,
  boredActionDelayMaxMs: 200,
}

const setup = () => {
  const clock = new FakeClock()
  return { clock, machine: new CharacterStateMachine(timing, clock) }
}

describe("CharacterStateMachine", () => {
  it("starts NORMAL, becomes BORED on idle, and returns on activity", () => {
    const { clock, machine } = setup()
    expect(machine.getSnapshot().state).toBe("NORMAL")
    clock.advance(999)
    expect(machine.tick().state).toBe("NORMAL")
    clock.advance(1)
    expect(machine.tick()).toMatchObject({ state: "BORED", previousState: "NORMAL", transitionReason: "idle-timeout" })
    expect(machine.dispatch({ type: "USER_ACTIVITY", source: "pointer" })).toMatchObject({ state: "NORMAL", transitionReason: "user-activity" })
  })

  it.each(["NORMAL", "BORED"] as const)("enters BUSY from %s on task start", (initial) => {
    const { clock, machine } = setup()
    if (initial === "BORED") {
      clock.advance(timing.boredAfterMs)
      machine.tick()
    }
    expect(machine.dispatch({ type: "TASK_STARTED", taskId: "A" })).toMatchObject({ state: "BUSY", activeTaskIds: ["A"], transitionReason: "task-started" })
  })

  it("tracks multiple tasks and only celebrates the last successful completion", () => {
    const { machine } = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    machine.dispatch({ type: "TASK_STARTED", taskId: "B" })
    expect(machine.dispatch({ type: "TASK_COMPLETED", taskId: "A" })).toMatchObject({ state: "BUSY", activeTaskIds: ["B"] })
    expect(machine.dispatch({ type: "TASK_COMPLETED", taskId: "B" })).toMatchObject({ state: "HAPPY", activeTaskIds: [], transitionReason: "all-tasks-completed" })
  })

  it("returns HAPPY to NORMAL after the configured duration", () => {
    const { clock, machine } = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    machine.dispatch({ type: "TASK_COMPLETED", taskId: "A" })
    clock.advance(timing.happyDurationMs)
    expect(machine.tick()).toMatchObject({ state: "NORMAL", transitionReason: "happy-timeout" })
  })

  it("lets a new task interrupt HAPPY immediately", () => {
    const { machine } = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    machine.dispatch({ type: "TASK_COMPLETED", taskId: "A" })
    expect(machine.dispatch({ type: "TASK_STARTED", taskId: "B" })).toMatchObject({ state: "BUSY", activeTaskIds: ["B"], transitionReason: "task-started" })
  })

  it.each([
    ["TASK_FAILED", "last-task-failed"],
    ["TASK_CANCELLED", "last-task-cancelled"],
  ] as const)("returns the last task to NORMAL on %s", (type, reason) => {
    const { machine } = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    expect(machine.dispatch({ type, taskId: "A" })).toMatchObject({ state: "NORMAL", activeTaskIds: [], transitionReason: reason })
  })

  it("keeps BUSY when failure or cancellation leaves another active task", () => {
    const { machine } = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    machine.dispatch({ type: "TASK_STARTED", taskId: "B" })
    expect(machine.dispatch({ type: "TASK_FAILED", taskId: "A" })).toMatchObject({ state: "BUSY", activeTaskIds: ["B"] })
    expect(machine.dispatch({ type: "TASK_CANCELLED", taskId: "B" })).toMatchObject({ state: "NORMAL", activeTaskIds: [] })
  })

  it("records unknown task events as stale without changing state", () => {
    const { machine } = setup()
    const snapshot = machine.dispatch({ type: "TASK_COMPLETED", taskId: "missing" })
    expect(snapshot).toMatchObject({ state: "NORMAL", staleEventCount: 1, lastStaleEvent: { type: "TASK_COMPLETED", taskId: "missing" } })
  })

  it("makes duplicate task starts idempotent and records progress only for active tasks", () => {
    const { machine } = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    expect(machine.dispatch({ type: "TASK_PROGRESS", taskId: "A", progress: 0.45 })).toMatchObject({ activeTaskIds: ["A"], taskProgress: { A: 0.45 }, staleEventCount: 0 })
    expect(machine.dispatch({ type: "TASK_PROGRESS", taskId: "B", progress: 0.2 }).staleEventCount).toBe(1)
  })

  it("RESET clears tasks, progress, stale diagnostics, and timers", () => {
    const { clock, machine } = setup()
    machine.dispatch({ type: "TASK_STARTED", taskId: "A" })
    machine.dispatch({ type: "TASK_PROGRESS", taskId: "missing", progress: 0.2 })
    clock.advance(200)
    expect(machine.dispatch({ type: "RESET" })).toMatchObject({
      state: "NORMAL",
      activeTaskIds: [],
      taskProgress: {},
      staleEventCount: 0,
      transitionReason: "reset",
      lastActivityAt: 200,
    })
  })
})

