import { describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { TaskControlService } from "../electron/main/control/TaskControlService"
import { validateControlTarget } from "../electron/shared/task-control-contract"
import type { ControlRpc } from "../electron/main/control/AppServerSocketClient"

async function fixture(active = true) {
  const a = { id: "thread-A", name: "첫 번째 대화", cwd: "/project/one", status: { type: active ? "active" : "idle", activeFlags: [] } }
  const b = { id: "thread-B", name: "두 번째 대화", cwd: "/project/two", status: { type: "active", activeFlags: [] } }
  let live = [a, b]
  let turn = active ? { id: "turn-A", status: "inProgress" } : { id: "turn-previous", status: "completed" }
  let notification: ((method: string, params: unknown) => void) | null = null
  let closed: (() => void) | null = null
  const request = vi.fn(async (method: string, params: any = {}): Promise<unknown> => {
    if (method === "thread/loaded/list") return { data: live.map(t => t.id), nextCursor: null }
    if (method === "thread/read") return { thread: { ...live.find(t => t.id === params.threadId), preview: "PRIVATE_PROMPT", turns: [] } }
    if (method === "thread/turns/list") return { data: params.threadId === a.id ? [turn] : [{ id: "turn-B", status: "inProgress" }], nextCursor: null }
    if (method === "thread/resume") return { thread: a }
    if (method === "turn/steer") return { turnId: turn.id }
    if (method === "turn/interrupt") return {}
    if (method === "turn/start") { turn = { id: "turn-new", status: "inProgress" }; a.status.type = "active"; return { turn } }
    throw new Error("unknown method")
  })
  const rpc: ControlRpc = { request, onNotification: listener => { notification = listener; return () => { notification = null } }, onServerRequest: () => () => {}, close: vi.fn() }
  const service = new TaskControlService(async (_path, onClosed) => { closed = onClosed; return rpc })
  await service.connect("/private/test/socket")
  const key = service.snapshot().threads[0].key
  await service.select(key)
  const target = () => ({ key, revision: service.snapshot().threads.find(t => t.key === key)!.revision, actionId: randomUUID() })
  return { service, request, rpc, a, key, target, disconnect: () => closed?.(), changeTurn: () => { turn = { id: "turn-changed", status: "inProgress" } }, drop: () => { live = [b] }, notify: (method: string, params: unknown) => notification?.(method, params) }
}

describe("shared Codex task control", () => {
  it("projects titles and opaque keys without exposing prompts, paths or wire IDs", async () => {
    const f = await fixture()
    try {
      const value = JSON.stringify(f.service.snapshot())
      expect(value).not.toMatch(/PRIVATE_PROMPT|thread-A|turn-A|\/project\//)
      expect(f.request).toHaveBeenCalledWith("thread/read", { threadId: "thread-A", includeTurns: false })
      expect(f.request).toHaveBeenCalledWith("thread/turns/list", { threadId: "thread-A", limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
      expect(f.request).toHaveBeenCalledWith("thread/resume", { threadId: "thread-A", excludeTurns: true })
    } finally { f.service.dispose() }
  })
  it("steers the selected live turn with an exact precondition and never retries the same action", async () => {
    const f = await fixture()
    try {
      const input = { ...f.target(), text: "이 부분을 확인해줘" }
      await f.service.send(input); await f.service.send(input)
      const calls = f.request.mock.calls.filter(([m]) => m === "turn/steer")
      expect(calls).toHaveLength(1)
      expect(calls[0][1]).toEqual({ threadId: "thread-A", expectedTurnId: "turn-A", clientUserMessageId: input.actionId, input: [{ type: "text", text: input.text, text_elements: [] }] })
      expect(f.request.mock.calls.some(([m]) => m === "turn/start")).toBe(false)
    } finally { f.service.dispose() }
  })
  it("starts a follow-up on the same idle loaded thread without permission or model overrides", async () => {
    const f = await fixture(false)
    try {
      const input = { ...f.target(), text: "다음 단계로 진행" }
      await f.service.send(input)
      expect(f.request.mock.calls.filter(([m]) => m === "turn/start")).toEqual([["turn/start", { threadId: "thread-A", clientUserMessageId: input.actionId, input: [{ type: "text", text: input.text, text_elements: [] }] }]])
    } finally { f.service.dispose() }
  })
  it("interrupts only the selected current turn and does not call it stopped before a terminal event", async () => {
    const f = await fixture()
    try {
      await f.service.stop(f.target())
      expect(f.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "thread-A", turnId: "turn-A" })
      expect(f.service.snapshot().threads.find(t => t.key === f.key)?.state).toBe("running")
    } finally { f.service.dispose() }
  })
  it("rejects stale turn revisions, unselected jobs and tasks unloaded before send", async () => {
    const f = await fixture()
    try {
      const stale = f.target(); f.changeTurn()
      await expect(f.service.stop(stale)).rejects.toThrow("STALE_TARGET")
      const other = f.service.snapshot().threads[1]
      await expect(f.service.stop({ key: other.key, revision: other.revision, actionId: randomUUID() })).rejects.toThrow("STALE_TARGET")
      const dropped = f.target(); f.drop()
      await expect(f.service.send({ ...dropped, text: "must not send" })).rejects.toThrow("STALE_TARGET")
      expect(f.request.mock.calls.some(([m]) => m.startsWith("turn/"))).toBe(false)
    } finally { f.service.dispose() }
  })
  it("keeps the result uncertain after a write timeout and blocks automatic resend", async () => {
    const f = await fixture()
    try {
      const original = f.request.getMockImplementation()!
      f.request.mockImplementation((method, params) => method === "turn/steer" ? Promise.reject(new Error("request timed out")) : original(method, params))
      const input = { ...f.target(), text: "possibly accepted" }
      await expect(f.service.send(input)).rejects.toThrow("OUTCOME_UNKNOWN")
      await expect(f.service.send(input)).rejects.toThrow("OUTCOME_UNKNOWN")
      expect(f.request.mock.calls.filter(([m]) => m === "turn/steer")).toHaveLength(1)
      f.disconnect()
      expect(f.service.snapshot().threads.every(t => !t.canSend && !t.canStop)).toBe(true)
    } finally { f.service.dispose() }
  })
  it("does not re-enable stale controls when a live turn event arrives during an older metadata read", async () => {
    const f = await fixture()
    try {
      const old = f.target(), original = f.request.getMockImplementation()!
      let release!: () => void, armed = true
      const gate = new Promise<void>(resolve => { release = resolve })
      f.request.mockImplementation(async (method, params) => {
        const result = await original(method, params)
        if (armed && method === "thread/turns/list" && params.threadId === "thread-A") { armed = false; await gate }
        return result
      })
      const refreshing = f.service.refresh()
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      f.changeTurn(); f.notify("turn/started", { threadId: "thread-A" })
      expect(f.service.snapshot().threads.find(t => t.key === f.key)?.canStop).toBe(false)
      release(); await refreshing
      await expect(f.service.stop(old)).rejects.toThrow("STALE_TARGET")
      expect(f.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false)
    } finally { f.service.dispose() }
  })
  it("requires bounded text, action IDs and exact payload shapes", () => {
    const value = { key: randomUUID(), actionId: randomUUID(), revision: 1, text: "테스트" }
    expect(validateControlTarget(value, true)).toEqual(value)
    for (const invalid of [{ ...value, threadId: "injected" }, { ...value, text: "가".repeat(6000) }, { ...value, text: "\0" }, { ...value, revision: NaN }, { ...value, actionId: "wrong" }]) expect(validateControlTarget(invalid, true)).toBeNull()
  })
})
