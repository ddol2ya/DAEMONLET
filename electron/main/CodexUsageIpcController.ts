import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { CODEX_USAGE_IPC, type UsageResponse } from "../shared/codex-usage-contract"
import { isTrustedSender } from "./SecurityPolicy"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { CodexUsageService } from "./codex-usage/CodexUsageService"
export class CodexUsageIpcController {
  private off: (() => void) | null = null
  private bucket = { owner: "", start: 0, count: 0 }
  constructor(private readonly service: CodexUsageService, private readonly bubble: ActivityBubbleWindowController, private readonly devServerUrl?: string, private readonly now = Date.now) {}
  register() {
    if (this.off) return
    for (const channel of [CODEX_USAGE_IPC.get, CODEX_USAGE_IPC.refresh]) ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<UsageResponse> => {
      if (!isTrustedSender(event, this.bubble.window, "activity-bubble", this.devServerUrl)) return { ok: false, code: "UNTRUSTED_SENDER" }
      if (args.length) return { ok: false, code: "INVALID_REQUEST" }
      const owner = `${event.sender.id}:${event.senderFrame!.processId}:${event.senderFrame!.routingId}`, at = this.now()
      if (owner !== this.bucket.owner || at - this.bucket.start >= 1000) this.bucket = { owner, start: at, count: 0 }
      if (++this.bucket.count > 12) return { ok: false, code: "REQUEST_LIMITED" }
      try { return { ok: true, value: channel === CODEX_USAGE_IPC.get ? this.service.snapshot() : await this.service.refresh() } }
      catch { return { ok: false, code: "UNAVAILABLE" } }
    })
    this.off = this.service.subscribe(value => this.bubble.send(CODEX_USAGE_IPC.changed, value))
  }
  dispose() { this.off?.(); this.off = null; ipcMain.removeHandler(CODEX_USAGE_IPC.get); ipcMain.removeHandler(CODEX_USAGE_IPC.refresh) }
}
