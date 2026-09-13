import { describe, expect, it, vi } from "vitest"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import type { BehaviorTiming, Clock } from "../src/behavior/types"
import { CharacterEventProtocolClient } from "../src/protocol/CharacterEventProtocolClient"
import { ProtocolLoopbackSource } from "../src/protocol/ProtocolLoopbackSource"
import { ProtocolTaskEventSource } from "../src/protocol/ProtocolTaskEventSource"
import { InMemoryProtocolTransport } from "../src/protocol/transports/InMemoryProtocolTransport"

class FakeClock implements Clock {
  constructor(public time = 50) {}
  now() { return this.time }
}
const timing: BehaviorTiming = { boredAfterMs: 1_000, happyDurationMs: 300, stateBlendMs: 0, boredActionDelayMinMs: 100, boredActionDelayMaxMs: 200 }

const setup = async () => {
  const clock = new FakeClock()
  const transport = new InMemoryProtocolTransport()
  const loopback = new ProtocolLoopbackSource(transport, () => 9_999_999)
  const client = new CharacterEventProtocolClient(transport, { clock, random: () => 0.5 })
  const source = new ProtocolTaskEventSource(client, clock)
  const machine = new CharacterStateMachine(timing, clock)
  source.subscribe((event) => machine.dispatch(event))
  await client.connect()
  return { clock, transport, loopback, client, source, machine }
}

describe("ProtocolTaskEventSource", () => {
  it("combines source presence with transport health without losing task state", async () => {
    const { source, client, loopback, machine } = await setup(), connections: boolean[] = []
    source.subscribe(event => { if (event.type === "CONNECTION_CHANGED") connections.push(event.connected) })
    loopback.startRun("existing")
    source.setSourceAvailable(false)
    expect(client.getDiagnostics().connectionState).toBe("READY")
    expect(machine.getSnapshot()).toMatchObject({state:"BUSY",activeTaskIds:["existing"],lastOutcome:null})
    source.setSourceAvailable(false); source.setSourceAvailable(true)
    expect(connections).toEqual([false,true])
    source.dispose(); client.disconnect()
  })
  it("preserves waiting through reconnect snapshots and resumes only on an explicit event", async () => {
    vi.useFakeTimers()
    try {
      const { loopback, transport, client, source, machine } = await setup()
      const connections: boolean[] = []
      source.subscribe(event => { if (event.type === "CONNECTION_CHANGED") connections.push(event.connected) })
      loopback.startRun("waiting-run")
      loopback.waitRun("waiting-run", "approval")
      expect(machine.getSnapshot()).toMatchObject({ state: "WAITING", waitingTaskIds: ["waiting-run"] })
      expect(client.getDiagnostics().activeRuns[0].waitingFor).toBe("approval")
      transport.drop()
      expect(connections).toEqual([false])
      expect(machine.getSnapshot().state).toBe("WAITING")
      await vi.advanceTimersByTimeAsync(500)
      expect(connections).toEqual([false, true])
      expect(machine.getSnapshot()).toMatchObject({ state: "WAITING", waitingTaskIds: ["waiting-run"], lastOutcome: null })
      loopback.resumeRun("waiting-run")
      expect(machine.getSnapshot()).toMatchObject({ state: "BUSY", waitingTaskIds: [] })
      expect(client.getDiagnostics().activeRuns[0].waitingFor).toBeUndefined()
      source.dispose()
      client.disconnect()
      expect(connections).toEqual([false, true])
    } finally { vi.useRealTimers() }
  })

  it("maps runs to behavior but keeps child task failure diagnostic-only", async () => {
    const { loopback, client, machine } = await setup()
    expect(client.getDiagnostics().connectionState).toBe("READY")
    expect(machine.getSnapshot()).toMatchObject({ state: "NORMAL", lastActivityAt: 50 })
    loopback.startRun("run")
    expect(machine.getSnapshot()).toMatchObject({ state: "BUSY", activeTaskIds: ["run"] })
    loopback.startTask("run", "test")
    loopback.failTask("run", "test")
    expect(machine.getSnapshot()).toMatchObject({ state: "BUSY", activeTaskIds: ["run"] })
    expect(client.getDiagnostics().activeRuns[0].failedTaskIds).toEqual(["test"])
    loopback.completeRun("run")
    expect(machine.getSnapshot()).toMatchObject({ state: "HAPPY", transitionReason: "all-tasks-completed" })
  })

  it("atomically reconciles a gap without producing a false completion", async () => {
    const { loopback, client, machine } = await setup()
    loopback.startRun("existing")
    loopback.sendGap()
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", bufferedFrameCount: 0 })
    expect(machine.getSnapshot()).toMatchObject({ state: "BUSY", activeTaskIds: ["existing", "gap-run"] })
    expect(machine.getSnapshot().transitionReason).not.toBe("all-tasks-completed")
  })

  it("keeps BUSY until the final of multiple Runs completes", async () => {
    const { loopback, machine } = await setup()
    loopback.startRun("A")
    loopback.startRun("B")
    loopback.completeRun("A")
    expect(machine.getSnapshot()).toMatchObject({ state: "BUSY", activeTaskIds: ["B"] })
    loopback.completeRun("B")
    expect(machine.getSnapshot()).toMatchObject({ state: "HAPPY", activeTaskIds: [] })
  })

  it("maps a top-level Run failure to NORMAL only when it is final", async () => {
    const { loopback, machine } = await setup()
    loopback.startRun("run")
    loopback.failRun("run", "top-level failure")
    expect(machine.getSnapshot()).toMatchObject({ state: "NORMAL", transitionReason: "last-task-failed", lastEvent: { type: "TASK_FAILED", message: "top-level failure" } })
  })

  it("maps an interrupted Run cancellation to NORMAL without a false HAPPY state", async () => {
    const { loopback, machine } = await setup()
    loopback.startRun("run")
    loopback.cancelRun("run")
    expect(machine.getSnapshot()).toMatchObject({ state: "NORMAL", activeTaskIds: [], lastEvent: { type: "TASK_CANCELLED" } })
    expect(machine.getSnapshot().transitionReason).not.toBe("all-tasks-completed")
  })

  it("deduplicates and rejects malformed frames without behavior emission", async () => {
    const { loopback, client, machine } = await setup()
    loopback.startRun("run")
    const before = machine.getSnapshot()
    loopback.duplicateLast()
    loopback.sendMalformed()
    expect(client.getDiagnostics()).toMatchObject({ duplicateCount: 1, rejectedCount: 1 })
    expect(machine.getSnapshot().stateSince).toBe(before.stateSince)
  })

  it("keeps bounded child failure history across an authoritative refresh", async () => {
    const { loopback, client } = await setup()
    loopback.startRun("run")
    loopback.startTask("run", "failed-child")
    loopback.failTask("run", "failed-child")
    loopback.sendSnapshot()
    expect(client.getDiagnostics().activeRuns[0].failedTaskIds).toEqual(["failed-child"])
  })

  it("retains semantic state across a drop until reconnect snapshot", async () => {
    vi.useFakeTimers()
    try {
      const { transport, loopback, client, machine } = await setup()
      loopback.startRun("run")
      transport.drop()
      expect(client.getDiagnostics().connectionState).toBe("RECONNECTING")
      expect(machine.getSnapshot().state).toBe("BUSY")
      await vi.advanceTimersByTimeAsync(500)
      expect(client.getDiagnostics().connectionState).toBe("READY")
      expect(machine.getSnapshot()).toMatchObject({ state: "BUSY", activeTaskIds: ["run"] })
      client.disconnect()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(client.getDiagnostics().connectionState).toBe("DISCONNECTED")
    } finally {
      vi.useRealTimers()
    }
  })
})
