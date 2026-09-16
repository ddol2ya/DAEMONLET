import { app, clipboard } from "electron"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readDesktopThreadCatalog } from "./control/DesktopThreadCatalog"
import type { CharacterRegistry } from "./CharacterRegistry"
import type { CharacterSelection } from "../shared/character-pack-contract"
import type { SideChatService } from "./side-chat/SideChatService"
import type { SideChatWindowController } from "./SideChatWindowController"
import { CHAT_PROFILE_HASH } from "./side-chat/SideChatPolicy"

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const assert = (value: unknown, code: string) => { if (!value) throw Error(code) }
async function until(check: () => unknown | Promise<unknown>) { const end = Date.now() + 180000; while (Date.now() < end) { if (await check()) return; await wait(40) }; throw Error("LIVE_DEADLINE") }

/** Explicit new review scope; legacy live-call markers do not authorize this.
 * Uses the production service/factory. No parent commands or fake responses. */
export async function runOfficialReadOnlyLiveSmoke(o: { service: SideChatService; window: SideChatWindowController; registry: CharacterRegistry; select(value: CharacterSelection): Promise<void>; home: string; parentId: string; output: string }) {
  if (!app.isPackaged || process.env.ELECTRON_SMOKE_TEST !== "1" || !process.env.ELECTRON_SMOKE_USER_DATA || process.env.ELECTRON_SMOKE_OFFICIAL_READONLY !== "fresh-approval-four-submissions") throw Error("Fresh official review approval required")
  const tokiOnly = process.env.ELECTRON_SMOKE_OFFICIAL_STAGE === "toki-only"
  const report: any = { kind: "official-same-home-packaged-ui-real-account", stage: tokiOnly ? "toki-completion" : "full-review", status: "NOT_RUN", profileHash: CHAT_PROFILE_HASH, logicalSubmissions: 0, uiSendAttempts: 0, nativeHttpRetriesAndCompaction: "not instrumented", checks: {}, responses: [] }
  const privateAnswers: Array<{ character: string; text: string }> = []
  try {
    const parent = (await readDesktopThreadCatalog(o.home)).find(row => row.id === o.parentId)
    assert(parent, "SELECTED_PARENT_MISSING")
    const toki = o.registry.snapshot().entries.find(e => e.source === "external" && e.id === "asuma-toki-v4")
    assert(toki, "EXISTING_TOKI_PACK_REQUIRED")
    await o.select(tokiOnly ? toki! : { id: "gpichan", revision: "builtin" })
    o.service.configure(true, "ko"); o.service.setConnectionMode("official-same-home")
    o.service.setCandidates([{ threadId: parent!.id, title: "선택한 실제 작업", cwd: parent!.cwd, sourceHome: o.home }], parent!.id); o.service.setMode("compact")
    const js = (code: string) => o.window.window!.webContents.executeJavaScript(code)
    await until(() => js('Boolean(document.querySelector("textarea"))'))
    const input = async (text: string) => {
      assert(report.logicalSubmissions < (tokiOnly ? 1 : 4), "NEW_REVIEW_BUDGET_EXHAUSTED")
      const previousReceipt = o.service.snapshot().acceptedSubmission?.requestId
      await js(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await wait(80); report.uiSendAttempts++
      await js("document.querySelector('.send').click()")
      await until(async () => o.service.snapshot().acceptedSubmission?.requestId !== previousReceipt || o.service.snapshot().phase === "error" || await js('Boolean(document.querySelector(".error"))'))
      assert(o.service.snapshot().acceptedSubmission?.requestId !== previousReceipt && Boolean(o.service.snapshot().acceptedSubmission), "UI_SEND_NOT_ACCEPTED")
      report.logicalSubmissions++
    }
    const answer = async (text: string) => {
      const count = o.service.snapshot().messages.filter(m => m.role === "assistant").length
      await input(text)
      await until(() => o.service.snapshot().messages.filter(m => m.role === "assistant").length > count || o.service.snapshot().phase === "error")
      assert(!o.service.snapshot().error, o.service.snapshot().error ?? "LIVE_ANSWER_FAILED")
      const message = o.service.snapshot().messages.filter(m => m.role === "assistant").at(-1)!
      await until(() => js(`Boolean(document.querySelector('.expand')) || Array.from(document.querySelectorAll('.message')).some(e=>e.textContent.includes(${JSON.stringify(message.text.slice(0, 70))}))`))
      report.responses.push({ character: o.service.snapshot().character.id, bytes: Buffer.byteLength(message.text), sha256: createHash("sha256").update(message.text).digest("hex") })
      privateAnswers.push({ character: o.service.snapshot().character.id, text: message.text })
      return message
    }
    if (tokiOnly) {
      await answer("토키, 네 말투로 짧게 인사하고 이 부모 대화의 작업을 어떻게 설명할 수 있는지 알려 주세요. 직접 작업을 실행했다고 주장하지 마세요.")
      report.checks.characterNewConversation = "PASS"; report.status = "LIVE_UI_PASS"
      return report
    }
    await answer("지피쨩, 승계한 부모 대화에서 진행하던 기능과 핵심 제약을 간단히 설명해 주세요. 현재 작업 상태는 추측하지 마세요.")
    report.checks.firstAnswer = "PASS"
    // Approval explicitly covers this non-sensitive file and range. UI picker
    // operation is tested separately; this calls the same Main file policy.
    await o.service.attachFile(join(parent!.cwd, "README.md"), 1, 40, o.service.snapshot().epoch)
    const second = await answer("방금 선택한 README.md의 행 번호를 인용해 프로젝트를 설명하고, 앞서 답한 부모 맥락과 연결해 주세요. 8개 문단과 짧은 코드 수정안 예시를 보여 주세요. 실제 파일은 바꾸지 마세요.")
    report.checks.fileFollowup = "RENDERED_REQUIRES_SEMANTIC_REVIEW"
    await until(() => js('Boolean(document.querySelector(".expand"))'))
    const count = report.logicalSubmissions
    await js("document.querySelector('.expand').click()")
    await until(() => js('Boolean(document.querySelector(".panel"))'))
    await js("Array.from(document.querySelectorAll('.copy')).at(-1).click()")
    await wait(100); assert(clipboard.readText() === second.text, "COPY_MISMATCH")
    if (clipboard.readText() === second.text) clipboard.clear()
    report.checks.exactCopyWithoutSubmission = count === report.logicalSubmissions ? "PASS" : "FAIL"
    await input("이 맥락과 코드 설명을 30개 문단으로 자세히 풀어 주세요.")
    await until(() => o.service.snapshot().phase === "answering" || o.service.snapshot().phase === "error")
    await wait(300)
    report.parentObserverAtStop = o.service.snapshot().task.state
    await o.service.stop()
    await until(() => ["stopped", "error", "idle"].includes(o.service.snapshot().phase))
    report.checks.childStop = o.service.snapshot().error === "STOPPED" ? "PASS" : "NOT_OBSERVED"
    o.service.reset(); await o.select(toki!)
    await until(() => o.service.snapshot().character.id === toki!.id && !o.service.snapshot().applying)
    await answer("토키, 네 말투로 짧게 인사하고 이 부모 대화의 작업을 어떻게 설명할 수 있는지 알려 주세요. 직접 작업을 실행했다고 주장하지 마세요.")
    report.checks.characterNewConversation = "PASS"
    report.status = Object.values(report.checks).some(v => v === "FAIL" || v === "NOT_OBSERVED") ? "PARTIAL" : "LIVE_UI_PASS"
  } catch (error) { report.status = "FAIL"; report.code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "LIVE_QA_FAILED" }
  finally {
    o.service.configure(false, "ko")
    await o.select({ id: "gpichan", revision: "builtin" })
    await writeFile(join(o.output, "private-official-answers.json"), JSON.stringify(privateAnswers) + "\n", { flag: "wx", mode: 0o600 })
    await writeFile(join(o.output, "official-live-result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  }
  return report
}
