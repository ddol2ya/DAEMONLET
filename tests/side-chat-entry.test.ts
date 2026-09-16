import { describe, expect, it, vi } from "vitest"
import { SideChatEntryController } from "../electron/main/side-chat/SideChatEntryController"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
import { compilePersona } from "../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../electron/shared/character-persona"

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function fixture(enabled = true) {
  const backend = { isSessionOpen: () => true, onSessionClosed: () => () => {}, open: vi.fn(async () => ({ threadId: "child", lastTurnId: "done", contextAt: 1 })), send: vi.fn(async () => ({ text: "kept answer", preview: "", expression: "neutral" as const })), stop: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const factory = vi.fn(() => backend), service = new SideChatService(factory)
  service.configure(enabled, "ko")
  service.applyPersona({ id: "gpichan", revision: "builtin", label: "Gpichan", compiled: compilePersona("gpichan", neutralPersona(), "ko") })
  service.setCandidates([{ threadId: "parent", title: "Chosen", cwd: "/project" }, { threadId: "other", title: "Other", cwd: "/project" }], "parent")
  const view = { revealPet: vi.fn(async (_signal: AbortSignal) => true), focus: vi.fn(), refreshParents: vi.fn(async (_query?: string) => {}), check: vi.fn(async () => {}) }
  const entry = new SideChatEntryController(service, view)
  return { service, backend, factory, view, entry }
}
describe("explicit character conversation entry", () => {
  it("reveals before focusing without enabling chat or creating a model session", async () => {
    const f = fixture(false), ready = deferred<boolean>()
    f.view.revealPet.mockReturnValueOnce(ready.promise)
    const opened = f.entry.open()
    expect(f.service.snapshot().mode).toBe("hidden"); expect(f.view.focus).not.toHaveBeenCalled()
    ready.resolve(true); await opened
    expect(f.service.snapshot()).toMatchObject({ enabled: false, mode: "compact" })
    expect(f.view.focus).toHaveBeenCalledOnce(); expect(f.view.check).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled()
  })
  it("preserves the same parent's transcript, draft and owned child when its activity mapping changes", async () => {
    const f = fixture(); await f.service.send("first"); f.service.setDraft("unsent")
    const before = f.service.snapshot(); f.service.setMode("hidden")
    await f.entry.open({ threadId: "parent", activityId: "new-row" }, true)
    expect(f.service.snapshot()).toMatchObject({ epoch: before.epoch, draft: "unsent", messages: before.messages, parent: { activityId: "new-row", contextAt: 1 } })
    expect(f.backend.open).toHaveBeenCalledOnce(); expect(f.backend.send).toHaveBeenCalledOnce(); expect(f.backend.close).not.toHaveBeenCalled()
    await f.entry.open()
    expect(f.service.snapshot().messages).toEqual(before.messages); expect(f.backend.open).toHaveBeenCalledOnce()
  })
  it("does not revive a pending reveal after hide or a newer open", async () => {
    const f = fixture(), first = deferred<boolean>()
    f.view.revealPet.mockReturnValueOnce(first.promise)
    const old = f.entry.open({ threadId: "other" }, true)
    const signal = f.view.revealPet.mock.calls[0][0]
    f.entry.cancel(); expect(signal.aborted).toBe(true)
    await f.entry.open({ threadId: "parent" }, true)
    first.resolve(true); await old
    expect(f.service.parentThreadId()).toBe("parent"); expect(f.view.focus).toHaveBeenCalledOnce()
    expect(f.factory).not.toHaveBeenCalled()
  })
  it("does not change selection or focus after closing during catalog preparation", async () => {
    const f = fixture(), catalog = deferred<void>()
    f.view.refreshParents.mockReturnValueOnce(catalog.promise)
    const opened = f.entry.open({ threadId: "other" }, true)
    await Promise.resolve(); await Promise.resolve()
    f.entry.cancel(); f.service.setMode("hidden"); f.service.setDraft("keep")
    catalog.resolve(); await opened
    expect(f.service.snapshot()).toMatchObject({ mode: "hidden", draft: "keep", parent: null })
    expect(f.view.focus).toHaveBeenCalledOnce(); expect(f.view.check).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled()
  })
  it("late readiness and answers cannot reopen a user-hidden window", async () => {
    const f = fixture(), check = deferred<void>(); f.view.check.mockReturnValueOnce(check.promise)
    const opened = f.entry.open(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    f.entry.cancel(); f.service.setMode("hidden")
    check.resolve(); await opened
    await f.service.send("fixture answer")
    expect(f.service.snapshot().mode).toBe("hidden"); expect(f.view.focus).toHaveBeenCalledOnce()
  })
  it("unmapped explicit task clears the previous context but keeps the draft", async () => {
    const f = fixture(); f.service.setDraft("keep")
    await f.entry.open(undefined, true)
    expect(f.service.snapshot()).toMatchObject({ parent: null, draft: "keep", mode: "compact" })
    expect(f.factory).not.toHaveBeenCalled()
  })
})
