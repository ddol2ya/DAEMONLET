import type { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { ActivityService } from "./activity/ActivityService"
import type { DesktopSettingsPatch } from "../shared/desktop-settings"
import { TASK_CONTROL_IPC, type TaskControlSnapshot } from "../shared/task-control-contract"

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Bubble UI smoke: ${label}`) }
async function until(check: () => unknown | Promise<unknown>, label: string) {
  const end = Date.now() + 20_000
  while (Date.now() < end) { if (await check()) return; await wait(40) }
  throw new Error(`Bubble UI smoke timed out: ${label}`)
}

/** UI + real worker/title-index path, entirely inside the smoke's temporary Home. */
export async function runBubbleUiSmoke(o: { pet: BrowserWindow; bubble: ActivityBubbleWindowController; activity: ActivityService; evidenceDirectory: string; dataDirectory: string; hookEndpoint: string; updateSettings(patch: DesktopSettingsPatch): void }) {
  const home = process.env.CODEX_HOME!, userData = process.env.ELECTRON_SMOKE_USER_DATA!
  assert(process.env.ELECTRON_SMOKE_TEST === "1" && home && userData, "isolated fixture required")
  const directory = join(o.evidenceDirectory, "ui-refinements"), date = new Date().toISOString(), sessionId = randomUUID(), turnId = randomUUID()
  const folder = join(home, "sessions", ...date.slice(0, 10).split("-"))
  await mkdir(folder, { recursive: true, mode: 0o700 }); await mkdir(directory, { recursive: true })
  const path = join(folder, `rollout-${date.slice(0, 19).replaceAll(":", "-")}-${sessionId}.jsonl`)
  const title = "세션 제목 표시와 긴 제목 말줄임을 확인하는 합성 테스트 · 카드와 제어 창에서 같은 대화를 찾을 수 있어야 합니다"
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: sessionId, source: "vscode" } }) + "\n", { mode: 0o600 })
  const db = new DatabaseSync(join(home, "state_5.sqlite"))
  db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, updated_at INTEGER, archived INTEGER)")
  db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?)").run(sessionId, path, folder, "첫 메시지 대체 제목", "vscode", Date.now(), 0); db.close()
  const nameRecord = (name: string) => JSON.stringify({ id: sessionId, thread_name: name, updated_at: new Date().toISOString() }) + "\n"
  await writeFile(join(home, "session_index.jsonl"), nameRecord(title), { mode: 0o600 })
  const token = (await readFile(join(o.dataDirectory, "adapter-token"), "utf8")).trim()
  const hook = async (event: string) => {
    await appendFile(path, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: event === "Stop" ? "task_complete" : "task_started", turn_id: turnId } }) + "\n")
    const response = await fetch(o.hookEndpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ payloadVersion: 1, sessionId, turnId, model: "smoke", permissionMode: "default", hookEventName: event, ...(event === "Stop" ? { stopHookActive: false } : {}) }) })
    assert(response.status === 202, "fixture Hook accepted")
  }
  const card = (code: string) => o.bubble.window!.webContents.executeJavaScript(code)
  const shot = async (name: string) => { await wait(120); await writeFile(join(directory, name + ".png"), (await o.bubble.window!.webContents.capturePage()).toPNG()) }
  const click = async (selector: string) => {
    const point = await card(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
    for (const type of ["mouseMove", "mouseDown", "mouseUp"] as const) o.bubble.window!.webContents.sendInputEvent({ type, ...point, ...(type !== "mouseMove" ? { button: "left" as const, clickCount: 1 } : {}) })
    await wait(160)
  }
  o.updateSettings({ visible: true, speechBubblesEnabled: false, taskBubblesEnabled: true })
  o.bubble.setView("activity", false)
  await hook("UserPromptSubmit")
  await until(() => o.activity.snapshot().entries.some(r => r.name === title), "renamed session title from actual metadata index")
  await until(async () => o.bubble.window?.isVisible() && await card("document.querySelector('.task-name')?.textContent") === title, "session title rendered")
  await hook("Stop")
  await until(() => o.activity.snapshot().entries.some(r => r.name === title && r.unread), "completed title retained")
  await shot("session-title")
  const header = () => card("(() => { const n=document.querySelector('.activity-view .bubble-top'),r=n.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} })()")
  const before = await header()
  await click(".bubble-menu summary")
  await until(async () => await card("document.querySelector('.bubble-menu').open"), "menu opens")
  const menu = await card("(() => { const n=document.querySelector('.bubble-menu-panel'),r=n.getBoundingClientRect(); return {x:r.x,y:r.y,bottom:r.bottom,right:r.right,viewportHeight:innerHeight,viewportWidth:innerWidth,position:getComputedStyle(n).position} })()")
  assert(JSON.stringify(await header()) === JSON.stringify(before), "menu does not reflow its header")
  assert(menu.position === "absolute" && menu.bottom <= menu.viewportHeight && menu.right <= menu.viewportWidth, "popover fits native viewport")
  await shot("menu-popover")
  o.bubble.window!.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); o.bubble.window!.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" })
  await until(async () => !await card("document.querySelector('.bubble-menu').open"), "Escape closes menu")
  assert(!o.bubble.getView().collapsed, "first Escape does not collapse the card")
  await click(".bubble-menu summary")
  await click(".bubble-menu-panel button:nth-child(2)")
  await until(async () => Boolean(await card("document.querySelector('.mini-task-chip')")), "minimal indicator shown")
  const compact = o.bubble.window!.getBounds()
  assert(compact.width === 64 && compact.height === 44, "64 by 44 DIP mini indicator")
  assert(await card("document.querySelectorAll('.activity-view button').length") === 1, "one expandable mini button")
  await shot("minimal-indicator")
  await card("document.querySelector('.mini-task-chip').addEventListener('pointerdown', e => { window.__miniPointerCapture = e.currentTarget.hasPointerCapture(e.pointerId) }, { once: true })")
  await click(".mini-task-chip svg")
  assert(await card("window.__miniPointerCapture === true"), "SVG icon press captures the containing button")
  await until(async () => await card("document.querySelector('.task-name')?.textContent") === title, "expand retains selected title")
  const snapshot: TaskControlSnapshot = { revision: 1_000_000, connection: "ready", source: "desktop", autoConnect: false, socketPath: "", selectedKey: sessionId, pending: false, issue: null, needsClient: false, threads: [{ key: sessionId, title, project: "", revision: 1, state: "idle", canSend: false, canStop: false, canOpenConversation: false }] }
  o.bubble.send(TASK_CONTROL_IPC.changed, snapshot); o.bubble.setView("control", false)
  await until(async () => !await card("document.querySelector('.control-panel').hidden"), "explicit control displayed")
  await click("[aria-label='Codex 제어 접기']")
  await until(() => o.bubble.window!.getBounds().height === 52, "control title bar collapsed")
  const ellipsis = await card("(() => { const n=document.querySelector('.control-panel strong'),s=getComputedStyle(n),b=document.querySelector('.control-panel .icon-button').getBoundingClientRect(); return {text:n.textContent,title:n.title,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,clipped:n.scrollWidth>n.clientWidth,buttonBottom:b.bottom,viewportHeight:innerHeight} })()")
  assert(ellipsis.text === title && ellipsis.title === title && ellipsis.whiteSpace === "nowrap" && ellipsis.textOverflow === "ellipsis" && ellipsis.clipped && ellipsis.buttonBottom <= ellipsis.viewportHeight, "long title ellipsis and expand button fit")
  await shot("control-long-title")
  snapshot.revision++; snapshot.threads[0].title = "짧은 세션 제목"; o.bubble.send(TASK_CONTROL_IPC.changed, snapshot)
  await until(async () => await card("document.querySelector('.control-panel strong').textContent") === "짧은 세션 제목", "short title")
  await shot("control-short-title")
  await click("[aria-label='Codex 제어 펼치기']")
  await click("[aria-label='작업 알림으로 돌아가기']")
  const renamed = "이름 변경이 반영된 세션"
  await appendFile(join(home, "session_index.jsonl"), nameRecord(renamed))
  await until(async () => await card("document.querySelector('.task-name')?.textContent") === renamed, "title refresh after rename")
  await shot("session-renamed")
  await o.activity.flush()
  const saved = await readFile(join(userData, "activity", "history.json"), "utf8")
  assert(!saved.includes(title) && !saved.includes(renamed), "display titles never enter persisted activity history")
  const report = { sessionIndexTitle: true, renameRefreshed: true, activityHistoryContainsTitles: false, menuHeaderUnchanged: true, menu, minimalIndicator: { width: compact.width, height: compact.height, svgPointerCapture: true }, controlTitleEllipsis: ellipsis, syntheticControlSnapshot: true, realAccountActions: false }
  await writeFile(join(directory, "verification.json"), JSON.stringify(report, null, 2) + "\n")
  return report
}
