import type { ProtocolDomainEvent } from "../src/protocol/types"

type Harness = {
  run(code: string): Promise<any>
  publish(event: ProtocolDomainEvent): void
  waitFor(code: string, label: string): Promise<void>
  capture(name: string): Promise<void>
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Dialogue ownership smoke: ${label}`) }

/** Synthetic events through the real WebSocket/StateMachine/Dialogue/React path. */
export async function runDialogueOwnershipCases({ run, publish, waitFor, capture }: Harness) {
  const reset = (queue = false) => run(`(async () => {
    const manifest = await (await fetch('/characters/bell/dialogue.ko.json')).json();
    if (${queue}) { manifest.triggers['task.started.command'].mode = 'queue'; manifest.triggers['task.started.file-change'].mode = 'queue'; }
    window.__codexPetDebug.dialogue.configure({ manifest, warnings: [] }, 'bell');
  })()`)
  const state = () => run(`(() => {
    const c = window.__codexPetDebug.dialogue, d = c.getSnapshot();
    const semantic = window.__codexPetDebug.getSnapshot().semantic;
    const bubble = document.querySelector('.speech-bubble');
    const panel = document.querySelector('[data-testid="dialogue-debug-panel"]');
    const exported = JSON.stringify(c) + JSON.stringify(d.history) + (bubble?.outerHTML ?? '') + (panel?.outerHTML ?? '');
    return { state: semantic.state, activeCount: semantic.activeTaskIds.length,
      visible: d.visible, trigger: d.triggerId, text: d.text, shownAt: d.shownAt,
      decision: d.lastDecision, queueLength: d.queueLength,
      privateCorrelationLeaked: /owner|epoch|private-run|private-task/i.test(exported) };
  })()`)
  const shown = (trigger: string) => waitFor(`window.__codexPetDebug.dialogue.getSnapshot().triggerId === ${JSON.stringify(trigger)}`, "expected dialogue trigger")
  const painted = (trigger: string) => waitFor(`(() => { const b = document.querySelector('.speech-bubble'); return b?.dataset.trigger === ${JSON.stringify(trigger)} && getComputedStyle(b).opacity === '1'; })()`, "bubble painted")
  const results = []
  for (const outcome of ["failed", "cancelled", "completed"] as const) {
    await reset()
    const first = `private-run-${outcome}-first`, next = `private-run-${outcome}-next`
    publish({ type: "run.started", runId: first }); await shown("run.started")
    await wait(100)
    if (outcome === "failed") publish({ type: "run.failed", runId: first, code: "codex-turn-failed" })
    if (outcome === "cancelled") publish({ type: "run.cancelled", runId: first, reason: "user-interrupted" })
    if (outcome === "completed") publish({ type: "run.completed", runId: first, confidence: "authoritative" })
    await shown(outcome === "failed" ? "run.failed" : outcome === "cancelled" ? "run.cancelled.user" : "run.completed.authoritative")
    const previous = await state()
    await wait(100)
    publish({ type: "run.started", runId: next })
    await waitFor(`window.__codexPetDebug.getSnapshot().semantic.state === 'BUSY' && !document.querySelector('.speech-bubble')`, "old outcome removed on restart")
    const restarted = await state()
    assert(!restarted.visible && restarted.decision === "cooldown", "start cooldown still clears previous result")
    await wait(200)
    publish({ type: "run.completed", runId: next, confidence: "authoritative" })
    await painted("run.completed.authoritative")
    const completed = await state()
    assert(completed.state === "HAPPY" && completed.activeCount === 0 && completed.decision === "shown", "new final outcome shown")
    assert(completed.shownAt > previous.shownAt && completed.shownAt - previous.shownAt < 1200, "new result replaces old within outcome cooldown")
    for (const item of [previous, restarted, completed]) assert(!item.privateCorrelationLeaked, "private correlation absent")
    await capture(`${outcome}-then-completed.png`)
    results.push({ scenario: `${outcome}-then-start-and-complete`, previous, restarted, completed })
  }

  await reset(true)
  const first = "private-run-queue-first", next = "private-run-queue-next"
  publish({ type: "run.started", runId: first }); await shown("run.started")
  publish({ type: "run.started", runId: next })
  publish({ type: "task.started", runId: first, taskId: "private-task-first", kind: "command" })
  publish({ type: "task.started", runId: next, taskId: "private-task-next", kind: "file-change" })
  await waitFor(`window.__codexPetDebug.dialogue.getSnapshot().queueLength === 2`, "two owned queue entries")
  const queued = await state()
  publish({ type: "run.cancelled", runId: first, reason: "user-interrupted" })
  await waitFor(`window.__codexPetDebug.dialogue.getSnapshot().queueLength === 1`, "only cancelled owner's queue removed")
  const pruned = await state()
  assert(pruned.state === "BUSY" && pruned.activeCount === 1, "parallel run remains BUSY")
  await painted("task.started.file-change")
  const drained = await state()
  const extra = "private-run-parallel-extra"
  publish({ type: "run.started", runId: extra })
  await waitFor(`window.__codexPetDebug.getSnapshot().semantic.activeTaskIds.length === 2`, "parallel run started")
  publish({ type: "run.failed", runId: extra, code: "codex-turn-failed" })
  await waitFor(`window.__codexPetDebug.getSnapshot().semantic.activeTaskIds.length === 1`, "parallel failure processed")
  const preserved = await state()
  assert(preserved.state === "BUSY" && preserved.activeCount === 1 && preserved.shownAt === drained.shownAt && preserved.text === drained.text, "remaining owner's visible line preserved")
  for (const item of [queued, pruned, drained, preserved]) assert(!item.privateCorrelationLeaked, "queue owners absent from exports")
  await capture("parallel-owner-preserved.png")
  publish({ type: "run.cancelled", runId: next, reason: "recovery-not-confirmed" })
  await waitFor(`window.__codexPetDebug.getSnapshot().semantic.state === 'NORMAL' && !document.querySelector('.speech-bubble')`, "final internal cleanup silent")
  const final = await state()
  results.push({ scenario: "cancelled-owner-queue-and-parallel-owner-preservation", queued, pruned, drained, preserved, final })
  return { testData: true, passed: true, results }
}
