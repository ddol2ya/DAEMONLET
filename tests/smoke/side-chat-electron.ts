import { app, BrowserWindow, clipboard } from "electron"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { registerAppScheme } from "../../electron/main/AppProtocol"
import { SideChatService } from "../../electron/main/side-chat/SideChatService"
import { SideChatWindowController } from "../../electron/main/SideChatWindowController"
import { SideChatIpcController } from "../../electron/main/SideChatIpcController"
import { compilePersona } from "../../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../../electron/shared/character-persona"
import type { ChatResponse } from "../../electron/shared/side-chat-contract"
const root = process.env.DAEMONLET_CHAT_SMOKE_ROOT!, output = process.env.DAEMONLET_CHAT_SMOKE_OUTPUT!
app.setPath("userData", process.env.DAEMONLET_CHAT_SMOKE_USER!)
registerAppScheme()
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition: unknown, label: string) => { if (!condition) throw Error(label) }
async function main() {
await app.whenReady()
let calls = 0, opens = 0, closes = 0
let answer: ChatResponse = { text: "듣고 있습니다. 무엇이 궁금하십니까?", preview: "", expression: "neutral" }
const service = new SideChatService(() => ({ open: async () => { opens++; return { threadId: "owned-child", lastTurnId: "done", contextAt: Date.now() - 10000 } }, send: async () => { calls++; await wait(80); return answer }, stop: async () => {}, close: async () => { closes++ } }))
const win = new SideChatWindowController({ preload: join(root, "dist-electron/side-chat-preload.cjs"), distRoot: join(root, "dist"), pet: () => null, hidden: () => service.setMode("hidden"), visibility: () => {} })
const ipc = new SideChatIpcController(service, win)
ipc.register(); service.subscribe(() => win.show(service.snapshot()))
const result: Record<string, unknown> = { backend: "synthetic", realAccountCalls: 0, status: "FAIL" }
try {
  service.configure(true, "ko"); service.applyPersona({ id: "gpichan", revision: "builtin", label: "지피쨩", compiled: compilePersona("지피쨩", neutralPersona(), "ko") })
  service.setCandidates([{ threadId: "parent", title: "합성 작업 · 부모 대화", cwd: root }], "parent"); service.setMode("compact")
  const window = win.window!, contents = window.webContents
  const js = <T = any>(code: string): Promise<T> => contents.executeJavaScript(code)
  async function until(code: string) { for (let n = 0; n < 100; n++) { if (await js(code)) return; await wait(40) }; throw Error("UI condition timed out: " + code) }
  await until('Boolean(document.querySelector("textarea"))')
  assert(calls === 0 && opens === 0, "Opening made no model call")
  const initialWindowId = window.id
  const type = async (text: string) => { await js(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(260) }
  await type("입력 중 한글")
  await js("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))")
  await wait(100); assert(calls === 0, "IME Enter did not send")
  await js("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))")
  assert(window.isVisible(), "IME Escape did not hide")
  await js("document.querySelector('.send').click()")
  await until('document.querySelector(".message")?.textContent.includes("듣고 있습니다")')
  assert(calls === 1, "one short-response call")
  await writeFile(join(output, "compact.png"), (await contents.capturePage()).toPNG())
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
  service.updateTask("waiting", Date.now()); await wait(80)
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
  service.configure(false, "en"); await wait(80); assert(await js('document.querySelector("textarea").value === ""'), "Disable clears renderer draft"); assert(!window.isVisible() && !service.snapshot().messages.length && !service.snapshot().draft, "Disable clears memory and hides")
  Object.assign(result, { status: "PASS", calls, forks: opens, ownedBackendCloses: closes, ime: "PASS", compactPanel: "PASS", noExpansionCall: "PASS", copyFullSource: "PASS", htmlRemoteMediaInactive: "PASS", taskStateDraftScroll: "PASS", hidePreservesWindow: "PASS", zoom150: "PASS", language: "PASS", disable: "PASS" })
} catch (error) { result.error = String(error) }
finally { ipc.dispose(); await service.dispose(); win.destroy(); for (const w of BrowserWindow.getAllWindows()) w.destroy(); await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n"); app.exit(result.status === "PASS" ? 0 : 1) }

}
void main().catch(async error => { await writeFile(join(output, "result.json"), JSON.stringify({ status: "FAIL", error: String(error) })); app.exit(1) })
