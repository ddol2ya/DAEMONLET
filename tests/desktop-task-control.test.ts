import { describe, expect, it, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { createDesktopControlFixture } from "../scripts/fixtures/desktop-control-fixture"
import { DesktopIpcClient } from "../electron/main/control/DesktopIpcClient"
import { DesktopControlConnection } from "../electron/main/control/DesktopControlConnection"
import { readDesktopThreadCatalog } from "../electron/main/control/DesktopThreadCatalog"
import { applyDesktopPatches, desktopLiveState, projectDesktopState } from "../electron/main/control/DesktopConversationState"
import { TaskControlService } from "../electron/main/control/TaskControlService"

// Each Vitest worker uses only its test profile's private Windows pipe.
beforeAll(() => { if (process.platform === "win32") vi.stubEnv("ELECTRON_SMOKE_TEST", "1") })
afterAll(() => vi.unstubAllEnvs())


const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (check()) return; await wait(10) }
  throw new Error("desktop fixture condition timed out")
}
async function fixture() {
  const desktop = await createDesktopControlFixture({ fragmented: true })
  const control = new TaskControlService(undefined, (_path, closed) => DesktopControlConnection.connect(closed, desktop.home))
  control.connectDesktop()
  await until(() => control.snapshot().threads.length === 2)
  const key = control.snapshot().threads[0].key
  const target = () => ({ key, revision: control.snapshot().threads.find(t => t.key === key)!.revision, actionId: randomUUID() })
  return { desktop, control, key, target, close: async () => { control.dispose(); await desktop.close() } }
}

// A case can include two bounded 4s waits, connection setup and socket cleanup.
// Its outer budget must exceed the combined waits without relaxing either one.
describe("desktop task auto connection", { timeout: 15_000 }, () => {
  it("discovers only live owners without starting a daemon, resuming history, or exposing private metadata", async () => {
    const f = await fixture()
    try {
      expect(f.control.snapshot()).toMatchObject({ source: "desktop", autoConnect: true, connection: "ready", selectedKey: null })
      expect(f.control.snapshot().threads.every(t => !t.canSend && !t.canStop)).toBe(true)
      const data = JSON.stringify(f.control.snapshot())
      expect(data).not.toMatch(/PRIVATE_|rollout-|ownerClientId|threadId|conversationId/)
      expect(f.desktop.calls.every(call => ["initialize", "thread-owner-discovery"].includes(call.method))).toBe(true)
      await f.control.select(f.key)
      await until(() => Boolean(f.control.snapshot().threads.find(t => t.key === f.key)?.canStop))
      expect(f.control.snapshot().threads.find(t => t.key === f.key)).toMatchObject({ state: "running", canSend: false, canStop: true })
      expect(f.desktop.calls.some(call => /resume|load-complete-history/.test(call.method))).toBe(false)
    } finally { await f.close() }
  })
  it("restricts desktop steering while preserving exact-turn stop and an idle follow-up", async () => {
    const f = await fixture()
    try {
      await f.control.select(f.key)
      const message = { ...f.target(), text: "진행 중인 부분을 확인해 줘" }
      await expect(f.control.send(message)).rejects.toThrow("STALE_TARGET")
      expect(f.desktop.calls.filter(call => call.method === "thread-follower-steer-turn")).toHaveLength(0)
      await f.control.stop(f.target())
      await until(() => f.control.snapshot().threads.find(t => t.key === f.key)?.state === "idle")
      expect(f.desktop.calls.find(call => call.method === "thread-follower-interrupt-turn")).toMatchObject({ targetClientId: f.desktop.owner, params: { conversationId: f.desktop.ids[0], expectedTurnId: f.desktop.turns[0], mode: "user-stop" } })
      await f.control.send({ ...f.target(), text: "같은 대화의 다음 단계" })
      const start = f.desktop.calls.find(call => call.method === "thread-follower-start-turn")!
      expect(start.params.turnStart.context).toEqual({ inheritThreadSettings: true })
      expect(Object.keys(start.params.turnStart.request).sort()).toEqual(["clientUserMessageId", "input", "threadId"])
      expect(start.params.conversationId).toBe(f.desktop.ids[0])
      expect(f.desktop.calls.filter(call => call.method.startsWith("thread-follower-")).every(call => call.params.conversationId === f.desktop.ids[0])).toBe(true)
    } finally { await f.close() }
  })
  it("never sends a T1 steer to T2 when the owner changes turns just after the final snapshot", async () => {
    const desktop = await createDesktopControlFixture({ fragmented: true })
    const rpc = await DesktopControlConnection.connect(() => {}, desktop.home)
    try {
      await rpc.request("thread/loaded/list")
      await rpc.request("thread/resume", { threadId: desktop.ids[0] })
      const t2 = randomUUID()
      desktop.afterNextSnapshot(id => {
        const state = desktop.states.get(id)
        state.turns[0].status = "completed"
        state.turns.push({ turnId: t2, status: "inProgress" })
      })
      await expect(rpc.request("turn/steer", { threadId: desktop.ids[0], expectedTurnId: desktop.turns[0], clientUserMessageId: randomUUID(), input: [{ type: "text", text: "T1 only" }] })).rejects.toThrow("PROTOCOL_UNSUPPORTED")
      expect(desktop.states.get(desktop.ids[0]).turns.at(-1).turnId).toBe(t2)
      expect(desktop.calls.some(call => call.method === "thread-follower-steer-turn")).toBe(false)
    } finally { rpc.close(); await desktop.close() }
  })
  it("rejects an old turn even when it changes after the service's metadata refresh", async () => {
    const f = await fixture()
    try {
      await f.control.select(f.key)
      const old = f.target()
      // No broadcast: the final synchronization before the command must catch it.
      f.desktop.states.get(f.desktop.ids[0]).turns[0].turnId = randomUUID()
      await expect(f.control.stop(old)).rejects.toThrow("STALE_TARGET")
      expect(f.desktop.calls.some(call => call.method === "thread-follower-interrupt-turn")).toBe(false)
    } finally { await f.close() }
  })
  it("does not accept another client's state and invalidates controls when ownership disappears", async () => {
    const f = await fixture()
    try {
      await f.control.select(f.key)
      const old = f.target()
      f.desktop.sendToClients({ type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: randomUUID(), params: { hostId: "local", conversationId: f.desktop.ids[0], change: { type: "snapshot", revision: 100, conversationState: { id: f.desktop.ids[0], threadRuntimeStatus: { type: "idle" }, turns: [] } } } })
      await wait(20)
      expect(f.control.snapshot().threads.find(t => t.key === f.key)?.state).toBe("running")
      f.desktop.owned.delete(f.desktop.ids[0])
      f.desktop.sendToClients({ type: "broadcast", method: "client-status-changed", version: 0, sourceClientId: f.desktop.owner, params: { clientId: f.desktop.owner, status: "disconnected" } })
      await until(() => f.control.snapshot().selectedKey === null)
      expect(f.control.snapshot().selectedKey).toBeNull()
      await expect(f.control.send({ ...old, text: "do not send" })).rejects.toThrow("STALE_TARGET")
      expect(f.desktop.calls.some(call => call.method.startsWith("thread-follower-"))).toBe(false)
    } finally { await f.close() }
  })
  it("reconnects after a socket loss and honors an explicit disconnect", async () => {
    const f = await fixture()
    try {
      await f.control.select(f.key)
      const count = f.desktop.calls.filter(call => call.method === "initialize").length
      f.desktop.dropConnections()
      await until(() => f.desktop.calls.filter(call => call.method === "initialize").length > count && f.control.snapshot().threads.length === 2, 6000)
      expect(f.control.snapshot()).toMatchObject({ connection: "ready", autoConnect: true, selectedKey: null })
      f.control.disconnect()
      const after = f.desktop.calls.filter(call => call.method === "initialize").length
      await wait(1200)
      expect(f.control.snapshot()).toMatchObject({ connection: "disconnected", autoConnect: false })
      expect(f.desktop.calls.filter(call => call.method === "initialize")).toHaveLength(after)
    } finally { await f.close() }
  })
  it("never offers to own tasks or answer desktop requests", async () => {
    const desktop = await createDesktopControlFixture({ fragmented: true })
    const client = await DesktopIpcClient.connect(() => {}, desktop.home)
    try {
      desktop.sendToClients({ type: "client-discovery-request", requestId: randomUUID(), request: { method: "thread-follower-command-approval-decision" } })
      await until(() => desktop.discoveryReplies.length === 1)
      expect(desktop.discoveryReplies).toEqual([{ canHandle: false }])
    } finally { client.close(); await desktop.close() }
  })
  it("reads only metadata and excludes archived, internal-agent, and outside-home candidates", async () => {
    const f = await createDesktopControlFixture()
    try {
      const db = new DatabaseSync(join(f.home, "state_5.sqlite"))
      try {
        const insert = db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)")
        const id = randomUUID()
        insert.run(id, join(f.home, "sessions", `rollout-${id}.jsonl`), "/synthetic/internal", "internal", null, JSON.stringify({ subAgent: { parent_thread_id: f.ids[0] } }), Date.now() / 1000, 0, "PRIVATE", "PRIVATE")
        insert.run(randomUUID(), "/outside/rollout.jsonl", "/outside", "outside", null, "vscode", Date.now() / 1000, 0, "PRIVATE", "PRIVATE")
        db.prepare("UPDATE threads SET archived=1 WHERE id=?").run(f.ids[1])
      } finally { db.close() }
      const catalog = await readDesktopThreadCatalog(f.home)
      expect(catalog.map(item => item.id)).toEqual([f.ids[0]])
      expect(JSON.stringify(catalog)).not.toContain("PRIVATE")
    } finally { await f.close() }
  })
})

describe("desktop state metadata projection", () => {
  it("keeps canonical turn identity while dropping transcript bodies and applies only allowed patches", () => {
    const id = randomUUID(), turnId = randomUUID(), key = "latest"
    const raw = { id, title: "작업", threadRuntimeStatus: { type: "active", activeFlags: [] }, requests: [], preview: "PRIVATE", turnHistory: { kind: "canonical", history: { islands: [{ id: "tail", newerBoundary: { status: "exhausted" }, entries: [{ value: key }] }], entitiesByKey: { [key]: { turnId, status: "inProgress", items: [{ text: "PRIVATE" }], params: { input: "PRIVATE" } } } } } }
    let state = projectDesktopState(raw)
    expect(JSON.stringify(state)).not.toContain("PRIVATE")
    expect(desktopLiveState(state, id)).toMatchObject({ type: "active", turn: { id: turnId, status: "inProgress" } })
    state = applyDesktopPatches(state, [
      { op: "add", path: ["turnHistory", "history", "entitiesByKey", key, "items", 1], value: { text: "PRIVATE" } },
      { op: "replace", path: ["turnHistory", "history", "entitiesByKey", key, "status"], value: "interrupted" },
      { op: "replace", path: ["threadRuntimeStatus", "type"], value: "idle" },
    ])
    expect(desktopLiveState(state, id)).toMatchObject({ type: "idle", turn: { id: turnId, status: "interrupted" } })
    expect(JSON.stringify(state)).not.toContain("PRIVATE")
    expect(() => applyDesktopPatches(state, [{ op: "add", path: ["__proto__", "polluted"], value: true }])).toThrow()
    expect(({} as any).polluted).toBeUndefined()
  })
})
