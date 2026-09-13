/**
 * PR #20 review regressions for HEAD 0a13349f46fc215cf202cfe8fd19f95ef61d2300.
 * Place this file at tests/pr20-recovery-regression.test.ts in the repository.
 * Run: npx vitest run tests/pr20-recovery-regression.test.ts
 * Both expectations describe the desired behavior and fail on the reviewed HEAD.
 * No real Codex process, account request, filesystem inventory, or UI is used.
 */
import { describe, expect, it } from "vitest"
import { CodexRunRegistry } from "../adapter/codex/CodexRunRegistry"
import { LiveActivityReconciler } from "../adapter/codex/lifecycle/LiveActivityReconciler"
import type { LiveActivitySnapshot, LiveSession } from "../adapter/codex/lifecycle/LiveActivity"
import { DesktopActivityObserver } from "../electron/main/activity/DesktopActivityObserver"

const sessionId = "11111111-1111-4111-8111-111111111111"
const oldTurnId = "22222222-2222-4222-8222-222222222222"
const newTurnId = "33333333-3333-4333-8333-333333333333"
const path = "/synthetic/sessions/rollout-test.jsonl"

describe("PR20: recovered observations must not supersede newer work", () => {
  it("does not forget a newer Hook-observed turn when an older desktop rollout result arrives", () => {
    let now = 1000
    const registry = new CodexRunRegistry({ now: () => now })
    const reconciler = new LiveActivityReconciler(registry, {
      now: () => now, snapshot: () => {}, target: () => {}, available: () => {},
    })
    registry.apply({ type: "run.started", sessionId, turnId: oldTurnId, backend: "HOOK_OBSERVER", observedAt: now })
    now = 2000
    registry.apply({ type: "run.completed", sessionId, turnId: oldTurnId, backend: "HOOK_OBSERVER", observedAt: now, confidence: "hook-stop" })
    now = 3000
    registry.apply({ type: "run.started", sessionId, turnId: newTurnId, backend: "HOOK_OBSERVER", observedAt: now })
    now = 4000
    reconciler.update({ desktopConnected: true, sessions: [{
      sessionId, turnId: oldTurnId, source: "desktop", path, status: "completed",
      waiting: false, waitingKnown: false, observedAt: 2000,
    }] })
    // Reviewed HEAD incorrectly publishes an empty registry here.
    expect([...registry.runs.values()].map(run => run.turnId)).toEqual([newTurnId])
  })

  it("does not let invalidated cached owner state hide a newer verified rollout turn", async () => {
    const snapshots: LiveActivitySnapshot[] = []
    const observer = new DesktopActivityObserver({
      home: "/synthetic", now: () => 4000, onSnapshot: value => snapshots.push(value),
    })
    // Deliberate white-box setup of state previously created by a T1-completed snapshot.
    // A separate integration test should establish it through the existing synthetic broker.
    const internal = observer as unknown as {
      desktopPresent: boolean
      openSessions: LiveSession[]
      followed: Map<string, {
        metadata: { id: string; path: string; title: string; cwd: string; updatedAt: number }
        owner: string; revision: number | null; state: Record<string, unknown> | null
        confirmed: LiveSession; followedAt: number; retryAt: number; retries: number
      }>
      broadcast(value: Record<string, unknown>): void
      publish(): void
    }
    internal.desktopPresent = true
    internal.followed.set(sessionId, {
      metadata: { id: sessionId, path, title: "Synthetic task", cwd: "/synthetic", updatedAt: 2 },
      owner: "owner", revision: 10, state: {}, followedAt: 2000, retryAt: 0, retries: 0,
      confirmed: { sessionId, turnId: oldTurnId, source: "desktop", path, status: "completed", waiting: false },
    })
    try {
      internal.broadcast({
        method: "thread-stream-state-changed", version: 11, sourceClientId: "owner",
        params: { hostId: "local", conversationId: sessionId,
          change: { type: "patches", baseRevision: 99, revision: 100, patches: [] } },
      })
      expect(internal.followed.get(sessionId)?.revision).toBeNull()
      internal.openSessions = [{
        sessionId, turnId: newTurnId, source: "desktop", path, status: "running",
        waiting: false, waitingKnown: false, observedAt: 3000,
      }]
      internal.publish()
      // Reviewed HEAD incorrectly publishes oldTurnId/completed instead.
      expect(snapshots.at(-1)?.sessions).toEqual([
        expect.objectContaining({ sessionId, turnId: newTurnId, status: "running" }),
      ])
    } finally { await observer.stop() }
  })
})
