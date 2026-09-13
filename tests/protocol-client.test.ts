import { afterEach, describe, expect, it, vi } from "vitest"
import { CharacterEventProtocolClient } from "../src/protocol/CharacterEventProtocolClient"
import { ProtocolLoopbackSource } from "../src/protocol/ProtocolLoopbackSource"
import type { ProtocolClientCommand, ProtocolEventFrame, ProtocolSnapshotFrame, SourceHelloFrame } from "../src/protocol/types"
import { InMemoryProtocolTransport } from "../src/protocol/transports/InMemoryProtocolTransport"
import { WebSocketProtocolTransport } from "../src/protocol/transports/WebSocketProtocolTransport"

const protocolBase = { protocolVersion: 1 as const, source: "test-source", sourceInstanceId: "instance-A", sessionId: "session-A", sentAt: 0 }
const hello = (sourceInstanceId = "instance-A", messageId = "hello-1", sessionId = "session-A"): SourceHelloFrame => ({
  ...protocolBase,
  sourceInstanceId,
  sessionId,
  frameType: "hello",
  messageId,
  payload: { sourceName: "Test source", supportedProtocolVersions: [1], capabilities: ["snapshot", "runs"], heartbeatIntervalMs: 60_000 },
})
const snapshot = (sequence: number, sourceInstanceId = "instance-A", messageId = "snapshot-1", activeRuns: ProtocolSnapshotFrame["payload"]["activeRuns"] = [], sessionId = "session-A"): ProtocolSnapshotFrame => ({
  ...protocolBase,
  sourceInstanceId,
  sessionId,
  frameType: "snapshot",
  messageId,
  sequence,
  payload: { snapshotId: `snapshot-${sourceInstanceId}-${sequence}`, activeRuns },
})
const runStarted = (sequence: number, messageId = `event-${sequence}`, runId = "run-1"): ProtocolEventFrame => ({
  ...protocolBase,
  frameType: "event",
  messageId,
  sequence,
  payload: { type: "run.started", runId },
})

class FailingSnapshotTransport extends InMemoryProtocolTransport {
  failSnapshotRequests = 0
  snapshotRequestAttempts = 0

  override send(command: ProtocolClientCommand): void {
    if (command.commandType === "snapshot.request") {
      this.snapshotRequestAttempts++
      if (this.failSnapshotRequests > 0) {
        this.failSnapshotRequests--
        throw new Error("snapshot send failed")
      }
    }
    super.send(command)
  }
}

class ClientFakeSocket {
  readyState = 0
  binaryType: BinaryType = "blob"
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  close = vi.fn(() => { this.readyState = 3 })
  send(data: string) { this.sent.push(data) }
  open() { this.readyState = 1; this.onopen?.(new Event("open")) }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent) }
}

afterEach(() => vi.useRealTimers())

describe("CharacterEventProtocolClient lifecycle", () => {
  it("rejects a non-canonical client command identity", () => {
    expect(() => new CharacterEventProtocolClient(new InMemoryProtocolTransport(), { clientId: " client " })).toThrow("clientId must be a canonical protocol ID")
  })

  it("resynchronizes on source restart and preserves bounded sanitized traces", async () => {
    const transport = new InMemoryProtocolTransport()
    const source = new ProtocolLoopbackSource(transport)
    const client = new CharacterEventProtocolClient(transport, { traceLimit: 3 })
    await client.connect()
    source.startRun("run")
    const oldInstance = client.getDiagnostics().sourceInstanceId
    source.restartSource()
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", lastAppliedSequence: 1 })
    expect(client.getDiagnostics().sourceInstanceId).not.toBe(oldInstance)
    expect(client.getRuntimeSnapshot().activeRuns.map((run) => run.runId)).toEqual(["run"])
    const trace = client.exportTrace()
    expect(trace.entries.length).toBeLessThanOrEqual(3)
    expect(trace.entries.every((entry) => !("payload" in entry))).toBe(true)
  })

  it("enters ERROR after an invalid-frame flood and does not auto-reconnect", async () => {
    vi.useFakeTimers()
    const transport = new InMemoryProtocolTransport()
    const source = new ProtocolLoopbackSource(transport)
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    for (let index = 0; index < 20; index++) transport.inject("{")
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "ERROR", rejectedCount: 20 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.getDiagnostics().reconnectCount).toBe(0)
    source.dispose()
  })

  it("treats heartbeat timeout as an unexpected close and reconnects", async () => {
    vi.useFakeTimers()
    let now = 0
    const transport = new InMemoryProtocolTransport()
    const source = new ProtocolLoopbackSource(transport, () => now)
    const client = new CharacterEventProtocolClient(transport, { clock: { now: () => now }, random: () => 0.5 })
    await client.connect()
    now = 180_000
    await vi.advanceTimersByTimeAsync(180_000)
    expect(client.getDiagnostics().connectionState).toBe("RECONNECTING")
    await vi.advanceTimersByTimeAsync(500)
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", reconnectCount: 1 })
  })

  it("dispose cancels reconnect and heartbeat timers/listeners", async () => {
    vi.useFakeTimers()
    const transport = new InMemoryProtocolTransport()
    const source = new ProtocolLoopbackSource(transport)
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    transport.drop()
    client.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.getDiagnostics().connectionState).toBe("DISCONNECTED")
    source.dispose()
  })

  it("clears the client connect promise after cancelling before OPEN and reaches READY on retry", async () => {
    const sockets: ClientFakeSocket[] = []
    const transport = new WebSocketProtocolTransport(undefined, { factory: () => { const socket = new ClientFakeSocket(); sockets.push(socket); return socket } })
    const client = new CharacterEventProtocolClient(transport)
    const first = client.connect()
    client.disconnect("cancel first connect")
    await expect(first).rejects.toMatchObject({ name: "AbortError" })

    const retry = client.connect()
    sockets[1].open()
    await retry
    sockets[1].message(hello())
    sockets[1].message(snapshot(1))
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", connectionEpoch: 1, snapshotRequestPending: false })
    client.dispose()
  })

  it("accepts reused hello and snapshot IDs in a new connection epoch", async () => {
    const transport = new InMemoryProtocolTransport()
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    transport.inject(hello())
    transport.inject(snapshot(1))
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", connectionEpoch: 1, lastAppliedSequence: 1 })

    client.disconnect()
    await client.connect()
    transport.inject(hello())
    transport.inject(snapshot(1))
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", connectionEpoch: 2, lastAppliedSequence: 1, duplicateCount: 0 })
  })

  it("accepts a source restart with reset message IDs and sequence", async () => {
    const transport = new InMemoryProtocolTransport()
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    transport.inject(hello())
    transport.inject(snapshot(5))
    transport.inject(hello("instance-B", "hello-1"))
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "SYNCING", sourceInstanceId: "instance-B", lastAppliedSequence: 0 })
    transport.inject(snapshot(1, "instance-B", "snapshot-1"))
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", sourceInstanceId: "instance-B", lastAppliedSequence: 1, duplicateCount: 0 })
  })

  it("deduplicates across frame types in one connection without starting another sync", async () => {
    const transport = new InMemoryProtocolTransport()
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    transport.inject(hello("instance-A", "shared-id"))
    const snapshotRequests = transport.getSentCommands().filter((command) => command.commandType === "snapshot.request").length
    transport.inject(hello("instance-A", "shared-id"))
    transport.inject(snapshot(1))
    transport.inject(runStarted(2, "shared-id"))
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", duplicateCount: 2 })
    expect(client.getDiagnostics().activeRuns).toEqual([])
    expect(transport.getSentCommands().filter((command) => command.commandType === "snapshot.request")).toHaveLength(snapshotRequests)
  })

  it("does not reapply an already-applied event retransmitted after reconnect", async () => {
    const transport = new InMemoryProtocolTransport()
    const client = new CharacterEventProtocolClient(transport)
    const acceptedRunStarts = vi.fn()
    client.subscribeAccepted((frame) => {
      if (frame.frameType === "event" && frame.payload.type === "run.started") acceptedRunStarts(frame)
    })
    await client.connect()
    transport.inject(hello())
    transport.inject(snapshot(1))
    transport.inject(runStarted(2))
    client.disconnect()
    await client.connect()
    transport.inject(hello())
    transport.inject(runStarted(2))
    transport.inject(snapshot(2, "instance-A", "snapshot-1", [{ runId: "run-1", tasks: [] }]))

    expect(acceptedRunStarts).toHaveBeenCalledTimes(1)
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", staleCount: 1, lastAppliedSequence: 2 })
  })

  it("keeps snapshot pending through ordered events and clears it only after snapshot application", async () => {
    const transport = new FailingSnapshotTransport()
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    transport.inject(hello())
    expect(client.getDiagnostics().snapshotRequestPending).toBe(true)
    transport.inject(snapshot(1))
    expect(client.getDiagnostics().snapshotRequestPending).toBe(false)

    client.requestSnapshot("manual")
    expect(client.getDiagnostics().snapshotRequestPending).toBe(true)
    transport.inject(runStarted(2))
    expect(client.getDiagnostics().snapshotRequestPending).toBe(true)
    transport.inject(snapshot(2, "instance-A", "snapshot-2", [{ runId: "run-1", tasks: [] }]))
    expect(client.getDiagnostics().snapshotRequestPending).toBe(false)
  })

  it("leaves snapshot pending false on send failure and retries on the next gap", async () => {
    const transport = new FailingSnapshotTransport()
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    transport.inject(hello())
    transport.inject(snapshot(1))
    transport.failSnapshotRequests = 1
    const attemptsBeforeGap = transport.snapshotRequestAttempts
    transport.inject(runStarted(3, "gap-3", "run-3"))
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "DESYNCED", snapshotRequestPending: false, lastError: "snapshot send failed" })
    transport.inject(runStarted(4, "gap-4", "run-4"))
    expect(transport.snapshotRequestAttempts).toBe(attemptsBeforeGap + 2)
    expect(client.getDiagnostics().snapshotRequestPending).toBe(true)
    client.disconnect()
    expect(client.getDiagnostics().snapshotRequestPending).toBe(false)
  })

  it("rejects a non-canonical completion ID without diverging reconciled state", async () => {
    const transport = new InMemoryProtocolTransport()
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    transport.inject(hello())
    transport.inject(snapshot(1))
    transport.inject(runStarted(2))
    transport.inject({ ...protocolBase, frameType: "event", messageId: "event-3", sequence: 3, payload: { type: "run.completed", runId: " run-1 " } })
    expect(client.getDiagnostics()).toMatchObject({ rejectedCount: 1, activeRuns: [{ runId: "run-1" }] })
  })
})
