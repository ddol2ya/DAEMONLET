import type { SideChatService } from "./SideChatService"

/** Only explicit UI entry may reveal/focus the pet and its existing task window. */
export class SideChatEntryController {
  private opening: AbortController | null = null
  constructor(private readonly service: SideChatService, private readonly view: {
    revealPet(signal: AbortSignal): Promise<boolean>
    focus(): void
    refreshParents(query?: string): Promise<void>
    check(): Promise<void>
  }) {}
  cancel() { this.opening?.abort(); this.opening = null }
  async open(target?: { threadId: string; activityId?: string }, explicitTask = false) {
    this.cancel()
    const opening = this.opening = new AbortController()
    const current = () => this.opening === opening && !opening.signal.aborted
    try {
      if (!await this.view.revealPet(opening.signal) || !current()) return
      if (this.service.snapshot().enabled && (explicitTask && !target || target && target.threadId !== this.service.parentThreadId())) this.service.clearParent()
      // OFF is a visible connection-settings view, never an implicit enable.
      this.service.setMode("compact")
      this.view.focus()
      if (!this.service.snapshot().enabled) return
      const epoch = this.service.snapshot().epoch
      await this.view.refreshParents(target?.threadId)
      if (!current() || epoch !== this.service.snapshot().epoch) return
      if (target) this.service.chooseThread(target.threadId, target.activityId)
      await this.view.check()
      // No show/focus continuation after metadata or a late answer.
    } finally { if (this.opening === opening) this.opening = null }
  }
}
