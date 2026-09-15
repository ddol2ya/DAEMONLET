import { clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from "electron"
import { SIDE_CHAT_IPC, validateChatRequest, type ChatAction } from "../shared/side-chat-contract"
import { chatError, type SideChatService } from "./side-chat/SideChatService"
import type { SideChatWindowController } from "./SideChatWindowController"
import { isTrustedSender } from "./SecurityPolicy"

export class SideChatIpcController {
  private rate = { since: 0, count: 0 }
  constructor(private readonly service: SideChatService, private readonly window: SideChatWindowController, private readonly devServerUrl?: string) {}
  register() {
    const trusted = (e: IpcMainInvokeEvent) => isTrustedSender(e, this.window.window, "side-chat", this.devServerUrl)
    ipcMain.handle(SIDE_CHAT_IPC.get, (e, ...args) => trusted(e) && !args.length ? { ok: true, value: this.service.snapshot() } : { ok: false, code: "INVALID_REQUEST" })
    ipcMain.handle(SIDE_CHAT_IPC.action, async (e, action: ChatAction, value: unknown, ...extra) => {
      try {
        if (!trusted(e) || extra.length || !["send", "stop", "reset", "draft", "compact", "panel", "hide", "parent", "copy"].includes(action)) throw new Error("INVALID_REQUEST")
        const now = Date.now()
        if (now - this.rate.since > 1000) this.rate = { since: now, count: 0 }
        if (++this.rate.count > 24) throw new Error("REQUEST_LIMITED")
        const request = validateChatRequest(value, ["send", "draft", "parent", "copy"].includes(action))
        this.service.accept(request)
        if (action === "reset" && this.service.snapshot().draft) {
          const ko = this.service.snapshot().language === "ko"
          const answer = await dialog.showMessageBox(this.window.window!, { type: "question", message: ko ? "대화를 초기화하시겠습니까? 작성 중인 입력은 보존됩니다." : "Reset this conversation? Your draft will be kept.", buttons: ko ? ["취소", "초기화"] : ["Cancel", "Reset"], defaultId: 0, cancelId: 0 })
          if (answer.response !== 1) return { ok: true, value: this.service.snapshot() }
          if (request.epoch !== this.service.snapshot().epoch) throw new Error("STALE_REQUEST")
        }
        if (action === "send") await this.service.send(request.text!)
        else if (action === "stop") await this.service.stop()
        else if (action === "reset") this.service.reset()
        else if (action === "draft") this.service.setDraft(request.text!)
        else if (action === "parent") this.service.chooseParent(request.text!)
        else if (action === "copy") { const message = this.service.snapshot().messages.find(m => m.id === request.text); if (!message) throw new Error("INVALID_REQUEST"); clipboard.writeText(message.text) }
        else this.service.setMode(action === "hide" ? "hidden" : action)
        return { ok: true, value: this.service.snapshot() }
      } catch (error) { return { ok: false, code: chatError(error) } }
    })
  }
  dispose() { ipcMain.removeHandler(SIDE_CHAT_IPC.get); ipcMain.removeHandler(SIDE_CHAT_IPC.action) }
}
