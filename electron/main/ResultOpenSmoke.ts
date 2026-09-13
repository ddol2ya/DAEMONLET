import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ActivityService } from "./activity/ActivityService"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { ActivityWindowController } from "./ActivityWindowController"
import { CodexThreadLauncher } from "./control/CodexThreadLauncher"

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Result open smoke: ${label}`) }
async function until(check: () => unknown | Promise<unknown>, label: string) {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await check()) return; await wait(70) }
  throw new Error(`Result open smoke timed out: ${label}`)
}

/** Real packaged file observation, React, IPC and target verification; external launch only is mocked. */
export async function runResultOpenSmoke(o: { activity: ActivityService; bubble: ActivityBubbleWindowController; list: ActivityWindowController; launcher: CodexThreadLauncher; home: string; evidenceDirectory: string }) {
  assert(process.env.ELECTRON_SMOKE_TEST === "1" && process.env.ELECTRON_SMOKE_USER_DATA, "isolated fixture")
  await mkdir(o.evidenceDirectory, { recursive: true })
  const opened: string[] = [], allowed = new Set<string>()
  let rejectNext = true
  const original = o.launcher.open
  const verifying = new CodexThreadLauncher({ home: o.home, app: { openThread: async id => {
    assert(allowed.has(id), "known result session")
    if (rejectNext) { rejectNext = false; throw new Error("SYNTHETIC_OPEN_FAILURE") }
    return "opened"
  } } })
  o.launcher.open = async target => { await verifying.open(target); opened.push(target.threadId) }
  const createResult = async () => {
    const previous = new Set(o.activity.snapshot().entries.map(e => e.activityId))
    const time = Date.now().toString(16).padStart(12, "0"), date = new Date().toISOString()
    const id = `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${randomUUID().slice(-12)}`, turn = randomUUID()
    const dir = join(o.home, "sessions", ...date.slice(0, 10).split("-")); await mkdir(dir, { recursive: true, mode: 0o700 })
    allowed.add(id)
    const rows = [
      { type: "session_meta", payload: { id, source: "vscode", thread_source: "agent_created_thread" } },
      { type: "event_msg", timestamp: date, payload: { type: "task_started", turn_id: turn } },
      { type: "event_msg", timestamp: date, payload: { type: "task_complete", turn_id: turn, last_agent_message: "RESULT_PRIVATE_CANARY" } },
    ]
    await writeFile(join(dir, `rollout-${date.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`), rows.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 })
    await until(() => o.activity.snapshot().entries.some(e => !previous.has(e.activityId) && e.unread && e.canOpenConversation), "new result mapped")
    return { id, entry: o.activity.snapshot().entries.find(e => !previous.has(e.activityId))! }
  }
  const counts = o.activity.snapshot().counts
  try {
    // Earlier keyboard/collapse checks leave focus inside the companion. End
    // that gesture before starting an independent result-navigation scenario.
    await o.bubble.window!.webContents.executeJavaScript("document.activeElement?.blur(); const menu = document.querySelector('.bubble-menu'); if (menu) menu.open = false")
    const first = await createResult(), win = o.bubble.window!
    const run = (code: string) => win.webContents.executeJavaScript(code)
    for (let i = 0; i <= o.activity.snapshot().entries.length; i++) {
      if (await run(`document.querySelector('.task-name')?.textContent === ${JSON.stringify(first.entry.name)}`)) break
      await run(`document.querySelector('[aria-label="다음 작업"]').click()`); await wait(90)
    }
    // Wait for the verified navigation snapshot before opening the menu, which
    // deliberately freezes the selected revision while the user operates it.
    await until(async () => await run(`document.querySelector('.activity-view main')?.dataset.activityId === ${JSON.stringify(first.entry.activityId)} && [...document.querySelectorAll('.task-links button')].some(b => b.textContent.includes('대화 열기'))`), "verified result navigation ready")
    await writeFile(join(o.evidenceDirectory, "result-bubble.png"), (await win.webContents.capturePage()).toPNG())
    await run("document.querySelector('.bubble-menu').open = true")
    await wait(2100)
    await run(`[...document.querySelectorAll('.bubble-menu button')].find(b => b.textContent.trim() === '열고 확인').click()`)
    await until(async () => await run(`document.querySelector('[role=alert]')?.textContent.includes('열지 못')`), "launch failure visible")
    assert(o.activity.snapshot().entries.find(e => e.activityId === first.entry.activityId)?.unread, "failure keeps unread")
    assert(opened.length === 0, "failed launch is not success")
    await writeFile(join(o.evidenceDirectory, "result-open-failed.png"), (await win.webContents.capturePage()).toPNG())
    await run("document.querySelector('.bubble-menu').open = true")
    await wait(2100)
    await run(`[...document.querySelectorAll('.bubble-menu button')].find(b => b.textContent.trim() === '열고 확인').click()`)
    await until(() => opened.length === 1 && o.activity.snapshot().entries.find(e => e.activityId === first.entry.activityId)?.unread === false, "bubble opens then acknowledges")
    assert(opened[0] === first.id, "bubble opens exact result session")
    await run("document.querySelector('.bubble-menu').open = false")
    const second = await createResult(), list = o.list.open()
    const selector = `button[aria-label=${JSON.stringify(second.entry.name + " 결과 확인")}]`
    await until(async () => !list.webContents.isLoadingMainFrame() && await list.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), "list result button")
    await list.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).closest('.activity-row').scrollIntoView({ block: 'center' })`)
    await wait(150)
    await writeFile(join(o.evidenceDirectory, "result-list.png"), (await list.webContents.capturePage()).toPNG())
    await wait(2100)
    await list.webContents.executeJavaScript(`[...document.querySelector(${JSON.stringify(selector)}).closest('.activity-row').querySelectorAll('button')].find(b => b.textContent.trim() === '열고 확인').click()`)
    await until(() => opened.length === 2 && o.activity.snapshot().entries.find(e => e.activityId === second.entry.activityId)?.unread === false, "list opens then acknowledges")
    assert(opened[1] === second.id && first.id !== second.id, "different result opens its own session")
    assert(o.activity.snapshot().counts.completed === counts.completed && o.activity.snapshot().counts.failed === counts.failed, "other unread results preserved")
    list.hide()
    const result = { packagedUi: true, bubbleOpenThenAcknowledge: true, listOpenThenAcknowledge: true, distinctSessionTargets: true, failedOpenPreservesUnread: true, otherResultsPreserved: true, finalExternalLaunchMocked: true, realChatGptScreenNavigation: false }
    await writeFile(join(o.evidenceDirectory, "result-open-smoke.json"), JSON.stringify(result, null, 2) + "\n")
    return result
  } finally { o.launcher.open = original }
}
