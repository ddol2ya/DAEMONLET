import { describe, expect, it } from "vitest"
import { IdleActionScheduler } from "../src/behavior/IdleActionScheduler"
import type { BehaviorAction, BehaviorTiming } from "../src/behavior/types"

const action = (id: string): BehaviorAction => ({
  id,
  durationMs: 10,
  motion: { loopDurationMs: 100, parameters: { body: { type: "constant", value: 0.1 } } },
})

const timing = (min: number, max: number): BehaviorTiming => ({
  boredAfterMs: 100,
  happyDurationMs: 100,
  stateBlendMs: 10,
  boredActionDelayMinMs: min,
  boredActionDelayMaxMs: max,
})

describe("IdleActionScheduler", () => {
  it("schedules the next action inside the configured delay range", () => {
    const scheduler = new IdleActionScheduler(() => 0.5)
    scheduler.start([action("look")], timing(100, 300), 1_000)
    expect(scheduler.getSnapshot().nextActionAt).toBe(1_200)
    expect(scheduler.tick(1_199).current).toBeNull()
    expect(scheduler.tick(1_200).current?.id).toBe("look")
  })

  it("does not choose the same action three times in a row", () => {
    const scheduler = new IdleActionScheduler(() => 0)
    scheduler.start([action("A"), action("B")], timing(0, 0), 0)
    scheduler.tick(0)
    scheduler.tick(10)
    scheduler.tick(20)
    expect(scheduler.getSnapshot().history).toEqual(["A", "A", "B"])
  })

  it("is deterministic for a seeded random sequence", () => {
    const values = [0.25, 0.75, 0.25, 0.75]
    const scheduler = new IdleActionScheduler(() => values.shift() ?? 0)
    scheduler.start([action("A"), action("B")], timing(0, 100), 0)
    expect(scheduler.getSnapshot().nextActionAt).toBe(25)
    expect(scheduler.tick(25).current?.id).toBe("B")
  })

  it("cancels a running action and pending schedule", () => {
    const scheduler = new IdleActionScheduler(() => 0)
    scheduler.start([action("A")], timing(0, 0), 0)
    scheduler.tick(0)
    scheduler.cancel()
    expect(scheduler.getSnapshot()).toMatchObject({ current: null, nextActionAt: null })
  })
})

