import { clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from "electron"
import { SIDE_CHAT_IPC, validateChatRequest, type ChatAction } from "../shared/side-chat-contract"
import { chatError, type SideChatService } from "./side-chat/SideChatService"
import type { SideChatWindowController } from "./SideChatWindowController"
import { isTrustedSender } from "./SecurityPolicy"
import type { SideChatSetupController } from "./side-chat/SideChatSetupController"

export class SideChatIpcController {
  private rate = { since: 0, count: 0 }
  private sendPending = false
  constructor(private readonly service: SideChatService, private readonly window: SideChatWindowController, private readonly devServerUrl?: string,
    private readonly setup?: SideChatSetupController, private readonly parents?: (query?: string, more?: boolean) => Promise<void>) {}
  register() {
    const trusted = (e: IpcMainInvokeEvent) => isTrustedSender(e, this.window.window, "side-chat", this.devServerUrl)
    ipcMain.handle(SIDE_CHAT_IPC.get, (e, ...args) => trusted(e) && !args.length ? { ok: true, value: this.service.snapshot() } : { ok: false, code: "INVALID_REQUEST" })
    ipcMain.handle(SIDE_CHAT_IPC.action, async (e, action: ChatAction, value: unknown, ...extra) => {
      try {
        if (!trusted(e) || extra.length || !["send", "stop", "reset", "draft", "compact", "panel", "hide", "parent", "copy", "attach", "detach", "remove-attachment", "check", "pick-cli", "discover-cli", "help", "enable", "search", "more", "dismiss-notice"].includes(action)) throw new Error("INVALID_REQUEST")
        const now = Date.now()
        if (now - this.rate.since > 1000) this.rate = { since: now, count: 0 }
        if (++this.rate.count > 24) throw new Error("REQUEST_LIMITED")
        const request = validateChatRequest(value, action)
        this.service.accept(request)
        if (action === "reset" && this.service.snapshot().draft) {
          const ko = this.service.snapshot().language === "ko"
          const answer = await dialog.showMessageBox(this.window.window!, { type: "question", message: ko ? "대화를 초기화하시겠습니까? 작성 중인 입력은 보존됩니다." : "Reset this conversation? Your draft will be kept.", buttons: ko ? ["취소", "초기화"] : ["Cancel", "Reset"], defaultId: 0, cancelId: 0 })
          if (answer.response !== 1) return { ok: true, value: this.service.snapshot() }
          if (request.epoch !== this.service.snapshot().epoch) throw new Error("STALE_REQUEST")
        }
        if (action === "send") {
          if (this.sendPending) throw Error("BUSY")
          this.sendPending = true
          try {
            if (!this.setup || await this.setup.confirmSend(request)) {
              if (request.epoch !== this.service.snapshot().epoch) throw Error("STALE_REQUEST")
              await this.service.send(request.text!, { requestId: request.requestId, draftRevision: request.draftRevision! })
            }
          } finally { this.sendPending = false }
        }
        else if (action === "stop") await this.service.stop()
        else if (action === "reset") this.service.reset()
        else if (action === "draft") this.service.setDraft(request.text!, request.draftRevision!)
        else if (action === "parent") this.service.chooseParent(request.text!)
        else if (action === "attach") {
          let range: { startLine: number; endLine: number }
          try { range = JSON.parse(request.text!) } catch { throw Error("INVALID_REQUEST") }
          if (!range || Object.keys(range).sort().join() !== "endLine,startLine" || !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine || range.endLine - range.startLine >= 400) throw Error("READ_LIMIT")
          const reader = await this.service.projectReader()
          const selection = await dialog.showOpenDialog(this.window.window!, { title: this.service.snapshot().language === "ko" ? "프로젝트 텍스트 파일 선택" : "Select a project text file", defaultPath: reader.root, properties: ["openFile", "dontAddToRecent"] })
          if (!selection.canceled && selection.filePaths.length === 1) await this.service.attachFile(selection.filePaths[0], range.startLine, range.endLine, request.epoch)
        }
        else if (action === "detach") this.service.detachFiles()
        else if (action === "remove-attachment") { if (!/^\d{1,2}$/.test(request.text!)) throw Error("INVALID_REQUEST"); this.service.removeAttachment(Number(request.text)) }
        else if (["check", "pick-cli", "discover-cli", "help", "enable", "dismiss-notice"].includes(action)) {
          if (!this.setup) throw Error("INVALID_REQUEST")
          if (action === "check") { await this.setup.check(); await this.parents?.() }
          else if (action === "pick-cli" || action === "discover-cli") { await this.setup.pickCli(action === "discover-cli"); await this.parents?.() }
          else if (action === "enable") { await this.setup.enable(); await this.parents?.() }
          else if (action === "dismiss-notice") await this.setup.dismissNotice()
          else await this.setup.help()
        }
        else if (action === "search" || action === "more") {
          if (!this.parents || (request.text?.length ?? 0) > 120) throw Error("INVALID_REQUEST")
          await this.parents(action === "search" ? request.text : undefined, action === "more")
        }
        else if (action === "copy") { const message = this.service.snapshot().messages.find(m => m.id === request.text); if (!message) throw new Error("INVALID_REQUEST"); clipboard.writeText(message.text) }
        else if (action === "hide" || action === "compact" || action === "panel") this.service.setMode(action === "hide" ? "hidden" : action)
        return { ok: true, value: this.service.snapshot() }
      } catch (error) { return { ok: false, code: chatError(error) } }
    })
  }
  dispose() { ipcMain.removeHandler(SIDE_CHAT_IPC.get); ipcMain.removeHandler(SIDE_CHAT_IPC.action) }
}
