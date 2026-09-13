import { describe, expect, it, vi } from "vitest"
import { MockTaskEventSource } from "../src/behavior/MockTaskEventSource"

describe("MockTaskEventSource", () => {
  it("publishes task events and supports unsubscribe", () => {
    const source = new MockTaskEventSource()
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    source.dispatch({ type: "TASK_STARTED", taskId: "mock-1" })
    unsubscribe()
    source.dispatch({ type: "TASK_COMPLETED", taskId: "mock-1" })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ type: "TASK_STARTED", taskId: "mock-1" })
  })
})

