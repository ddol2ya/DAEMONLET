import { describe, expect, it } from "vitest"
import { validateProtocolFrame } from "../src/protocol/validation"
import { PROTOCOL_TASK_KINDS } from "../src/protocol/types"
import { ProtocolSnapshotReconciler } from "../src/protocol/ProtocolSnapshotReconciler"
import { CodexRunRegistry } from "../adapter/codex/CodexRunRegistry"
import type { CodexTaskCategory } from "../adapter/codex/types"

const base = { protocolVersion: 1 as const, messageId: "m", source: "s", sourceInstanceId: "i", sessionId: "session", sentAt: 0, sequence: 1 }
const event = (payload: unknown) => ({ ...base, frameType: "event", payload })
describe("protocol v1 additive outcome metadata", () => {
  it.each([undefined, "observed", "authoritative"])("accepts completion confidence case %#", (confidence) => {
    expect(validateProtocolFrame(event({ type: "run.completed", runId: "r", ...(confidence ? { confidence } : {}) })).ok).toBe(true)
  })
  it.each(["hook-stop", "success", null, true, 1])("rejects invalid confidence case %#", (confidence) => {
    expect(validateProtocolFrame(event({ type: "run.completed", runId: "r", confidence })).ok).toBe(false)
  })
  it.each(["task.started", "task.progress", "task.completed", "task.failed", "task.cancelled"])("validates kind on %s while retaining strict unknown-field rejection", (type) => {
    for (const kind of [undefined, ...PROTOCOL_TASK_KINDS]) expect(validateProtocolFrame(event({ type, runId: "r", taskId: "t", ...(kind ? { kind } : {}) })).ok).toBe(true)
    expect(validateProtocolFrame(event({ type, runId: "r", taskId: "t", kind: "mcp-tool" })).ok).toBe(false)
    expect(validateProtocolFrame(event({ type, runId: "r", taskId: "t", command: "forbidden" })).ok).toBe(false)
  })
  it("preserves kind through snapshots, starts and progress", () => {
    const reconciler = new ProtocolSnapshotReconciler()
    const frame = { ...base, frameType: "snapshot" as const, payload: { snapshotId: "s", activeRuns: [{ runId: "r", tasks: [{ taskId: "t", kind: "tool" as const, status: "running" as const }] }] } }
    expect(validateProtocolFrame(frame).ok).toBe(true)
    reconciler.applySnapshot(frame)
    expect(reconciler.getSnapshot().activeRuns[0].tasks[0].kind).toBe("tool")
    reconciler.applyEvent({ ...base, frameType: "event", payload: { type: "task.progress", runId: "r", taskId: "t", kind: "review" } })
    expect(reconciler.getSnapshot().activeRuns[0].tasks[0].kind).toBe("review")
    expect(validateProtocolFrame({ ...frame, payload: { snapshotId: "s", activeRuns: [{ runId: "r", tasks: [{ taskId: "t", status: "running", kind: "invalid" }] }] } }).ok).toBe(false)
  })
  it.each(["hook-stop", "authoritative"] as const)("maps adapter confidence %s", (confidence) => {
    const registry = new CodexRunRegistry()
    const common = { sessionId: "s", turnId: "t", backend: "HOOK_OBSERVER" as const, observedAt: 10 }
    registry.apply({ ...common, type: "run.started" })
    expect(registry.apply({ ...common, type: "run.completed", confidence })).toMatchObject({ confidence: confidence === "hook-stop" ? "observed" : "authoritative" })
  })
  it.each([['command','command'],['file-change','file-change'],['mcp-tool','tool'],['dynamic-tool','tool'],['web-search','web-search'],['subagent','subtask'],['review','review'],['other','other']] as const)("maps adapter category %s to %s without label inference", (category, kind) => {
    const registry = new CodexRunRegistry()
    const common = { sessionId: "s", turnId: "t", backend: "APP_SERVER_OWNED" as const, observedAt: 10 }
    registry.apply({ ...common, type: "run.started" })
    const task = { ...common, taskId: "t", category: category as CodexTaskCategory, label: "unrelated" }
    expect(registry.apply({ ...task, type: "task.started" })).toMatchObject({ kind })
    expect(registry.getSnapshot()[0].tasks[0].kind).toBe(kind)
    expect(registry.apply({ ...task, type: "task.completed" })).toMatchObject({ kind })
  })
})
