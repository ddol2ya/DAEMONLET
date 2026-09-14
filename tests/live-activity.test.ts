import { afterEach, describe, expect, it, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { appendFile, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DesktopActivityObserver } from "../electron/main/activity/DesktopActivityObserver"
import { DesktopIpcClient } from "../electron/main/control/DesktopIpcClient"
import { cliRolloutPaths, inspectOpenCliRollout, inspectOpenCodexRollout } from "../electron/main/activity/OpenCliSessions"
import { createDesktopControlFixture } from "../scripts/fixtures/desktop-control-fixture"
import { CodexRunRegistry } from "../adapter/codex/CodexRunRegistry"
import { LiveActivityReconciler } from "../adapter/codex/lifecycle/LiveActivityReconciler"
import type { LiveSession, LiveActivitySnapshot } from "../adapter/codex/lifecycle/LiveActivity"

// Each Vitest worker uses only its test profile's private Windows pipe.
beforeAll(() => { if (process.platform === "win32") vi.stubEnv("ELECTRON_SMOKE_TEST", "1") })
afterAll(() => vi.unstubAllEnvs())


const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function until(check: () => boolean) {
  const end = Date.now() + 4000
  while (!check()) { if (Date.now() > end) throw new Error("Live activity timed out"); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function fixture(omitSecond = false) {
  const desktop = await createDesktopControlFixture({ fragmented: true }); cleanups.push(() => desktop.close())
  if (omitSecond) desktop.owned.delete(desktop.ids[1])
  const registry = new CodexRunRegistry(), events: string[] = [], available: boolean[] = [], snapshots: LiveActivitySnapshot[] = []
  let snapshotCount = 0, now = Date.now(), canConnect = true, cli: LiveSession[] = []
  registry.subscribe(event => events.push(event.type))
  const reconciler = new LiveActivityReconciler(registry, { now: () => now, snapshot: () => snapshotCount++, target: () => {}, available: value => available.push(value) })
  const observer = new DesktopActivityObserver({ home: desktop.home, now: () => now, cli: async () => cli,
    connect: closed => canConnect ? DesktopIpcClient.connect(closed, desktop.home) : Promise.reject(new Error("Desktop exited")),
    onSnapshot: value => { snapshots.push(value); reconciler.update(value) } })
  cleanups.push(() => observer.stop())
  await observer.poll(); await until(() => registry.runs.size === 1)
  return { desktop, registry, events, available, observer, snapshots, reconciler, snapshotCount: () => snapshotCount,
    setCli(value: LiveSession[]) { cli = value }, setConnected(value: boolean) { canConnect = value },
    async poll() { now += 16_000; await observer.poll() } }
}

describe("live desktop and CLI activity", () => {
  it("recovers a second process-proven desktop task without a full snapshot, deduplicates, and respects desktop exit", async () => {
    const f = await fixture(true)
    const sessions: LiveSession[] = f.desktop.ids.map((id, i) => ({ sessionId: id, turnId: f.desktop.turns[i], source: "desktop", path: `${f.desktop.home}/sessions/rollout-desktop-${id}.jsonl`, status: "running", waiting: false, waitingKnown: false, observedAt: Date.now(), observation: { kind: "rollout", readStartedAt: Date.now() } }))
    f.setCli(sessions); await f.poll()
    expect(f.registry.runs.size).toBe(2)
    expect(f.snapshots.at(-1)?.sessions.filter(session => session.status === "running")).toHaveLength(2)
    f.setCli(sessions.slice(0, 1)); await f.poll()
    expect(f.registry.runs.size).toBe(1)
    f.setCli(sessions); await f.poll(); expect(f.registry.runs.size).toBe(2)
    f.setConnected(false); await f.desktop.pauseBroker()
    await until(() => f.available.at(-1) === false)
    expect(f.registry.runs.size).toBe(0)
    expect(f.events).not.toContain("run.completed")
  })

  it("backs off missing snapshots even while the owner continues to send patches", async () => {
    let now = 10000, receive!: (message: any) => void, follows = 0
    const id = randomUUID(), observer = new DesktopActivityObserver({ home: "/unused", now: () => now, cli: async () => [], onSnapshot: () => {}, catalog: async () => [{ id, title: "large", cwd: "/fixture", path: "/fixture", updatedAt: 1 }], connect: async () => ({ request: async () => ({ handledByClientId: "owner", result: { supportsUntrustedAppInput: true } }), follow: () => { follows++ }, onBroadcast: listener => { receive = listener; return () => {} }, close: () => {} }) })
    cleanups.push(() => observer.stop()); await observer.poll()
    for (let i = 0; i < 50; i++) { now += 1000; receive({ method: "thread-stream-state-changed", version: 11, sourceClientId: "owner", params: { hostId: "local", conversationId: id, change: { type: "patches", revision: i + 2, baseRevision: i + 1, patches: [] } } }); await observer.poll() }
    expect(follows).toBeGreaterThan(1)
    expect(follows).toBeLessThanOrEqual(6)
  })
  it("recovers work already running at startup using only passive follower operations", async () => {
    const f = await fixture()
    expect([...f.registry.runs.values()][0]).toMatchObject({ sessionId: f.desktop.ids[0], turnId: f.desktop.turns[0] })
    expect(f.available.at(-1)).toBe(true)
    expect(f.events).toEqual(["run.started"])
    expect(f.desktop.calls.every(call => ["initialize", "thread-owner-discovery"].includes(call.method))).toBe(true)
    expect(JSON.stringify(f.snapshots)).not.toMatch(/PRIVATE_|items|input|title|cwd/)
  })

  it("keeps activity during window changes, partial state and network retries; reports the final failure once", async () => {
    const f = await fixture(), id = f.desktop.ids[0]
    f.desktop.sendToClients({type:"broadcast",method:"window-minimized",params:{}})
    f.desktop.sendToClients({type:"broadcast",method:"client-status-changed",version:0,sourceClientId:f.desktop.owner,params:{clientId:f.desktop.owner,status:"disconnected"}})
    const state = f.desktop.states.get(id)
    for (let attempt = 1; attempt <= 5; attempt++) {
      state.threadRuntimeStatus = { type: "unknown" }
      state.retryText = `Reconnecting... ${attempt}/5`
      f.desktop.broadcastState(id)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(f.registry.runs.size).toBe(1); expect(f.available.at(-1)).toBe(true)
    expect(f.events).toEqual(["run.started"])
    await f.poll() // Rediscover the owner after the simulated window-owner loss.
    state.threadRuntimeStatus = { type: "idle" }; state.turns[0].status = "failed"
    f.desktop.broadcastState(id)
    await until(() => f.registry.runs.size === 0)
    f.desktop.broadcastState(id)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(f.events).toEqual(["run.started", "run.failed"])
  })

  it("marks full exit disconnected without a fake outcome and restores the same still-live turn on reopen", async () => {
    const f = await fixture()
    f.setConnected(false); f.desktop.dropConnections()
    await until(() => f.available.at(-1) === false)
    expect(f.registry.runs.size).toBe(0)
    expect(f.events).toEqual(["run.started"])
    expect(f.snapshotCount()).toBe(1)
    f.setConnected(true); await f.poll(); await until(() => f.registry.runs.size === 1)
    expect([...f.registry.runs.values()][0].turnId).toBe(f.desktop.turns[0])
    expect(f.available.at(-1)).toBe(true)
  })

  it("keeps an active CLI ahead of desktop exit, then disconnects when its process disappears", async () => {
    const f = await fixture()
    const cli: LiveSession = {sessionId:randomUUID(),turnId:randomUUID(),source:"cli",path:"/private/cli.jsonl",status:"running",waiting:false,observedAt:Date.now(),observation:{kind:"rollout",readStartedAt:Date.now()}}
    f.setCli([cli]); await f.poll()
    expect(f.registry.runs.size).toBe(2)
    f.setConnected(false); f.desktop.dropConnections()
    await until(() => f.snapshots.at(-1)?.desktopConnected === false)
    expect([...f.registry.runs.values()].map(run => run.sessionId)).toEqual([cli.sessionId])
    expect(f.available.at(-1)).toBe(true)
    f.setCli([]); await f.poll()
    expect(f.registry.runs.size).toBe(0); expect(f.available.at(-1)).toBe(false)
    expect(f.events.every(event => event === "run.started")).toBe(true)
  })

  it("ignores a forged sender and preserves confirmed work across a revision gap", async () => {
    const f = await fixture(), id = f.desktop.ids[0]
    const change = { type:"snapshot",revision:100,conversationState:{id,threadRuntimeStatus:{type:"idle"},turns:[]} }
    f.desktop.sendToClients({type:"broadcast",method:"thread-stream-state-changed",version:11,sourceClientId:randomUUID(),params:{hostId:"local",conversationId:id,change}})
    f.desktop.sendToClients({type:"broadcast",method:"thread-stream-state-changed",version:11,sourceClientId:f.desktop.owner,params:{hostId:"local",conversationId:id,change:{type:"patches",baseRevision:77,revision:78,patches:[]}}})
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(f.registry.runs.size).toBe(1)
    await f.poll(); expect(f.registry.runs.size).toBe(1)
    expect(f.events).toEqual(["run.started"])
  })

  it("replaces a provisional old desktop turn without falsely completing it", () => {
    const registry = new CodexRunRegistry(), sessionId = randomUUID(), old = randomUUID(), next = randomUUID(), events: string[] = []
    registry.apply({type:"run.started",sessionId,turnId:old,backend:"HOOK_OBSERVER",observedAt:1})
    registry.subscribe(event => events.push(event.type))
    const live = new LiveActivityReconciler(registry,{snapshot:()=>{},target:()=>{},available:()=>{}})
    live.update({desktopConnected:true,sessions:[{sessionId,turnId:next,source:"desktop",path:"/private/fixture",status:"running",waiting:true,observedAt:2,observation:{kind:"owner",ownerId:"owner",epoch:1,revision:1,valid:true}}]})
    expect([...registry.runs.values()].map(run => run.turnId)).toEqual([next])
    expect(registry.getSnapshot()[0].waitingFor).toBe("user-input")
    expect(events).toEqual(["run.started","run.waiting"])
    live.update({desktopConnected:true,sessions:[{sessionId,turnId:next,source:"desktop",path:"/private/fixture",status:"running",waiting:false,waitingKnown:false,observedAt:3,observation:{kind:"rollout",readStartedAt:3}}]})
    expect(registry.getSnapshot()[0].waitingFor).toBe("user-input")
    expect(events).toEqual(["run.started","run.waiting"])
  })
})

describe("startup CLI proof", () => {
  it("reads ongoing progress when the initial start has left the tail and never revives terminal turns from later usage records", async () => {
    const home = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "2dl-desktop-progress-"))); cleanups.push(() => rm(home, { recursive: true, force: true }))
    await mkdir(join(home, "sessions"), { mode: 0o700 })
    const id = randomUUID(), turnId = randomUUID(), path = join(home, "sessions", `rollout-test-${id}.jsonl`)
    const header = JSON.stringify({ type: "session_meta", payload: { id, source: "vscode" } }) + "\n"
    const row = (type: string, payload: object) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload: { turn_id: turnId, ...payload } }) + "\n"
    const usage = row("token_usage_record", {})
    const largeToolResult = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(24 * 1024 * 1024) } }) + "\n"
    await writeFile(path, header + row("event_msg", { type: "item_completed" }) + usage + largeToolResult, { mode: 0o600 })
    expect(await inspectOpenCodexRollout(home, path)).toMatchObject({ sessionId: id, turnId, source: "desktop", status: "running", waitingKnown: false })
    await appendFile(path, row("event_msg", { type: "task_complete", last_agent_message: "PRIVATE".repeat(20000) }) + usage)
    expect(await inspectOpenCodexRollout(home, path)).toMatchObject({ status: "completed" })
    await appendFile(path, usage)
    expect(await inspectOpenCodexRollout(home, path)).toMatchObject({ status: "completed" })
    expect(await inspectOpenCliRollout(home, path)).toBeNull()
  })
  it("recovers a continued file using its original conversation ID and verified header", async () => {
    const home = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "2dl-cli-continued-"))); cleanups.push(() => rm(home, { recursive: true, force: true }))
    await mkdir(join(home, "sessions"), { mode: 0o700 })
    const id = randomUUID(), segment = randomUUID(), turnId = randomUUID(), path = join(home, "sessions", `rollout-test-${id}_${segment}.jsonl`)
    const data = (headerId: string) => JSON.stringify({ type: "session_meta", payload: { id: headerId, source: "cli" } }) + "\n" + JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: turnId } }) + "\n"
    await writeFile(path, data(id), { mode: 0o600 })
    expect(await inspectOpenCliRollout(home, path)).toMatchObject({ sessionId: id, turnId, source: "cli", status: "running" })
    await writeFile(path, data(segment))
    expect(await inspectOpenCliRollout(home, path)).toBeNull()
  })
  it("accepts only writable codex rollout handles", () => {
    const output = "p1\nccodex\nf9\nar\nn/private/read.jsonl\nf10\nau\nn/private/live.jsonl\np2\ncnode\nf8\naw\nn/private/fake.jsonl\n"
    expect(cliRolloutPaths(output)).toEqual(["/private/live.jsonl"])
  })
  it("requires a safe CLI header, uses the latest lifecycle, and skips message bodies", async () => {
    const home = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "2dl-cli-proof-"))); cleanups.push(() => rm(home,{recursive:true,force:true}))
    await mkdir(join(home,"sessions"),{mode:0o700})
    const id = randomUUID(), turn = randomUUID(), path = join(home,"sessions",`rollout-test-${id}.jsonl`)
    const header = (source: unknown) => JSON.stringify({type:"session_meta",payload:{id,source}})+"\n"
    const event = (type: string) => JSON.stringify({timestamp:new Date().toISOString(),type:"event_msg",payload:{type,turn_id:turn}})+"\n"
    const body = JSON.stringify({type:"response_item",payload:{text:"PRIVATE_RESPONSE"}})+"\n"
    await writeFile(path,header("cli")+event("task_started")+body,{mode:0o600})
    expect(await inspectOpenCliRollout(home,path)).toMatchObject({sessionId:id,turnId:turn,status:"running",source:"cli"})
    await appendFile(path,JSON.stringify({type:"response_item",payload:{text:"x".repeat(3*1024*1024)}})+"\n")
    expect(await inspectOpenCliRollout(home,path)).toMatchObject({status:"running",turnId:turn})
    await writeFile(path,header("cli")+event("task_started")+body+event("task_complete"))
    expect(await inspectOpenCliRollout(home,path)).toMatchObject({status:"completed"})
    await writeFile(path,header("vscode")+event("task_started"))
    expect(await inspectOpenCliRollout(home,path)).toBeNull()
    await writeFile(path,header({subAgent:{}})+event("task_started"))
    expect(await inspectOpenCliRollout(home,path)).toBeNull()
    await chmod(path,0o666); expect(await inspectOpenCliRollout(home,path)).toBeNull()
    const link = join(home,"sessions",`rollout-link-${turn}.jsonl`); await symlink(path,link)
    expect(await inspectOpenCliRollout(home,link)).toBeNull()
  })
})
