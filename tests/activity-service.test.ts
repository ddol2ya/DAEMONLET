import { afterEach, describe, expect, it, vi } from "vitest"
import { ActivityService } from "../electron/main/activity/ActivityService"
import type { ActivityHistoryData } from "../electron/main/activity/ActivityStore"
import type { ActivityPersistence } from "../electron/main/activity/ActivityHistoryStore"
import { CharacterEventProtocolClient } from "../src/protocol/CharacterEventProtocolClient"
import { ProtocolTaskEventSource } from "../src/protocol/ProtocolTaskEventSource"
import { InMemoryProtocolTransport } from "../src/protocol/transports/InMemoryProtocolTransport"
import type { ProtocolDomainEvent, ProtocolRunSnapshot } from "../src/protocol/types"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import { createDefaultBehaviorProfile } from "../src/behavior/BehaviorManifest"
import { activityCorrelationKey } from "../adapter/codex/privacy/CanonicalId"

const services: ActivityService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.dispose())); vi.useRealTimers() })

async function fixture(saved: ActivityHistoryData | null = null) {
  vi.useFakeTimers(); vi.setSystemTime(10_000)
  let sequence = 0, message = 0, instance = "instance-one", autoSnapshot = true
  const activeRuns = new Map<string, ProtocolRunSnapshot>()
  const transport = new InMemoryProtocolTransport()
  const connect = vi.spyOn(transport, "connect")
  const client = new CharacterEventProtocolClient(transport, { random: () => 0.5 })
  const persistence = { load: vi.fn(async () => ({ data: saved, issue: null })), save: vi.fn(async (data: ActivityHistoryData) => { saved = structuredClone(data) }) } satisfies ActivityPersistence
  const service = new ActivityService(client, persistence)
  services.push(service)
  const base = () => ({ protocolVersion: 1, source: "codex-adapter", sourceInstanceId: instance, sessionId: "wire-session", sentAt: Date.now(), messageId: `message-${++message}` })
  const hello = () => transport.inject({ ...base(), frameType: "hello", payload: { sourceName: "Codex Adapter", supportedProtocolVersions: [1], capabilities: ["snapshot", "heartbeat", "runs", "tasks"], heartbeatIntervalMs: 60_000 } })
  const snapshot = () => transport.inject({ ...base(), frameType: "snapshot", sequence: ++sequence, payload: { snapshotId: `snapshot-${sequence}`, activeRuns: [...activeRuns.values()] } })
  transport.subscribeCommand(command => {
    if (command.commandType === "client.hello") hello()
    if (command.commandType === "snapshot.request" && autoSnapshot) snapshot()
  })
  const emit = (payload: ProtocolDomainEvent) => {
    if (payload.type === "run.started") activeRuns.set(payload.runId, { runId: payload.runId, tasks: [] })
    if (payload.type === "run.completed" || payload.type === "run.failed" || payload.type === "run.cancelled") activeRuns.delete(payload.runId)
    if (payload.type === "run.waiting") activeRuns.set(payload.runId, { runId: payload.runId, waitingFor: payload.reason, tasks: [] })
    if (payload.type === "run.resumed" && activeRuns.has(payload.runId)) delete activeRuns.get(payload.runId)!.waitingFor
    const frame = { ...base(), frameType: "event", sequence: ++sequence, payload }
    transport.inject(frame)
    return frame
  }
  await service.start(); await client.connect()
  return { service, client, connect, transport, persistence, emit, snapshot, activeRuns, saved: () => saved!, autoSnapshot: (value: boolean) => { autoSnapshot = value }, skip: () => { sequence++ }, restart: () => { instance = "instance-two"; sequence = 0; hello() } }
}

describe("main ActivityService uses the existing validated protocol client", () => {
  it("shows verified session titles without persisting them or changing result revisions", async () => {
    const f = await fixture()
    f.emit({ type: "run.completed", runId: "A" }); f.emit({ type: "run.completed", runId: "B" })
    const key = activityCorrelationKey("A")
    const before = f.service.snapshot().entries.map(r => ({ id: r.activityId, revision: r.revision }))
    f.service.setConversationKeys(new Set([key]))
    f.service.setConversationTitles(new Map([[key, "제목 표시 테스트"], ["unverified", "WRONG_TITLE"]]))
    expect(f.service.snapshot().entries.filter(r => r.name === "제목 표시 테스트")).toHaveLength(1)
    expect(f.service.snapshot().entries.map(r => ({ id: r.activityId, revision: r.revision }))).toEqual(before)
    await f.service.flush()
    expect(JSON.stringify(f.saved())).not.toContain("제목 표시 테스트")
    expect(JSON.stringify(f.service.snapshot())).not.toContain("WRONG_TITLE")
    f.service.setConversationKeys(new Set())
    expect(f.service.snapshot().entries.every(r => r.name.startsWith("작업 "))).toBe(true)
  })
  it("collects mixed Run attention without changing the character's BUSY policy", async () => {
    const f = await fixture()
    const source = new ProtocolTaskEventSource(f.client)
    const machine = new CharacterStateMachine(createDefaultBehaviorProfile().timing, { now: Date.now })
    source.subscribe(event => machine.dispatch(event))
    f.emit({ type: "run.started", runId: "A" }); f.emit({ type: "run.started", runId: "B" })
    f.emit({ type: "run.waiting", runId: "B", reason: "user-input" })
    expect(machine.getSnapshot().state).toBe("BUSY")
    expect(f.service.snapshot().counts).toMatchObject({ running: 1, waiting: 1 })
    source.dispose() // Equivalent lifetime boundary of a character renderer/session.
    f.emit({ type: "run.completed", runId: "A", confidence: "observed" })
    expect(f.service.snapshot().counts).toMatchObject({ running: 0, waiting: 1, completed: 1 })
  })

  it("dedupes wire frames and keeps acknowledgements across Adapter restart", async () => {
    const f = await fixture()
    f.emit({ type: "run.started", runId: "A" })
    const frame = f.emit({ type: "run.completed", runId: "A" })
    f.transport.inject(frame)
    f.service.acknowledge({ targets: f.service.snapshot().entries.map(({ activityId, revision }) => ({ activityId, revision })) })
    f.restart()
    f.emit({ type: "run.started", runId: "A" }); f.emit({ type: "run.completed", runId: "A" })
    expect(f.service.snapshot().entries).toHaveLength(1)
    expect(f.service.snapshot().counts.completed).toBe(0)
  })

  it("buffers sequence gaps and treats snapshot omissions as unknown without clearing history", async () => {
    const f = await fixture()
    f.emit({ type: "run.started", runId: "A" }); f.emit({ type: "run.failed", runId: "B" })
    f.autoSnapshot(false); f.skip()
    f.emit({ type: "run.started", runId: "C" })
    expect(f.service.snapshot()).toMatchObject({ connection: "DESYNCED", counts: { running: 1, failed: 1 } })
    expect(f.service.snapshot().entries.find(r => r.state === "running")?.freshness).toBe("rechecking")
    f.activeRuns.delete("A"); f.snapshot()
    expect(f.service.snapshot()).toMatchObject({ connection: "READY", counts: { running: 1, failed: 1, completed: 0 } })
    expect(f.service.snapshot().entries.some(r => r.state === "unknown")).toBe(true)
  })

  it("retains memory on save failure, advertises the failure and saves the next change", async () => {
    const f = await fixture()
    f.persistence.save.mockRejectedValueOnce(new Error("PRIVATE_RAW_PATH"))
    f.emit({ type: "run.failed", runId: "A", message: "PRIVATE_RESPONSE" })
    await f.service.flush()
    expect(f.service.snapshot()).toMatchObject({ storage: "error", counts: { failed: 1 } })
    expect(JSON.stringify(f.service.snapshot())).not.toContain("PRIVATE")
    f.emit({ type: "run.completed", runId: "B" })
    await f.service.flush()
    expect(f.service.snapshot()).toMatchObject({ storage: "saved", counts: { failed: 1, completed: 1 } })
    expect(f.saved().records).toHaveLength(2)
  })

  it("coalesces writes, serializes an in-flight save and flushes the newest result", async () => {
    const f = await fixture()
    let release!: () => void
    f.persistence.save.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    f.emit({ type: "run.failed", runId: "A" })
    const flush = f.service.flush()
    await Promise.resolve()
    f.emit({ type: "run.completed", runId: "B" })
    expect(f.persistence.save).toHaveBeenCalledOnce()
    release(); await flush
    expect(f.persistence.save).toHaveBeenCalledTimes(2)
    expect(f.saved().records).toHaveLength(2)
    expect(f.service.snapshot().storage).toBe("saved")
  })

  it("retries unsaved memory on graceful shutdown without an infinite retry loop", async () => {
    const f = await fixture()
    f.persistence.save.mockRejectedValueOnce(new Error("disk temporarily unavailable"))
    f.emit({ type: "run.failed", runId: "A" })
    await f.service.flush()
    expect(f.service.snapshot().storage).toBe("error")
    expect(f.persistence.save).toHaveBeenCalledOnce()
    await f.service.dispose()
    expect(f.saved().records).toHaveLength(1)
    expect(f.persistence.save).toHaveBeenCalledTimes(2)
  })

  it("supports window subscriptions without new collectors and cleans up sockets/timers", async () => {
    const f = await fixture()
    await f.service.start()
    const initialConnects = f.connect.mock.calls.length
    for (let i = 0; i < 20; i++) { const stop = f.service.subscribe(() => {}); f.service.snapshot(); stop() }
    expect(f.connect).toHaveBeenCalledTimes(initialConnects)
    f.emit({ type: "run.completed", runId: "A" })
    const before = f.service.snapshot().counts
    f.service.snapshot(); f.service.setNavigation("app"); f.service.snapshot()
    expect(f.service.snapshot().counts).toEqual(before)
    await f.service.dispose()
    expect(f.transport.getStatus().state).toBe("CLOSED")
    expect(vi.getTimerCount()).toBe(0)
    expect(f.saved().records).toHaveLength(1)
  })

  it("preserves unread history through an app restart and does not invent offline results", async () => {
    const f = await fixture()
    f.emit({ type: "run.completed", runId: "done" }); f.emit({ type: "run.started", runId: "offline" })
    await f.service.dispose()
    const restored = await fixture(f.saved())
    expect(restored.service.snapshot()).toMatchObject({ counts: { completed: 1, failed: 0, running: 0 } })
    expect(restored.service.snapshot().entries.some(r => r.state === "unknown")).toBe(true)
  })

  it("rejects invalid frames before state changes and never exports raw errors", async () => {
    const f = await fixture()
    f.transport.inject({ protocolVersion: 1, frameType: "event", payload: { type: "run.failed", runId: "forged", message: "PRIVATE_RAW" } })
    expect(f.service.snapshot().entries).toHaveLength(0)
    f.transport.inject({ protocolVersion: 1, frameType: "error", source: "codex-adapter", sourceInstanceId: "instance-one", sessionId: "wire-session", messageId: "error-1", sentAt: Date.now(), payload: { code: "PRIVATE_TOKEN", message: "PRIVATE_RAW", recoverable: false } })
    expect(f.service.snapshot()).toMatchObject({ connection: "ERROR", counts: { failed: 0 } })
    expect(JSON.stringify(f.service.snapshot())).not.toContain("PRIVATE")
  })
})
