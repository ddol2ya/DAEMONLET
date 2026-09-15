import { describe, expect, it, vi } from "vitest"
import { CodexSideChatBackend } from "../electron/main/side-chat/SideChatBackend"
import { compilePersona } from "../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../electron/shared/character-persona"
import type { AppServerJsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient"
import { PassThrough } from "node:stream"
import { AppServerJsonlClient as JsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient"

function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }
function fixture(manual = false) {
  let turnSequence = 0
  const starts: ReturnType<typeof deferred>[] = [], interrupts: ReturnType<typeof deferred>[] = []
  let notification: (method: string, params: unknown) => void = () => {}, closed = () => {}, request: (v: Record<string, unknown>) => void = () => {}
  const client = {
    initialize: vi.fn(async (_info: unknown, _profile: string) => ({})), onClose: (fn: () => void) => { closed = fn; return () => {} },
    onNotification: (fn: typeof notification) => { notification = fn; return () => {} }, onServerRequest: (fn: typeof request) => { request = fn; return () => {} },
    rejectServerRequest: vi.fn(async () => {}),
    request: vi.fn(async (method: string, params: any) => {
      if (method === "thread/read") return { thread: { id: "parent", updatedAt: 1 } }
      if (method === "thread/turns/list") return { data: [{ id: "working", status: "inProgress" }, { id: "complete", status: "completed", completedAt: 123 }] }
      if (method === "thread/fork") return { thread: { id: "child", ephemeral: true } }
      if (method === "turn/start") {
        if (manual) { const rpc = deferred(); starts.push(rpc); return rpc.promise }
        const id = `turn-${++turnSequence}`
        notification("turn/started", { threadId: params.threadId, turn: { id } }); return { turn: { id } }
      }
      if (method === "turn/interrupt" && manual) { const rpc = deferred(); interrupts.push(rpc); return rpc.promise }
      return {}
    }),
  }
  const processStop = vi.fn(async () => {}), owned = vi.fn(async (_id: string) => {}), backend = new CodexSideChatBackend(async () => ({ client: client as unknown as AppServerJsonlClient, stop: processStop }), owned)
  const open = () => backend.open({ threadId: "parent", title: "Parent", cwd: "/synthetic" }, compilePersona("A", neutralPersona(), "ko"))
  const final = (threadId = "child", turnId = `turn-${turnSequence}`, text = JSON.stringify({ text: "Hello", preview: "", expression: "neutral" })) => notification("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text }] } })
  return { starts, interrupts, notify: (method: string, params: unknown) => notification(method, params), backend, client, processStop, owned, open, final, closed: () => closed(), request: () => request({ id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "child" } }) }
}
describe("dedicated side chat RPC", () => {
  it("forks through last completed turn and never resumes/mutates parent", async () => {
    const f = fixture(); const context = await f.open()
    expect(context.lastTurnId).toBe("complete"); expect(f.owned).toHaveBeenCalledWith("child")
    expect(f.client.initialize.mock.calls[0][1]).toBe("side-chat")
    const fork = f.client.request.mock.calls.find(([method]) => method === "thread/fork")![1]
    expect(fork).toMatchObject({ threadId: "parent", lastTurnId: "complete", ephemeral: true, excludeTurns: true })
    expect(fork).not.toHaveProperty("tools"); expect(fork).not.toHaveProperty("deferGoalContinuation")
    for (let n = 0; n < 2; n++) { const result = f.backend.send("hi"); f.final("parent"); f.final("child", "stale"); f.final(); expect(await result).toEqual({ text: "Hello", preview: "", expression: "neutral" }) }
    for (const [, params] of f.client.request.mock.calls.filter(([method]) => method === "turn/start")) { expect(params.threadId).toBe("child"); expect(params.outputSchema.required).toEqual(["text", "preview", "expression"]); expect(params.input[0].text).toContain("Character style data") }
    expect(f.client.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false)
    await f.backend.close(); expect(f.processStop).toHaveBeenCalledTimes(1)
  })
  it("interrupts only the currently owned child turn", async () => {
    const f = fixture(); await f.open(); const result = f.backend.send("hi"); const checked = expect(result).rejects.toThrow("STOPPED")
    await f.backend.stop(); await checked
    expect(f.client.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "child", turnId: "turn-1" })
  })
  it("rejects unexpected server calls and invalid final output without a model retry", async () => {
    const f = fixture(); await f.open(); const result = f.backend.send("hi"); const checked = expect(result).rejects.toThrow("CHAT_POLICY_UNENFORCEABLE"); f.request(); await checked
    expect(f.client.rejectServerRequest).toHaveBeenCalledWith(42); expect(f.processStop).toHaveBeenCalledTimes(1)
    const g = fixture(); await g.open(); const invalid = g.backend.send("hi"); g.final("child", "turn-1", '{"text":'); await expect(invalid).rejects.toThrow("RESPONSE_INVALID")
    expect(g.client.request.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(1)
  })
  it("treats disconnect while awaiting response as unknown outcome", async () => {
    const f = fixture(); await f.open(); const result = f.backend.send("hi"); const checked = expect(result).rejects.toThrow("OUTCOME_UNKNOWN"); f.closed(); await checked
  })
  it("keeps observer initialization unchanged and opts in only the chat instance", async () => {
    for (const profile of ["observer", "side-chat"] as const) {
      const readable = new PassThrough(), writable = new PassThrough(), wire: any[] = []
      writable.on("data", line => { const value = JSON.parse(line.toString()); wire.push(value); if (value.id) queueMicrotask(() => readable.write(JSON.stringify({ id: value.id, result: {} }) + "\n")) })
      const client = new JsonlClient({ readable, writable }); await client.initialize({ name: "test", title: "Test", version: "1" }, profile)
      expect(wire[0].params.capabilities.experimentalApi).toBe(profile === "side-chat")
      expect(wire[0].params.capabilities.optOutNotificationMethods.includes("item/agentMessage/delta")).toBe(profile === "observer")
      const close = vi.fn(); client.onClose(close); client.close(); expect(close).toHaveBeenCalledTimes(1)
    }
  })
})


describe("per-send RPC ownership", () => {
  const started = (f: ReturnType<typeof fixture>, id: string) => f.notify("turn/started", { threadId: "child", turn: { id } })
  for (const outcome of ["resolve", "reject"] as const) {
    it(`ignores A's late start ${outcome} after A completes and B starts`, async () => {
      const f = fixture(true); await f.open()
      const a = f.backend.send("A"); started(f, "A"); f.final("child", "A"); await a
      const b = f.backend.send("B"), settled = vi.fn(); void b.then(settled, settled)
      if (outcome === "resolve") f.starts[0].resolve({ turn: { id: "A" } })
      else f.starts[0].reject(new Error("late start failure"))
      await flush(); expect(settled).not.toHaveBeenCalled(); expect(f.processStop).not.toHaveBeenCalled()
      started(f, "B"); f.starts[1].resolve({ turn: { id: "B" } }); f.final("child", "B")
      await expect(b).resolves.toMatchObject({ text: "Hello" }); await f.backend.close()
    })
    it(`ignores A's late interrupt ${outcome} after interruption and B starts`, async () => {
      const f = fixture(true); await f.open()
      const a = f.backend.send("A"), checked = expect(a).rejects.toThrow("STOPPED")
      started(f, "A"); f.starts[0].resolve({ turn: { id: "A" } })
      const stop = f.backend.stop()
      f.notify("turn/completed", { threadId: "child", turn: { id: "A", status: "interrupted" } }); await checked
      const b = f.backend.send("B"), settled = vi.fn(); void b.then(settled, settled)
      if (outcome === "resolve") f.interrupts[0].resolve({})
      else f.interrupts[0].reject(new Error("late interrupt failure"))
      await stop; expect(settled).not.toHaveBeenCalled(); expect(f.processStop).not.toHaveBeenCalled()
      started(f, "B"); f.starts[1].resolve({ turn: { id: "B" } }); f.final("child", "B")
      await expect(b).resolves.toMatchObject({ text: "Hello" })
      expect(f.client.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "child", turnId: "A" })
      expect(f.client.request.mock.calls.filter(([m]) => ["turn/start", "turn/steer", "turn/interrupt"].includes(m)).every(([, p]) => p.threadId === "child")).toBe(true)
      await f.backend.close()
    })
    it(`discards old start and interrupt ${outcome} after close/reopen even with the same child ID`, async () => {
      const f = fixture(true); await f.open()
      const a = f.backend.send("A"), checked = expect(a).rejects.toThrow("SESSION_LOST")
      started(f, "A"); const stop = f.backend.stop()
      await f.backend.close(); await checked; await f.open()
      const b = f.backend.send("B"), settled = vi.fn(); void b.then(settled, settled)
      if (outcome === "resolve") { f.starts[0].resolve({ turn: { id: "A" } }); f.interrupts[0].resolve({}) }
      else { f.starts[0].reject(new Error("old connection")); f.interrupts[0].reject(new Error("old connection")) }
      await stop; await flush()
      expect(settled).not.toHaveBeenCalled(); expect(f.processStop).toHaveBeenCalledTimes(1)
      started(f, "B"); f.starts[1].resolve({ turn: { id: "B" } }); f.final("child", "B")
      await expect(b).resolves.toMatchObject({ text: "Hello" }); await f.backend.close()
    })
  }
})
