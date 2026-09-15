import { describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
import { compilePersona } from "../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../electron/shared/character-persona"
import { parseChatResponse, validateChatRequest, validChatInput } from "../electron/shared/side-chat-contract"
import { connectVerifiedSideChat } from "../electron/main/side-chat/SideChatPolicy"
import { BubblePresentationCoordinator } from "../electron/main/BubblePresentationCoordinator"
import { requiresPanel, isComposing } from "../src/side-chat/presentation"

const response = { text: "응답입니다.", preview: "", expression: "neutral" as const }
const persona = (id: string, language: "ko" | "en" = "ko") => ({ id, revision: "builtin", label: id, compiled: compilePersona(id, neutralPersona(), language) })
function fixture() {
  let resolve!: (v: typeof response) => void, reject!: (error: Error) => void
  const backend = { open: vi.fn(async () => ({ threadId: "child", lastTurnId: "done", contextAt: 123 })), send: vi.fn(() => new Promise<typeof response>((yes, no) => { resolve = yes; reject = no })), stop: vi.fn(async () => reject(new Error("STOPPED"))), close: vi.fn(async () => {}) }
  const factory = vi.fn(() => backend), service = new SideChatService(factory)
  service.configure(true, "ko"); service.applyPersona(persona("A")); service.setCandidates([{ threadId: "parent", title: "Selected task", cwd: "/synthetic" }], "parent")
  return { service, backend, factory, finish: () => resolve(response), fail: () => reject(new Error("OUTCOME_UNKNOWN")) }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
describe("side chat lifetime", () => {
  it("does not call backend until send, and keeps fork/messages/draft on hide and layout changes", async () => {
    const f = fixture(); f.service.setDraft("draft"); f.service.setMode("compact"); f.service.setMode("panel"); f.service.setMode("hidden")
    expect(f.factory).not.toHaveBeenCalled(); expect(f.service.snapshot().draft).toBe("draft")
    const sent = f.service.send("hello"); await tick(); f.finish(); await sent
    f.service.setMode("panel"); f.service.setMode("compact"); expect(f.backend.open).toHaveBeenCalledTimes(1); expect(f.service.snapshot().messages).toHaveLength(2)
    f.service.setCandidates([{ threadId: "other", title: "Other", cwd: "/else" }], "other"); expect(f.service.parentThreadId()).toBe("parent")
    expect(f.backend.send).toHaveBeenCalledTimes(1)
  })
  it("withholds old replies while applying; successful apply retires the old epoch and keeps draft", async () => {
    const f = fixture(), sent = f.service.send("hello"); await tick(); const epoch = f.service.snapshot().epoch
    f.service.setDraft("next"); f.service.beginCharacterApply(); f.finish(); await sent
    expect(f.service.snapshot().messages).toHaveLength(1)
    f.service.applyPersona(persona("B")); expect(f.service.snapshot().epoch).toBeGreaterThan(epoch)
    expect(f.service.snapshot().messages).toEqual([]); expect(f.service.snapshot().draft).toBe("next"); expect(f.backend.close).toHaveBeenCalledTimes(1)
  })
  it("keeps old conversation on failed visual apply and ignores unrelated pack installs", async () => {
    const f = fixture(), sent = f.service.send("hello"); await tick(); const epoch = f.service.snapshot().epoch
    f.service.beginCharacterApply(); f.finish(); await sent; f.service.characterFailed()
    f.service.applyPersona(persona("A")); expect(f.service.snapshot().epoch).toBe(epoch); expect(f.service.snapshot().messages).toHaveLength(2)
    expect(f.backend.close).not.toHaveBeenCalled()
  })
  it("ignores late replies across reset, rejects simultaneous requests and stops only its backend", async () => {
    const f = fixture(), sent = f.service.send("hello"); await tick()
    await expect(f.service.send("twice")).rejects.toThrow("BUSY")
    await f.service.stop(); await sent; expect(f.service.snapshot().error).toBe("STOPPED")
    const again = f.service.send("next"); await tick(); f.service.reset(); f.finish(); await again
    expect(f.service.snapshot().messages).toHaveLength(0)
  })
  it("blocks automatic or manual replay after unknown outcome until explicit new conversation", async () => {
    const f = fixture(), sent = f.service.send("hello"); await tick(); f.fail(); await sent
    expect(f.service.snapshot().error).toBe("OUTCOME_UNKNOWN")
    await expect(f.service.send("hello")).rejects.toThrow("OUTCOME_UNKNOWN"); expect(f.backend.send).toHaveBeenCalledTimes(1)
    f.service.reset(); expect(f.service.snapshot().error).toBe(null)
  })
  it("changes language without a call, resets safely and clears transcript on disable", async () => {
    const f = fixture(); f.service.setDraft("draft"); f.service.configure(true, "en"); f.service.applyPersona(persona("A", "en"))
    expect(f.service.snapshot().notice).toBe("language"); expect(f.factory).not.toHaveBeenCalled(); expect(f.service.snapshot().draft).toBe("draft")
    f.service.configure(false, "en"); await expect(f.service.send("hello")).rejects.toThrow("CHAT_DISABLED"); expect(f.service.snapshot().draft).toBe(""); expect(() => f.service.setDraft("late draft")).toThrow("CHAT_DISABLED")
  })
  it("rejects replayed request IDs and stale generations", () => {
    const f = fixture(), s = f.service.snapshot(), request = { handle: s.handle, epoch: s.epoch, requestId: randomUUID() }
    f.service.accept(request); expect(() => f.service.accept(request)).toThrow("STALE_REQUEST"); f.service.reset(); expect(() => f.service.accept({ ...request, requestId: randomUUID() })).toThrow("STALE_REQUEST")
  })
  it("fails closed before starting a process in unsupported production runtimes", async () => { await expect(connectVerifiedSideChat()).rejects.toThrow("CHAT_POLICY_UNENFORCEABLE") })
})
describe("text and presentation contracts", () => {
  it("bounds Unicode input and keeps complete output including code and emoji", () => {
    expect(validChatInput("가".repeat(4000))).toBe(true); expect(validChatInput("😀".repeat(4001))).toBe(false)
    const text = "긴 설명 👩‍💻\n```js\nconst a = 1\n```\n".repeat(200)
    expect(parseChatResponse(JSON.stringify({ ...response, text })).text).toBe(text)
    expect(parseChatResponse(JSON.stringify({ ...response, preview: "가".repeat(121) })).preview).toBe("")
    expect(parseChatResponse(JSON.stringify({ ...response, expression: "unknown-pose" })).expression).toBe("neutral")
    expect(() => parseChatResponse('{"text":')).toThrow("RESPONSE_INVALID")
    expect(() => parseChatResponse(JSON.stringify({ ...response, text: "a".repeat(65537) }))).toThrow("RESPONSE_INVALID")
  })
  it("rejects UI-injected raw IDs, config, prompt and paths", () => {
    const r = { handle: randomUUID(), epoch: 1, requestId: randomUUID(), text: "hi" }
    expect(validateChatRequest(r, "parent")).toEqual(r)
    for (const key of ["parentId", "childId", "config", "developerInstructions", "path"]) expect(() => validateChatRequest({ ...r, [key]: "bad" }, "parent")).toThrow()
  })
  it("uses measured five-line threshold, grapheme-safe previews and IME guard", () => {
    expect(requiresPanel("short", 100, 20)).toBe(false); expect(requiresPanel("long", 120, 20)).toBe(true)
    expect(requiresPanel("```js\n1\n```", 40, 20)).toBe(true); expect(requiresPanel("| a | b |", 20, 20)).toBe(true)
    expect(isComposing({ isComposing: true })).toBe(true); expect(isComposing({ keyCode: 229 })).toBe(true)
    const family = "👨‍👩‍👧‍👦".repeat(120); expect(parseChatResponse(JSON.stringify({ ...response, preview: family })).preview).toBe(family)
  })
  it("arbitrates displays without changing fixed dialogue limits or task state", async () => {
    const coordinator = new BubblePresentationCoordinator(() => {}), epoch = coordinator.begin()
    coordinator.setSideChatVisible(true)
    expect(coordinator.canShowActivity).toBe(false)
    expect((await coordinator.report({ epoch, sequence: 1, available: true, phase: "preparing", anchor: null })).granted).toBe(false)
    coordinator.setSideChatVisible(false); expect(coordinator.sideChatVisible).toBe(false)
  })
})

describe("submitted draft ownership", () => {
  const submission = (draftRevision: number) => ({ requestId: randomUUID(), draftRevision })
  it("acknowledges the submitted revision even when its last edit beat draft debounce", async () => {
    const f = fixture(), receipt = submission(2)
    f.service.setDraft("hello", 1)
    const sent = f.service.send("hello!", receipt); await tick()
    expect(f.service.snapshot()).toMatchObject({ draft: "", draftRevision: 2, acceptedSubmission: receipt, phase: "answering" })
    f.service.setDraft("hello", 1); f.service.setDraft("hello!", 2)
    expect(f.service.snapshot().draft).toBe("")
    f.finish(); await sent
    expect(f.service.snapshot().acceptedSubmission).toEqual(receipt)
    expect(f.backend.send).toHaveBeenCalledTimes(1)
  })
  it("keeps edits made during preparation and response, including identical text at a newer revision", async () => {
    const f = fixture(); let opened!: () => void
    f.backend.open.mockImplementationOnce(() => new Promise(resolve => { opened = () => resolve({ threadId: "child", lastTurnId: "done", contextAt: 123 }) }))
    const receipt = submission(1), sent = f.service.send("same", receipt); await tick()
    f.service.setDraft("same", 3); opened(); await tick()
    expect(f.service.snapshot()).toMatchObject({ draft: "same", draftRevision: 3, acceptedSubmission: receipt })
    f.service.setDraft("next response draft", 4); f.finish(); await sent
    expect(f.service.snapshot().draft).toBe("next response draft")
  })
  it.each([false, true])("preserves the latest draft on a known predispatch failure (new edit: %s)", async newer => {
    const f = fixture(); let failed!: () => void
    f.backend.open.mockImplementationOnce(() => new Promise((_resolve, reject) => { failed = () => reject(Error("CHAT_POLICY_UNENFORCEABLE")) }))
    const sent = f.service.send("submitted", submission(1)); await tick()
    if (newer) f.service.setDraft("new draft", 2)
    failed(); await sent
    expect(f.service.snapshot()).toMatchObject({ draft: newer ? "new draft" : "submitted", acceptedSubmission: null, error: "CHAT_POLICY_UNENFORCEABLE" })
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it("does not apply an old receipt across character replacement or accept older submitted drafts", async () => {
    const f = fixture(); let opened!: () => void
    f.backend.open.mockImplementationOnce(() => new Promise(resolve => { opened = () => resolve({ threadId: "child", lastTurnId: "done", contextAt: 123 }) }))
    const sent = f.service.send("old", submission(1)); await tick()
    f.service.setDraft("new", 2); f.service.applyPersona(persona("B")); opened(); await sent
    expect(f.service.snapshot()).toMatchObject({ draft: "new", acceptedSubmission: null, messages: [] })
    await expect(f.service.send("old", submission(1))).rejects.toThrow("STALE_REQUEST")
    expect(f.backend.send).not.toHaveBeenCalled()
  })
})
