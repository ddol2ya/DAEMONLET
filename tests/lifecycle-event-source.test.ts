import { describe, expect, it, vi } from "vitest"
import { ProtocolTaskEventSource } from "../src/protocol/ProtocolTaskEventSource"
import type { CharacterEventProtocolClient } from "../src/protocol/CharacterEventProtocolClient"
import type { ProtocolDomainEvent, ProtocolFrame, ProtocolRunSnapshot } from "../src/protocol/types"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import { createDefaultBehaviorProfile } from "../src/behavior/BehaviorManifest"
import type { CharacterLifecycleEvent } from "../src/lifecycle/CharacterLifecycleEvent"

function setup() {
  let listener: (frame: ProtocolFrame) => void = () => {}
  const unsubscribe = vi.fn(() => { listener = () => {} })
  const client: Pick<CharacterEventProtocolClient, "subscribeAccepted"> = { subscribeAccepted: (callback: typeof listener) => { listener = callback; return unsubscribe } }
  const source = new ProtocolTaskEventSource(client, { now: () => 123 })
  const machine = new CharacterStateMachine(createDefaultBehaviorProfile().timing, { now: () => 123 })
  const order: string[] = []
  const lifecycle: CharacterLifecycleEvent[] = []
  source.subscribe((event) => { machine.dispatch(event); order.push(event.type) })
  source.subscribeLifecycle((event) => { lifecycle.push(event); order.push(event.type) })
  const frame = { protocolVersion: 1 as const, messageId: "message", source: "test", sourceInstanceId: "instance", sessionId: "session", sentAt: 0, sequence: 1 }
  return { source, machine, lifecycle, order, unsubscribe,
    event: (payload: ProtocolDomainEvent) => listener({ ...frame, frameType: "event", payload }),
    snapshot: (activeRuns: ProtocolRunSnapshot[]) => listener({ ...frame, frameType: "snapshot", payload: { snapshotId: "snapshot", activeRuns } }),
  }
}

describe("lifecycle event source", () => {
  it.each([
    { type: "run.completed", confidence: "observed" },
    { type: "run.completed", confidence: "authoritative" },
    { type: "run.failed", code: "rate-limit", message: "diagnostic detail" },
    { type: "run.cancelled", reason: "user-interrupted" },
  ] as const)("preserves terminal metadata for $type after behavior dispatch", (terminal) => {
    const t = setup(); t.event({ type: "run.started", runId: "run" }); t.event({ ...terminal, runId: "run" })
    expect(t.order[2]).toMatch(/^TASK_/)
    expect(t.order[3]).toBe(terminal.type)
    expect(t.machine.getSnapshot().lastOutcome?.kind).toBe(terminal.type.split(".")[1])
    expect(t.lifecycle[1]).toMatchObject({ type: terminal.type, runId: "run", at: 123 })
    if (terminal.type === "run.cancelled") expect(t.machine.getSnapshot().lastOutcome).toMatchObject({ reason: terminal.reason })
    if (terminal.type === "run.completed") expect(t.lifecycle[1]).toMatchObject({ confidence: terminal.confidence })
    if (terminal.type === "run.failed") expect(t.lifecycle[1]).toEqual({ type: "run.failed", runId: "run", code: "rate-limit", at: 123 })
  })
  it("emits child signals only on lifecycle and caches kind per run/task pair", () => {
    const t = setup()
    t.event({ type: "run.started", runId: "A" }); t.event({ type: "run.started", runId: "B" })
    const before = t.machine.getSnapshot()
    t.event({ type: "task.started", runId: "A", taskId: "same", kind: "command", label: "diagnostic" })
    t.event({ type: "task.started", runId: "B", taskId: "same", kind: "web-search" })
    t.event({ type: "task.completed", runId: "A", taskId: "same" })
    t.event({ type: "task.failed", runId: "B", taskId: "same" })
    expect(t.machine.getSnapshot()).toEqual(before)
    expect(t.lifecycle.slice(-2).map((e) => "kind" in e ? e.kind : null)).toEqual(["command", "web-search"])
    expect(JSON.stringify(t.lifecycle)).not.toContain("diagnostic")
  })
  it("replaces the task cache on snapshots, removes terminals, defaults old events to other", () => {
    const t = setup()
    t.snapshot([{ runId: "run", tasks: [{ taskId: "child", status: "running", kind: "file-change" }] }])
    expect(t.order).toEqual(["TASK_SNAPSHOT", "snapshot.applied"])
    expect(t.machine.getSnapshot().lastOutcome).toBeNull()
    t.event({ type: "task.completed", runId: "run", taskId: "child" })
    expect(t.lifecycle.at(-1)).toMatchObject({ kind: "file-change" })
    t.event({ type: "task.cancelled", runId: "run", taskId: "child" })
    expect(t.lifecycle.at(-1)).toMatchObject({ kind: "other" })
    t.event({ type: "task.started", runId: "run", taskId: "old", kind: "review" })
    t.snapshot([{ runId: "run", tasks: [] }])
    t.event({ type: "task.completed", runId: "run", taskId: "old" })
    expect(t.lifecycle.at(-1)).toMatchObject({ kind: "other" })
  })
  it("bounds its cache even for an excessive stream", () => {
    const t = setup(); t.event({ type: "run.started", runId: "run" })
    for (let i = 0; i < 1025; i++) t.event({ type: "task.started", runId: "run", taskId: String(i), kind: "tool" })
    t.event({ type: "task.completed", runId: "run", taskId: "0" })
    expect(t.lifecycle.at(-1)).toMatchObject({ kind: "other" })
    t.event({ type: "task.completed", runId: "run", taskId: "1024" })
    expect(t.lifecycle.at(-1)).toMatchObject({ kind: "tool" })
  })
  it("suppresses duplicate starts, late terminals/children and cleans up on dispose", () => {
    const t = setup(); t.event({ type: "run.started", runId: "run" }); t.event({ type: "run.started", runId: "run" })
    t.event({ type: "run.cancelled", runId: "run", reason: "interrupted" })
    t.event({ type: "run.completed", runId: "run" }); t.event({ type: "task.started", runId: "run", taskId: "late" })
    expect(t.lifecycle).toHaveLength(2)
    const before = t.machine.getSnapshot()
    t.source.dispose(); t.event({ type: "run.started", runId: "new" })
    expect(t.unsubscribe).toHaveBeenCalledOnce()
    expect(t.machine.getSnapshot()).toEqual(before)
  })
  it("updates semantics before a presentation listener runs and isolates its failure", () => {
    const t = setup()
    t.source.subscribeLifecycle((event) => { if (event.type === "run.completed") expect(t.machine.getSnapshot().state).toBe("HAPPY"); throw new Error("view failed") })
    expect(() => { t.event({ type: "run.started", runId: "run" }); t.event({ type: "run.completed", runId: "run" }) }).not.toThrow()
  })
})
