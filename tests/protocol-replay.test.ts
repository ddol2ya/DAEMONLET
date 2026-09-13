import { afterEach, describe, expect, it, vi } from "vitest"
import { CharacterEventProtocolClient } from "../src/protocol/CharacterEventProtocolClient"
import type { ProtocolFrame } from "../src/protocol/types"
import { ReplayProtocolTransport } from "../src/protocol/transports/ReplayProtocolTransport"

const base = { protocolVersion: 1 as const, source: "replay", sourceInstanceId: "i", sessionId: "s", sentAt: 0 }
const frames: ProtocolFrame[] = [
  { ...base, frameType: "hello", messageId: "hello", payload: { sourceName: "Replay", supportedProtocolVersions: [1], capabilities: ["snapshot", "replay"], heartbeatIntervalMs: 1_000 } },
  { ...base, frameType: "snapshot", messageId: "snapshot", sequence: 1, sentAt: 100, payload: { snapshotId: "s", activeRuns: [] } },
  { ...base, frameType: "event", messageId: "event-gap", sequence: 3, sentAt: 200, payload: { type: "run.started", runId: "run" } },
]

afterEach(() => vi.useRealTimers())

describe("ReplayProtocolTransport", () => {
  it("steps deterministically, resets, and still uses live validation/sequence rules", async () => {
    const transport = new ReplayProtocolTransport()
    transport.load(frames)
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    expect(transport.step()).toBe(true)
    expect(transport.step()).toBe(true)
    expect(client.getDiagnostics().connectionState).toBe("READY")
    expect(transport.step()).toBe(true)
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "DESYNCED", gapCount: 1, bufferedFrameCount: 1 })
    transport.reset()
    expect(transport.getPlaybackState()).toMatchObject({ index: 0, count: 3, playing: false })
    transport.load([{ raw: "{", at: 0 }])
    transport.step()
    expect(client.getDiagnostics().rejectedCount).toBe(1)
  })

  it("can reset both playback and protocol dedupe state for deterministic reruns", async () => {
    const transport = new ReplayProtocolTransport()
    transport.load(frames.slice(0, 2))
    const client = new CharacterEventProtocolClient(transport)
    await client.connect()
    transport.step()
    transport.step()
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", acceptedCount: 2 })
    client.reset()
    transport.reset()
    await client.connect()
    transport.step()
    transport.step()
    expect(client.getDiagnostics()).toMatchObject({ connectionState: "READY", acceptedCount: 2, duplicateCount: 0 })
  })

  it("plays with relative timing, pause, and speed", async () => {
    vi.useFakeTimers()
    const transport = new ReplayProtocolTransport()
    transport.load(frames.slice(0, 2))
    await transport.connect()
    const listener = vi.fn()
    transport.subscribeMessage(listener)
    transport.setSpeed(2)
    transport.play()
    await vi.advanceTimersByTimeAsync(0)
    expect(listener).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(49)
    expect(listener).toHaveBeenCalledTimes(1)
    transport.pause()
    await vi.advanceTimersByTimeAsync(100)
    expect(listener).toHaveBeenCalledTimes(1)
    transport.play()
    await vi.advanceTimersByTimeAsync(50)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("loads JSON arrays and JSONL while preserving the previous replay after invalid input", async () => {
    const transport = new ReplayProtocolTransport()
    transport.load(JSON.stringify(frames.slice(0, 2)))
    expect(transport.getPlaybackState()).toMatchObject({ index: 0, count: 2 })
    await transport.connect()
    expect(transport.step()).toBe(true)

    expect(() => transport.load(`${JSON.stringify(frames[0])}\n{ malformed`)).toThrow("neither valid JSON nor JSONL")
    expect(transport.getPlaybackState()).toMatchObject({ index: 1, count: 2 })

    transport.load(frames.slice(0, 2).map((frame) => JSON.stringify(frame)).join("\n"))
    expect(transport.getPlaybackState()).toMatchObject({ index: 0, count: 2 })
    expect(() => transport.load("42")).toThrow("must be an object")
    expect(transport.getPlaybackState()).toMatchObject({ index: 0, count: 2 })
  })

  it("rejects malformed replay entries atomically and accepts a later valid retry", () => {
    const transport = new ReplayProtocolTransport()
    transport.load(frames.slice(0, 1))
    expect(() => transport.load('[{"raw":7,"at":0}]')).toThrow("raw must be a string")
    expect(transport.getPlaybackState().count).toBe(1)
    transport.load('[{"raw":"{}","at":0}]')
    expect(transport.getPlaybackState()).toMatchObject({ index: 0, count: 1 })
  })
})
