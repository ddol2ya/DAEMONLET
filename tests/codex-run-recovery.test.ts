import { describe, expect, it } from "vitest"
import { CodexRunRegistry, type PersistedRegistryState } from "../adapter/codex/CodexRunRegistry.ts"

const RECOVERY_TTL_MS = 120_000
const RESTORED_AT = 1_000_000

function persistedRun(updatedAt = RESTORED_AT - 60_000): PersistedRegistryState {
  return {
    runs: [{
      sessionId: "recovered-session",
      turnId: "recovered-turn",
      backend: "HOOK_OBSERVER",
      startedAt: updatedAt - 1_000,
      updatedAt,
      tasks: [],
    }],
  }
}

function restore(options: { staleTtlMs?: number; updatedAt?: number } = {}): CodexRunRegistry {
  const registry = new CodexRunRegistry({
    now: () => RESTORED_AT,
    recoveryTtlMs: RECOVERY_TTL_MS,
    staleTtlMs: options.staleTtlMs,
  })
  registry.restore(persistedRun(options.updatedAt))
  return registry
}

describe("provisional recovered Codex runs", () => {
  it.each([
    { age: RECOVERY_TTL_MS - 1, active: 1, provisional: 1, stale: 0 },
    { age: RECOVERY_TTL_MS, active: 0, provisional: 0, stale: 1 },
    { age: RECOVERY_TTL_MS + 1, active: 0, provisional: 0, stale: 1 },
  ])("applies the restore age boundary at $age ms", ({ age, active, provisional, stale }) => {
    const registry = restore({ updatedAt: RESTORED_AT - age })

    expect(registry.getDiagnostics()).toMatchObject({
      activeRunCount: active,
      provisionalRecoveredRunCount: provisional,
    })
    expect(registry.staleRunCount).toBe(stale)
  })

  it("restores recent state provisionally without persisting the runtime marker", () => {
    const registry = restore()
    const run = [...registry.runs.values()][0]

    expect(run?.recovery).toEqual({
      restoredAt: RESTORED_AT,
      confirmationDeadline: RESTORED_AT + RECOVERY_TTL_MS,
    })
    expect(JSON.stringify(registry.exportState())).not.toContain("recovery")
  })

  it("expires an unconfirmed recovered run exactly at its confirmation deadline", () => {
    const registry = restore()
    const emitted: unknown[] = []
    registry.subscribe((event) => emitted.push(event))

    expect(registry.cleanupStale(RESTORED_AT + RECOVERY_TTL_MS - 1)).toEqual([])
    expect(registry.getSnapshot()).toHaveLength(1)

    const expired = registry.cleanupStale(RESTORED_AT + RECOVERY_TTL_MS)
    expect(expired).toMatchObject([{ type: "run.cancelled", reason: "recovery-not-confirmed" }])
    expect(emitted).toEqual(expired)
    expect(registry.getSnapshot()).toEqual([])
    expect(registry.getDiagnostics()).toMatchObject({
      activeRunCount: 0,
      provisionalRecoveredRunCount: 0,
      warnings: ["Recovered Run expired without live confirmation (recovery-not-confirmed)"],
    })
    expect(registry.staleRunCount).toBe(1)
    expect(registry.cleanupStale(RESTORED_AT + RECOVERY_TTL_MS)).toEqual([])
  })

  it("uses a duplicate run.started as confirmation without emitting it twice", () => {
    const staleTtlMs = RECOVERY_TTL_MS + 1_000
    const registry = restore({ staleTtlMs })
    const emitted: unknown[] = []
    registry.subscribe((event) => emitted.push(event))

    expect(registry.apply({
      type: "run.started",
      sessionId: "recovered-session",
      turnId: "recovered-turn",
      backend: "HOOK_OBSERVER",
      observedAt: RESTORED_AT + 50,
    })).toBeNull()
    expect(emitted).toEqual([])
    expect([...registry.runs.values()][0]?.updatedAt).toBe(RESTORED_AT + 50)
    expect(registry.getDiagnostics().provisionalRecoveredRunCount).toBe(0)

    expect(registry.cleanupStale(RESTORED_AT + RECOVERY_TTL_MS)).toEqual([])
    expect(registry.cleanupStale(RESTORED_AT + 50 + staleTtlMs)).toMatchObject([
      { type: "run.cancelled", reason: "stale-adapter-state" },
    ])
  })

  it("uses task.started as live confirmation", () => {
    const registry = restore()

    expect(registry.apply({
      type: "task.started",
      sessionId: "recovered-session",
      turnId: "recovered-turn",
      taskId: "live-task",
      category: "command",
      label: "Bash",
      observedAt: RESTORED_AT + 90_000,
    })).toMatchObject({ type: "task.started" })
    expect(registry.getDiagnostics()).toMatchObject({
      activeRunCount: 1,
      activeTaskCount: 1,
      provisionalRecoveredRunCount: 0,
    })
  })

  it.each(["task.completed", "task.failed", "task.cancelled"] as const)(
    "uses an unknown %s as confirmation while keeping the run active",
    (type) => {
      const registry = restore()

      expect(registry.apply({
        type,
        sessionId: "recovered-session",
        turnId: "recovered-turn",
        taskId: "unknown-live-task",
        category: "command",
        label: "Bash",
        observedAt: RESTORED_AT + 10,
      })).toBeNull()
      expect(registry.getSnapshot()).toHaveLength(1)
      expect(registry.getDiagnostics().provisionalRecoveredRunCount).toBe(0)
    },
  )

  it("does not treat session.observed as run confirmation", () => {
    const registry = restore()

    expect(registry.apply({
      type: "session.observed",
      sessionId: "recovered-session",
      backend: "HOOK_OBSERVER",
      observedAt: RESTORED_AT + 10,
    })).toBeNull()
    expect(registry.getDiagnostics().provisionalRecoveredRunCount).toBe(1)
  })

  it("finishes a provisional run normally when a terminal run event arrives", () => {
    const registry = restore()

    expect(registry.apply({
      type: "run.completed",
      sessionId: "recovered-session",
      turnId: "recovered-turn",
      backend: "HOOK_OBSERVER",
      confidence: "hook-stop",
      observedAt: RESTORED_AT + 10,
    })).toMatchObject({ type: "run.completed" })
    expect(registry.getDiagnostics()).toMatchObject({
      activeRunCount: 0,
      provisionalRecoveredRunCount: 0,
    })
  })

  it("does not revive a run after recovery-not-confirmed cancellation", () => {
    const registry = restore()
    registry.cleanupStale(RESTORED_AT + RECOVERY_TTL_MS)

    expect(registry.apply({
      type: "run.started",
      sessionId: "recovered-session",
      turnId: "recovered-turn",
      backend: "HOOK_OBSERVER",
      observedAt: RESTORED_AT + RECOVERY_TTL_MS + 1,
    })).toBeNull()
    expect(registry.getSnapshot()).toEqual([])
  })

  it("rejects implausibly future persisted timestamps without exposing IDs", () => {
    const registry = restore({ updatedAt: RESTORED_AT + 5 * 60_000 + 1 })
    const diagnostics = registry.getDiagnostics()

    expect(diagnostics.activeRunCount).toBe(0)
    expect(diagnostics.warnings).toEqual(["Persisted Run timestamp is too far in the future"])
    expect(JSON.stringify(diagnostics)).not.toContain("recovered-session")
  })
})
