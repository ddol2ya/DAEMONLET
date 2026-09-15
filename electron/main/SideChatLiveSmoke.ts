import { app, clipboard } from "electron"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { readChatParentContext } from "./side-chat/SideChatParent"
import { connectVerifiedSideChat, CHAT_PROFILE_HASH } from "./side-chat/SideChatPolicy"
import type { ChatConnection } from "./side-chat/SideChatBackend"
import type { SideChatService } from "./side-chat/SideChatService"
import type { SideChatWindowController } from "./SideChatWindowController"
import type { CharacterRegistry } from "./CharacterRegistry"
import type { CharacterSelection } from "../shared/character-pack-contract"
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition: unknown, label: string) => { if (!condition) throw Error(label) }
const until = async (check: () => unknown | Promise<unknown>, label: string, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await wait(30) }
  throw Error(label)
}
/** Explicit account QA only, using the real production factory/service/IPC/window.
 * No fake provider or alternate backend is injected. Never runs on ordinary startup. */
export async function runSideChatLiveSmoke(o: { service: SideChatService; window: SideChatWindowController; registry: CharacterRegistry; select(value: CharacterSelection): Promise<void>; authHome: string; output: string }) {
  if (process.env.ELECTRON_SMOKE_TEST !== "1" || !process.env.ELECTRON_SMOKE_USER_DATA || !app.isPackaged || process.env.ELECTRON_SMOKE_LIVE_SIDE_CHAT !== "user-authorized-six-requests") throw Error("Live QA requires explicit isolated packaged invocation")
  await mkdir(o.output, { recursive: true })
  const result: any = { status: "NOT_RUN", provider: "official-Codex-ChatGPT", profileHash: CHAT_PROFILE_HASH, packaged: app.isPackaged, logicalModelRequests: 0, checks: {}, responses: [] }
  let seed: ChatConnection | null = null, parentId: string | null = null, parentWork: string | null = null
  const seedEvents: any[] = []
  try {
    seed = await connectVerifiedSideChat({ codexHome: o.authHome })
    seed.client.onNotification((method, params) => seedEvents.push({ method, params }))
    const cwd = seed.execution!.cwd, sourceHome = join(dirname(cwd), "codex")
    const { thread: parent } = await seed.client.request("thread/start", { cwd, model: "gpt-5.6-luna", historyMode: "legacy", environments: [], approvalPolicy: "never", sandbox: "read-only", developerInstructions: "This is a non-sensitive, user-authorized Daemonlet QA conversation." }) as any
    parentId = parent.id
    result.logicalModelRequests++
    const initial: any = await seed.client.request("turn/start", { threadId: parent.id, environments: [], input: [{ type: "text", text: "이 대화는 앱 연결 검증용입니다. 기억할 검증 문구는 ‘은빛별 731’입니다. 한 문장으로 확인해 주세요.", text_elements: [] }] })
    await until(() => seedEvents.some(e => e.method === "turn/completed" && e.params.turn.id === initial.turn.id), "Parent seed completion")
    const initialResult = seedEvents.find(e => e.method === "turn/completed" && e.params.turn.id === initial.turn.id).params.turn
    if (initialResult.status !== "completed") {
      result.providerFailure = { status: initialResult.status, info: initialResult.error?.codexErrorInfo, message: String(initialResult.error?.message ?? "").slice(0, 1000) }
      throw Error("Parent seed failed")
    }
    await until(() => readChatParentContext(sourceHome, { threadId: parent.id, title: "QA", cwd, path: parent.path }).then(context => context.lastTurnId === initial.turn.id).catch(() => false), "Parent durable boundary", 5000)
    const parentBefore: any = await seed.client.request("thread/read", { threadId: parent.id, includeTurns: true })
    await o.select({ id: "gpichan", revision: "builtin" })
    o.service.configure(true, "ko")
    o.service.setCandidates([{ threadId: parent.id, title: "비민감 사이드챗 검증", cwd, path: parent.path, sourceHome }], parent.id)
    o.service.setMode("compact")
    const win = o.window.window!, js = (code: string) => win.webContents.executeJavaScript(code)
    await until(() => js('Boolean(document.querySelector("textarea"))'), "Chat renderer load")
    const send = async (text: string) => {
      assert(result.logicalModelRequests < 6, "Six-request budget")
      const before = o.service.snapshot().messages.filter(m => m.role === "assistant").length
      await js(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await wait(50); result.logicalModelRequests++
      await js("document.querySelector('.send').click()")
      await until(() => o.service.snapshot().messages.filter(m => m.role === "assistant").length > before || o.service.snapshot().phase === "error", "Real reply completion", 120000)
      assert(!o.service.snapshot().error, "Real chat failed: " + o.service.snapshot().error)
      const message = o.service.snapshot().messages.filter(m => m.role === "assistant").at(-1)!
      await until(() => js(`Boolean(document.querySelector('.expand')) || Array.from(document.querySelectorAll('.message')).some(e => e.textContent.includes(${JSON.stringify(message.text.slice(0, 80))}))`), "Real response rendered")
      result.responses.push({ character: o.service.snapshot().character.id, text: message.text })
      return message
    }
    await send("지피쨩, 간단히 인사하고 부모 대화의 검증 문구를 알려 주세요.")
    result.checks.gpichanFirst = "PASS"
    await writeFile(join(o.output, "gpichan-short.png"), (await win.webContents.capturePage()).toPNG())
    const long = await send("앞서 기억한 검증 문구를 먼저 말하고, 대화의 맥락이 유지되는 이유를 8개 문단으로 자세히 설명해 주세요. 끝에 간단한 TypeScript 예시 코드도 넣어 주세요.")
    assert(long.text.includes("731"), "Parent/child follow-up context")
    await until(() => js('Boolean(document.querySelector(".expand"))'), "Long answer expansion")
    const beforeExpand = result.logicalModelRequests
    await js("document.querySelector('.expand').click()")
    await until(() => js('Boolean(document.querySelector(".panel"))'), "Expanded panel")
    await js("Array.from(document.querySelectorAll('.copy')).at(-1).click()")
    await wait(100); assert(clipboard.readText() === long.text, "Exact real-response copy")
    assert(result.logicalModelRequests === beforeExpand, "Expansion made no call")
    result.checks.followupContext = "PASS"; result.checks.longExpandCopy = "PASS"
    await writeFile(join(o.output, "gpichan-long-panel.png"), (await win.webContents.capturePage()).toPNG())
    assert(JSON.stringify(parentBefore.thread.turns) === JSON.stringify((await seed.client.request("thread/read", { threadId: parent.id, includeTurns: true }) as any).thread.turns), "Child modified parent history")
    const external = o.registry.snapshot().entries.find(e => e.source === "external" && e.id === "asuma-toki-v5")
    if (external) {
      const epoch = o.service.snapshot().epoch
      await o.select(external)
      await until(() => o.service.snapshot().character.id === external.id && !o.service.snapshot().applying, "Toki persona applied")
      assert(o.service.snapshot().epoch > epoch && !o.service.snapshot().messages.length, "Character change retired old chat")
      await send("토키, 짧게 자기소개하고 지금 작업 상태를 확실히 알 수 있는지 답해 주세요.")
      result.checks.tokiSwitch = "PASS"
      await writeFile(join(o.output, "toki-real-response.png"), (await win.webContents.capturePage()).toPNG())
    } else result.checks.tokiSwitch = "BLOCKED_INPUT"
    assert(result.logicalModelRequests + 2 <= 6, "Remaining stop budget")
    result.logicalModelRequests++
    const work: any = await seed.client.request("turn/start", { threadId: parent.id, environments: [], input: [{ type: "text", text: "동시 진행 검증입니다. 1부터 60까지 번호와 짧은 테스트 문장을 한 줄씩 작성해 주세요.", text_elements: [] }] })
    parentWork = work.turn.id
    result.logicalModelRequests++
    await js("(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'검증용으로 긴 설명을 30개 문단 작성해 주세요.');e.dispatchEvent(new Event('input',{bubbles:true}));})()")
    await wait(30); await js("document.querySelector('.send').click()")
    await until(() => o.service.snapshot().phase === "answering" || o.service.snapshot().phase === "error", "Interruptable child")
    await wait(150)
    const beforeStop: any = await seed.client.request("thread/read", { threadId: parent.id, includeTurns: true })
    result.checks.parentInProgressAtChildStop = beforeStop.thread.turns.some((t: any) => t.id === parentWork && t.status === "inProgress") ? "PASS" : "NOT_OBSERVED"
    await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='응답 중지').click()")
    await until(() => ["stopped", "error"].includes(o.service.snapshot().phase), "Child stopped")
    assert(o.service.snapshot().error === "STOPPED", "Child interruption outcome")
    const afterStop: any = await seed.client.request("thread/read", { threadId: parent.id, includeTurns: true })
    assert(afterStop.thread.turns.find((t: any) => t.id === parentWork)?.status !== "interrupted", "Child stop interrupted parent")
    result.checks.childOnlyStop = "PASS"
    // This separate QA caller owns the synthetic parent and stops its own remaining work.
    await seed.client.request("turn/interrupt", { threadId: parent.id, turnId: parentWork }).catch(() => {})
    parentWork = null
    result.status = Object.values(result.checks).every(value => value === "PASS") ? "PASS" : "PARTIAL"
  } catch (error) { result.status = "FAIL"; result.error = String(error) }
  finally {
    if (seed && parentId && parentWork) await seed.client.request("turn/interrupt", { threadId: parentId, turnId: parentWork }).catch(() => {})
    o.service.configure(false, "ko"); await seed?.stop()
    await writeFile(join(o.output, "live-result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
  }
  return result
}
