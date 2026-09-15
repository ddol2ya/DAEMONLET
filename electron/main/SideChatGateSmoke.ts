import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { SideChatService } from "./side-chat/SideChatService"
import type { SideChatWindowController } from "./SideChatWindowController"
import type { PersonaResolver } from "./side-chat/PersonaResolver"
import type { CharacterSelection } from "../shared/character-pack-contract"
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export async function runSideChatGateSmoke(service: SideChatService, window: SideChatWindowController, resolver: PersonaResolver, selection: CharacterSelection, output: string) {
  if (process.env.ELECTRON_SMOKE_TEST !== "1" || !process.env.ELECTRON_SMOKE_USER_DATA) throw new Error("Side chat smoke requires isolated app profile")
  await mkdir(output, { recursive: true })
  service.configure(true, "ko"); service.applyPersona(await resolver.resolve(selection, "ko"))
  service.setCandidates([{ threadId: "synthetic-parent-not-read", title: "합성 부모 · 전송 차단 확인", cwd: output }], "synthetic-parent-not-read")
  service.setMode("compact")
  const win = window.window!
  for (let n = 0; n < 100; n++) { if (!win.webContents.isLoading() && await win.webContents.executeJavaScript('Boolean(document.querySelector("textarea"))').catch(() => false)) break; await wait(50) }
  const state = service.snapshot()
  await win.webContents.executeJavaScript(`window.daemonletSideChat.action('send', ${JSON.stringify({ handle: state.handle, epoch: state.epoch, requestId: "00000000-0000-4000-8000-000000000001", text: "합성 전송 검사" })})`)
  await wait(150)
  if (service.snapshot().error !== "CHAT_POLICY_UNENFORCEABLE" || service.snapshot().messages.length) throw new Error("Side chat smoke: runtime gate did not block before sending")
  if (!await win.webContents.executeJavaScript('Boolean(document.querySelector(".error"))')) throw new Error("Side chat smoke: error UI missing")
  await writeFile(join(output, "packaged-compact.png"), (await win.webContents.capturePage()).toPNG())
  service.setMode("panel"); await wait(120)
  await writeFile(join(output, "packaged-panel.png"), (await win.webContents.capturePage()).toPNG())
  const result = { status: "PASS", character: state.character.id, explicitPersona: true, runtimeGate: "CHAT_POLICY_UNENFORCEABLE", displayedMessages: 0, realAccountCalls: 0, packagedUiLoaded: true }
  service.configure(false, "ko")
  await writeFile(join(output, "gate-result.json"), JSON.stringify(result, null, 2) + "\n")
  return result
}
