import type { ChatSessionClosed } from "../../electron/main/side-chat/SideChatBackend"
import { app, dialog, BrowserWindow, clipboard, ipcMain } from "electron"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { installAppProtocol, registerAppScheme } from "../../electron/main/AppProtocol"
import { SideChatService } from "../../electron/main/side-chat/SideChatService"
import { SideChatWindowController } from "../../electron/main/SideChatWindowController"
import { SideChatIpcController } from "../../electron/main/SideChatIpcController"
import { compilePersona } from "../../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../../electron/shared/character-persona"
import type { ChatResponse } from "../../electron/shared/side-chat-contract"
import { ActivityBubbleWindowController } from "../../electron/main/ActivityBubbleWindowController"
import { BubblePresentationIpcController } from "../../electron/main/BubblePresentationIpcController"
import { ActivityStore } from "../../electron/main/activity/ActivityStore"
import { ACTIVITY_IPC } from "../../electron/shared/activity-contract"
import { TASK_CONTROL_IPC } from "../../electron/shared/task-control-contract"
import { defaultDesktopSettings } from "../../electron/shared/desktop-settings"
const root = process.env.DAEMONLET_CHAT_SMOKE_ROOT!, output = process.env.DAEMONLET_CHAT_SMOKE_OUTPUT!
app.setPath("userData", process.env.DAEMONLET_CHAT_SMOKE_USER!)
registerAppScheme()
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition: unknown, label: string) => { if (!condition) throw Error(label) }
async function main() {
await app.whenReady()
let calls = 0, opens = 0, closes = 0
let openGate: (() => Promise<void>) | null = null, sendError: string | null = null
const sentTexts: string[] = []
installAppProtocol(process.env.DAEMONLET_CHAT_SMOKE_FIXTURE_DIST!)
const pet = new BrowserWindow({ width: 360, height: 360, x: 850, y: 250, show: true, webPreferences: { preload: join(root, "dist-electron/pet-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
const bubbles = new ActivityBubbleWindowController(join(root, "dist-electron/activity-preload.cjs"))
const bubbleIpc = new BubblePresentationIpcController(bubbles)
bubbles.attach(pet, defaultDesktopSettings()); bubbleIpc.register()
const store = new ActivityStore()
store.accept({ protocolVersion: 1, source: "codex-adapter", sourceInstanceId: "synthetic", sessionId: "wire", messageId: "one", sequence: 1, sentAt: Date.now(), frameType: "event", payload: { type: "run.completed", runId: "A" } })
const activity = { ...store.view(), revision: 1, storage: "saved" as const, historyRecovered: false, navigation: "none" as const }
ipcMain.handle(ACTIVITY_IPC.get, () => ({ ok: true, value: activity }))
ipcMain.handle(TASK_CONTROL_IPC.getView, () => ({ ok: true, value: { view: "activity", collapsed: false } }))
bubbles.update(activity)
await pet.loadURL("pet://app/pet.html")
let answer: ChatResponse = { text: "듣고 있습니다. 무엇이 궁금하십니까?", preview: "", expression: "neutral" }
const service = new SideChatService(() => {
  let opened = false
  const listeners = new Set<(event: ChatSessionClosed) => void>()
  return {
    isSessionOpen: () => opened,
    onSessionClosed: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    open: async () => { opens++; await openGate?.(); opened = true; return { threadId: "owned-child", lastTurnId: "done", contextAt: Date.now() - 10000 } },
    send: async text => {
      calls++; sentTexts.push(text); await wait(80)
      if (sendError) {
        const error = Error(sendError)
        opened = false; for (const listener of [...listeners]) listener({ error, hadSession: true })
        throw error
      }
      return answer
    },
    stop: async () => {}, close: async () => { opened = false; closes++ },
  }
})
const win = new SideChatWindowController({ preload: join(root, "dist-electron/side-chat-preload.cjs"), distRoot: join(root, "dist"), pet: () => pet, hidden: () => service.setMode("hidden"), visibility: value => bubbles.presentation.setSideChatVisible(value) })
const ipc = new SideChatIpcController(service, win)
ipc.register(); service.subscribe(() => win.show(service.snapshot()))
const result: Record<string, unknown> = { backend: "synthetic", realAccountCalls: 0, status: "FAIL" }
try {
  service.configure(true, "ko"); service.applyPersona({ id: "gpichan", revision: "builtin", label: "지피쨩", compiled: compilePersona("지피쨩", neutralPersona(), "ko") })
  const project = join(await realpath(process.env.DAEMONLET_CHAT_SMOKE_USER!), "project")
  await mkdir(project); await writeFile(join(project, "example.ts"), "export const example = 42;\n// selected file\n")
  service.setConnectionMode("official-same-home")
  service.setCandidates([{ threadId: "parent", title: "캐릭터 제작스킬에서 이미지 넣을때 조건이 있었나? 그리고 이미지 넣으면 어떤식으로 가공해주냐? ".repeat(3).slice(0, 120), cwd: project }], "parent"); service.setMode("compact")
  const window = win.window!, contents = window.webContents
  const js = <T = any>(code: string): Promise<T> => contents.executeJavaScript(code)
  async function until(code: string) { for (let n = 0; n < 100; n++) { if (await js(code)) return; await wait(40) }; throw Error("UI condition timed out: " + code) }
  await until('Boolean(document.querySelector("textarea"))')
  await js("document.querySelector('.parent-search summary').click();document.querySelector('.context select').focus()")
  assert(await js("(()=>{const r=document.querySelector('.setup-region');return r.scrollWidth<=r.clientWidth+1 && r.scrollLeft===0 && document.querySelector('footer').getBoundingClientRect().bottom<=innerHeight+1})()"), "Long parent title must not move preparation controls outside the compact viewport")
  result.longParentLayout = "PASS"
  await js("document.querySelector('.parent-search summary').click()")
  assert(calls === 0 && opens === 0, "Opening made no model call")
  const initialWindowId = window.id
  const type = async (text: string, delay = 260) => { await js(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); if (delay) await wait(delay) }
  await type("입력 중 한글")
  await js("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))")
  await wait(100); assert(calls === 0, "IME Enter did not send")
  await js("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))")
  assert(window.isVisible(), "IME Escape did not hide")
  await js("document.querySelector('.send').click()")
  await until('document.querySelector(".message")?.textContent.includes("듣고 있습니다")')
  assert(calls === 1, "one short-response call")
  await writeFile(join(output, "compact.png"), (await contents.capturePage()).toPNG())
  const originalPicker = dialog.showOpenDialog
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [join(project, "example.ts")] })
  try {
    await js("document.querySelector('.file-selection summary').click();document.querySelector('.file-range button').click()")
    await until("document.querySelector('.file-selection').textContent.includes('example.ts')")
    assert(calls === 1, "File selection made no model call")
    assert(service.snapshot().attachments?.[0]?.startLine === 1, "Selected excerpt metadata")
    await writeFile(join(output, "file-selected.png"), (await contents.capturePage()).toPNG())
    await js("document.querySelector('.file-selection summary').click()")
    result.fileSelection = "PASS"
  } finally { dialog.showOpenDialog = originalPicker }
  answer = { text: "긴 답변의 첫 전제입니다.\n\n" + "한글과 English 설명, 이모지 👨‍👩‍👧‍👦를 포함합니다.\n".repeat(12) + "\n```typescript\nconst longIdentifier = '" + "wide".repeat(30) + "';\n```\n\n| 열 | 긴 값 |\n| --- | --- |\n| 결과 | " + "table".repeat(40) + " |\n<script>alert(1)</script>\n![remote](https://invalid.example/image.png)", preview: "긴 설명과 코드를 준비했습니다. 전체 답변에서 전제를 확인해 주세요.", expression: "neutral" }
  await type("자세히 설명해 주세요"); await js("document.querySelector('.send').click()")
  await until('Boolean(document.querySelector(".expand"))')
  assert(window.getBounds().width === 380, "Long response did not expand window")
  await wait(180)
  await writeFile(join(output, "long-compact.png"), (await contents.capturePage()).toPNG())
  const beforeExpand = calls
  await js("document.querySelector('.expand').click()")
  await until('Boolean(document.querySelector(".panel pre"))')
  assert(calls === beforeExpand && opens === 1, "Expand reused response and fork")
  assert(await js('document.querySelectorAll("img,iframe,script[src^=http]").length === 0'), "No active HTML/remote image")
  await js("Array.from(document.querySelectorAll('.copy')).at(-1).click()")
  await wait(80); assert(clipboard.readText() === answer.text, "Copy preserves entire source")
  await writeFile(join(output, "panel.png"), (await contents.capturePage()).toPNG())
  await type("보존할 초안")
  await js("document.querySelector('.history').scrollTop=0;document.querySelector('.history').dispatchEvent(new Event('scroll'))")
  service.updateTask("parent", "waiting", Date.now()); await wait(80)
  assert(await js('document.querySelector("textarea").value === "보존할 초안" && document.querySelector(".history").scrollTop === 0'), "Task updates preserve draft and scroll")
  service.setMode("hidden"); service.setMode("panel"); await wait(80)
  assert(win.window?.id === initialWindowId && opens === 1, "Hide preserves window and fork")
  contents.setZoomFactor(1.5); await wait(180)
  assert(await js('Array.from(document.querySelectorAll("footer button,textarea")).every(e=>e.getBoundingClientRect().bottom <= innerHeight+1)'), "Composer fits at 150%")
  await writeFile(join(output, "zoom-150.png"), (await contents.capturePage()).toPNG())
  contents.setZoomFactor(1)
  service.configure(true, "en"); service.applyPersona({ id: "gpichan", revision: "builtin", label: "Gpichan", compiled: compilePersona("Gpichan", neutralPersona(), "en") }); await wait(100)
  assert(await js('document.body.textContent.includes("Side conversation")'), "Language updates UI")
  assert(calls === 2, "Language switch made no call")
  await writeFile(join(output, "english.png"), (await contents.capturePage()).toPNG())
  // F3: exercise the mounted React event path without waiting for the 200ms draft debounce.
  const enter = () => js("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
  const idle = async () => { for (let n = 0; n < 150; n++) { if (service.snapshot().phase === "idle") return; await wait(20) }; throw Error("send did not finish") }
  await type("hello"); assert(service.snapshot().draft === "hello", "old draft reached Main")
  const beforeQuick = calls
  await type("hello!", 0); await enter(); await enter(); await until('document.querySelector("textarea").value === ""'); await idle(); await wait(260)
  assert(calls === beforeQuick + 1 && sentTexts.at(-1) === "hello!" && service.snapshot().draft === "", "F3 quick last edit sent once and cleared")
  await writeFile(join(output, "draft-quick-send.png"), (await contents.capturePage()).toPNG())
  service.reset()
  let releaseOpen!: () => void
  openGate = () => new Promise<void>(resolve => { releaseOpen = resolve })
  await type("first draft", 0); await enter()
  await until('document.querySelector(".response-status").textContent.includes("Preparing")')
  await type("new draft during preparation", 0); releaseOpen(); openGate = null
  await idle(); await wait(260)
  assert(await js('document.querySelector("textarea").value === "new draft during preparation"'), "F3 newer renderer draft survives acceptance")
  assert(service.snapshot().draft === "new draft during preparation", "F3 newer Main draft survives acceptance")
  service.setMode("hidden"); service.setMode("panel"); await wait(80)
  assert(await js('document.querySelector("textarea").value === "new draft during preparation"'), "F3 hide/show retains new edit")
  // Editing away and back is still a newer revision, even with identical text.
  service.reset(); openGate = () => new Promise<void>(resolve => { releaseOpen = resolve })
  await type("same text", 0); await enter(); await until('document.querySelector(".response-status").textContent.includes("Preparing")')
  await type("other text", 0); await type("same text", 0); releaseOpen(); openGate = null; await idle(); await wait(260)
  assert(await js('document.querySelector("textarea").value === "same text"'), "F3 identical text at a new revision survives")
  service.reset(); openGate = async () => { throw Error("CHAT_POLICY_UNENFORCEABLE") }
  await type("keep rejected input", 0); const beforeFailure = calls; await enter()
  await until('document.querySelector(".error")?.textContent.includes("verified chat-only")'); await wait(260)
  assert(calls === beforeFailure && service.snapshot().draft === "keep rejected input" && await js('document.querySelector("textarea").value === "keep rejected input"'), "F3 known predispatch failure preserves input")
  openGate = null; service.reset()
  await type("조합 완료 문장", 0)
  await js("document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
  await wait(80); assert(calls === beforeFailure, "F3 composition Enter does not send")
  await js("document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))"); await enter()
  await until('document.querySelector("textarea").value === ""'); await idle()
  assert(calls === beforeFailure + 1, "F3 completed composition sends exactly once")
  await type("한".repeat(4000), 0); await type("한".repeat(4001), 0)
  assert(await js('Array.from(document.querySelector("textarea").value).length === 4000'), "F3 input limit retained")
  await type("unknown outcome", 0); sendError = "OUTCOME_UNKNOWN"; await enter()
  await until('document.querySelector(".error")?.textContent.includes("Delivery outcome is unknown")')
  const unknownCalls = calls; await type("manual retry", 0); await enter(); await wait(280)
  assert(calls === unknownCalls && service.snapshot().error === "OUTCOME_UNKNOWN", "F3 unknown outcome stays blocked without retry")
  sendError = null; service.reset()

  // Recovery UI: no send or receipt until the user explicitly starts a new conversation.
  sendError = "CHAT_AUTH_REQUIRED"
  await type("expire authenticated child", 0); await enter()
  await until('document.querySelector(".recovery")?.textContent.includes("Check your Codex login")')
  const recoveryCalls = calls, recoveryOpens = opens, recoveryReceipt = service.snapshot().acceptedSubmission
  await type("keep next recovery draft", 0); await enter(); await wait(280)
  assert(await js('document.querySelector(".send").disabled && document.querySelector("textarea").value === "keep next recovery draft"'), "Closed-child UI preserves draft and disables sending")
  assert(calls === recoveryCalls && service.snapshot().acceptedSubmission?.requestId === recoveryReceipt?.requestId, "Closed child produces no fake receipt or extra request")
  sendError = null; await wait(100); assert(opens === recoveryOpens, "Login recovery never reconnects automatically")
  service.setMode("compact"); await wait(100)
  await writeFile(join(output, "auth-new-conversation-required.png"), (await contents.capturePage()).toPNG())
  // Deterministic synthetic user choice in the existing native reset confirmation.
  const originalDialog = dialog.showMessageBox
  let confirmations = 0
  dialog.showMessageBox = (async () => { confirmations++; return { response: 1, checkboxChecked: false } }) as typeof dialog.showMessageBox
  await js("document.querySelector('.quiet').click()")
  await until('!document.querySelector(".recovery")')
  dialog.showMessageBox = originalDialog; assert(confirmations === 1, "Existing reset confirmation was honored")
  assert(await js('document.querySelector("textarea").value === "keep next recovery draft"'), "Explicit reset retains unsent draft")
  assert(calls === recoveryCalls && opens === recoveryOpens && service.snapshot().messages.length === 0, "Reset itself makes no model request")
  await enter(); await idle()
  assert(calls === recoveryCalls + 1 && opens === recoveryOpens + 1 && sentTexts.at(-1) === "keep next recovery draft", "Only manual send opens a fresh context")
  Object.assign(result, { closedChildRecovery: "PASS", recoveryDraftPreserved: "PASS", noAutomaticReconnect: "PASS" })

  // F1: actual dialogue controller expires through the production Pet hook + IPC while chat owns the surface.
  service.setMode("hidden")
  const petJs = (code: string) => pet.webContents.executeJavaScript(code)
  async function nativeUntil(check: () => unknown | Promise<unknown>, label: string) { for (let n = 0; n < 200; n++) { if (await check()) return; await wait(30) }; throw Error(label) }
  await nativeUntil(() => bubbles.window?.isVisible(), "F1 initial task bubble")
  for (let cycle = 0; cycle < 3; cycle++) {
    await petJs('document.querySelector("button").click()')
    await nativeUntil(() => bubbles.speech.window?.isVisible(), "F1 authored speech visible")
    service.setMode("compact"); await wait(60)
    assert(!bubbles.window?.isVisible() && !bubbles.speech.window?.isVisible(), "F1 chat suppresses both native bubbles")
    if (cycle === 0) {
      service.setMode("hidden"); await nativeUntil(() => bubbles.speech.window?.isVisible(), "F1 unexpired speech resumes")
      service.setMode("compact")
    }
    await nativeUntil(() => petJs('document.querySelector("main").dataset.phase === "hidden"'), "F1 actual dialogue timer expired")
    await wait(100)
    assert(bubbles.presentation.speech === null && !bubbles.speech.window?.isVisible() && !bubbles.window?.isVisible(), "F1 consumed hidden state under chat")
    service.setMode("hidden")
    await nativeUntil(() => bubbles.window?.isVisible(), "F1 task bubble returned without further Pet events")
    assert(bubbles.presentation.canShowActivity && !bubbles.speech.window?.isVisible(), "F1 expired speech did not replay")
  }
  await writeFile(join(output, "bubble-returned.png"), (await bubbles.window!.webContents.capturePage()).toPNG())
  Object.assign(result, { draftQuickSend: "PASS", newerDraftDuringPreparation: "PASS", sameTextNewRevision: "PASS", predispatchFailure: "PASS", imeCompositionEnd: "PASS", inputLimit: "PASS", unknownOutcomeNoRetry: "PASS", bubbleReturnCycles: 3, bubbleLifetimeHookIpcNative: "PASS" })
  service.configure(false, "en"); await wait(80); assert(await js('document.querySelector("textarea").value === ""'), "Disable clears renderer draft"); assert(!window.isVisible() && !service.snapshot().messages.length && !service.snapshot().draft, "Disable clears memory and hides")
  Object.assign(result, { status: "PASS", calls, forks: opens, ownedBackendCloses: closes, ime: "PASS", compactPanel: "PASS", noExpansionCall: "PASS", copyFullSource: "PASS", htmlRemoteMediaInactive: "PASS", taskStateDraftScroll: "PASS", hidePreservesWindow: "PASS", zoom150: "PASS", language: "PASS", disable: "PASS" })
} catch (error) { result.error = String(error) }
finally { ipc.dispose(); bubbleIpc.dispose(); await service.dispose(); win.destroy(); bubbles.destroy(); for (const w of BrowserWindow.getAllWindows()) w.destroy(); await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n"); app.exit(result.status === "PASS" ? 0 : 1) }

}
void main().catch(async error => { await writeFile(join(output, "result.json"), JSON.stringify({ status: "FAIL", error: String(error) })); app.exit(1) })
