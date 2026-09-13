import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { TASK_CONTROL_IPC, isControlKey, validateControlTarget, type TaskControlResponse, type TaskControlSend, type TaskControlError } from "../shared/task-control-contract"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { TaskControlService } from "./control/TaskControlService"
import type { DictationService } from "./control/DictationService"
import { CodexThreadLauncher } from "./control/CodexThreadLauncher"
import { isTrustedSender } from "./SecurityPolicy"

const errors = new Set<TaskControlError>(["INVALID_REQUEST", "REQUEST_LIMITED", "UNAVAILABLE", "UNSAFE_SOCKET", "CONNECT_FAILED", "PROTOCOL_UNSUPPORTED", "STALE_TARGET", "ACTION_FAILED", "OUTCOME_UNKNOWN", "OPERATION_PENDING", "OPEN_FAILED"])
export class TaskControlIpcController {
  private channels: string[] = []
  private unsubscribes: Array<() => void> = []
  private bucket = { owner: "", start: 0, count: 0 }
  constructor(private readonly window: ActivityBubbleWindowController, private readonly service: TaskControlService, private readonly dictation: DictationService, private readonly devServerUrl?: string, private readonly now = Date.now, private readonly launcher = new CodexThreadLauncher()) {}
  register(): void {
    if (this.channels.length) return
    const bind = <T>(channel: string, arity: number, action: (args: unknown[]) => T | Promise<T>) => {
      this.channels.push(channel)
      ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TaskControlResponse<T>> => {
        if (!isTrustedSender(event, this.window.window, "activity-bubble", this.devServerUrl)) return { ok: false, code: "UNTRUSTED_SENDER" }
        const owner = `${event.sender.id}:${event.senderFrame!.processId}:${event.senderFrame!.routingId}`, at = this.now()
        if (this.bucket.owner !== owner || at - this.bucket.start >= 1000) this.bucket = { owner, start: at, count: 0 }
        if (++this.bucket.count > 20) return { ok: false, code: "REQUEST_LIMITED" }
        if (args.length !== arity) return { ok: false, code: "INVALID_REQUEST" }
        try { return { ok: true, value: await action(args) } }
        catch (error) { const code = error instanceof Error ? error.message as TaskControlError : "UNAVAILABLE"; return { ok: false, code: errors.has(code) ? code : "UNAVAILABLE" } }
      })
    }
    bind(TASK_CONTROL_IPC.openConversation, 1, async ([key]) => { if (!isControlKey(key)) throw new Error("INVALID_REQUEST"); this.dictation.cancel(); await this.launcher.open(await this.service.navigationTarget(key)); return null })
    bind(TASK_CONTROL_IPC.get, 0, () => this.service.snapshot())
    bind(TASK_CONTROL_IPC.getView, 0, () => this.window.getView())
    bind(TASK_CONTROL_IPC.connect, 1, ([path]) => { if (typeof path !== "string" || path.length > 256 || !path || path.includes("\0")) throw new Error("INVALID_REQUEST"); this.dictation.cancel(); return this.service.connect(path) })
    bind(TASK_CONTROL_IPC.connectDesktop, 0, () => { this.dictation.cancel(); return this.service.connectDesktop() })
    bind(TASK_CONTROL_IPC.disconnect, 0, () => { this.dictation.cancel(); return this.service.disconnect() })
    bind(TASK_CONTROL_IPC.refresh, 0, () => this.service.refresh())
    bind(TASK_CONTROL_IPC.select, 1, ([key]) => { if (!isControlKey(key)) throw new Error("INVALID_REQUEST"); this.dictation.cancel(); return this.service.select(key) })
    bind(TASK_CONTROL_IPC.send, 1, ([value]) => { const request = validateControlTarget(value, true); if (!request) throw new Error("INVALID_REQUEST"); this.dictation.cancel(); return this.service.send(request as TaskControlSend) })
    bind(TASK_CONTROL_IPC.stop, 1, ([value]) => { const request = validateControlTarget(value, false); if (!request) throw new Error("INVALID_REQUEST"); return this.service.stop(request) })
    bind(TASK_CONTROL_IPC.view, 2, ([view, collapsed]) => { if ((view !== "activity" && view !== "control") || typeof collapsed !== "boolean") throw new Error("INVALID_REQUEST"); this.dictation.cancel(); this.window.setView(view, collapsed); return null })
    bind(TASK_CONTROL_IPC.dictationStart, 1, ([sessionId]) => {
      if (!isControlKey(sessionId)) throw new Error("INVALID_REQUEST")
      if (this.window.getView().view !== "control" || this.window.getView().collapsed || !this.window.window?.isVisible()) throw new Error("UNAVAILABLE")
      this.dictation.start(sessionId); return null
    })
    bind(TASK_CONTROL_IPC.dictationStop, 1, ([sessionId]) => { if (!isControlKey(sessionId)) throw new Error("INVALID_REQUEST"); this.dictation.stop(sessionId); return null })
    let previousContext: string | null = null
    this.unsubscribes.push(this.service.subscribe(value => {
      const context = `${value.source}:${value.connection}:${value.selectedKey ?? ""}`
      if (previousContext !== null && previousContext !== context) this.dictation.cancel()
      previousContext = context; this.window.send(TASK_CONTROL_IPC.changed, value)
    }), this.dictation.subscribe(value => this.window.send(TASK_CONTROL_IPC.dictation, value)))
  }
  dispose(): void { for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe(); for (const channel of this.channels.splice(0)) ipcMain.removeHandler(channel); this.dictation.dispose(); this.service.dispose(); void this.launcher.dispose() }
}
