import type { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ActivityService } from "./activity/ActivityService"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { ActivityWindowController } from "./ActivityWindowController"
import { CodexThreadLauncher } from "./control/CodexThreadLauncher"

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Restart smoke: ${label}`) }
async function until(check: () => unknown | Promise<unknown>, label: string) {
  const end = Date.now() + 20000
  while (Date.now() < end) { if (await check()) return; await wait(70) }
  throw new Error(`Restart smoke timed out: ${label}`)
}
/** Synthetic native QA only; real worker, file observation, Protocol, React and IPC. */
export async function runRestartDetectionSmoke(o: {
  activity: ActivityService; bubble: ActivityBubbleWindowController; list: ActivityWindowController;
  pet: BrowserWindow; launcher: CodexThreadLauncher; home: string; dataDir: string; hookEndpoint: string; evidenceDirectory: string;
  reloadPet(): Promise<void>
}) {
  assert(process.env.ELECTRON_SMOKE_TEST === "1" && process.env.ELECTRON_SMOKE_USER_DATA, "isolated smoke environment")
  const millis = Date.now().toString(16).padStart(12, "0")
  const sessionId = `${millis.slice(0, 8)}-${millis.slice(8)}-7000-8000-${randomUUID().slice(-12)}`
  const first = randomUUID(), resumed = randomUUID()
  const date = new Date().toISOString(), dir = join(o.home, "sessions", ...date.slice(0, 10).split("-"))
  await mkdir(dir, { recursive: true, mode: 0o700 }); await mkdir(o.evidenceDirectory, { recursive: true })
  const path = join(dir, `rollout-${date.slice(0, 19).replaceAll(":", "-")}-${sessionId}.jsonl`)
  const record = (type: string, turnId: string, fields = {}) => JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type, turn_id: turnId, ...fields } }) + "\n"
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: sessionId, source: "vscode", base_instructions: "RESTART_PRIVATE_CANARY" } }) + "\n", { mode: 0o600 })
  const token = (await readFile(join(o.dataDir, "adapter-token"), "utf8")).trim()
  const hook = async (turnId: string, hookEventName: string) => {
    const response = await fetch(o.hookEndpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ payloadVersion: 1, sessionId, turnId, model: "smoke", permissionMode: "default", hookEventName }) })
    assert(response.status === 202, "Hook accepted")
  }
  const before = new Set(o.activity.snapshot().entries.map(e => e.activityId))
  const opened: Array<{ threadId: string; rolloutPath: string | null }> = []
  const original = o.launcher.open
  // Keep real local-file verification; replace only the final external application boundary.
  const verifying = new CodexThreadLauncher({ home: o.home, app: { openThread: async threadId => { assert(threadId === sessionId, "correct final conversation UUID"); return "opened" } } })
  o.launcher.open = async target => { await verifying.open(target); opened.push(target) }
  try {
    await until(() => o.activity.snapshot().counts.running === 0 && o.activity.snapshot().counts.waiting === 0, "initial idle")
    o.list.window?.hide()
    // Other smoke scenarios have already used writing dialogue. Start with its real default
    // cooldown state, then respect its 12s cooldown when testing the second pose entry.
    await o.reloadPet()
    await appendFile(path, record("task_started", first))
    await hook(first, "UserPromptSubmit")
    await until(() => o.activity.snapshot().entries.some(e => !before.has(e.activityId) && e.state === "running" && e.canOpenConversation), "initial mapping pinned")
    const firstEntry = o.activity.snapshot().entries.find(e => !before.has(e.activityId))!
    await until(async () => await o.pet.webContents.executeJavaScript(`Boolean(document.querySelector('.speech-bubble[data-trigger="run.started"][data-phase="shown"]'))`), "initial writing dialogue")
    await writeFile(join(o.evidenceDirectory, "initial-writing.png"), (await o.pet.webContents.capturePage()).toPNG())
    await hook(first, "Interrupt"); await appendFile(path, record("turn_aborted", first, { reason: "interrupted" }))
    await until(() => o.activity.snapshot().counts.running === 0, "interrupt clears running")
    await until(async () => !await o.pet.webContents.executeJavaScript(`Boolean(document.querySelector('.speech-bubble[data-trigger="run.started"][data-phase="shown"]'))`), "writing leaves on interrupt")
    await wait(12100)
    // Empty-input retry: deliberately no UserPromptSubmit, PreToolUse, or PostToolUse.
    await appendFile(path, record("task_started", resumed))
    await until(() => o.activity.snapshot().entries.some(e => !before.has(e.activityId) && e.activityId !== firstEntry.activityId && e.state === "running" && e.canOpenConversation), "restart without Hooks registered")
    const entry = o.activity.snapshot().entries.find(e => !before.has(e.activityId) && e.activityId !== firstEntry.activityId)!
    await until(async () => await o.pet.webContents.executeJavaScript(`Boolean(document.querySelector('.speech-bubble[data-trigger="run.started"][data-phase="shown"]'))`), "writing restored on restart")
    await wait(250)
    await writeFile(join(o.evidenceDirectory, "resumed-writing.png"), (await o.pet.webContents.capturePage()).toPNG())
    const win = o.bubble.window!
    const run = (code: string) => win.webContents.executeJavaScript(code)
    for (let i = 0; i <= o.activity.snapshot().entries.length; i++) {
      if (await run(`document.querySelector('.task-name')?.textContent === ${JSON.stringify(entry.name)}`)) break
      await run(`document.querySelector('[aria-label="다음 작업"]').click()`); await wait(90)
    }
    await until(async () => await run(`[...document.querySelectorAll('.task-links button')].some(b => b.textContent.includes('대화 열기'))`), "specific conversation button")
    await writeFile(join(o.evidenceDirectory, "resumed-task-bubble.png"), (await win.webContents.capturePage()).toPNG())
    await run(`[...document.querySelectorAll('.task-links button')].find(b => b.textContent.includes('대화 열기')).click()`)
    await until(() => opened.length === 1, "bubble routes selected activity")
    assert(opened[0].threadId === sessionId, "bubble UUID mapping")
    const list = o.list.open()
    await until(async () => !list.webContents.isLoadingMainFrame() && await list.webContents.executeJavaScript(`Boolean(document.querySelector('button[aria-label=${JSON.stringify(entry.name + " 대화 열기")}]'))`), "list conversation button")
    await list.webContents.executeJavaScript(`document.querySelector('button[aria-label=${JSON.stringify(entry.name + " 대화 열기")}]').closest('.activity-row').scrollIntoView({ block: 'center' })`)
    await wait(150)
    await writeFile(join(o.evidenceDirectory, "activity-conversations.png"), (await list.webContents.capturePage()).toPNG())
    await wait(2100)
    await list.webContents.executeJavaScript(`document.querySelector('button[aria-label=${JSON.stringify(entry.name + " 대화 열기")}]').click()`)
    await until(() => opened.length === 2, "list routes same activity")
    assert(o.activity.snapshot().entries.find(e => e.activityId === entry.activityId)?.state === "running", "navigation leaves state intact")
    assert(!JSON.stringify(o.activity.snapshot()).includes(sessionId) && !JSON.stringify(o.activity.snapshot()).includes(o.home), "DTO excludes private identity and path")
    await hook(resumed, "Interrupt"); await appendFile(path, record("turn_aborted", resumed, { reason: "interrupted" }))
    await until(() => o.activity.snapshot().counts.running === 0, "restart interrupt clears state")
    // A delayed start for the interrupted turn must never resurrect it.
    await appendFile(path, record("task_started", resumed)); await wait(800)
    assert(o.activity.snapshot().counts.running === 0, "late start suppressed")
    assert(o.activity.snapshot().entries.filter(e => !before.has(e.activityId)).length === 2, "one entry per real turn")
    let discoveredWithoutHooks = 0
    if (process.env.ELECTRON_SMOKE_SESSION_DISCOVERY === "1") {
      const previous = new Set(o.activity.snapshot().entries.map(e => e.activityId))
      const created: Array<{ path: string; turn: string }> = []
      for (let i = 0; i < 2; i++) {
        const time = Date.now().toString(16).padStart(12, "0")
        const id = `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${randomUUID().slice(-12)}`, turn = randomUUID()
        const file = join(dir, `rollout-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`)
        await writeFile(file, JSON.stringify({ type: "session_meta", payload: { id, source: "vscode", thread_source: "agent_created_thread" } }) + "\n" + record("task_started", turn), { mode: 0o600 })
        created.push({ path: file, turn })
      }
      await until(() => o.activity.snapshot().counts.running === 2, "two created sessions without any Hook")
      const entries = o.activity.snapshot().entries.filter(e => !previous.has(e.activityId))
      assert(entries.length === 2 && entries.every(e => e.state === "running" && e.canOpenConversation), "two distinct navigable sessions")
      await until(async () => await list.webContents.executeJavaScript(`document.querySelectorAll('.activity-row.running').length === 2`), "two running rows rendered")
      await list.webContents.executeJavaScript(`document.querySelector('.activity-row.running').scrollIntoView({ block: 'center' })`)
      await wait(150)
      await writeFile(join(o.evidenceDirectory, "two-created-sessions.png"), (await list.webContents.capturePage()).toPNG())
      await appendFile(created[0].path, record("turn_aborted", created[0].turn, { reason: "interrupted" }))
      await until(() => o.activity.snapshot().counts.running === 1, "second session remains active")
      await appendFile(created[1].path, record("turn_aborted", created[1].turn, { reason: "interrupted" }))
      await until(() => o.activity.snapshot().counts.running === 0, "both created sessions ended")
      discoveredWithoutHooks = 2
    }
    list.hide()
    const result = { discoveredWithoutHooks, packagedWorker: true, futureLifecycleOnly: true, restartWithoutAnyHook: true, writingRestored: true, taskBubbleRestored: true, exactBubbleConversation: true, exactListConversation: true, realChatGptNavigation: false, externalOpenMocked: true, lateStartSuppressed: true, noDuplicateActivity: true, privateMetadataExcludedFromDto: true }
    await writeFile(join(o.evidenceDirectory, "packaged-restart-smoke.json"), JSON.stringify(result, null, 2) + "\n")
    return result
  } catch (error) {
    await writeFile(join(o.evidenceDirectory, "failure-pet.png"), (await o.pet.webContents.capturePage()).toPNG())
    await writeFile(join(o.evidenceDirectory, "failure-state.json"), JSON.stringify({ counts: o.activity.snapshot().counts, petVisible: o.pet.isVisible(), dialogue: await o.pet.webContents.executeJavaScript(`(() => { const e = document.querySelector('.speech-bubble'); return { hidden: document.hidden, phase: e?.dataset.phase, trigger: e?.dataset.trigger }; })()`) }, null, 2) + "\n")
    throw error
  } finally { o.launcher.open = original; await hook(resumed, "Interrupt").catch(() => {}) }
}
