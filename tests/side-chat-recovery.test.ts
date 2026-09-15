import { afterEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
import { CodexSideChatBackend, type ChatConnection } from "../electron/main/side-chat/SideChatBackend"
import { compilePersona } from "../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../electron/shared/character-persona"
import type { AppServerJsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient"
const tick = () => new Promise(resolve => setImmediate(resolve))
const services: SideChatService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())) })
function fixture() {
  let authenticated = true
  const instances: ReturnType<typeof instance>[] = []
  function instance() {
    let notify: (method: string, params: any) => void = () => {}, serverRequest: (r: any) => void = () => {}, closed = () => {}, turn = 0
    const id = `child-${instances.length}`, stop = vi.fn(async () => {})
    const client = {
      handshakeState: "READY", onNotification: (fn: typeof notify) => { notify = fn; return () => {} },
      onServerRequest: (fn: typeof serverRequest) => { serverRequest = fn; return () => {} }, onClose: (fn: () => void) => { closed = fn; return () => {} },
      rejectServerRequest: vi.fn(async () => {}), respondToServerRequest: vi.fn(async () => {}),
      request: vi.fn(async (method: string, params: any) => {
        if (method === "thread/fork") return { thread: { id, ephemeral: true } }
        if (method === "turn/start") { const id = `turn-${++turn}`; notify("turn/started", { threadId: params.threadId, turn: { id } }); return { turn: { id } } }
        return {}
      }),
    }
    const connection: ChatConnection = { client: client as unknown as AppServerJsonlClient, stop, parentContext: async () => ({ path: "/synthetic", lastTurnId: "base", contextAt: 123 }), refreshAuth: async () => { throw Error("CHAT_AUTH_REQUIRED") } }
    const backend = new CodexSideChatBackend(async () => { if (!authenticated) throw Error("CHAT_AUTH_REQUIRED"); return connection })
    const lifetime = vi.spyOn(backend, "onSessionClosed")
    const emit = (method: string, item: unknown) => notify(method, { threadId: id, turnId: `turn-${turn}`, item })
    const final = (text = JSON.stringify({ text: "정상 합성 답변", preview: "", expression: "neutral" })) => {
      const item = { id: `answer-${turn}`, type: "agentMessage", phase: "final_answer", text }
      emit("item/started", item); emit("item/completed", item)
      notify("turn/completed", { threadId: id, turn: { id: `turn-${turn}`, status: "completed", items: [] } })
    }
    return { backend, client, connection, lifetime, stop, emit, final, disconnect: () => closed(), requestRefresh: () => serverRequest({ id: 42, method: "account/chatgptAuthTokens/refresh" }) }
  }
  const factory = vi.fn(() => { const next = instance(); instances.push(next); return next.backend })
  const service = new SideChatService(factory); services.push(service)
  service.configure(true, "ko"); service.applyPersona({ id: "gpichan", revision: "builtin", label: "지피쨩", compiled: compilePersona("지피쨩", neutralPersona(), "ko") })
  service.setCandidates([{ threadId: "parent", title: "Synthetic", cwd: "/synthetic" }], "parent")
  return { service, factory, instances, auth: (value: boolean) => { authenticated = value } }
}
describe("closed child recovery through the production service/backend/collector", () => {
  it.each(["auth", "count", "bytes", "malformed"])("invalidates a closed child after %s without accepting or consuming the next draft", async failure => {
    const f = fixture(), first = f.service.send("첫 질문"); await tick(); const old = f.instances[0]
    const code = failure === "auth" ? "CHAT_AUTH_REQUIRED" : failure === "malformed" ? "RESPONSE_INVALID" : "RESPONSE_LIMIT"
    if (failure === "auth") old.requestRefresh()
    else if (failure === "count") for (let n = 0; n < 65; n++) old.emit("item/started", { id: String(n), type: "agentMessage" })
    else { old.emit("item/started", { id: "bad", type: "agentMessage" }); old.emit("item/completed", { id: "bad", type: "agentMessage", text: failure === "bytes" ? "x".repeat(65536 * 6 + 1) : 123 }) }
    await first; await tick()
    const failedState = f.service.snapshot()
    expect(old.stop).toHaveBeenCalledTimes(1)
    const receipt = f.service.snapshot().acceptedSubmission, messages = f.service.snapshot().messages
    const next = { requestId: randomUUID(), draftRevision: 20 }
    const nextOutcome = await f.service.send("미전송 다음 초안", next).then(() => null, error => error.message)
    expect(f.service.snapshot()).toMatchObject({ error: code, draft: "미전송 다음 초안", acceptedSubmission: receipt, messages })
    expect(nextOutcome).toBe(code)
    expect(failedState).toMatchObject({ error: code, requiresNewConversation: true })
    expect(old.client.request.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(1)
    expect(f.factory).toHaveBeenCalledTimes(1)
    f.auth(true); await tick(); expect(f.factory).toHaveBeenCalledTimes(1)
    f.service.reset()
    expect(f.service.snapshot()).toMatchObject({ messages: [], draft: "미전송 다음 초안", acceptedSubmission: null, requiresNewConversation: false })
    expect(f.factory).toHaveBeenCalledTimes(1)
    const retry = f.service.send("미전송 다음 초안"); await tick(); f.instances[1].final(); await retry
    expect(f.service.snapshot().messages.map(m => m.text)).toEqual(["미전송 다음 초안", "정상 합성 답변"])
  })
  it("keeps the same child after a terminal JSON error and waits for an explicit question", async () => {
    const f = fixture(), first = f.service.send("첫 질문"); await tick(); const child = f.instances[0]; child.final("{broken"); await first
    expect(f.service.snapshot()).toMatchObject({ error: "RESPONSE_INVALID", requiresNewConversation: false })
    expect(child.stop).not.toHaveBeenCalled()
    const next = f.service.send("수동 후속 질문"); await tick(); child.final(); await next
    expect(f.factory).toHaveBeenCalledTimes(1)
    expect(child.client.request.mock.calls.filter(([m]) => m === "thread/fork")).toHaveLength(1)
    expect(f.service.snapshot().messages).toHaveLength(3)
  })
  it("requires explicit new conversation on an idle disconnect and ignores a stale backend close", async () => {
    const f = fixture(), first = f.service.send("첫 질문"); await tick(); const old = f.instances[0]; old.final(); await first
    old.disconnect()
    expect(f.service.snapshot()).toMatchObject({ error: "SESSION_LOST", requiresNewConversation: true })
    f.service.reset(); const next = f.service.send("새 질문"); await tick(); old.disconnect(); old.lifetime.mock.calls[0][0]({ error: Error("CHAT_AUTH_REQUIRED"), hadSession: true }); f.instances[1].final(); await next
    expect(f.service.snapshot()).toMatchObject({ error: null, requiresNewConversation: false })
    expect(f.instances[1].stop).not.toHaveBeenCalled()
  })
  it("does not silently fork if the current child closes during the next preparation", async () => {
    const f = fixture(), first = f.service.send("first"); await tick(); const old = f.instances[0]; old.final(); await first
    const prior = f.service.snapshot(), unsubscribe = f.service.subscribe(() => { if (f.service.snapshot().phase === "preparing") old.disconnect() })
    await f.service.send("keep next input"); unsubscribe()
    expect(f.service.snapshot()).toMatchObject({ requiresNewConversation: true, error: "SESSION_LOST", draft: "keep next input", messages: prior.messages, acceptedSubmission: prior.acceptedSubmission })
    expect(f.factory).toHaveBeenCalledTimes(1)
    expect(old.client.request.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(1)
  })
  it("checks a dead session before acceptance even if its notification is unavailable", async () => {
    const f = fixture(), first = f.service.send("first"); await tick(); const old = f.instances[0]; old.final(); await first
    const receipt = f.service.snapshot().acceptedSubmission
    vi.spyOn(old.backend, "isSessionOpen").mockReturnValue(false)
    await f.service.send("not accepted")
    expect(f.service.snapshot()).toMatchObject({ draft: "not accepted", requiresNewConversation: true, acceptedSubmission: receipt })
    expect(old.client.request.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(1)
  })
  it("ignores delayed auth failure after explicit reset and a new child starts", async () => {
    const f = fixture(), first = f.service.send("first"); await tick(); const old = f.instances[0]
    let fail!: (error: Error) => void
    old.connection.refreshAuth = () => new Promise((_yes, no) => { fail = no })
    old.requestRefresh(); f.service.reset(); await first
    const next = f.service.send("new child"); await tick(); fail(Error("CHAT_AUTH_REQUIRED")); await tick()
    expect(f.service.snapshot()).toMatchObject({ phase: "answering", error: null, requiresNewConversation: false })
    expect(f.instances[1].stop).not.toHaveBeenCalled(); f.instances[1].final(); await next
  })
  it("retains the live context if character application pauses a prepared question", async () => {
    const f = fixture(), first = f.service.send("first"); await tick(); const child = f.instances[0]; child.final(); await first
    let applied = false
    const off = f.service.subscribe(() => { if (!applied && f.service.snapshot().phase === "preparing") { applied = true; f.service.beginCharacterApply() } })
    await f.service.send("keep paused draft"); off(); f.service.characterFailed()
    expect(f.service.snapshot()).toMatchObject({ draft: "keep paused draft", error: "BUSY", requiresNewConversation: false })
    expect(child.stop).not.toHaveBeenCalled()
    const next = f.service.send("keep paused draft"); await tick(); child.final(); await next
    expect(f.factory).toHaveBeenCalledTimes(1)
  })
  it("keeps close observation bound after stopping preparation with an existing child", async () => {
    const f = fixture(), first = f.service.send("first"); await tick(); const child = f.instances[0]; child.final(); await first
    const off = f.service.subscribe(() => { if (f.service.snapshot().phase === "preparing") void f.service.stop() })
    await f.service.send("stopped before handoff"); off(); child.disconnect()
    expect(f.service.snapshot()).toMatchObject({ draft: "stopped before handoff", error: "SESSION_LOST", requiresNewConversation: true })
    expect(child.client.request.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(1)
  })
  it("awaits the same process cleanup when reset follows a synchronous close notification", async () => {
    const f = fixture(), first = f.service.send("first"); await tick(); const old = f.instances[0]
    let stopped!: () => void
    old.stop.mockImplementation(() => new Promise<void>(resolve => { stopped = resolve }))
    old.requestRefresh(); await first; f.service.reset()
    const next = f.service.send("wait for cleanup"); await tick(); const openedBeforeCleanup = f.factory.mock.calls.length
    stopped(); await tick(); f.instances[1].final(); await next
    expect(openedBeforeCleanup).toBe(1)
    expect(old.stop).toHaveBeenCalledTimes(1)
  })
  it("preserves predispatch auth failure and permits preparation only after a new manual send", async () => {
    const f = fixture(); f.auth(false); await f.service.send("보존할 입력")
    expect(f.service.snapshot()).toMatchObject({ error: "CHAT_AUTH_REQUIRED", draft: "보존할 입력", acceptedSubmission: null, messages: [], requiresNewConversation: false })
    f.auth(true); await tick(); expect(f.factory).toHaveBeenCalledTimes(1)
    const retry = f.service.send("보존할 입력"); await tick(); f.instances[1].final(); await retry
    expect(f.service.snapshot().messages.at(-1)?.text).toBe("정상 합성 답변")
  })
})
