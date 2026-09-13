import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CharacterDialogueController } from "../src/dialogue/CharacterDialogueController"
import { DIALOGUE_TRIGGER_IDS, type DialogueManifest } from "../src/dialogue/types"
import { dialogueProfile } from "./helpers/dialogue"

const controllers: CharacterDialogueController[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.useRealTimers() })
const setup = (change?: (m: DialogueManifest) => void, random = () => 0) => {
  const controller = new CharacterDialogueController({ clock: { now: () => Date.now() }, random })
  controller.configure(dialogueProfile(change), "bell")
  controllers.push(controller)
  return controller
}

describe("dialogue controller", () => {
  it("uses the visible variant's own lines while preserving trigger fallback and silent return", () => {
    const c = setup(m => {
      m.settings.repeatMemory = 5
      m.poseTriggers = { writing: 'run.started', happy: 'run.completed.observed', 'happy-double-v': 'run.completed.observed', 'head-tap': 'interaction.head-tap' }
      m.poseLines = { happy: ['수고하셨습니다.'], 'happy-double-v': ['피스, 피스.', '브이, 브이.'], 'head-tap': ['부르셨습니까?'] }
    })
    c.setPoseContext('happy')
    expect(c.getSnapshot().text).toBe('수고하셨습니다.')
    c.setPoseContext('happy-double-v')
    expect(c.getSnapshot().text).toBe('피스, 피스.')
    c.setPoseContext('head-tap')
    expect(c.getSnapshot().text).toBe('부르셨습니까?')
    c.setPoseContext('happy-double-v')
    expect(c.getSnapshot().visible).toBe(false)
    c.setPoseContext('writing')
    expect(c.getSnapshot().text).toBe('확인할게.')
    c.setPoseContext('happy-double-v')
    expect(c.getSnapshot().text).toBe('브이, 브이.')
    c.clear(); c.triggerDebug('run.completed.observed')
    expect(c.getSnapshot().text).toBe('살펴볼게.')
  })

  it("drops queued lines owned by an old pose before showing the new variant", () => {
    const c = setup(m => {
      m.poseTriggers = { happy: 'run.completed.observed', 'happy-double-v': 'run.completed.observed' }
      m.poseLines = { happy: ['수고하셨습니다.'], 'happy-double-v': ['피스, 피스.'] }
      m.triggers['run.completed.observed']!.mode = 'queue'
    })
    c.triggerDebug('run.failed')
    c.setPoseContext('happy')
    expect(c.getSnapshot().queueLength).toBe(1)
    c.setPoseContext('happy-double-v')
    expect(c.getSnapshot().queueLength).toBe(1)
    vi.advanceTimersByTime(1060)
    expect(c.getSnapshot().text).toBe('피스, 피스.')
    expect(c.getSnapshot().history.some(h => h.text === '수고하셨습니다.')).toBe(false)
  })

  it("replaces a pose cue with the next pose immediately, including lower priorities", () => {
    const c=setup(m=>{m.poseTriggers={base:'state.normal',failed:'run.failed',waiting:'state.waiting',writing:'run.started'}})
    c.setPoseContext('failed')
    expect(c.getSnapshot().triggerId).toBe('run.failed')
    c.setPoseContext('waiting')
    expect(c.getSnapshot()).toMatchObject({triggerId:'state.waiting',visible:true,queueLength:0})
    const shown=c.getSnapshot().shownAt
    vi.advanceTimersByTime(200)
    c.setPoseContext('waiting')
    expect(c.getSnapshot().shownAt).toBe(shown)
    c.setPoseContext('writing')
    expect(c.getSnapshot().triggerId).toBe('run.started')
    c.setPoseContext(null)
    expect(c.getSnapshot().triggerId).toBe('state.normal')
    c.setPoseContext('unmapped-pose')
    expect(c.getSnapshot()).toMatchObject({visible:false,queueLength:0})
    expect(vi.getTimerCount()).toBe(0)
  })

  it("waits for the matching pose before speaking and does not replay hidden cues", () => {
    const c=setup(m=>{m.poseTriggers={writing:'run.started','head-tap':'interaction.head-tap',waiting:'state.waiting'}})
    c.setPoseContext('writing')
    c.handleMotion({type:'interaction.started',interactionId:'HEAD_TAP',at:10})
    expect(c.getSnapshot().triggerId).toBe('run.started')
    c.setPoseContext('head-tap')
    expect(c.getSnapshot().triggerId).toBe('interaction.head-tap')
    c.setAvailable(false)
    c.setPoseContext('waiting')
    c.setAvailable(true)
    c.setPoseContext('waiting')
    expect(c.getSnapshot().visible).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['head-tap', 'torso-tap'])("returns silently from %s even after the work cue cooldown expires", (interaction) => {
    const c = setup(m => { m.poseTriggers = { writing: 'run.started', waiting: 'state.waiting', 'head-tap': 'interaction.head-tap', 'torso-tap': 'interaction.torso-tap' } })
    c.setPoseContext('writing')
    vi.advanceTimersByTime(15000)
    c.setPoseContext(interaction)
    expect(c.getSnapshot().triggerId).toBe(`interaction.${interaction}`)
    c.setPoseContext('writing')
    expect(c.getSnapshot()).toMatchObject({ visible: false, queueLength: 0 })
    expect(c.getSnapshot().history.filter(e => e.decision === 'shown' && e.triggerId === 'run.started')).toHaveLength(1)
    // A real state change can still speak, including a later return to work.
    c.setPoseContext('waiting')
    expect(c.getSnapshot().triggerId).toBe('state.waiting')
    c.setPoseContext('writing')
    expect(c.getSnapshot().triggerId).toBe('run.started')
  })

  it("keeps the original return pose across successive clicks but speaks when work finishes during a click", () => {
    const c = setup(m => { m.poseTriggers = { writing: 'run.started', happy: 'run.completed.observed', 'head-tap': 'interaction.head-tap', 'torso-tap': 'interaction.torso-tap' } })
    c.setPoseContext('writing')
    c.setPoseContext('head-tap')
    c.setPoseContext('torso-tap')
    c.setPoseContext('writing')
    expect(c.getSnapshot().visible).toBe(false)
    c.setPoseContext('head-tap')
    c.setPoseContext('happy')
    expect(c.getSnapshot().triggerId).toBe('run.completed.observed')
  })

  it("selects deterministically, fades out, clears text and cancels timers", () => {
    const c = setup()
    c.triggerDebug("run.started")
    expect(c.getSnapshot()).toMatchObject({ visible: true, text: "확인할게.", phase: "shown", hideAt: 800 })
    vi.advanceTimersByTime(800)
    expect(c.getSnapshot().phase).toBe("exiting")
    vi.advanceTimersByTime(160)
    expect(c.getSnapshot()).toMatchObject({ visible: false, text: null })
    expect(vi.getTimerCount()).toBe(0)
  })
  it("preserves a held dialogue's full remaining lifetime without disabling generation", () => {
    const c = setup()
    c.triggerDebug("run.started")
    vi.advanceTimersByTime(100); c.setPresentationPaused(true)
    vi.advanceTimersByTime(10000)
    expect(c.getSnapshot()).toMatchObject({ enabled: true, phase: "shown", visible: true })
    c.setPresentationPaused(false)
    vi.advanceTimersByTime(699); expect(c.getSnapshot().phase).toBe("shown")
    vi.advanceTimersByTime(1); expect(c.getSnapshot().phase).toBe("exiting")
    vi.advanceTimersByTime(160); expect(c.getSnapshot().visible).toBe(false)
  })
  it("still invalidates owners and drops unavailable cues while presentation is held", () => {
    const c = setup(m => { m.poseTriggers = { writing: "run.started", failed: "run.failed" } })
    c.setPoseContext("writing"); c.setPresentationPaused(true)
    vi.advanceTimersByTime(1000); c.setPoseContext("failed")
    expect(c.getSnapshot().triggerId).toBe("run.failed")
    c.setAvailable(false); c.setPresentationPaused(false); c.setAvailable(true)
    expect(c.getSnapshot().visible).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("avoids recent and immediate repeats, then permits exhausted lines", () => {
    const c = setup()
    const lines = []
    for (let i = 0; i < 5; i++) { c.clear(); c.triggerDebug("interaction.pet"); lines.push(c.getSnapshot().text) }
    expect(lines).toEqual(["확인할게.", "살펴볼게.", "기다려 줘.", "확인할게.", "살펴볼게."])
  })
  it("suppresses probability without starting timers", () => {
    const c = setup((m) => { m.triggers["state.bored"]!.probability = .25 }, () => .5)
    c.triggerDebug("state.bored")
    expect(c.getSnapshot()).toMatchObject({ lastDecision: "probability", visible: false })
    expect(vi.getTimerCount()).toBe(0)
  })
  it("enforces per-trigger cooldown", () => {
    const c = setup((m) => { m.triggers["interaction.pet"]!.cooldownMs = 10000 })
    c.triggerDebug("interaction.pet"); c.clear(); c.triggerDebug("interaction.pet")
    expect(c.getSnapshot().lastDecision).toBe("cooldown")
    vi.advanceTimersByTime(10000); c.triggerDebug("interaction.pet")
    expect(c.getSnapshot().visible).toBe(true)
  })
  it("replaces lower priorities immediately and does not let interaction replace a terminal", () => {
    const c = setup()
    c.triggerDebug("task.started.command"); c.triggerDebug("run.cancelled.user")
    expect(c.getSnapshot().triggerId).toBe("run.cancelled.user")
    c.triggerDebug("interaction.pet")
    expect(c.getSnapshot()).toMatchObject({ triggerId: "run.cancelled.user", lastDecision: "lower-priority" })
    expect(vi.getTimerCount()).toBe(1)
  })
  it("drops background signals while busy and within the global gap", () => {
    const c = setup()
    c.triggerDebug("interaction.pet"); c.triggerDebug("state.bored")
    expect(c.getSnapshot().lastDecision).toBe("lower-priority")
    vi.advanceTimersByTime(960); c.triggerDebug("state.bored")
    expect(c.getSnapshot().lastDecision).toBe("global-gap")
    vi.advanceTimersByTime(100); c.triggerDebug("state.bored")
    expect(c.getSnapshot().triggerId).toBe("state.bored")
  })
  it("allows terminal feedback immediately during the quiet gap", () => {
    const c = setup()
    c.triggerDebug("run.started"); vi.advanceTimersByTime(960); c.triggerDebug("run.failed")
    expect(c.getSnapshot().triggerId).toBe("run.failed")
  })
  it("queues to the bound, suppresses duplicates and drains after fade plus gap", () => {
    const c = setup((m) => { for (const entry of Object.values(m.triggers)) entry!.mode = "queue" })
    c.triggerDebug("run.started")
    for (const id of ["interaction.pet", "interaction.head-tap", "interaction.face-hold", "interaction.torso-tap"] as const) c.triggerDebug(id)
    expect(c.getSnapshot()).toMatchObject({ queueLength: 3, lastDecision: "queue-full" })
    c.triggerDebug("interaction.pet")
    expect(c.getSnapshot().lastDecision).toBe("duplicate")
    vi.advanceTimersByTime(1060)
    expect(c.getSnapshot()).toMatchObject({ triggerId: "interaction.pet", queueLength: 2 })
  })
  it("expires old queue entries before presentation", () => {
    const c = setup((m) => { m.triggers["run.started"]!.displayMs = 6000; m.triggers["interaction.pet"]!.mode = "queue" })
    c.triggerDebug("run.started"); c.triggerDebug("interaction.pet"); vi.advanceTimersByTime(6300)
    expect(c.getSnapshot()).toMatchObject({ visible: false, queueLength: 0, lastDecision: "expired" })
  })
  it.each(["disable", "hidden", "configure", "dispose"])("cleans presentation and timers on %s", (action) => {
    const c = setup((m) => { m.triggers["interaction.pet"]!.mode = "queue" })
    c.triggerDebug("run.started"); c.triggerDebug("interaction.pet")
    if (action === "disable") c.setEnabled(false)
    if (action === "hidden") c.setAvailable(false)
    if (action === "configure") c.configure(dialogueProfile(), "momo")
    if (action === "dispose") c.dispose()
    expect(c.getSnapshot()).toMatchObject({ visible: false, queueLength: 0 })
    expect(vi.getTimerCount()).toBe(0)
    if (action !== "dispose") { c.setEnabled(true); c.setAvailable(true); vi.advanceTimersByTime(10000); expect(c.getSnapshot().visible).toBe(false) }
  })
  it("drops hidden signals and re-enables only for future events", () => {
    const c = setup(); c.setAvailable(false); c.triggerDebug("run.started")
    expect(c.getSnapshot().lastDecision).toBe("disabled")
    c.setAvailable(true); expect(c.getSnapshot().visible).toBe(false)
    c.triggerDebug("run.started"); expect(c.getSnapshot().visible).toBe(true)
  })
  it("survives 21 character switches without old voice, cooldowns, queues or timers", () => {
    const c = setup()
    for (let i = 0; i < 21; i++) {
      const character = ["bell", "momo", "longhair"][i % 3]
      c.configure(dialogueProfile((m) => { m.triggers["run.started"]!.lines = [character]; m.triggers["run.started"]!.cooldownMs = 60000 }), character)
      expect(c.getSnapshot()).toMatchObject({ visible: false, queueLength: 0, history: [] })
      expect(vi.getTimerCount()).toBe(0)
      c.triggerDebug("run.started"); expect(c.getSnapshot().text).toBe(character)
    }
    c.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it("bounds diagnostics and isolates throwing presentation listeners", () => {
    const c = setup()
    const off = c.subscribe(() => { throw new Error("renderer failure") })
    for (let i = 0; i < 100; i++) { c.clear(); c.triggerDebug(DIALOGUE_TRIGGER_IDS[i % DIALOGUE_TRIGGER_IDS.length]) }
    expect(c.getSnapshot().history).toHaveLength(64)
    off()
  })
  it("rejects unvalidated profiles and arbitrary debug IDs without retaining their input", () => {
    const c = setup()
    c.triggerDebug("private-input" as never)
    expect(JSON.stringify(c.getSnapshot())).not.toContain("private-input")
    c.configure(dialogueProfile((m) => { m.triggers["run.started"]!.lines = ["<b>private</b>"] }), "bell")
    c.triggerDebug("run.started")
    expect(c.getSnapshot()).toMatchObject({ enabled: false, visible: false })
    expect(JSON.stringify(c.getSnapshot())).not.toContain("private")
  })
})


describe("owned continuous dialogue", () => {
  it("uses the accepted pet pose's lines and keeps a face hold's own fallback", () => {
    const c = setup()
    c.configure(dialogueProfile(m => {
      m.poseTriggers = { waiting: 'state.waiting', 'head-pet': 'interaction.pet' }
      m.poseLines = { waiting: ['대기합니다.'], 'head-pet': ['이것이 포상입니까.'] }
      m.triggers['interaction.face-hold']!.lines = ['얼굴은 점검 대상이 아닙니다.']
    }), 'test', ['interaction.pet', 'interaction.face-hold'])
    c.setPoseContext('waiting'); c.clear()
    const event = (phase: 'pending' | 'active' | 'ended', gestureId: number, interactionId: 'PET' | 'HOLD') => c.handleBehavior({ type: 'continuous.changed', phase, gestureId, interactionId, poseId: interactionId === 'PET' ? 'head-pet' : null, at: Date.now() })
    event('pending', 1, 'PET'); c.setPoseContext('head-pet'); event('active', 1, 'PET')
    expect(c.getSnapshot().text).toBe('이것이 포상입니까.')
    event('ended', 1, 'PET'); c.setPoseContext('waiting')
    expect(c.getSnapshot().visible).toBe(false)
    event('pending', 2, 'HOLD'); event('active', 2, 'HOLD')
    expect(c.getSnapshot().text).toBe('얼굴은 점검 대상이 아닙니다.')
  })

  const prepare = () => {
    const c=setup()
    c.configure(dialogueProfile(m=>{m.poseTriggers={base:'state.normal',writing:'run.started','head-pet':'interaction.pet',happy:'run.completed.observed'}}),'gpichan',['interaction.pet','interaction.face-hold'])
    const event=(phase:'pending'|'active'|'ended',gestureId=1,interactionId:'PET'|'HOLD'='PET')=>c.handleBehavior({type:'continuous.changed',phase,gestureId,interactionId,poseId:interactionId==='PET'?'head-pet':null,at:Date.now()})
    return {c,event}
  }
  it('waits for the visible pose, speaks once, and does not announce work on return', () => {
    const {c,event}=prepare();c.setPoseContext('writing');c.clear()
    event('pending');expect(c.getSnapshot().visible).toBe(false)
    c.setPoseContext('head-pet');expect(c.getSnapshot().visible).toBe(false)
    event('active');const started=c.getSnapshot().shownAt
    expect(c.getSnapshot().triggerId).toBe('interaction.pet')
    c.handleMotion({type:'interaction.started',interactionId:'PET',at:1})
    event('active');expect(c.getSnapshot().shownAt).toBe(started)
    event('ended');c.setPoseContext('writing')
    expect(c.getSnapshot()).toMatchObject({visible:false,queueLength:0})
    expect(c.getSnapshot().history.filter(e=>e.decision==='shown'&&e.triggerId==='run.started')).toHaveLength(1)
  })
  it('rejects a late ready event after a pending gesture ended', () => {
    const {c,event}=prepare();event('pending');event('ended');event('active')
    expect(c.getSnapshot().visible).toBe(false)
  })
  it('does not let a late release clear a newer result or gesture', () => {
    const {c,event}=prepare();event('pending');event('active');event('ended')
    c.setPoseContext('happy');event('ended')
    expect(c.getSnapshot().triggerId).toBe('run.completed.observed')
    c.clear();event('pending',2,'HOLD');event('active',2,'HOLD');event('ended',1)
    expect(c.getSnapshot().triggerId).toBe('interaction.face-hold')
  })
  it.each(['hidden','disabled'] as const)('does not replay a %s gesture on return', mode => {
    const {c,event}=prepare()
    if(mode==='hidden')c.setAvailable(false);else c.setEnabled(false)
    event('pending');event('active');event('ended')
    c.setAvailable(true);c.setEnabled(true);event('active')
    expect(c.getSnapshot().visible).toBe(false)
  })
})
