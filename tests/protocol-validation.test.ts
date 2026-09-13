import { describe, expect, it } from "vitest"
import { parseProtocolFrame, validateProtocolFrame } from "../src/protocol/validation"

const base = { protocolVersion: 1, messageId: "message-1", source: "mock", sourceInstanceId: "instance-1", sessionId: "session-1", sentAt: 100 }
const event = (payload: unknown, overrides: Record<string, unknown> = {}) => ({ ...base, frameType: "event", sequence: 1, payload, ...overrides })

describe("protocol runtime validation", () => {
  it("validates explicit waiting reasons and wait metadata in snapshots", () => {
    for (const reason of ["user-input", "approval"]) {
      expect(validateProtocolFrame(event({ type: "run.waiting", runId: "run", reason })).ok).toBe(true)
      expect(validateProtocolFrame({ ...base, frameType: "snapshot", sequence: 1, payload: { snapshotId: "s", activeRuns: [{ runId: "run", waitingFor: reason, tasks: [] }] } }).ok).toBe(true)
    }
    expect(validateProtocolFrame(event({ type: "run.resumed", runId: "run" })).ok).toBe(true)
    for (const reason of [undefined, "busy", "", 2]) expect(validateProtocolFrame(event({ type: "run.waiting", runId: "run", reason })).ok).toBe(false)
    expect(validateProtocolFrame(event({ type: "run.resumed", runId: "run", command: "extra" })).ok).toBe(false)
  })

  it("accepts hello, every event kind, and an authoritative snapshot", () => {
    expect(validateProtocolFrame({ ...base, frameType: "hello", payload: { sourceName: "Mock", supportedProtocolVersions: [1], capabilities: ["snapshot", "runs"], heartbeatIntervalMs: 1_000 } }).ok).toBe(true)
    const payloads = [
      { type: "run.started", runId: "run" }, { type: "run.progress", runId: "run", progress: 0.5 },
      { type: "run.completed", runId: "run" }, { type: "run.failed", runId: "run", message: "no" }, { type: "run.cancelled", runId: "run" },
      { type: "task.started", runId: "run", taskId: "task" }, { type: "task.progress", runId: "run", taskId: "task", progress: 1 },
      { type: "task.completed", runId: "run", taskId: "task" }, { type: "task.failed", runId: "run", taskId: "task" }, { type: "task.cancelled", runId: "run", taskId: "task" },
    ]
    for (const payload of payloads) expect(validateProtocolFrame(event(payload))).toMatchObject({ ok: true })
    expect(validateProtocolFrame({ ...base, frameType: "snapshot", sequence: 2, payload: { snapshotId: "snapshot", activeRuns: [{ runId: "run", progress: 0.2, tasks: [{ taskId: "task", status: "running", progress: 0.4 }] }] } }).ok).toBe(true)
  })

  it.each([
    ["unsupported version", event({ type: "run.started", runId: "run" }, { protocolVersion: 2 }), "unsupported-version"],
    ["unknown frame", { ...base, frameType: "command", payload: {} }, "unknown-frame-type"],
    ["unknown event", event({ type: "shell.execute", runId: "run" }), "unknown-event-type"],
    ["empty ID", event({ type: "run.started", runId: " " }), "invalid-run-id"],
    ["oversized ID", event({ type: "run.started", runId: "x".repeat(129) }), "invalid-run-id"],
    ["invalid sequence", event({ type: "run.started", runId: "run" }, { sequence: 0 }), "invalid-sequence"],
    ["negative progress", event({ type: "run.progress", runId: "run", progress: -0.1 }), "invalid-progress"],
    ["large progress", event({ type: "run.progress", runId: "run", progress: 1.1 }), "invalid-progress"],
    ["NaN progress", event({ type: "run.progress", runId: "run", progress: Number.NaN }), "invalid-progress"],
    ["Infinity progress", event({ type: "run.progress", runId: "run", progress: Number.POSITIVE_INFINITY }), "invalid-progress"],
  ])("rejects %s", (_label, value, code) => {
    const result = validateProtocolFrame(value)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(code)
  })

  it("rejects duplicate snapshot IDs and bounded collection violations", () => {
    const duplicateRun = { ...base, frameType: "snapshot", sequence: 1, payload: { snapshotId: "s", activeRuns: [{ runId: "r", tasks: [] }, { runId: "r", tasks: [] }] } }
    const duplicateTask = { ...base, frameType: "snapshot", sequence: 1, payload: { snapshotId: "s", activeRuns: [{ runId: "r", tasks: [{ taskId: "t", status: "running" }, { taskId: "t", status: "running" }] }] } }
    expect(validateProtocolFrame(duplicateRun)).toMatchObject({ ok: false, error: { code: "duplicate-run" } })
    expect(validateProtocolFrame(duplicateTask)).toMatchObject({ ok: false, error: { code: "duplicate-task" } })
    const manyRuns = Array.from({ length: 65 }, (_, index) => ({ runId: `r-${index}`, tasks: [] }))
    expect(validateProtocolFrame({ ...base, frameType: "snapshot", sequence: 1, payload: { snapshotId: "s", activeRuns: manyRuns } })).toMatchObject({ ok: false, error: { code: "too-many-runs" } })
  })

  it("rejects malformed, binary, and oversized raw messages", () => {
    expect(parseProtocolFrame("{")).toMatchObject({ ok: false, error: { code: "malformed-json" } })
    expect(parseProtocolFrame(new ArrayBuffer(1))).toMatchObject({ ok: false, error: { code: "binary-not-supported" } })
    expect(parseProtocolFrame(" ".repeat(65 * 1024))).toMatchObject({ ok: false, error: { code: "message-too-large" } })
  })

  it.each([
    ["messageId", { ...event({ type: "run.started", runId: "run" }), messageId: " message-1" }, "invalid-id"],
    ["sourceInstanceId", { ...event({ type: "run.started", runId: "run" }), sourceInstanceId: "instance-1 " }, "invalid-id"],
    ["sessionId", { ...event({ type: "run.started", runId: "run" }), sessionId: "\tsession-1" }, "invalid-id"],
    ["runId", event({ type: "run.started", runId: " run-1 " }), "invalid-run-id"],
    ["taskId", event({ type: "task.started", runId: "run", taskId: " task-1" }), "invalid-task-started"],
    ["snapshotId", { ...base, frameType: "snapshot", sequence: 1, payload: { snapshotId: "snapshot-1 ", activeRuns: [] } }, "invalid-snapshot"],
    ["heartbeatId", { ...base, frameType: "heartbeat", payload: { heartbeatId: " heartbeat-1" } }, "invalid-heartbeat"],
    ["error code", { ...base, frameType: "error", payload: { code: " error-code", message: "failure", recoverable: true } }, "invalid-error"],
  ])("rejects non-canonical %s", (_field, value, code) => {
    expect(validateProtocolFrame(value)).toMatchObject({ ok: false, error: { code } })
  })

  it.each([" run-1", "run-1 ", "\trun-1"])("rejects runId whitespace variant %j without trimming", (runId) => {
    const result = validateProtocolFrame(event({ type: "run.started", runId }))
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-run-id" } })
    if (!result.ok) expect(result.error.message).toContain("without leading/trailing whitespace")
  })
})
