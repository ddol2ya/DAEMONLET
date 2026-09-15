import { describe, expect, it, vi } from "vitest"
import { CodexSideChatBackend } from "../electron/main/side-chat/SideChatBackend"
import { compilePersona } from "../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../electron/shared/character-persona"
import type { AppServerJsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient"
import { PassThrough } from "node:stream"
import { AppServerJsonlClient as JsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient"

function fixture() {
  let notification: (method: string, params: unknown) => void = () => {}, closed = () => {}, request: (v: Record<string, unknown>) => void = () => {}
  const client = {
    initialize: vi.fn(async (_info: unknown, _profile: string) => ({})), onClose: (fn: () => void) => { closed = fn; return () => {} },
    onNotification: (fn: typeof notification) => { notification = fn; return () => {} }, onServerRequest: (fn: typeof request) => { request = fn; return () => {} },
    rejectServerRequest: vi.fn(async () => {}),
    request: vi.fn(async (method: string, params: any) => {
      if (method === "thread/read") return { thread: { id: "parent", updatedAt: 1 } }
      if (method === "thread/turns/list") return { data: [{ id: "working", status: "inProgress" }, { id: "complete", status: "completed", completedAt: 123 }] }
      if (method === "thread/fork") return { thread: { id: "child", ephemeral: true } }
      if (method === "turn/start") { notification("turn/started", { threadId: params.threadId, turn: { id: "turn" } }); return { turn: { id: "turn" } } }
      return {}
    }),
  }
  const processStop = vi.fn(async () => {}), owned = vi.fn(async (_id: string) => {}), backend = new CodexSideChatBackend(async () => ({ client: client as unknown as AppServerJsonlClient, stop: processStop }), owned)
  const open = () => backend.open({ threadId: "parent", title: "Parent", cwd: "/synthetic" }, compilePersona("A", neutralPersona(), "ko"))
  const final = (threadId = "child", turnId = "turn", text = JSON.stringify({ text: "Hello", preview: "", expression: "neutral" })) => notification("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text }] } })
  return { backend, client, processStop, owned, open, final, closed: () => closed(), request: () => request({ id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "child" } }) }
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
    expect(f.client.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "child", turnId: "turn" })
  })
  it("rejects unexpected server calls and invalid final output without a model retry", async () => {
    const f = fixture(); await f.open(); const result = f.backend.send("hi"); const checked = expect(result).rejects.toThrow("CHAT_POLICY_UNENFORCEABLE"); f.request(); await checked
    expect(f.client.rejectServerRequest).toHaveBeenCalledWith(42); expect(f.processStop).toHaveBeenCalledTimes(1)
    const g = fixture(); await g.open(); const invalid = g.backend.send("hi"); g.final("child", "turn", '{"text":'); await expect(invalid).rejects.toThrow("RESPONSE_INVALID")
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
