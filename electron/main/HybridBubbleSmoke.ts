import { app, screen, type BrowserWindow } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { ActivityWindowController } from "./ActivityWindowController"
import type { ActivityService } from "./activity/ActivityService"
import type { DesktopSettingsPatch } from "../shared/desktop-settings"
import type { DictationService } from "./control/DictationService"
import { TASK_CONTROL_IPC } from "../shared/task-control-contract"
import { runBubbleUiSmoke } from "./BubbleUiSmoke"

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Hybrid smoke: ${label}`) }
async function until(check: () => unknown | Promise<unknown>, label: string, ms = 18000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await wait(30) }
  throw new Error(`Hybrid smoke timed out: ${label}`)
}
type Options = {
  pet: BrowserWindow; bubble: ActivityBubbleWindowController; list: ActivityWindowController; activity: ActivityService; dictation: DictationService
  evidenceDirectory: string; dataDirectory: string; hookEndpoint: string
  updateSettings(patch: DesktopSettingsPatch): void
  selectCharacter(id: string): Promise<void>
  reloadPet(): Promise<void>
  setLayout(value: boolean): void
}
/** Opt-in isolated Hook/UI QA. Never sends to an account or records a microphone. */
export async function runHybridBubbleSmoke(o: Options) {
  await mkdir(o.evidenceDirectory, { recursive: true })
  const token = (await readFile(join(o.dataDirectory, "adapter-token"), "utf8")).trim()
  const hook = async (turnId: string, hookEventName: string, fields: Record<string, unknown> = {}) => {
    const response = await fetch(o.hookEndpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ payloadVersion: 1, sessionId: "hybrid-smoke", turnId, model: "smoke", permissionMode: "default", hookEventName, ...(hookEventName === "Stop" ? { stopHookActive: false } : {}), ...fields }) })
    assert(response.status === 202, "fixture Hook accepted")
  }
  const pet = (code: string) => o.pet.webContents.executeJavaScript(code)
  const card = (code: string) => o.bubble.window!.webContents.executeJavaScript(code)
  const dialogue = async () => o.bubble.speech.window?.isVisible() ? o.bubble.speech.window.webContents.executeJavaScript(`(() => { const n = document.querySelector('.speech-bubble'); return n && n.dataset.phase !== 'hidden' ? { phase: n.dataset.phase, text: n.textContent } : null })()`) : null
  const cardVisible = () => Boolean(o.bubble.window?.isVisible())
  const click = (label: string) => card(`(() => { const b = [...document.querySelectorAll('.activity-view button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(label)} && !b.disabled); if (!b) throw new Error('missing QA button'); b.click() })()`)
  const acknowledgeAll = () => o.activity.acknowledge({ targets: o.activity.snapshot().entries.filter(r => r.unread).map(({ activityId, revision }) => ({ activityId, revision })) })
  const frames: Array<Record<string, unknown>> = [], geometry: Array<Record<string, unknown>> = []
  const shot = async (name: string) => {
    await wait(100)
    await writeFile(join(o.evidenceDirectory, `${name}-pet.png`), (await o.pet.webContents.capturePage()).toPNG())
    if (o.bubble.speech.window?.isVisible()) await writeFile(join(o.evidenceDirectory, `${name}-speech.png`), (await o.bubble.speech.window.webContents.capturePage()).toPNG())
    if (cardVisible()) await writeFile(join(o.evidenceDirectory, `${name}-card.png`), (await o.bubble.window!.webContents.capturePage()).toPNG())
  }
  const captureGeometry = async (name: string) => {
    const bounds = o.bubble.window!.getBounds(), petBounds = o.pet.getBounds(), area = screen.getDisplayMatching(petBounds).workArea
    const relative = { x: bounds.x - petBounds.x, y: bounds.y - petBounds.y, width: bounds.width, height: bounds.height }
    const overlap = await pet(`(() => { const c = document.querySelector('canvas'), copy = document.createElement('canvas'); copy.width = c.clientWidth; copy.height = c.clientHeight; const ctx = copy.getContext('2d'); ctx.drawImage(c,0,0,copy.width,copy.height); const pixels = ctx.getImageData(0,0,copy.width,copy.height).data, r = ${JSON.stringify(relative)}; let count = 0; for (let y = Math.max(0,r.y); y < Math.min(copy.height,r.y+r.height); y++) for (let x = Math.max(0,r.x); x < Math.min(copy.width,r.x+r.width); x++) if (pixels[(Math.floor(y)*copy.width+Math.floor(x))*4+3] >= 16) count++; return count; })()`)
    const content = await card(`(() => { const m = document.querySelector('.activity-view main'); return { height: m.getBoundingClientRect().height, scrollHeight: m.scrollHeight, width: m.getBoundingClientRect().width, viewport: innerHeight, clippedButtons: [...m.querySelectorAll('button')].filter(b => b.checkVisibility() && (b.getBoundingClientRect().bottom > innerHeight || b.getBoundingClientRect().right > innerWidth)).length } })()`)
    const entry = { name, bounds, petBounds, workArea: area, scaleFactor: screen.getDisplayMatching(petBounds).scaleFactor, overlap, content }
    geometry.push(entry)
    assert(overlap === 0, `card leaves artwork unobscured (${name}, ${overlap} pixels)`)
    assert(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height, "card inside work area")
    assert(content.clippedButtons === 0 && content.height + 6 <= content.viewport + 1, "all content and buttons fit")
    await shot(name)
  }
  const startFrames = () => {
    let stopped = false, busy = false
    const timer = setInterval(() => {
      if (stopped || busy) return
      busy = true
      void dialogue().then(d => frames.push({ at: Date.now(), phase: d?.phase ?? "hidden", card: cardVisible(), counts: o.activity.snapshot().counts })).finally(() => { busy = false })
    }, 16)
    return async () => { stopped = true; clearInterval(timer); while (busy) await wait(10) }
  }
  let stopFrames: (() => Promise<void>) | null = null
  let nativeReview: Record<string, unknown> | null = null
  const nativeIdle = process.env.ELECTRON_SMOKE_HYBRID_NATIVE_IDLE === "1"
  try {
    acknowledgeAll()
    o.updateSettings({ visible: true, taskBubblesEnabled: true, speechBubblesEnabled: false, scale: 1 })
    await o.selectCharacter("gpichan")
    await o.reloadPet() // Earlier desktop smoke cues must not consume this fixture's cooldown.
    await until(() => !cardVisible(), "empty has no automatic card")
    await shot("empty")
    await hook("A", "UserPromptSubmit")
    await until(cardVisible, "running card")
    await until(async () => await card("document.querySelector('.activity-view main')?.dataset.state === 'running'"), "running DOM")
    const aName = await card("document.querySelector('.task-name').textContent")
    await captureGeometry("running")
    await hook("B", "UserPromptSubmit"); await hook("B", "PreToolUse", { toolName: "request_user_input", toolUseId: "question" })
    await until(async () => await card("document.querySelector('.bubble-summary').textContent.includes('입력 필요 1')"), "global attention visible")
    assert(await card("document.querySelector('.task-name').textContent") === aName, "manual selection survives a higher priority arrival")
    await shot("selected-running-with-waiting")
    await click("다음 작업")
    await until(async () => await card("document.querySelector('.activity-view main').dataset.state === 'waiting'"), "waiting selected")
    await captureGeometry("waiting")
    await click("다음 작업")
    await hook("A", "PreToolUse", { toolName: "request_user_input", toolUseId: "question-A" })
    await wait(2000) // Allow the first waiting PSD decode and enter transition to settle.
    o.updateSettings({ speechBubblesEnabled: true })
    await pet("window.petDesktop.getSettings()")
    stopFrames = startFrames()
    await hook("B", "PostToolUse", { toolName: "request_user_input", toolUseId: "question" }) // The visible pose resumes writing.
    await until(async () => Boolean(await dialogue()), "dialogue starts")
    assert(!cardVisible(), "card hidden before speech")
    const list = o.list.open()
    await until(() => !list.webContents.isLoadingMainFrame(), "explicit list ready")
    await shot("dialogue")
    await hook("A", "Stop")
    assert(list.isVisible(), "explicit list stays open during speech")
    await hook("C", "UserPromptSubmit"); await hook("C", "Stop")
    const a = o.activity.snapshot().entries.find(r => r.unread)!
    o.activity.acknowledge({ targets: [{ activityId: a.activityId, revision: a.revision }] })
    await until(async () => !await dialogue() && cardVisible(), "latest card returns after real fade")
    assert(o.activity.snapshot().entries.some(r => r.unread), "completion during speech retained")
    await stopFrames(); stopFrames = null
    assert(frames.some(f => f.phase === "shown") && frames.some(f => f.phase === "exiting") && !frames.some(f => f.phase !== "hidden" && f.card), "frame sequence has no simultaneous card and dialogue")
    await shot("returned-result")
    list.close()
    o.updateSettings({ speechBubblesEnabled: false })
    await hook("B", "Stop")
    await until(() => o.activity.snapshot().counts.waiting === 0, "waiting resumed")
    // A restored / Hook-only entry cannot navigate; the actual UI must still acknowledge it.
    await until(async () => await card("Boolean(document.querySelector('.activity-view .confirm'))"), "unmapped result confirm button")
    const before = o.activity.snapshot().entries.filter(r => r.unread).length
    await click("확인")
    await until(() => o.activity.snapshot().entries.filter(r => r.unread).length === before - 1, "individual acknowledgement")
    assert(o.activity.snapshot().entries.some(r => r.unread), "other unread result preserved")
    await captureGeometry("completed")
    await hook("F", "UserPromptSubmit"); await hook("F", "Stop")
    await until(() => o.activity.snapshot().entries.filter(r => r.unread).length >= 2, "pointer race has two results")
    // Start this gesture fixture with a fresh dialogue cooldown/pose context.
    await o.reloadPet(); await until(cardVisible, "fresh pointer fixture renderer")
    const pressedName = await card("document.querySelector('.task-name').textContent")
    const pressedId = await card("document.querySelector('.activity-view main').dataset.activityId")
    const pressedEntry = o.activity.snapshot().entries.find(r => r.activityId === pressedId)!
    const others = o.activity.snapshot().entries.filter(r => r.unread && r.activityId !== pressedEntry.activityId).map(r => r.activityId)
    await card("window.__hybridInput = []; for (const type of ['pointerdown','pointerup','pointercancel','lostpointercapture','blur']) window.addEventListener(type, e => window.__hybridInput.push({type, at: Date.now(), target: e.target?.getAttribute?.('class'), buttons: e.buttons}), true)")
    const point = await card("(() => { const r = document.querySelector('.task-links .confirm').getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } })()")
    o.bubble.window!.webContents.sendInputEvent({ type: "mouseMove", ...point })
    o.bubble.window!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
    await until(() => o.bubble.presentation.interactionLocked, "native down locks before dispatch")
    o.pet.focus(); await wait(80)
    assert(o.bubble.presentation.interactionLocked, "focus change preserves a captured down/up gesture")
    o.activity.acknowledge({ targets: [{ activityId: pressedEntry.activityId, revision: pressedEntry.revision }] })
    o.updateSettings({ speechBubblesEnabled: true }); await pet("window.petDesktop.getSettings()")
    await hook("G", "UserPromptSubmit")
    await until(async () => await pet("Boolean(document.querySelector('.speech-bubble[data-phase=shown]'))"), "dialogue prepared during held pointer")
    assert(cardVisible() && !await dialogue(), "held pointer defers dialogue painting")
    assert(await card("document.querySelector('.task-name').textContent") === pressedName, "down/up target frozen after external acknowledgement")
    assert(await card("document.querySelector('.activity-view main').dataset.activityId") === pressedId, "same-title entries retain exact identity")
    await shot("pointer-held")
    o.bubble.window!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
    await until(async () => Boolean(await dialogue()) && !cardVisible(), "pointer/action completion releases dialogue")
    assert(others.every(id => o.activity.snapshot().entries.find(r => r.activityId === id)?.unread), "late confirm never acknowledges another result")
    o.updateSettings({ speechBubblesEnabled: false }); await hook("G", "Stop")
    await until(cardVisible, "card after pointer race")
    for (const character of ["gpichan", "asuma-toki-v2"]) {
      await o.selectCharacter(character)
      for (const size of [280, 320, 460, 720]) {
        o.updateSettings({ scale: size / 460 }); await wait(250)
        await until(cardVisible, "card after size and character change")
        await captureGeometry(`${character}-${size}`)
      }
    }
    o.updateSettings({ scale: 1 })
    await o.selectCharacter("gpichan")
    await card("document.querySelector('.bubble-menu').open = true")
    await click("접기")
    const selectedName = await card("document.querySelector('.activity-view main').dataset.state")
    o.updateSettings({ speechBubblesEnabled: true })
    await hook("D", "UserPromptSubmit")
    await until(async () => Boolean(await dialogue()), "speech with collapsed card")
    await until(async () => !await dialogue() && cardVisible(), "collapsed card returns")
    assert(o.bubble.getView().collapsed && await card("document.querySelector('.activity-view main').classList.contains('compact')"), "collapsed state preserved")
    assert(await card("document.querySelector('.activity-view main').dataset.state") === selectedName, "selection preserved")
    await shot("collapsed-return")
    o.updateSettings({ speechBubblesEnabled: false }); await hook("D", "Stop")
    // Explicit control view occupies its own adjacent slot, including IME and dictation.
    // Start with a fresh cue cooldown, just like the pointer-race fixture above.
    await o.reloadPet(); await until(cardVisible, "fresh explicit-control fixture")
    o.bubble.setView("control", false)
    await until(async () => await card("!document.querySelector('.control-panel').hidden"), "control shown")
    await card(`(() => { const n = document.querySelector('textarea'); n.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'유지할 초안'); n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'ㅎ'})); })()`)
    const cancel = o.dictation.cancel.bind(o.dictation), start = o.dictation.start.bind(o.dictation)
    let cancelled = 0
    o.dictation.cancel = () => { cancelled++; cancel() }
    o.dictation.start = id => o.bubble.send(TASK_CONTROL_IPC.dictation, { sessionId: id, state: "listening", text: "", error: null })
    try {
      await card("document.querySelector('[aria-label=\"음성 받아쓰기\"]').click()")
      await until(async () => await card("Boolean(document.querySelector('[aria-label=\"받아쓰기 중지\"]'))"), "synthetic dictation active")
      const beforeCancel = cancelled
      o.updateSettings({ speechBubblesEnabled: true }); await hook("E", "UserPromptSubmit")
      await until(async () => Boolean(await dialogue()), "speech while explicit control active")
      assert(cardVisible() && cancelled === beforeCancel, "speech does not hide controls or cancel dictation")
      assert(await card("document.querySelector('textarea').value") === "유지할 초안", "draft retained")
      await shot("dialogue-with-explicit-control")
      o.updateSettings({ visible: false })
      await until(() => !cardVisible(), "user hide hides controls")
      await until(() => cancelled > beforeCancel, "real user hide still cancels dictation")
    } finally { o.dictation.cancel = cancel; o.dictation.start = start; o.dictation.cancel() }
    o.updateSettings({ visible: true, speechBubblesEnabled: false })
    o.bubble.setView("activity", false)
    await hook("E", "Stop"); await until(cardVisible, "card after controls")
    o.setLayout(true); await until(() => !cardVisible(), "layout suppresses automatic card")
    o.setLayout(false); await until(cardVisible, "leaving layout restores card")
    o.pet.minimize(); await until(() => !cardVisible(), "minimize hides card")
    o.pet.restore(); await until(cardVisible, "restore returns card")
    const count = o.activity.snapshot().entries.filter(r => r.unread).length
    await o.reloadPet(); await until(cardVisible, "reload recovers arbitration")
    assert(o.activity.snapshot().entries.filter(r => r.unread).length === count, "reload preserves unread")
    o.updateSettings({ taskBubblesEnabled: false }); assert(!cardVisible(), "task toggle independent")
    o.updateSettings({ taskBubblesEnabled: true }); await until(cardVisible, "task toggle restored")
    if (process.env.ELECTRON_SMOKE_HYBRID_NATIVE_REVIEW === "1") {
      await card("window.__hybridNativeClicks = []; document.addEventListener('click', e => { const n = e.target.closest?.('button,summary'); if (n && e.isTrusted) window.__hybridNativeClicks.push({ at: Date.now(), label: n.getAttribute('aria-label') || n.textContent.trim() }) }, true)")
      const unreadBefore = o.activity.snapshot().entries.filter(r => r.unread).length
      app.setAccessibilitySupportEnabled(true)
      o.bubble.window!.focus(); o.bubble.window!.webContents.focus()
      process.stdout.write("HYBRID_NATIVE_REVIEW_READY\n")
      let listSeen = false, listClosedAt = 0
      const end = Date.now() + 180_000
      while (Date.now() < end) {
        if (o.list.window?.isVisible()) listSeen = true
        if (listSeen && !o.list.window && !listClosedAt) listClosedAt = Date.now()
        if (listClosedAt && Date.now() - listClosedAt > 10_000) break
        await wait(1000)
      }
      const clicks = await card("window.__hybridNativeClicks")
      nativeReview = { clicks, listSeen, listClosed: Boolean(listClosedAt), unreadPreserved: o.activity.snapshot().entries.filter(r => r.unread).length === unreadBefore }
      await shot("native-final")
      await writeFile(join(o.evidenceDirectory, "native-review.json"), JSON.stringify(nativeReview, null, 2) + "\n")
      assert(clicks.length >= 2 && listSeen && listClosedAt, "native menu/list clicks observed")
    }
    acknowledgeAll(); await until(() => !cardVisible(), "acknowledged history leaves no card")
    await shot("final-empty")
    o.updateSettings({ speechBubblesEnabled: true }); await pet("window.petDesktop.getSettings()")
    o.pet.focus()
    if (nativeIdle) {
      process.stdout.write("HYBRID_NATIVE_IDLE_READY: click Gpichan's face with no task candidates.\n")
    } else {
      const point = await pet("(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(r.x+r.width*634/1280), y: Math.round(r.y+r.height*210/1280) } })()")
      o.pet.webContents.sendInputEvent({ type: "mouseMove", ...point })
      o.pet.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
      o.pet.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
    }
    await until(async () => await pet("Boolean(document.querySelector('.speech-bubble[data-trigger=\"interaction.head-tap\"][data-phase=shown]'))") && Boolean(await dialogue()), "touch dialogue without task candidates", 90_000)
    assert(!cardVisible(), "empty touch shows only dialogue")
    await shot("empty-touch")
    await until(async () => !await dialogue() && !cardVisible(), "empty touch ends without leaving a card")
    await shot("empty-touch-ended")
    const result = { nativeReview, rendererDevicePixelRatio: await pet("devicePixelRatio"), syntheticHooks: true, realAccountActions: false, nativeMicrophoneRecorded: false, dialoguePriority: true, actualFadeLifetime: true, globalAttention: true, separateAcknowledgement: true, nativeDispatchPointerRace: true, heldInputDefersDialogue: true, selectionAndCollapsePreserved: true, explicitListPreserved: true, explicitControlAndSyntheticDictationPreserved: true, userHideCancelsDictation: true, loadingLayoutMinimizeReload: true, independentSettings: true, geometry, frames }
    const uiRefinements = process.env.ELECTRON_SMOKE_BUBBLE_UI === "1" ? await runBubbleUiSmoke(o) : null
    const verified = { ...result, emptyTouchDialogue: true, emptyTouchNativeInput: nativeIdle, uiRefinements }
    await writeFile(join(o.evidenceDirectory, "hybrid-smoke.json"), JSON.stringify(verified, null, 2) + "\n")
    return verified
  } catch (error) {
    await shot("failure").catch(() => {})
    const debug = { cardVisible: cardVisible(), locked: o.bubble.presentation.interactionLocked, canShowActivity: o.bubble.presentation.canShowActivity, view: o.bubble.getView(), dialogue: await dialogue().catch(() => null), input: await card("window.__hybridInput ?? []").catch(() => []) }
    await writeFile(join(o.evidenceDirectory, "failure-details.json"), JSON.stringify({ error: error instanceof Error ? error.message : String(error), debug, geometry, frames }, null, 2) + "\n")
    throw error
  } finally { await stopFrames?.() }
}
