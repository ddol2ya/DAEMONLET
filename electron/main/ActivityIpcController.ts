import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { ACTIVITY_IPC, validateActivityAck, type ActivityResponse } from "../shared/activity-contract"
import { isTrustedSender } from "./SecurityPolicy"
import type { ActivityWindowController } from "./ActivityWindowController"
import type { ActivityService } from "./activity/ActivityService"
import type { CodexAppLauncher } from "./activity/CodexAppLauncher"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"

export class ActivityIpcController {
  private readonly channels: string[] = []
  private unsubscribe: (() => void) | null = null
  private readonly buckets = new Map<"activity" | "activity-bubble", { owner: string; start: number; count: number }>()
  private lastOpen = -Infinity
  private openingResult = false
  constructor(private readonly window: ActivityWindowController, private readonly activity: ActivityService, private readonly launcher: CodexAppLauncher, private readonly devServerUrl?: string, private readonly now: () => number = Date.now, private readonly bubble?: ActivityBubbleWindowController, private readonly openConversation?: (key: string) => Promise<void>, private readonly openChat?: (key?: string, activityId?: string) => Promise<void>) {}

  register(): void {
    if (this.unsubscribe) return
    const bind = <T>(channel: string, arity: number, action: (args: unknown[]) => Promise<ActivityResponse<T>> | ActivityResponse<T>, bubbleOnly = false) => {
      this.channels.push(channel)
      ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ActivityResponse<T>> => {
        const role = isTrustedSender(event, this.bubble?.window ?? null, "activity-bubble", this.devServerUrl) ? "activity-bubble"
          : !bubbleOnly && isTrustedSender(event, this.window.window, "activity", this.devServerUrl) ? "activity" : null
        if (!role) return { ok: false, code: "UNTRUSTED_SENDER" }
        const owner = `${event.sender.id}:${event.senderFrame!.processId}:${event.senderFrame!.routingId}`
        const at = this.now()
        let bucket = this.buckets.get(role)
        if (!bucket || bucket.owner !== owner || at - bucket.start >= 1000) { bucket = { owner, start: at, count: 0 }; this.buckets.set(role, bucket) }
        if (++bucket.count > 24) return { ok: false, code: "REQUEST_LIMITED" }
        if (args.length !== arity) return { ok: false, code: "INVALID_REQUEST" }
        try { return await action(args) } catch { return { ok: false, code: "UNAVAILABLE" } }
      })
    }
    bind(ACTIVITY_IPC.get, 0, () => ({ ok: true, value: this.activity.snapshot() }))
    bind(ACTIVITY_IPC.acknowledge, 1, ([value]) => {
      const request = validateActivityAck(value)
      return request ? { ok: true, value: this.activity.acknowledge(request) } : { ok: false, code: "INVALID_REQUEST" }
    })
    bind(ACTIVITY_IPC.openResult, 1, async ([target]) => {
      const request = validateActivityAck({ targets: [target] })
      if (!request) return { ok: false, code: "INVALID_REQUEST" }
      const selected = request.targets[0]
      const entry = this.activity.snapshot().entries.find(e => e.activityId === selected.activityId)
      if (!entry?.unread || entry.revision !== selected.revision) return { ok: false, code: "STALE_TARGET" }
      const key = this.activity.conversationKey(selected)
      if (!key || !this.openConversation) return { ok: false, code: "UNAVAILABLE" }
      if (this.openingResult || this.now() - this.lastOpen < 2000) return { ok: false, code: "REQUEST_LIMITED" }
      this.openingResult = true; this.lastOpen = this.now()
      try {
        await this.openConversation(key)
        // Only this click's revision is acknowledged, after the launch request succeeds.
        return { ok: true, value: this.activity.acknowledge(request) }
      } catch { return { ok: false, code: "OPEN_FAILED" } }
      finally { this.openingResult = false }
    })
    bind(ACTIVITY_IPC.openCodex, 0, async () => {
      if (this.now() - this.lastOpen < 2000) return { ok: false, code: "REQUEST_LIMITED" }
      this.lastOpen = this.now()
      const result = await this.launcher.open()
      if (result === "unavailable") this.activity.setNavigation("none")
      return result === "opened" ? { ok: true, value: null } : { ok: false, code: result === "unavailable" ? "UNAVAILABLE" : "OPEN_FAILED" }
    })
    bind(ACTIVITY_IPC.openConversation, 1, async ([target]) => {
      const request = validateActivityAck({ targets: [target] })
      if (!request) return { ok: false, code: "INVALID_REQUEST" }
      const key = this.activity.conversationKey(request.targets[0])
      if (!key || !this.openConversation) return { ok: false, code: "UNAVAILABLE" }
      if (this.now() - this.lastOpen < 2000) return { ok: false, code: "REQUEST_LIMITED" }
      this.lastOpen = this.now()
      try { await this.openConversation(key); return { ok: true, value: null } }
      catch { return { ok: false, code: "OPEN_FAILED" } }
    })
    bind(ACTIVITY_IPC.openList, 0, () => { this.window.open(); return { ok: true, value: null } }, true)
    bind(ACTIVITY_IPC.openChat, 1, async ([target]) => {
      if (!this.openChat) return { ok: false, code: "UNAVAILABLE" }
      if (target === null) { await this.openChat(); return { ok: true, value: null } }
      const request = validateActivityAck({ targets: [target] })
      if (!request) return { ok: false, code: "INVALID_REQUEST" }
      const key = this.activity.conversationKey(request.targets[0])
      if (!key) return { ok: false, code: "STALE_TARGET" }
      await this.openChat(key, request.targets[0].activityId)
      return { ok: true, value: null }
    }, true)
    bind(ACTIVITY_IPC.setCollapsed, 1, ([value]) => typeof value === "boolean" && this.bubble
      ? { ok: true, value: this.bubble.setCollapsed(value) } : { ok: false, code: "INVALID_REQUEST" }, true)
    this.unsubscribe = this.activity.subscribe(value => { this.window.send(ACTIVITY_IPC.changed, value); this.bubble?.send(ACTIVITY_IPC.changed, value) })
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; this.buckets.clear(); for (const channel of this.channels.splice(0)) ipcMain.removeHandler(channel) }
}
