import { runActivityBubbleSmoke } from "./ActivityBubbleSmoke"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { BrowserWindow } from "electron"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ActivityWindowController } from "./ActivityWindowController"
import type { ActivityService } from "./activity/ActivityService"
import type { DesktopSettingsPatch } from "../shared/desktop-settings"
import { activitySummary } from "../shared/activity-contract"

type Options = {
  activity: ActivityService
  bubble: ActivityBubbleWindowController
  window: ActivityWindowController
  pet: BrowserWindow
  evidenceDirectory: string
  userData: string
  dataDirectory: string
  hookEndpoint: string
  updateSettings(patch: DesktopSettingsPatch): void
  selectCharacter(id: string): Promise<void>
  reloadPet(): Promise<void>
  stopAdapter(): Promise<void>
  startAdapter(): Promise<void>
  bridgeClients(): number
  showMenu(): void
  verifyRestart?(): Promise<Record<string, unknown>>
  verifyResultOpen?(): Promise<Record<string, unknown>>
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Activity smoke: ${label}`) }
async function until(check: () => unknown | Promise<unknown>, label: string, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await wait(60) }
  throw new Error(`Activity smoke timed out: ${label}`)
}
async function ready(win: BrowserWindow) {
  await until(async () => !win.webContents.isLoadingMainFrame() && await win.webContents.executeJavaScript("Boolean(window.activityDesktop && document.querySelector('.counts'))"), "window ready")
}
async function shot(win: BrowserWindow, directory: string, name: string) {
  await wait(160)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name), (await win.webContents.capturePage()).toPNG())
}

/** Explicit synthetic packaged QA only; no test IPC is added to any preload. */
export async function runActivitySmoke(o: Options) {
  const { activity } = o
  await until(() => activity.snapshot().connection === "READY", "main collector ready")
  assert(activity.snapshot().counts.failed === 1, "seeded failure restored")
  const token = (await readFile(join(o.dataDirectory, "adapter-token"), "utf8")).trim()
  const hook = async (turnId: string, hookEventName: string, fields: Record<string, unknown> = {}, expectedStatus = 202) => {
    const response = await fetch(o.hookEndpoint, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ payloadVersion: 1, sessionId: "activity-smoke-session", turnId, model: "smoke", permissionMode: "default", hookEventName, ...(hookEventName === "Stop" ? { stopHookActive: false } : {}), ...fields }),
    })
    assert(response.status === expectedStatus, "synthetic Hook contract")
  }
  await hook("rejected", "UserPromptSubmit", { prompt: "ACTIVITY_PRIVATE_CANARY" }, 400)
  await hook("A", "UserPromptSubmit")
  await hook("A", "PreToolUse", { toolName: "ACTIVITY_PRIVATE_CANARY", toolUseId: "tool-one" })
  await hook("A", "PostToolUse", { toolName: "ACTIVITY_PRIVATE_CANARY", toolUseId: "tool-one" })
  await hook("B", "UserPromptSubmit")
  await hook("B", "PreToolUse", { toolName: "request_user_input", toolUseId: "input-one" })
  await hook("C", "UserPromptSubmit")
  await hook("C", "Stop")
  await until(() => activity.snapshot().counts.completed === 1 && activity.snapshot().counts.waiting === 1, "parallel results")
  const mixed = activity.snapshot().counts
  assert(mixed.running === 1 && mixed.failed === 1, "independent counts")
  const clients = o.bridgeClients()
  let win = o.window.open()
  assert(o.window.open() === win, "single window reuse")
  await ready(win)
  const preferences = (win.webContents as typeof win.webContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
  assert(preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration && preferences.webSecurity, "secure window")
  assert(await win.webContents.executeJavaScript("document.querySelectorAll('canvas').length === 0 && !('protocol' in window.activityDesktop) && !window.petDesktop"), "display-only preload, no WebGL")
  const initialUnread = activity.snapshot().counts.completed + activity.snapshot().counts.failed
  await win.webContents.executeJavaScript("document.querySelector('.activity-row').click(); window.activityDesktop.getSnapshot()")
  assert(activity.snapshot().counts.completed + activity.snapshot().counts.failed === initialUnread, "open/select/query does not acknowledge")
  await until(async () => await win.webContents.executeJavaScript("document.querySelectorAll('.activity-row').length >= 4"), "rows rendered")
  await shot(win, o.evidenceDirectory, "activity-list.png")
  if (process.env.ELECTRON_SMOKE_ACTIVITY_NATIVE_REVIEW === "1") {
    o.showMenu()
    process.stdout.write("ACTIVITY_NATIVE_MENU_READY\n")
    await wait(45_000)
  }
  const bubbleValidation = await runActivityBubbleSmoke({ bubble: o.bubble, pet: o.pet, activity, evidenceDirectory: join(o.evidenceDirectory, "bubble"), updateSettings: o.updateSettings, listWindow: () => o.window.window })
  const summary = activitySummary(activity.snapshot())
  assert(!await win.webContents.executeJavaScript("/ACTIVITY_PRIVATE_CANARY|activity-smoke-session|codex-run-|wire-session/.test(document.body.innerText)"), "no raw DOM data")
  await win.webContents.executeJavaScript("document.querySelector('button.primary').click()")
  await until(() => activity.snapshot().counts.completed === 0 && activity.snapshot().counts.failed === 0, "acknowledge visible results")
  assert(activity.snapshot().counts.waiting === 1, "acknowledgement leaves input waiting")
  assert(await win.webContents.executeJavaScript("document.activeElement.id === 'activity-title'"), "keyboard focus retained")

  o.updateSettings({ visible: false })
  await hook("hidden", "UserPromptSubmit"); await hook("hidden", "Stop")
  await until(() => activity.snapshot().counts.completed === 1, "hidden pet still collects")
  // Hidden Pet rendering intentionally pauses requestAnimationFrame. Make it
  // visible for the subsequent, separate character-ready assertion.
  o.updateSettings({ visible: true })
  const changing = o.selectCharacter("asuma-toki-v2")
  await hook("switch", "UserPromptSubmit"); await hook("switch", "Stop")
  await changing
  assert(activity.snapshot().counts.completed === 2, "character change keeps history")
  const reloading = o.reloadPet()
  await hook("reload", "UserPromptSubmit"); await hook("reload", "Stop")
  await reloading
  await until(() => activity.snapshot().counts.completed === 3, "renderer reload keeps collection")
  await o.selectCharacter("gpichan")
  o.updateSettings({ visible: true })
  win.close()
  await until(() => o.window.window === null, "list closed")
  assert(activity.snapshot().counts.completed === 3, "closing list keeps results")
  for (let cycle = 0; cycle < 3; cycle++) {
    win = o.window.open(); assert(o.window.open() === win, "reused window")
    await ready(win)
    if (cycle < 2) { win.close(); await until(() => o.window.window === null, "closed cycle") }
  }
  await until(() => o.bridgeClients() === clients, "renderer bridge count unchanged")
  await o.stopAdapter()
  await until(() => activity.snapshot().connection !== "READY", "disconnected")
    await until(async () => await win.webContents.executeJavaScript("document.body.innerText.includes('연결 확인 중')"), "disconnected copy")
  assert(activity.snapshot().counts.failed === 0 && activity.snapshot().counts.completed === 3, "disconnect is not task failure")
  await shot(win, o.evidenceDirectory, "activity-disconnected.png")
  await o.startAdapter(); activity.reconnect()
  await until(() => activity.snapshot().connection === "READY", "reconnected")
  await hook("C", "UserPromptSubmit"); await hook("C", "Stop")
  await wait(120)
  assert(activity.snapshot().counts.completed === 3, "restart does not revive acknowledged result")

  const path = join(o.userData, "activity/history.json"), backup = join(o.userData, "activity/smoke-history.backup")
  await activity.flush(); await rename(path, backup); await mkdir(path)
  try {
    await hook("write-failure", "UserPromptSubmit"); await hook("write-failure", "Stop")
    await until(() => activity.snapshot().counts.completed === 4, "result in memory")
    await activity.flush()
    assert(activity.snapshot().storage === "error", "persistence failure advertised")
    await until(async () => await win.webContents.executeJavaScript("document.body.innerText.includes('이력 저장 실패')"), "storage error rendered")
    await shot(win, o.evidenceDirectory, "activity-storage-error.png")
  } finally { await rm(path, { recursive: true, force: true }); await rename(backup, path) }
  await hook("B", "PostToolUse", { toolName: "request_user_input", toolUseId: "input-one" })
  await until(() => activity.snapshot().counts.waiting === 0, "resume clears wait")
  await hook("A", "Interrupt"); await hook("B", "Interrupt")
  const restartValidation = await o.verifyRestart?.()
  const resultOpenValidation = await o.verifyResultOpen?.()
  await hook("offline", "UserPromptSubmit")
  await until(() => activity.snapshot().counts.running === 1, "restart fixture active")
  await activity.flush()
  assert(activity.snapshot().storage === "saved", "storage recovered")
  assert(!(await readFile(path, "utf8")).includes("ACTIVITY_PRIVATE_CANARY"), "history excludes raw text")
  const retained = activity.snapshot().entries.map(({ activityId, state, unread }) => ({ activityId, state, unread }))
  win.close()
  return {
    bubbleValidation, restartValidation, resultOpenValidation, syntheticHookObserver: true, realCodexTask: false, mixedCounts: mixed, summary,
    secureWindow: true, noWebGL: true, windowReuse: true, noAutomaticAcknowledgement: true, acknowledgementKeepsWait: true,
    focusRetained: true, hiddenPetCollection: true, characterSwitchCollection: true, rendererReloadCollection: true,
    windowCyclesNoExtraBridgeClients: true, disconnectUncertainty: true, reconnectNoResurrection: true,
    storageFailureVisible: true, storageRecovered: true, privacyCanaryAbsent: true,
    navigation: activity.snapshot().navigation, retained,
    screenshots: ["activity-list.png", "activity-disconnected.png", "activity-storage-error.png"],
  }
}

export async function runActivityRestoreSmoke(activity: ActivityService, window: ActivityWindowController, evidenceDirectory: string) {
  await until(() => activity.snapshot().connection === "READY", "restored collector ready")
  const win = window.open(); await ready(win)
  assert(activity.snapshot().counts.completed > 0, "unread history restored")
  assert(activity.snapshot().entries.some(r => r.state === "unknown"), "missing offline Run is unknown")
  await shot(win, evidenceDirectory, "activity-restarted.png")
  return { restored: true, navigation: activity.snapshot().navigation, entries: activity.snapshot().entries.map(({ activityId, state, unread }) => ({ activityId, state, unread })) }
}
