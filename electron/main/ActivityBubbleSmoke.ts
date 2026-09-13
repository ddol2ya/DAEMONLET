import { screen, type BrowserWindow } from "electron"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { ActivityService } from "./activity/ActivityService"
import type { DesktopSettingsPatch } from "../shared/desktop-settings"
import { intersectionArea } from "../shared/desktop-settings"

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Activity bubble smoke: ${label}`) }
async function until(check: () => unknown | Promise<unknown>, label: string) {
  const end = Date.now() + 15_000
  while (Date.now() < end) { if (await check()) return; await wait(60) }
  throw new Error(`Activity bubble smoke timed out: ${label}`)
}
export async function runActivityBubbleSmoke(o: {
  bubble: ActivityBubbleWindowController; pet: BrowserWindow; activity: ActivityService; evidenceDirectory: string;
  updateSettings(patch: DesktopSettingsPatch): void; listWindow(): BrowserWindow | null;
}) {
  await mkdir(o.evidenceDirectory, { recursive: true })
  o.updateSettings({ speechBubblesEnabled: false })
  await until(() => o.bubble.window?.isVisible(), "visible")
  const win = o.bubble.window!
  const evaluate = (code: string) => win.webContents.executeJavaScript(code)
  await until(async () => !win.webContents.isLoadingMainFrame() && await evaluate("Boolean(document.querySelector('.activity-view main'))"), "card rendered")
  const click = async (label: string) => {
    await until(async () => await evaluate(`[...document.querySelectorAll('.activity-view button')].some(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(label)} && !b.disabled)`), label)
    await evaluate(`[...document.querySelectorAll('.activity-view button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(label)}).click()`)
    await wait(100)
  }
  const selectState = async (state: string) => {
    for (let i = 0; i <= o.activity.snapshot().entries.length; i++) {
      if (await evaluate(`document.querySelector('.activity-view main').dataset.state === ${JSON.stringify(state)}`)) return
      await click("다음 작업")
    }
    throw new Error("Activity bubble smoke: state not found")
  }
  await selectState("waiting")
  const shot = async (name: string) => { await wait(120); await writeFile(join(o.evidenceDirectory, name), (await win.webContents.capturePage()).toPNG()) }
  const initialCounts = o.activity.snapshot().counts
  const preferences = (win.webContents as typeof win.webContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
  assert(preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration && preferences.webSecurity, "isolated companion")
  assert(await evaluate("!document.querySelector('canvas') && !window.petDesktop && !('protocol' in window.activityDesktop)"), "no character renderer or protocol bridge")
  // The companion opening/updating must not activate itself over another app window.
  assert(!win.isFocused(), "showInactive does not steal focus")
  const petBounds = o.pet.getBounds()
  const area = screen.getDisplayMatching(petBounds).workArea
  o.pet.setBounds({ ...petBounds, x: area.x + 40, y: area.y + 210 })
  await wait(160)
  const firstBounds = win.getBounds()
  o.pet.setBounds({ ...o.pet.getBounds(), x: area.x + 90 })
  await wait(160)
  assert(win.getBounds().x !== firstBounds.x, "follows native movement")
  const geometry: Array<Record<string, unknown>> = []
  for (const [x, y] of [[area.x, area.y], [area.x + area.width - petBounds.width, area.y + area.height - petBounds.height]]) {
    o.pet.setBounds({ ...petBounds, x, y }); await wait(140)
    const bubble = win.getBounds(), pet = o.pet.getBounds()
    assert(intersectionArea(bubble, area) === bubble.width * bubble.height, "within work area")
    const anchor = o.bubble.presentation.anchor!
    const head = { x: pet.x + anchor.x0 * pet.width, y: pet.y + anchor.y0 * pet.height, width: (anchor.x1 - anchor.x0) * pet.width, height: (anchor.y1 - anchor.y0) * pet.height }
    assert(intersectionArea(bubble, head) === 0, "outside visible head anchor")
    geometry.push({ bubble, pet, workArea: area })
  }
  await shot("bubble-waiting.png")
  await writeFile(join(o.evidenceDirectory, "pet-with-dialogue.png"), (await o.pet.webContents.capturePage()).toPNG())
  await selectState("failed")
  await shot("bubble-failed.png")
  await evaluate("document.querySelector('.bubble-menu').open = true"); await wait(100)
  await click("접기")
  await until(async () => win.getBounds().height >= 44 && await evaluate("document.querySelector('main').classList.contains('compact')"), "collapsed")
  assert(win.getBounds().width === 64 && win.getBounds().height === 44, "minimal icon footprint")
  await shot("bubble-compact.png")
  await click("작업 알림 펼치기")
  await until(async () => !await evaluate("document.querySelector('main').classList.contains('compact')"), "expanded")
  assert(JSON.stringify(o.activity.snapshot().counts) === JSON.stringify(initialCounts), "cycle/collapse is not acknowledgement")
  o.updateSettings({ speechBubblesEnabled: false })
  assert(win.isVisible(), "dialogue toggle independent")
  o.updateSettings({ speechBubblesEnabled: true, taskBubblesEnabled: false })
  assert(!win.isVisible(), "task toggle hides companion")
  o.updateSettings({ taskBubblesEnabled: true })
  await until(() => win.isVisible(), "task toggle restored")
  o.updateSettings({ visible: false }); assert(!win.isVisible(), "pet hide hides companion")
  o.updateSettings({ visible: true }); await until(() => win.isVisible(), "pet show restores companion")
  await click("작업 목록 열기")
  assert(o.listWindow()?.isVisible(), "list button opens actual window")
  assert(JSON.stringify(o.activity.snapshot().counts) === JSON.stringify(initialCounts), "open list is not acknowledgement")
  assert(!await evaluate("[...document.querySelectorAll('.task-links button')].some(b => b.textContent.includes('대화 열기'))"), "unmapped result has no navigation action")
  await click("확인")
  await until(() => o.activity.snapshot().counts.failed === initialCounts.failed - 1, "explicit local acknowledgement from UI")
  assert(o.activity.snapshot().counts.waiting === initialCounts.waiting && o.activity.snapshot().counts.completed === initialCounts.completed, "ack only selected result")
  await selectState("running")
  await shot("bubble-running.png")
  win.webContents.reload()
  await until(async () => !win.webContents.isLoadingMainFrame() && await evaluate("document.querySelector('main')?.dataset.state === 'waiting'"), "reload retains activity")
  assert(o.activity.snapshot().counts.waiting === initialCounts.waiting, "reload leaves waiting")
  o.pet.setBounds(petBounds)
  return { synthetic: true, realCodexControl: false, waitingPriority: true, cycle: true, collapse: true, noAutomaticAcknowledgement: true, unmappedResultIndividuallyAcknowledged: true, explicitLocalAcknowledgement: true, independentToggles: true, hideShow: true, followsPet: true, noFocusSteal: true, secureWindow: true, rendererReload: true, geometry, screenshots: ["bubble-waiting.png", "bubble-failed.png", "bubble-compact.png", "bubble-running.png", "pet-with-dialogue.png"] }
}
