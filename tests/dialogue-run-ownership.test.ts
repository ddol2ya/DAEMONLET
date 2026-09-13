import { readFileSync } from "node:fs"
import { createElement, createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import { createDefaultBehaviorProfile } from "../src/behavior/BehaviorManifest"
import type { CharacterTaskEvent } from "../src/behavior/types"
import { CharacterDialogueController } from "../src/dialogue/CharacterDialogueController"
import { parseDialogueManifest } from "../src/dialogue/DialogueManifest"
import type { DialogueManifest } from "../src/dialogue/types"
import { taskEventLifecycle } from "../src/lifecycle/CharacterLifecycleEvent"
import { SpeechBubbleOverlay } from "../src/pet/SpeechBubbleOverlay"

const bell = JSON.parse(readFileSync(new URL("./fixtures/profiles/finite/dialogue.ko.json", import.meta.url), "utf8"))
const controllers: CharacterDialogueController[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.restoreAllMocks(); vi.useRealTimers() })

function setup(change?: (manifest: DialogueManifest) => void) {
  const manifest = parseDialogueManifest(bell)
  change?.(manifest)
  const clock = { now: () => Date.now() }
  const machine = new CharacterStateMachine(createDefaultBehaviorProfile().timing, clock)
  const c = new CharacterDialogueController({ clock, random: () => 0 })
  c.configure({ manifest, warnings: [] }, "bell")
  controllers.push(c)
  const dispatch = (event: CharacterTaskEvent) => {
    const semantic = machine.dispatch({ ...event, at: clock.now() })
    const lifecycle = taskEventLifecycle(event, clock.now())
    if (lifecycle) c.handleLifecycle(lifecycle, semantic)
  }
  return {
    c, machine, dispatch,
    at: (time: number) => { vi.advanceTimersByTime(time - Date.now()); machine.tick() },
    start: (runId: string) => dispatch({ type: "TASK_STARTED", taskId: runId }),
    end: (runId: string, type: "failed" | "cancelled" | "completed", reason = "user-interrupted") => {
      if (type === "failed") dispatch({ type: "TASK_FAILED", taskId: runId, code: "codex-turn-failed" })
      if (type === "cancelled") dispatch({ type: "TASK_CANCELLED", taskId: runId, reason })
      if (type === "completed") dispatch({ type: "TASK_COMPLETED", taskId: runId, confidence: "authoritative" })
    },
    task: (runId: string, taskId: string, kind: "command" | "file-change" = "command", type: "task.started" | "task.completed" | "task.failed" | "task.cancelled" = "task.started") => {
      c.handleLifecycle({ type, runId, taskId, kind, at: clock.now() }, machine.getSnapshot())
    },
  }
}

const outcomes = [
  ["failed", "run.failed"],
  ["cancelled", "run.cancelled.user"],
  ["completed", "run.completed.authoritative"],
] as const

describe("PR #9 attached reproduction scenarios", () => {
  it.each(outcomes)("A_%s_then_B_starts_and_completes", (outcome, trigger) => {
    const t = setup()
    t.start("A")
    t.at(100); t.end("A", outcome)
    expect(t.c.getSnapshot().triggerId).toBe(trigger)
    t.at(200); t.start("B")
    expect(t.machine.getSnapshot().state).toBe("BUSY")
    // A's result must disappear even though Bell's 10-second start cooldown applies.
    expect.soft(t.c.getSnapshot()).toMatchObject({ visible: false, text: null, lastDecision: "cooldown" })
    t.at(1500); t.end("B", "completed")
    expect(t.machine.getSnapshot().state).toBe("HAPPY")
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: "run.completed.authoritative", shownAt: 1500, lastDecision: "shown" })
  })

  it("custom_queue_for_cancelled_A_drains_while_B_active: discards A's entry", () => {
    const t = setup(m => { m.triggers["task.started.command"]!.mode = "queue" })
    t.start("A")
    t.at(100); t.start("B")
    t.at(200); t.task("A", "command-A")
    expect(t.c.getSnapshot().queueLength).toBe(1)
    t.at(300); t.end("A", "cancelled")
    expect(t.machine.getSnapshot()).toMatchObject({ state: "BUSY", activeTaskIds: ["B"] })
    expect.soft(t.c.getSnapshot().queueLength).toBe(0)
    t.at(3060)
    expect(t.c.getSnapshot()).toMatchObject({ visible: false, queueLength: 0 })
    expect(t.c.getSnapshot().history.filter(entry => entry.triggerId === "task.started.command" && entry.decision === "shown")).toEqual([])
  })

  it("same_kind_20_seconds_later: retains the existing consecutive-kind suppression", () => {
    const t = setup()
    t.start("A")
    t.at(4000); t.task("A", "first")
    expect(t.c.getSnapshot().triggerId).toBe("task.started.command")
    t.at(24000); t.task("A", "second")
    expect(t.c.getSnapshot()).toMatchObject({ visible: false, lastDecision: "duplicate" })
  })
})

describe("Run ownership and work-period lifetime", () => {
  it.each(outcomes)("does not reuse the previous work period's %s outcome cooldown", (outcome, trigger) => {
    const t = setup()
    t.start("A"); t.at(100); t.end("A", outcome)
    t.at(200); t.start("B"); t.at(400); t.end("B", outcome)
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: trigger, shownAt: 400, lastDecision: "shown" })
  })

  it.each(["completed", "failed", "cancelled"] as const)("removes only a finished Run's visible line on %s", outcome => {
    const t = setup()
    t.start("A"); t.at(100); t.start("B")
    t.at(4000); t.task("A", "a")
    expect(t.c.getSnapshot().triggerId).toBe("task.started.command")
    t.at(4100); t.end("A", outcome)
    expect(t.machine.getSnapshot()).toMatchObject({ state: "BUSY", activeTaskIds: ["B"] })
    expect(t.c.getSnapshot()).toMatchObject({ visible: false, queueLength: 0 })
  })

  it.each(["completed", "failed", "cancelled"] as const)("preserves B's visible line when concurrent A is %s", outcome => {
    const t = setup()
    t.start("A"); t.at(100); t.start("B")
    t.at(4000); t.task("B", "b")
    const shown = t.c.getSnapshot()
    t.at(4100); t.end("A", outcome)
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: shown.triggerId, shownAt: shown.shownAt, hideAt: shown.hideAt, text: shown.text })
  })

  it("removes A's queue while retaining B's queue and its valid next line", () => {
    const t = setup(m => {
      m.triggers["task.started.command"]!.mode = "queue"
      m.triggers["task.started.file-change"]!.mode = "queue"
    })
    t.start("A"); t.at(100); t.start("B")
    t.at(200); t.task("A", "a"); t.task("B", "b", "file-change")
    expect(t.c.getSnapshot().queueLength).toBe(2)
    t.at(300); t.end("A", "cancelled", "recovery-not-confirmed")
    expect(t.c.getSnapshot().queueLength).toBe(1)
    t.at(3060)
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: "task.started.file-change", lastDecision: "shown", queueLength: 0 })
  })

  it.each(["task.completed", "task.failed", "task.cancelled"] as const)("does not dequeue a Task after %s", type => {
    const t = setup(m => { m.triggers["task.started.command"]!.mode = "queue" })
    t.start("A"); t.at(100); t.task("A", "a")
    t.at(200); t.task("A", "a", "command", type)
    t.at(3060)
    expect(t.c.getSnapshot()).toMatchObject({ visible: false, queueLength: 0 })
    expect(t.machine.getSnapshot().state).toBe("BUSY")
  })

  it("does not let an already queued old timer callback expire the new work period", () => {
    const scheduled = vi.spyOn(globalThis, "setTimeout")
    const t = setup()
    t.start("A"); t.at(100); t.end("A", "failed")
    const staleCallback = scheduled.mock.calls.at(-1)![0] as () => void
    t.at(200); t.start("B"); t.at(400); t.end("B", "completed")
    const shown = t.c.getSnapshot()
    staleCallback()
    vi.advanceTimersByTime(160)
    expect(t.c.getSnapshot()).toMatchObject({ visible: true, phase: "shown", triggerId: shown.triggerId, shownAt: shown.shownAt })
  })

  it("ignores stale internal cancellation without clearing a newer outcome", () => {
    const t = setup()
    t.start("A"); t.at(100); t.end("A", "failed")
    t.at(200); t.start("B"); t.at(400); t.end("B", "completed")
    t.at(500); t.end("A", "cancelled", "recovery-not-confirmed")
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: "run.completed.authoritative", shownAt: 400, lastDecision: "shown" })
  })

  it("keeps interaction priority and cooldown across work periods", () => {
    const t = setup()
    t.c.triggerDebug("interaction.pet")
    const interaction = t.c.getSnapshot()
    t.start("A")
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: "interaction.pet", shownAt: interaction.shownAt, lastDecision: "lower-priority" })
    t.at(100); t.end("A", "cancelled", "recovery-not-confirmed")
    expect(t.c.getSnapshot().triggerId).toBe("interaction.pet")
    t.at(200); t.start("B"); t.c.clear(); t.c.triggerDebug("interaction.pet")
    expect(t.c.getSnapshot()).toMatchObject({ visible: false, lastDecision: "cooldown" })
  })

  it("preserves equal-kind queue entries from a different Run", () => {
    const t = setup(m => { m.triggers["task.started.command"]!.mode = "queue" })
    t.start("A"); t.at(100); t.start("B")
    t.at(200); t.task("A", "a"); t.task("B", "b")
    expect(t.c.getSnapshot().queueLength).toBe(2)
    t.at(300); t.end("A", "completed")
    expect(t.c.getSnapshot().queueLength).toBe(1)
    t.at(3060)
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: "task.started.command", shownAt: 3060 })
  })

  it("clears a queued result from an older work period even with terminal queue mode", () => {
    const t = setup(m => {
      m.triggers["run.failed"]!.mode = "queue"
      m.triggers["interaction.pet"]!.displayMs = 6000
    })
    t.start("A"); t.c.triggerDebug("interaction.pet")
    t.at(100); t.end("A", "failed")
    expect(t.c.getSnapshot().queueLength).toBe(1)
    t.at(200); t.start("B")
    expect(t.c.getSnapshot()).toMatchObject({ queueLength: 0, triggerId: "interaction.pet" })
    t.at(1500); t.end("B", "completed")
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: "run.completed.authoritative", shownAt: 1500 })
  })

  it.each(["snapshot", "hidden", "disabled", "configure"])("keeps %s clear and prevents its old callbacks from replaying", action => {
    const scheduled = vi.spyOn(globalThis, "setTimeout")
    const t = setup(m => { m.triggers["task.started.command"]!.mode = "queue" })
    t.start("A"); t.at(100); t.task("A", "a")
    const oldCallbacks = scheduled.mock.calls.map(([fn]) => fn as () => void)
    if (action === "snapshot") t.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "B" }] })
    if (action === "hidden") { t.c.setAvailable(false); t.c.setAvailable(true) }
    if (action === "disabled") { t.c.setEnabled(false); t.c.setEnabled(true) }
    if (action === "configure") t.c.configure({ manifest: parseDialogueManifest(bell), warnings: [] }, "momo")
    oldCallbacks.forEach(fn => fn())
    t.at(5000)
    expect(t.c.getSnapshot()).toMatchObject({ visible: false, queueLength: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not borrow a pre-snapshot outcome cooldown for the recovered work period", () => {
    const t = setup()
    t.start("A"); t.at(100); t.end("A", "completed")
    t.at(200); t.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "B" }] })
    t.at(400); t.end("B", "completed")
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: "run.completed.authoritative", shownAt: 400, lastDecision: "shown" })
  })

  it("uses the semantic first-run boundary after a behavior-only source reset", () => {
    const t = setup()
    t.start("A")
    t.machine.reset()
    t.c.clear()
    t.c.triggerDebug("run.failed")
    t.at(200); t.start("B")
    expect(t.c.getSnapshot()).toMatchObject({ visible: false, lastDecision: "cooldown" })
    t.at(400); t.end("B", "completed")
    expect(t.c.getSnapshot()).toMatchObject({ triggerId: "run.completed.authoritative", shownAt: 400, lastDecision: "shown" })
  })

  it("rejects repeated terminal events instead of creating a fresh outcome after cooldown", () => {
    const t = setup()
    t.start("A"); t.at(100); t.end("A", "completed")
    const outcome = t.c.getSnapshot()
    t.at(1500); t.end("A", "completed")
    expect(t.c.getSnapshot()).toMatchObject({ shownAt: outcome.shownAt, hideAt: outcome.hideAt, text: outcome.text })
    expect(t.c.getSnapshot().history.filter(entry => entry.triggerId === "run.completed.authoritative" && entry.decision === "shown")).toHaveLength(1)
  })

  it("exports only public diagnostics, never internal owner/epoch or Run/Task IDs", () => {
    const t = setup(m => { m.triggers["task.started.command"]!.mode = "queue" })
    const runId = "PRIVATE_OWNER_RUN", taskId = "PRIVATE_OWNER_TASK"
    const leaks: string[] = []
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")]
    const off = t.c.subscribe(() => {
      const snapshot = t.c.getSnapshot()
      const dom = renderToStaticMarkup(createElement(SpeechBubbleOverlay, { snapshot, runtime: {} as never, canvasRef: createRef<HTMLCanvasElement>() }))
      const exports = [dom, JSON.stringify(snapshot.history), JSON.stringify(snapshot), JSON.stringify(t.c)]
      for (const value of exports) if (/PRIVATE_OWNER|owner|epoch|taskId|runId/i.test(value)) leaks.push(value)
    })
    t.start(runId); t.at(100); t.task(runId, taskId)
    expect(t.c.getSnapshot().queueLength).toBe(1)
    t.at(200); t.end(runId, "failed")
    t.at(300); t.start("PRIVATE_OWNER_NEXT"); t.at(400); t.end("PRIVATE_OWNER_NEXT", "completed")
    expect(leaks).toEqual([])
    for (const log of logs) expect(log).not.toHaveBeenCalled()
    off()
  })
})
