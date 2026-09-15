import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BubblePresentationCoordinator } from "../electron/main/BubblePresentationCoordinator"
import { BUBBLE_RETURN_DELAY_MS, validatePetBubblePresentation, type PetBubblePresentation } from "../electron/shared/bubble-presentation"
import { ActivityStore } from "../electron/main/activity/ActivityStore"

const anchor = { x0: .32, y0: .03, x1: .67, y1: .32 }
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function fixture() {
  const events: string[] = []
  const c = new BubblePresentationCoordinator(() => events.push(c.canShowActivity ? "activity" : "hidden"))
  let epoch = c.begin(), sequence = 0
  const report = (phase: PetBubblePresentation["phase"], available = true) => c.report({ epoch, sequence: ++sequence, phase, available, anchor })
  return { c, events, report, epoch, nextEpoch: () => { epoch = c.begin(); sequence = 0; return epoch } }
}
describe("dialogue-priority presentation", () => {
  it("hides the native card before granting dialogue and waits through exit plus return debounce", async () => {
    const f = fixture()
    expect(f.c.canShowActivity).toBe(false)
    await f.report("hidden"); expect(f.c.canShowActivity).toBe(true)
    const pending = f.report("preparing").then(p => { f.events.push("permit"); return p })
    expect(f.events.at(-1)).toBe("hidden")
    expect(await pending).toMatchObject({ granted: true })
    expect(f.events.slice(-2)).toEqual(["hidden", "permit"])
    await f.report("shown"); await vi.advanceTimersByTimeAsync(9000)
    expect(f.c.canShowActivity).toBe(false) // No guessed display-duration timer.
    await f.report("exiting"); await vi.advanceTimersByTimeAsync(500)
    expect(f.c.canShowActivity).toBe(false)
    await f.report("hidden"); await vi.advanceTimersByTimeAsync(BUBBLE_RETURN_DELAY_MS - 1)
    expect(f.c.canShowActivity).toBe(false)
    await vi.advanceTimersByTimeAsync(1); expect(f.c.canShowActivity).toBe(true)
    f.c.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it("keeps consecutive speech exclusive and ignores delayed ends from old sequences and characters", async () => {
    const f = fixture()
    await f.report("preparing"); await f.report("hidden")
    await vi.advanceTimersByTimeAsync(BUBBLE_RETURN_DELAY_MS - 1); await f.report("preparing")
    await vi.advanceTimersByTimeAsync(1000); expect(f.c.canShowActivity).toBe(false)
    expect(await f.c.report({ epoch: f.epoch, sequence: 2, phase: "hidden", available: true, anchor })).toMatchObject({ granted: false })
    f.nextEpoch(); await f.report("preparing")
    await f.c.report({ epoch: f.epoch, sequence: 1000, phase: "hidden", available: true, anchor })
    await vi.advanceTimersByTimeAsync(1000); expect(f.c.canShowActivity).toBe(false)
  })
  it("defers speech during pointer/action input and releases only the newest pending request", async () => {
    const f = fixture(); await f.report("hidden")
    f.c.setInteractionLocked(true)
    const old = f.report("preparing")
    const newest = f.report("preparing")
    expect(await old).toMatchObject({ granted: false })
    expect(f.c.canShowActivity).toBe(true)
    let granted = false; void newest.then(p => { granted = p.granted })
    await vi.advanceTimersByTimeAsync(60_000); expect(granted).toBe(false)
    f.c.setInteractionLocked(false)
    expect(f.c.canShowActivity).toBe(false)
    expect(await newest).toMatchObject({ granted: true })
  })
  it("clears pending permission and debounce on unavailable, renderer loss, and disposal", async () => {
    const f = fixture(); await f.report("hidden"); f.c.setInteractionLocked(true)
    const pending = f.report("preparing")
    f.nextEpoch(); expect(await pending).toMatchObject({ granted: false })
    expect(f.c.canShowActivity).toBe(false)
    await f.report("hidden"); expect(f.c.canShowActivity).toBe(true)
    f.c.setInteractionLocked(false); await f.report("preparing"); await f.report("hidden")
    await f.report("hidden", false); await vi.advanceTimersByTimeAsync(500)
    expect(f.c.canShowActivity).toBe(false)
    await f.report("hidden"); expect(f.c.canShowActivity).toBe(true)
    f.c.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it("does not couple unread activity lifetime to presentation lifetime", async () => {
    const store = new ActivityStore(() => 10_000), f = fixture()
    const complete = (runId: string) => store.accept({ protocolVersion: 1, source: "codex-adapter", sourceInstanceId: "one", sessionId: "wire", messageId: runId, sequence: 1, sentAt: 10_000, frameType: "event", payload: { type: "run.completed", runId } })
    complete("A"); await f.report("preparing"); complete("B")
    const a = store.view().entries.find(e => e.activityId === "activity-1")!
    store.acknowledge({ targets: [{ activityId: a.activityId, revision: a.revision }] })
    await f.report("exiting"); await f.report("hidden"); await vi.advanceTimersByTimeAsync(200)
    expect(store.view().entries.filter(e => e.unread).map(e => e.activityId)).toEqual(["activity-2"])
  })
})

describe("side chat display arbitration", () => {
  const speech = { text: "Old authored line", width: 150, height: 42, fadeMs: 160 }
  it("consumes hidden reports during chat and restores activity without another Pet event", async () => {
    const f = fixture()
    await f.c.report({ epoch: f.epoch, sequence: 1, phase: "shown", available: true, anchor, speech })
    f.c.setSideChatVisible(true)
    expect(f.c.canShowActivity).toBe(false)
    await f.c.report({ epoch: f.epoch, sequence: 2, phase: "hidden", available: true, anchor })
    expect(f.c.speech).toBeNull()
    await vi.advanceTimersByTimeAsync(BUBBLE_RETURN_DELAY_MS)
    expect(f.c.canShowActivity).toBe(false)
    f.c.setSideChatVisible(false)
    expect(f.c.speech).toBeNull(); expect(f.c.canShowActivity).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("keeps new anchors, unavailability and sequence validation while suppressing permission", async () => {
    const f = fixture(), moved = { ...anchor, x0: .2 }
    await f.c.report({ epoch: f.epoch, sequence: 1, phase: "shown", available: true, anchor, speech })
    f.c.setSideChatVisible(true)
    expect(await f.c.report({ epoch: f.epoch, sequence: 3, phase: "shown", available: true, anchor: moved, speech })).toMatchObject({ granted: false })
    expect(f.c.anchor).toEqual(moved)
    await f.c.report({ epoch: f.epoch, sequence: 2, phase: "hidden", available: false, anchor: null })
    await f.c.report({ epoch: f.epoch - 1, sequence: 100, phase: "hidden", available: false, anchor: null })
    expect(f.c.anchor).toEqual(moved); expect(f.c.speech?.content).toEqual(speech)
    await f.c.report({ epoch: f.epoch, sequence: 4, phase: "hidden", available: false, anchor: null })
    f.c.setSideChatVisible(false)
    expect(f.c.anchor).toBeNull(); expect(f.c.speech).toBeNull(); expect(f.c.canShowActivity).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("rejects pending/new preparations during chat, including when the input lock releases", async () => {
    const f = fixture(); await f.report("hidden"); f.c.setInteractionLocked(true)
    const pending = f.report("preparing"); f.c.setSideChatVisible(true)
    expect(await pending).toMatchObject({ granted: false })
    expect(await f.report("preparing")).toMatchObject({ granted: false })
    f.c.setInteractionLocked(false); expect(f.c.canShowActivity).toBe(false)
    f.c.setSideChatVisible(false); expect(f.c.canShowActivity).toBe(true)
    expect(await f.report("preparing")).toMatchObject({ granted: true })
  })
})

describe("presentation geometry ingress", () => {
  const valid = { epoch: 1, sequence: 1, available: true, phase: "hidden", anchor }
  it("accepts only finite normalized geometry and exact non-content fields", () => {
    expect(validatePetBubblePresentation(valid)).toEqual(valid)
    expect(validatePetBubblePresentation({ ...valid, phase: ["shown"] })).toBeNull()
    expect(validatePetBubblePresentation({ ...valid, phase: new String("hidden") })).toBeNull()
    for (const value of [null, [], { ...valid, text: "private" }, { ...valid, phase: "queued" }, { ...valid, sequence: Infinity }, { ...valid, epoch: 0 }, { ...valid, anchor: { ...anchor, x0: -1 } }, { ...valid, anchor: { ...anchor, x1: NaN } }, { ...valid, anchor: { ...anchor, y1: 0 } }, { ...valid, anchor: { ...anchor, screenX: 4000 } }]) expect(validatePetBubblePresentation(value)).toBeNull()
  })
  it("bounds the authored speech payload without accepting arbitrary fields", () => {
    const speech = { text: "주의를 끄는 데에는 성공하셨습니다.", width: 230, height: 62, fadeMs: 160 }
    expect(validatePetBubblePresentation({ ...valid, speech })).toEqual({ ...valid, speech })
    for (const bad of [null, [], { ...speech, width: 241 }, { ...speech, height: Infinity }, { ...speech, fadeMs: -1 }, { ...speech, text: "x".repeat(37) }, { ...speech, text: "" }, { ...speech, rawEvent: {} }]) expect(validatePetBubblePresentation({ ...valid, speech: bad })).toBeNull()
  })
  it("only publishes current, granted speech and immediately clears it on hide or reload", async () => {
    const f = fixture(), speech = { text: "확인할게.", width: 80, height: 42, fadeMs: 160 }
    const report = (sequence: number, phase: PetBubblePresentation["phase"]) => f.c.report({ epoch: f.epoch, sequence, phase, available: true, anchor, speech })
    await report(1, "preparing"); expect(f.c.speech).toBeNull()
    await report(2, "shown"); expect(f.c.speech).toEqual({ content: speech, phase: "shown" })
    await report(1, "hidden"); expect(f.c.speech?.phase).toBe("shown")
    await report(3, "exiting"); expect(f.c.speech?.phase).toBe("exiting")
    await report(4, "hidden"); expect(f.c.speech).toBeNull()
    await report(5, "shown"); f.nextEpoch(); expect(f.c.speech).toBeNull()
    f.c.dispose()
  })
})
