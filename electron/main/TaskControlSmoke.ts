import { createServer } from "node:http"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { WebSocketServer } from "ws"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { TaskControlService } from "./control/TaskControlService"
import type { CodexThreadLauncher } from "./control/CodexThreadLauncher"
import type { DictationService } from "./control/DictationService"
import { TASK_CONTROL_IPC } from "../shared/task-control-contract"
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await check()) return; await wait(60) }
  throw new Error(`Task control smoke timed out: ${label}`)
}
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Task control smoke: ${label}`) }

/** Isolated packaged UI fixture; no additional IPC channel or production permission bypass. */
export async function runTaskControlSmoke(o: { bubble: ActivityBubbleWindowController; control: TaskControlService; dictation: DictationService; launcher: CodexThreadLauncher; evidenceDirectory: string }) {
  const root = await mkdtemp("/private/tmp/2dl-ui-")
  const path = join(root, "server.sock")
  const threadA = "01234567-89ab-7cde-8fab-0123456789a1", threadB = "01234567-89ab-7cde-8fab-0123456789b2"
  const http = createServer()
  const server = new WebSocketServer({ server: http, maxPayload: 64 * 1024 })
  let state = "active", turnId = "turn-original", turnStatus = "inProgress"
  const requests: Array<{ method: string; params: any }> = []
  server.on("connection", ws => ws.on("message", data => {
    const message = JSON.parse(data.toString())
    if (message.id === undefined) return
    const params = message.params ?? {}
    requests.push({ method: message.method, params })
    let result: unknown = {}
    if (message.method === "thread/loaded/list") result = { data: [threadA, threadB], nextCursor: null }
    if (message.method === "thread/read") result = { thread: { id: params.threadId, name: params.threadId === threadA ? "말풍선 기능 검증" : "두 번째 작업", cwd: "/synthetic/workspace", path: join(process.env.CODEX_HOME ?? root, "sessions", `rollout-probe-${params.threadId}.jsonl`), status: { type: params.threadId === threadA ? state : "idle", activeFlags: [] }, ephemeral: false } }
    if (message.method === "thread/turns/list") result = { data: [{ id: params.threadId === threadA ? turnId : "turn-B", status: params.threadId === threadA ? turnStatus : "completed" }], nextCursor: null }
    if (message.method === "thread/resume") result = { thread: { id: params.threadId } }
    if (message.method === "turn/interrupt") { state = "idle"; turnStatus = "interrupted" }
    if (message.method === "turn/start") { state = "active"; turnId = "turn-followup"; turnStatus = "inProgress"; result = { turn: { id: turnId, status: turnStatus } } }
    if (message.method === "turn/steer") result = { turnId }
    ws.send(JSON.stringify({ id: message.id, result }))
  }))
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(path, resolve) })
  const start = o.dictation.start.bind(o.dictation), stop = o.dictation.stop.bind(o.dictation)
  let voiceId = "", voiceStarted = 0, openedThread = ""
  const openConversation = o.launcher.open.bind(o.launcher)
  o.launcher.open = async target => { openedThread = target.threadId }
  // Exercise the real preload/IPC and the UI's asynchronous dictation path without recording a person.
  o.dictation.start = id => { voiceId = id; voiceStarted++; o.bubble.send(TASK_CONTROL_IPC.dictation, { sessionId: id, state: "listening", text: "", error: null }) }
  o.dictation.stop = id => { assert(id === voiceId, "recording identity"); o.bubble.send(TASK_CONTROL_IPC.dictation, { sessionId: id, state: "idle", text: "받아쓴 후속 질문입니다", error: null }) }
  try {
    o.control.disconnect()
    await mkdir(o.evidenceDirectory, { recursive: true })
    o.bubble.setView("control", false)
    const win = o.bubble.window!
    const evaluate = (script: string) => win.webContents.executeJavaScript(script)
    await until(async () => win.isVisible() && await evaluate("!document.querySelector('[aria-label=\"Codex 작업 제어\"]').hidden"), "control view")
    const click = async (label: string) => {
      await until(async () => await evaluate(`Boolean(document.querySelector('button[aria-label=${JSON.stringify(label)}]:not(:disabled)'))`), label)
      await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`); await wait(120)
    }
    const screenshot = async (name: string) => { await wait(160); await writeFile(join(o.evidenceDirectory, name), (await win.webContents.capturePage()).toPNG()) }
    await screenshot("control-connect.png")
    await evaluate(`(async () => { const r = await window.taskControlDesktop.connect(${JSON.stringify(path)}); if (!r.ok) throw new Error(r.code) })()`)
    await until(() => o.control.snapshot().threads.length === 2, "thread list")
    const key = o.control.snapshot().threads[0].key
    await evaluate(`window.taskControlDesktop.select(${JSON.stringify(key)})`)
    await until(async () => await evaluate("document.querySelector('#control-thread').value !== ''"), "selected thread")
    await click("선택한 대화 열기")
    assert(openedThread === threadA, "navigation exact selected conversation")
    await screenshot("control-running.png")
    await click("음성 받아쓰기")
    await until(async () => await evaluate("document.querySelector('[aria-label=\"받아쓰기 중지\"]') !== null"), "microphone toggled")
    await screenshot("control-listening.png")
    assert(requests.every(r => !["turn/start", "turn/steer"].includes(r.method)), "microphone does not auto-send")
    await click("받아쓰기 중지")
    await until(async () => await evaluate("document.querySelector('textarea').value === '받아쓴 후속 질문입니다'"), "transcript in composer")
    await screenshot("control-dictated.png")
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('전송')).click()")
    await until(() => requests.some(r => r.method === "turn/steer"), "send to running turn")
    const steering = requests.find(r => r.method === "turn/steer")!
    assert(steering.params.threadId === threadA && steering.params.expectedTurnId === "turn-original" && steering.params.input[0].text === "받아쓴 후속 질문입니다", "exact selected turn and text")
    await until(async () => await evaluate("document.querySelector('textarea').value === ''"), "draft cleared after confirmed send")
    await click("선택한 작업 실행 중지")
    await until(() => o.control.snapshot().threads[0].state === "idle", "stop observed")
    assert(requests.find(r => r.method === "turn/interrupt")?.params.turnId === "turn-original", "stop exact turn")
    await screenshot("control-stopped.png")
    await evaluate(`(() => { const node = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, '새 후속 질문'); node.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await wait(80)
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('전송')).click()")
    await until(() => requests.some(r => r.method === "turn/start"), "idle follow-up")
    assert(requests.find(r => r.method === "turn/start")?.params.threadId === threadA, "idle follow-up same conversation")
    await click("음성 받아쓰기")
    const lateId = voiceId
    await click("Codex 제어 접기")
    await until(() => win.getBounds().height === 52, "collapse stops dictation view")
    o.bubble.send(TASK_CONTROL_IPC.dictation, { sessionId: lateId, state: "idle", text: "LATE_TRANSCRIPT_MUST_NOT_APPEAR", error: null })
    await click("Codex 제어 펼치기")
    assert(!await evaluate("document.querySelector('textarea').value.includes('LATE_TRANSCRIPT')"), "late voice result ignored")
    await screenshot("control-followup.png")
    const panelGeometry = await evaluate(`(() => { const p = document.querySelector('[aria-label="Codex 작업 제어"]'); return { width: innerWidth, height: innerHeight, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight, textareaHeight: document.querySelector('textarea').getBoundingClientRect().height }; })()`)
    assert(panelGeometry.scrollHeight <= panelGeometry.clientHeight + 1 && panelGeometry.textareaHeight >= 40, "controls fit")
    const result = { exactConversationNavigation: true, realChatGptNavigation: false, packagedUi: true, syntheticServer: true, syntheticDictation: true, nativeMicrophoneRecorded: false, explicitThreadSelection: true, runningSteer: true, idleFollowup: true, exactTurnStop: true, dictationToDraftOnly: true, voiceCancelOnCollapse: true, lateTranscriptIgnored: true, voiceStarted, panelGeometry, screenshots: ["control-connect.png", "control-running.png", "control-listening.png", "control-dictated.png", "control-stopped.png", "control-followup.png"] }
    await writeFile(join(o.evidenceDirectory, "packaged-control-smoke.json"), JSON.stringify(result, null, 2) + "\n")
    return result
  } finally {
    o.launcher.open = openConversation
    o.dictation.start = start; o.dictation.stop = stop; o.dictation.cancel()
    o.control.disconnect(); o.bubble.setView("activity", false)
    for (const socket of server.clients) socket.terminate()
    server.close(); http.close()
    await rm(root, { recursive: true, force: true })
  }
}
