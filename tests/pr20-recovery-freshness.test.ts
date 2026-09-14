import { afterEach, describe, expect, it, beforeAll, afterAll, vi } from "vitest"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { CodexRunRegistry } from "../adapter/codex/CodexRunRegistry"
import { LiveActivityReconciler } from "../adapter/codex/lifecycle/LiveActivityReconciler"
import { preferLiveSession, type LiveActivitySnapshot, type LiveSession } from "../adapter/codex/lifecycle/LiveActivity"
import { DesktopActivityObserver } from "../electron/main/activity/DesktopActivityObserver"
import { inspectOpenCodexRollout } from "../electron/main/activity/OpenCliSessions"
import { createDesktopControlFixture } from "../scripts/fixtures/desktop-control-fixture"

// Each Vitest worker uses only its test profile's private Windows pipe.
beforeAll(() => { if (process.platform === "win32") vi.stubEnv("ELECTRON_SMOKE_TEST", "1") })
afterAll(() => vi.unstubAllEnvs())


const sessionId = "11111111-1111-4111-8111-111111111111"
const oldTurnId = "22222222-2222-4222-8222-222222222222"
const newTurnId = "33333333-3333-4333-8333-333333333333"
const thirdTurnId = "44444444-4444-4444-8444-444444444444"
const path = "/synthetic/sessions/rollout-test.jsonl"
const rollout = (turnId: string, observedAt: number, status: LiveSession["status"] = "running"): LiveSession => ({ sessionId, turnId, path, source: "desktop", status, waiting: false, waitingKnown: false, observedAt, observation: { kind: "rollout", readStartedAt: 9000 } })
const owner = (turnId: string, observedAt: number, valid = true): LiveSession => ({ sessionId, turnId, path, source: "desktop", status: "running", waiting: false, observedAt, observation: { kind: "owner", ownerId: "owner", epoch: 1, revision: 1, valid } })
const hook = (registry: CodexRunRegistry, turnId: string, at: number, type: "run.started" | "run.completed" = "run.started", id = sessionId) => {
  const identity = { sessionId: id, turnId, observedAt: at, backend: "HOOK_OBSERVER" as const }
  return registry.apply(type === "run.started" ? { ...identity, type } : { ...identity, type, confidence: "hook-stop" })
}
function unit() {
  let now = 1000, snapshots = 0
  const registry = new CodexRunRegistry({ now: () => now })
  const live = new LiveActivityReconciler(registry, { now: () => now, snapshot: () => snapshots++, target: () => {}, available: () => {} })
  return { registry, live, clock: (at: number) => { now = at }, snapshots: () => snapshots }
}

describe("recovery observation ordering", () => {
  it.each(["desktop", "cli"] as const)("does not apply an old %s running observation over a newer Hook turn", source => {
    const f = unit(); hook(f.registry, newTurnId, 3000); f.clock(9000)
    f.live.update({ desktopConnected: true, sessions: [{ ...rollout(oldTurnId, 2000), source }] })
    expect([...f.registry.runs.values()].map(run => [run.turnId, run.updatedAt])).toEqual([[newTurnId, 3000]])
    expect(f.snapshots()).toBe(0)
  })

  it("keeps the latest Hook watermark after completion so an older unseen turn cannot reappear", () => {
    const f = unit(); hook(f.registry, newTurnId, 3000); hook(f.registry, newTurnId, 4000, "run.completed")
    f.live.update({ desktopConnected: true, sessions: [rollout(oldTurnId, 2000)] })
    expect(f.registry.runs.size).toBe(0)
  })

  it.each([undefined, NaN, Infinity, -1])("treats an observation time of %s conservatively", observedAt => {
    const f = unit(); hook(f.registry, newTurnId, 3000)
    f.live.update({ desktopConnected: true, sessions: [{ ...owner(oldTurnId, 9000), observedAt }] })
    expect([...f.registry.runs.values()].map(run => run.turnId)).toEqual([newTurnId])
  })

  it("does not use an invalidated owner cache to apply a new run or remove a newer Hook", () => {
    const f = unit(); hook(f.registry, newTurnId, 3000)
    f.live.update({ desktopConnected: true, sessions: [owner(oldTurnId, 9000, false)] })
    expect([...f.registry.runs.values()].map(run => run.turnId)).toEqual([newTurnId])
  })

  it("does not reclassify a newer CLI turn using an older desktop fallback", () => {
    const f = unit(); hook(f.registry, newTurnId, 3000)
    f.live.target({ sessionId, turnId: newTurnId, path, source: "cli" })
    f.live.update({ desktopConnected: true, sessions: [rollout(oldTurnId, 2000, "completed")] })
    f.live.update({ desktopConnected: false, sessions: [] })
    expect([...f.registry.runs.values()].map(run => run.turnId)).toEqual([newTurnId])
  })

  it.each(["approval", "user-input"] as const)("preserves a known %s wait against unknown and older observations", reason => {
    const f = unit(); hook(f.registry, newTurnId, 1000)
    f.registry.apply({ type: "run.waiting", sessionId, turnId: newTurnId, requestId: "pending", reason, backend: "HOOK_OBSERVER", observedAt: 2000 })
    f.registry.apply({ type: "task.started", sessionId, turnId: newTurnId, taskId: "late-tool", category: "command", label: "Command", observedAt: 1500 })
    expect([...f.registry.runs.values()][0].updatedAt).toBe(2000)
    f.live.update({ desktopConnected: true, sessions: [owner(newTurnId, 1500)] })
    expect(f.registry.getSnapshot()[0].waitingFor).toBe(reason)
    f.live.update({ desktopConnected: true, sessions: [rollout(newTurnId, 3000)] })
    expect(f.registry.getSnapshot()[0].waitingFor).toBe(reason)
    f.live.update({ desktopConnected: true, sessions: [owner(newTurnId, 4000)] })
    expect(f.registry.getSnapshot()[0].waitingFor).toBeUndefined()
  })

  it("does not refresh a run's evidence time when the same fallback is republished", () => {
    const f = unit(), session = rollout(newTurnId, 1000)
    f.live.update({ desktopConnected: true, sessions: [session] })
    f.clock(9000); f.live.update({ desktopConnected: true, sessions: [session] })
    expect([...f.registry.runs.values()][0]).toMatchObject({ startedAt: 1000, updatedAt: 1000 })
  })

  it("limits a delayed disappearance to the observed turn and the inventory's original time", () => {
    const f = unit(), session = { ...rollout(oldTurnId, 1000), source: "cli" as const }
    f.live.update({ desktopConnected: true, sessions: [session], inventoryAt: 1000 })
    f.registry.apply({ type: "task.started", sessionId, turnId: oldTurnId, taskId: "fresh", category: "command", label: "Command", observedAt: 3000 })
    f.clock(9000); f.live.update({ desktopConnected: true, sessions: [], inventoryAt: 2000 })
    expect(f.registry.runs.size).toBe(1)
    f.live.update({ desktopConnected: true, sessions: [], inventoryAt: 4000 })
    expect(f.registry.runs.size).toBe(0)
    f.live.update({ desktopConnected: true, sessions: [session], inventoryAt: 5000 })
    hook(f.registry, newTurnId, 6000)
    f.live.update({ desktopConnected: true, sessions: [], inventoryAt: 7000 })
    expect([...f.registry.runs.values()].map(run => run.turnId)).toEqual([newTurnId])
  })

  it("selects by evidence freshness in both directions, with valid owner detail winning ties", () => {
    const cached = { ...owner(oldTurnId, 2000, false), status: "completed" as const }
    expect(preferLiveSession(cached, rollout(newTurnId, 3000)).turnId).toBe(newTurnId)
    expect(preferLiveSession(rollout(newTurnId, 3000), owner(thirdTurnId, 4000)).turnId).toBe(thirdTurnId)
    expect(preferLiveSession(rollout(oldTurnId, 1000), cached)).toBe(cached)
    expect(preferLiveSession(rollout(newTurnId, 3000), owner(newTurnId, 3000)).observation?.kind).toBe("owner")
  })
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000
  while (!check()) { if (Date.now() > deadline) throw Error("Synthetic recovery timed out"); await new Promise(resolve => setTimeout(resolve, 5)) }
}
async function integration() {
  const desktop = await createDesktopControlFixture({ fragmented: true }); cleanups.push(() => desktop.close())
  const id = desktop.ids[0], first = desktop.turns[0], state = desktop.states.get(id)
  state.turns[0].status = "completed"; state.threadRuntimeStatus = { type: "idle" }
  const file = join(desktop.home, "sessions", `rollout-desktop-${id}.jsonl`)
  let now = 1000, read = async (): Promise<LiveSession[]> => { const value = await inspectOpenCodexRollout(desktop.home, file); return value ? [value] : [] }
  const snapshots: LiveActivitySnapshot[] = [], registry = new CodexRunRegistry({ now: () => now })
  const live = new LiveActivityReconciler(registry, { now: () => now, snapshot: () => {}, target: () => {}, available: () => {} })
  const observer = new DesktopActivityObserver({ home: desktop.home, now: () => now, cli: () => read(), onSnapshot: value => { snapshots.push(value); live.update(value) } })
  cleanups.push(() => observer.stop()); await observer.poll()
  await until(() => snapshots.at(-1)?.sessions.some(value => value.sessionId === id && value.turnId === first && value.status === "completed") ?? false)
  const entry = () => snapshots.at(-1)?.sessions.find(value => value.sessionId === id)
  const send = (change: unknown, sourceClientId = desktop.owner) => desktop.sendToClients({ type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId, params: { hostId: "local", conversationId: id, change } })
  return { desktop, registry, observer, snapshots, id, first, file, state, entry, send, clock: (at: number) => { now = at }, setRead: (next: typeof read) => { read = next } }
}

describe("synthetic broker recovery freshness", () => {
  it("does not re-date an unchanged completed owner state after metadata patches or repeated snapshots", async () => {
    const f = await integration(), original = f.entry()!
    f.clock(3000); hook(f.registry, newTurnId, 3000, "run.started", f.id)
    f.clock(4000); f.send({ type: "patches", revision: 2, baseRevision: 1, patches: [{ op: "replace", path: ["title"], value: "Renamed synthetic task" }] })
    await until(() => f.entry()?.observation?.kind === "owner" && (f.entry()!.observation as { revision: number }).revision === 2)
    expect(f.entry()?.observedAt).toBe(original.observedAt)
    expect(f.entry()?.observation).toMatchObject({ validatedAt: 4000 })
    f.clock(5000); f.send({ type: "snapshot", revision: 3, conversationState: f.state })
    await until(() => f.entry()?.observation?.kind === "owner" && (f.entry()!.observation as { revision: number }).revision === 3)
    expect(f.entry()?.observedAt).toBe(original.observedAt)
    expect([...f.registry.runs.values()].map(run => run.turnId)).toEqual([newTurnId])
  })

  it("recovers T2 after a gap, accepts a newer owner epoch, and rejects old-owner and old-revision snapshots", async () => {
    const f = await integration(), initial = f.entry()!
    f.desktop.withholdSnapshots(f.id, true); f.clock(2000)
    f.send({ type: "patches", revision: 10, baseRevision: 9, patches: [] })
    await until(() => f.entry()?.observation?.kind === "owner" && !(f.entry()!.observation as { valid: boolean }).valid)
    const event = JSON.stringify({ timestamp: new Date(3000).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: newTurnId } }) + "\n"
    await appendFile(f.file, event); f.clock(4000); await f.observer.poll()
    expect(f.entry()).toMatchObject({ turnId: newTurnId, observedAt: 3000, observation: { kind: "rollout" } })
    expect([...f.registry.runs.values()].map(run => run.turnId)).toEqual([newTurnId])
    f.clock(8000); await f.observer.poll()
    expect([...f.registry.runs.values()][0].updatedAt).toBe(3000)
    f.send({ type: "snapshot", revision: 2, conversationState: f.state })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.entry()?.turnId).toBe(newTurnId)

    f.clock(20000); const oldOwner = f.desktop.changeOwner()
    f.state.turns = [{ turnId: thirdTurnId, status: "inProgress" }]; f.state.threadRuntimeStatus = { type: "active", activeFlags: [] }
    f.desktop.withholdSnapshots(f.id, false)
    await new Promise(resolve => setTimeout(resolve, 15)); await f.observer.poll()
    await until(() => f.entry()?.turnId === thirdTurnId)
    expect(f.entry()).toMatchObject({ observedAt: 20000, observation: { kind: "owner", ownerId: f.desktop.owner, valid: true } })
    const evidence = f.entry()!.observation
    expect(evidence?.kind === "owner" && initial.observation?.kind === "owner" && evidence.epoch > initial.observation.epoch).toBe(true)
    const revision = evidence?.kind === "owner" ? evidence.revision : -1
    f.clock(25000)
    f.send({ type: "snapshot", revision: 999, conversationState: { ...f.state, turns: [{ turnId: newTurnId, status: "inProgress" }] } }, oldOwner)
    f.send({ type: "snapshot", revision, conversationState: { ...f.state, turns: [{ turnId: thirdTurnId, status: "completed" }], threadRuntimeStatus: { type: "idle" } } })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.entry()).toMatchObject({ turnId: thirdTurnId, status: "running", observedAt: 20000 })
    expect([...f.registry.runs.values()].map(run => run.turnId)).toEqual([thirdTurnId])
  })

  it("does not timestamp a delayed filesystem read as new evidence after a Hook has started T2", async () => {
    const f = await integration(); f.desktop.withholdSnapshots(f.id, true)
    let finish!: (values: LiveSession[]) => void, entered = false
    f.setRead(() => { entered = true; return new Promise(resolve => { finish = resolve }) })
    f.clock(4000); const reading = f.observer.poll(); await until(() => entered)
    f.clock(5000); hook(f.registry, newTurnId, 5000, "run.started", f.id)
    f.clock(6000); finish([{ ...rollout(f.first, 2000, "completed"), sessionId: f.id, path: f.file }]); await reading
    expect(f.snapshots.at(-1)?.inventoryAt).toBe(4000)
    expect(f.entry()?.observedAt).toBe(2000)
    expect([...f.registry.runs.values()].map(run => [run.turnId, run.startedAt, run.updatedAt])).toEqual([[newTurnId, 5000, 5000]])
  })
})
