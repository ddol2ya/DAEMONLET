import { app, clipboard } from "electron"
import { writeFile, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { readDesktopThreadCatalog } from "./control/DesktopThreadCatalog"
import { inspectChatSource } from "./side-chat/SideChatSource"
import { CHAT_PROFILE_HASH } from "./side-chat/SideChatPolicy"
import type { SideChatService } from "./side-chat/SideChatService"
import type { SideChatWindowController } from "./SideChatWindowController"
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const assert = (v: unknown, label: string) => { if (!v) throw Error(label) }
async function until(check: () => unknown | Promise<unknown>, label: string) {
  const end = Date.now() + 180000
  while (Date.now() < end) { if (await check()) return; await wait(40) }
  throw Error(label)
}
/** Opt-in packaged QA. Uses the configured production factory and real input UI.
 * Does not create a parent, issue parent RPCs, or record transcript/screenshot data. */
export async function runPaginatedSideChatLiveSmoke(o: { service: SideChatService; window: SideChatWindowController; home: string; selectedId: string; output: string }) {
  if (!app.isPackaged || process.env.ELECTRON_SMOKE_TEST !== "1" || !process.env.ELECTRON_SMOKE_USER_DATA || process.env.ELECTRON_SMOKE_PAGINATED_CHAT !== "user-authorized-three-turns") throw Error("Isolated explicit three-turn QA authorization required")
  const report: any = { status: "NOT_RUN", kind: "existing-paginated-parent-production-ui-real-account", profileHash: CHAT_PROFILE_HASH, logicalTurnSubmissions: 0, parentRPCs: 0, transcriptRecorded: false, screenshotsRecorded: false, checks: {}, responses: [] }
  let source: Awaited<ReturnType<typeof open>> | null = null
  try {
    const parent = (await readDesktopThreadCatalog(o.home)).find(row => row.id === o.selectedId)
    assert(parent, "SELECTED_PARENT_MISSING")
    const selected = { threadId: parent!.id, title: "선택된 실제 작업 세션", cwd: parent!.cwd, path: parent!.path, sourceHome: o.home }
    assert((await inspectChatSource(o.home, selected)).format === "paginated", "PAGINATED_PARENT_REQUIRED")
    source = await open(parent!.path, "r")
    const original = await source.stat(), prefix = Buffer.alloc(Math.min(original.size, 65536))
    await source.read(prefix, 0, prefix.length, 0)
    o.service.configure(true, "ko"); o.service.setCandidates([selected], selected.threadId); o.service.setMode("compact")
    const win = o.window.window!, js = (code: string) => win.webContents.executeJavaScript(code)
    await until(() => js('Boolean(document.querySelector("textarea"))'), "RENDERER_READY")
    const input = async (text: string) => {
      assert(report.logicalTurnSubmissions < 3, "THREE_TURN_BUDGET")
      await js(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await wait(60); report.logicalTurnSubmissions++
      await js("document.querySelector('.send').click()")
    }
    const answer = async (text: string) => {
      const before = o.service.snapshot().messages.filter(m => m.role === "assistant").length
      await input(text)
      await until(() => o.service.snapshot().messages.filter(m => m.role === "assistant").length > before || o.service.snapshot().phase === "error", "ANSWER_DEADLINE")
      assert(!o.service.snapshot().error, o.service.snapshot().error ?? "ANSWER_FAILED")
      const message = o.service.snapshot().messages.filter(m => m.role === "assistant").at(-1)!
      await until(() => js(`Boolean(document.querySelector('.expand')) || Array.from(document.querySelectorAll('.message')).some(e=>e.textContent.includes(${JSON.stringify(message.text.slice(0,80))}))`), "FINAL_BODY_RENDERED")
      report.responses.push({ bytes: Buffer.byteLength(message.text), sha256: createHash("sha256").update(message.text).digest("hex"), character: o.service.snapshot().character.id })
      return message
    }
    const first = await answer("지피쨩, 부모 대화에서 사용자가 지금 구현하려는 기능과 원본 작업을 보존하기 위한 핵심 제약을 간단히 설명해 주세요. 확실하지 않은 것은 추측하지 마세요.")
    report.checks.firstAnswerRendered = "PASS"
    report.checks.contextTerms = /paginated|페이지|사이드.*(챗|대화)/i.test(first.text) && /원본|읽기.*전용|read.only/i.test(first.text) ? "MATCHED" : "NEEDS_USER_REVIEW"
    const second = await answer("같은 맥락을 바탕으로 원본 대화와 자식 대화의 관계를 8개 문단으로 설명해 주세요. 마지막에 짧은 TypeScript 예시를 넣어 주세요. 실제 확인하지 않은 시험은 성공이라고 말하지 마세요.")
    report.checks.followupAnswerRendered = "PASS"
    await until(() => js('Boolean(document.querySelector(".expand"))'), "EXPAND_AVAILABLE")
    const count = report.logicalTurnSubmissions
    await js("document.querySelector('.expand').click()")
    await until(() => js('Boolean(document.querySelector(".panel"))'), "PANEL_VISIBLE")
    await js("Array.from(document.querySelectorAll('.copy')).at(-1).click()")
    await wait(120); assert(clipboard.readText() === second.text, "COPY_EXACT")
    // Clear only the value this test just placed on the clipboard; retain no raw answer.
    if (clipboard.readText() === second.text) clipboard.clear()
    report.checks.expandCopyWithoutSubmission = report.logicalTurnSubmissions === count ? "PASS" : "FAIL"
    await input("검증용으로 이 설계를 30개 문단으로 자세히 설명해 주세요.")
    await until(() => o.service.snapshot().phase === "answering" || o.service.snapshot().phase === "error", "CHILD_STARTED")
    await wait(300)
    report.parentObserverAtStop = o.service.snapshot().task.state
    await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='응답 중지').click()")
    await until(() => ["stopped", "error"].includes(o.service.snapshot().phase), "CHILD_STOPPED")
    assert(o.service.snapshot().error === "STOPPED", "CHILD_INTERRUPT_OUTCOME")
    report.checks.childStop = "PASS"
    const after = Buffer.alloc(prefix.length); await source.read(after, 0, after.length, 0)
    assert(after.equals(prefix), "SOURCE_PREFIX_CHANGED")
    report.checks.sourcePrefixUnchanged = "PASS"
    report.checks.parentProgress = (await source.stat()).size > original.size ? "APPEND_OBSERVED" : "NOT_OBSERVED"
    report.checks.nativeCompletedBoundary = o.service.snapshot().parent?.contextAt ? "PASS" : "FAIL"
    report.status = "LIVE_UI_PASS"
  } catch (error) { report.status = "FAIL"; report.reason = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "LIVE_QA_FAILED" }
  finally { o.service.configure(false, "ko"); await source?.close(); await writeFile(join(o.output, "paginated-live-result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }) }
  return report
}
