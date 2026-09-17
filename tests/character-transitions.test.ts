import { afterEach, describe, expect, it, vi } from "vitest"
import { CharacterTransitions } from "../electron/main/CharacterTransitions"
import { parseCharacterLoadTicket } from "../electron/shared/character-load"
import { validatePetReadyInfo } from "../electron/shared/runtime-validation"
import { waitForCharacterFrame } from "../src/pet/waitForCharacterFrame"

const a = { id: "style-a", revision: "a".repeat(64) }, b = { id: "style-b", revision: "b".repeat(64) }
function fixture() {
  let owner: string | null = null
  const failed = vi.fn(ticket => { if (owner === ticket.requestId) owner = null })
  const timeout = vi.fn(ticket => transitions.fail(ticket))
  const transitions = new CharacterTransitions({ begin: ticket => { owner = ticket.requestId }, failed, timeout })
  return { transitions, failed, timeout, owner: () => owner }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe("character transition ownership", () => {
  it("ignores a late ready/failure from an earlier attempt of the same revision", async () => {
    const f = fixture(), first = f.transitions.begin(a)
    f.transitions.fail(first.ticket)
    await expect(first.done).rejects.toThrow("PACK_LOAD")
    const retry = f.transitions.begin(a)
    expect(retry.ticket.requestId).not.toBe(first.ticket.requestId)
    expect(f.transitions.ready(first.ticket)).toBe(false)
    expect(f.transitions.fail(first.ticket)).toBe(false)
    expect(f.transitions.busy).toBe(true); expect(f.owner()).toBe(retry.ticket.requestId)
    expect(f.transitions.ready(retry.ticket)).toBe(true); await retry.done
  })
  it("owns timeout cleanup and does not terminate the fallback or a later selection", async () => {
    vi.useFakeTimers()
    const f = fixture(), first = f.transitions.begin(a)
    const firstResult = expect(first.done).rejects.toThrow("PACK_CANCELLED")
    vi.advanceTimersByTime(44_000)
    const next = f.transitions.begin(b)
    await firstResult
    vi.advanceTimersByTime(1_001)
    expect(f.timeout).not.toHaveBeenCalled(); expect(f.owner()).toBe(next.ticket.requestId)
    vi.advanceTimersByTime(44_000)
    await expect(next.done).rejects.toThrow("PACK_LOAD")
    expect(f.owner()).toBeNull(); expect(f.transitions.busy).toBe(false)
    const fallback = f.transitions.begin(a)
    expect(f.transitions.fail(next.ticket)).toBe(false)
    expect(f.owner()).toBe(fallback.ticket.requestId)
    f.transitions.ready(fallback.ticket); await fallback.done
    vi.runAllTimers(); expect(f.timeout).toHaveBeenCalledOnce()
  })
  it("retires an entire renderer document and requires fresh proof even for the same model", async () => {
    const f = fixture(), first = f.transitions.begin(a)
    f.transitions.ready(first.ticket); await first.done
    expect(f.transitions.begin(a)).toBe(first)
    f.transitions.retire()
    const reloaded = f.transitions.begin(a)
    expect(reloaded.ticket.rendererGeneration).toBe(first.ticket.rendererGeneration + 1)
    expect(f.transitions.ready(first.ticket)).toBe(false)
    expect(f.transitions.busy).toBe(true)
    f.transitions.retire(); await expect(reloaded.done).rejects.toThrow("PACK_CANCELLED")
    expect(f.owner()).toBeNull()
  })
  it("rejects forged identity, generation and ready reports without a Main ticket", () => {
    const f = fixture(), t = f.transitions.begin(a)
    const info = { webgl: true, characterId: a.id, revision: a.revision, firstFrameAt: 10, ticket: t.ticket }
    expect(validatePetReadyInfo(info)).toEqual(info)
    for (const ticket of [undefined, { ...t.ticket, path: "/private" }, { ...t.ticket, rendererGeneration: NaN }]) expect(validatePetReadyInfo({ ...info, ticket })).toBeNull()
    expect(validatePetReadyInfo({ ...info, characterId: b.id })).toBeNull()
    expect(f.transitions.ready({ ...t.ticket, rendererGeneration: 50 })).toBe(false)
    expect(parseCharacterLoadTicket(t.ticket)).toEqual(t.ticket)
    f.transitions.retire()
  })
})
describe("real frame waiting", () => {
  it("does not signal ready from a timer; retirement cancels a stalled rAF", async () => {
    const callbacks = new Map<number, FrameRequestCallback>(); let id = 0
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id })
    vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key))
    const aborted = new AbortController(), pending = waitForCharacterFrame(aborted.signal), finished = vi.fn()
    void pending.then(finished, () => {})
    callbacks.get(1)!(1); callbacks.delete(1)
    await Promise.resolve(); expect(finished).not.toHaveBeenCalled()
    aborted.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(callbacks.size).toBe(0)
    const ready = waitForCharacterFrame(new AbortController().signal)
    callbacks.get(3)!(3); callbacks.get(4)!(4)
    await expect(ready).resolves.toBeUndefined()
  })
})
