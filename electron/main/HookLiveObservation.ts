import { emptyHookReceipts, sanitizeHookReceipts, type HookEventReceipt } from "../../adapter/codex/hooks/HookEvents"
import type { LiveObservation, ObservationSurface } from "../shared/codex-integration-contract"
import type { EventSupport } from "../../adapter/codex/hooks/HookInstallPlan"

export class HookLiveObservation {
  private baseline = emptyHookReceipts()
  private value: LiveObservation = this.empty()

  private empty(): LiveObservation {
    return { active: false, startedAt: null, surface: null, source: "user-selected-surface", status: "not-tested", events: emptyHookReceipts(), interrupt: "not-tested", desktopStopAttempt: "not-tested" }
  }
  reset(): void { this.value = this.empty(); this.baseline = emptyHookReceipts() }
  start(surface: ObservationSurface, current: HookEventReceipt[] | undefined, now = Date.now()): void {
    this.baseline = sanitizeHookReceipts(current)
    this.value = { ...this.empty(), active: true, startedAt: now, surface }
  }
  stop(): void { this.value.active = false }
  reportDesktopStopAttempt(): void {
    if (!this.value.active || this.value.surface !== "desktop") throw new Error("DESKTOP_OBSERVATION_REQUIRED")
    this.value.desktopStopAttempt = "user-reported"
  }
  update(current: HookEventReceipt[] | undefined, support: EventSupport, ownedAdapter: boolean): void {
    if (this.value.active && ownedAdapter) {
      const events = sanitizeHookReceipts(current)
      if (events.some((item, index) => item.count < this.baseline[index].count)) { this.reset(); return }
      this.value.events = events.map((item, index) => {
        const count = item.lastReceivedAt !== null && item.lastReceivedAt >= this.value.startedAt! ? Math.max(0, item.count - this.baseline[index].count) : 0
        return { event: item.event, count, lastReceivedAt: count ? item.lastReceivedAt : null }
      })
      const observed = (name: string) => this.value.events.some((item) => item.event === name && item.count > 0)
      this.value.status = observed("UserPromptSubmit") && observed("Stop") ? "observed" : this.value.events.some((item) => item.count > 0) ? "partial" : "not-tested"
      if (observed("Interrupt")) this.value.interrupt = "observed"
    }
    if (this.value.interrupt !== "observed") this.value.interrupt = support.Interrupt === "unsupported" ? "unsupported" : support.Interrupt === "unknown" ? "unknown" : "not-tested"
  }
  get(): LiveObservation { return structuredClone(this.value) }
}
