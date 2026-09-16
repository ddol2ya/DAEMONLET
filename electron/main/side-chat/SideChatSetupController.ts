import { dialog, shell, type BrowserWindow } from "electron"
import { homedir } from "node:os"
import { join } from "node:path"
import { chatError, type SideChatService } from "./SideChatService"
import { connectVerifiedSideChat, inspectSideChatRuntime } from "./SideChatPolicy"
import { SIDE_CHAT_MODEL } from "./SideChatModelPolicy"
import { SideChatPreferences, SIDE_CHAT_CONSENT_VERSION } from "./SideChatPreferences"
import type { ChatRequest } from "../../shared/side-chat-contract"

export class SideChatSetupController {
  private generation = 0
  private pending: { generation: number; selection: string; promise: Promise<void> } | null = null
  private detected: string | null = null
  constructor(private readonly service: SideChatService, private readonly preferences: SideChatPreferences,
    private readonly selection: () => { codexHome: string | null; executablePath: string | null },
    private readonly window: () => BrowserWindow | null, private readonly enableSetting: () => void) {}
  async load() { await this.preferences.load(); this.publishPreferences() }
  private publishPreferences() {
    const pref = this.preferences.get()
    this.service.setPreparation({ consentRequired: pref.consentVersion !== SIDE_CHAT_CONSENT_VERSION,
      offNotice: !this.service.snapshot().enabled && !pref.offNoticeSeen })
  }
  options() {
    const shared = this.selection()
    return { codexHome: shared.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      executable: this.preferences.get().executable ?? shared.executablePath ?? this.detected ?? process.env.CODEX_PATH ?? null }
  }
  invalidate() { this.generation++; this.detected = null; this.service.connectionChanged(); this.service.setPreparation({ readiness: { phase: "unchecked", code: null, checkedAt: null } }) }
  /** Account/catalog metadata only: never fork, resume, turn/start or send text. */
  check(): Promise<void> {
    if (!this.service.snapshot().enabled) { this.publishPreferences(); return Promise.resolve() }
    const options = this.options(), selection = JSON.stringify(options), generation = this.generation
    const previous = this.pending
    if (previous?.generation === generation && previous.selection === selection) return previous.promise
    const job = { generation, selection, promise: Promise.resolve() }
    this.pending = job
    this.service.setPreparation({ readiness: { phase: "checking", code: null, checkedAt: null } })
    const current = () => this.pending === job && generation === this.generation && this.service.snapshot().enabled && job.selection === JSON.stringify(this.options())
    const run = async () => {
      // Serialize cleanup, but superseded queued selections never open a connection.
      await previous?.promise.catch(() => {})
      let connection: Awaited<ReturnType<typeof connectVerifiedSideChat>> | null = null
      try {
        if (!current()) return
        const runtime = await inspectSideChatRuntime(options.executable)
        if (!current()) return
        connection = await connectVerifiedSideChat({ ...options, executable: runtime.executable })
        if (!current()) return
        this.detected = runtime.executable
        job.selection = JSON.stringify(this.options())
        this.service.setConnectionMode("official-same-home")
        this.service.setPreparation({ readiness: { phase: "ready", code: null, version: runtime.runtime.version, model: SIDE_CHAT_MODEL.id, checkedAt: Date.now() } })
      } catch (error) {
        if (current()) this.service.setPreparation({ readiness: { phase: "blocked", code: chatError(error), checkedAt: Date.now() } })
      } finally {
        try { await connection?.stop() }
        catch { if (current()) this.service.setPreparation({ readiness: { phase: "blocked", code: "SESSION_LOST", checkedAt: Date.now() } }) }
        finally { if (this.pending === job) this.pending = null }
      }
    }
    return job.promise = run()
  }
  async pickCli(discover = false) {
    let executable: string
    if (discover) executable = (await inspectSideChatRuntime()).executable
    else {
      const choice = await dialog.showOpenDialog(this.window()!, { properties: ["openFile", "dontAddToRecent"], title: this.service.snapshot().language === "ko" ? "공식 Codex CLI 선택" : "Choose official Codex CLI" })
      if (choice.canceled || choice.filePaths.length !== 1) return
      executable = (await inspectSideChatRuntime(choice.filePaths[0])).executable
    }
    // Explicit side-chat action only. Shared task-control/Hook selection survives.
    await this.preferences.save({ executable }); this.invalidate(); await this.check()
  }
  async enable() { this.invalidate(); this.enableSetting(); this.publishPreferences(); await this.check() }
  async dismissNotice() { await this.preferences.save({ offNoticeSeen: true }); this.publishPreferences() }
  async help() { await shell.openExternal("https://developers.openai.com/codex/cli") }
  async confirmSend(request: ChatRequest): Promise<boolean> {
    if (!this.service.snapshot().enabled) throw Error("CHAT_DISABLED")
    if (this.preferences.get().consentVersion === SIDE_CHAT_CONSENT_VERSION) return true
    this.service.setDraft(request.text!, request.draftRevision!)
    const before = this.service.snapshot(), ko = before.language === "ko"
    if (!before.parent) throw Error("NO_PARENT")
    const answer = await dialog.showMessageBox(this.window()!, { type: "question", defaultId: 0, cancelId: 0,
      message: ko ? "선택한 맥락으로 질문을 보내시겠습니까?" : "Send using the selected context?",
      detail: ko
        ? `선택한 대화 ‘${before.parent.title}’의 성공 완료 맥락과 선택한 파일 ${before.attachments?.length ?? 0}개가 별도 임시 자식에서 모델 제공자 OpenAI로 전달되며 Codex 사용량이 발생합니다. 설명·수정안을 제시할 수 있지만 파일 변경·명령·빌드·테스트·외부 서비스·부모 제어는 허용하지 않습니다. 앱 대화와 초안은 메모리에만 보관하며 앱 종료 시 사라집니다. Codex의 정상 내부 저장·로그·인증 처리는 발생할 수 있습니다. 모델: ${SIDE_CHAT_MODEL.id}.`
        : `Successful completed context from “${before.parent.title}” and ${before.attachments?.length ?? 0} selected file excerpts are sent to OpenAI in a separate temporary child and consume Codex usage. It can explain and propose changes. File changes, commands, builds, tests, external services and parent control are disabled. App chat and drafts live in memory until the app exits. Normal Codex storage, logs and authentication processing can occur. Model: ${SIDE_CHAT_MODEL.id}.`,
      buttons: ko ? ["취소", "동의하고 보내기"] : ["Cancel", "Agree and send"] })
    if (answer.response !== 1) return false
    const after = this.service.snapshot()
    if (after.epoch !== request.epoch || !after.enabled || after.draftRevision !== before.draftRevision || JSON.stringify(after.attachments) !== JSON.stringify(before.attachments)) throw Error("STALE_REQUEST")
    await this.preferences.save({ consentVersion: SIDE_CHAT_CONSENT_VERSION }); this.publishPreferences()
    return true
  }
}
