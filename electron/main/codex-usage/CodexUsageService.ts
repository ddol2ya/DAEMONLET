import { emptyCodexUsage, type CodexUsageSnapshot } from "../../shared/codex-usage-contract"
import type { UsageProvider, UsageReader } from "./CodexUsageReader"
export const USAGE_POLICY = { poll: 60_000, cooldown: 15_000, stale: 180_000, discard: 600_000, maxBackoff: 300_000 } as const
export class CodexUsageService {
  private value = emptyCodexUsage()
  private readonly listeners = new Set<(value: CodexUsageSnapshot) => void>()
  private provider: UsageProvider = { executablePath: null, codexHome: null }
  private generation = 0
  private visible = false
  private suspended = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<void> | null = null
  private controller: AbortController | null = null
  private due = 0
  private failures = 0
  private lastManual = -Infinity
  private scope: string | null = null
  constructor(private readonly read: UsageReader, private readonly now = Date.now, private readonly random = Math.random) {}
  snapshot() { return structuredClone(this.value) }
  subscribe(listener: (value: CodexUsageSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: CodexUsageSnapshot) {
    if (JSON.stringify({ ...next, revision: 0 }) === JSON.stringify({ ...this.value, revision: 0 })) return
    this.value = { ...next, revision: this.value.revision + 1 }
    for (const listener of this.listeners) listener(this.snapshot())
  }
  private empty(state: CodexUsageSnapshot["state"], reason: CodexUsageSnapshot["reason"] = null) { this.publish({ ...emptyCodexUsage(), enabled: this.value.enabled, state, reason }) }
  private active() { return !this.disposed && this.value.enabled && this.visible && !this.suspended }
  configure(enabled: boolean, provider: UsageProvider) {
    if (this.disposed) return
    const changed = JSON.stringify(provider) !== JSON.stringify(this.provider)
    if (!changed && enabled === this.value.enabled) return
    this.cancel(); this.provider = { ...provider }; this.scope = null; this.failures = 0; this.due = 0
    this.publish({ ...emptyCodexUsage(), enabled, state: enabled ? "loading" : "disabled" })
    this.schedule()
  }
  setVisible(visible: boolean) {
    if (this.visible === visible || this.disposed) return
    this.visible = visible
    if (!visible) this.cancel()
    else { this.age(); this.schedule() }
  }
  setSuspended(suspended: boolean) {
    if (this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) this.cancel()
    else { this.age(); this.schedule() }
  }
  private cancel() { this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = null; this.controller?.abort() }
  private age() {
    const at = this.now(), observed = this.value.observedAtMs
    if (observed === null) return
    if (at - observed >= USAGE_POLICY.discard) { this.empty("unavailable", "query-failed"); return }
    const stale = at - observed >= USAGE_POLICY.stale
    const window = (w: CodexUsageSnapshot["fiveHour"]) => w && ({ ...w, freshness: w.resetsAtMs !== null && at >= w.resetsAtMs ? "reset-pending" as const : stale ? "stale" as const : "fresh" as const })
    this.publish({ ...this.value, state: stale ? "stale" : this.value.state, fiveHour: window(this.value.fiveHour), weekly: window(this.value.weekly) })
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.active() || this.pending) return
    const now = this.now(), observed = this.value.observedAtMs
    const deadlines = [Math.max(now, this.due)]
    if (observed !== null) for (const boundary of [observed + USAGE_POLICY.stale, observed + USAGE_POLICY.discard, this.value.fiveHour?.resetsAtMs, this.value.weekly?.resetsAtMs]) if (boundary != null && boundary > now) deadlines.push(boundary)
    this.timer = setTimeout(() => { this.timer = null; this.age(); if (this.now() >= this.due) void this.query(); else this.schedule() }, Math.max(0, Math.min(...deadlines) - now))
  }
  async refresh(): Promise<CodexUsageSnapshot> {
    if (!this.active()) return this.snapshot()
    if (this.pending) { await this.pending; return this.snapshot() }
    if (this.now() - this.lastManual < USAGE_POLICY.cooldown) return this.snapshot()
    this.lastManual = this.now(); await this.query(); return this.snapshot()
  }
  private query(): Promise<void> {
    if (this.pending) return this.pending
    if (!this.active()) return Promise.resolve()
    if (!this.provider.codexHome || !this.provider.executablePath) {
      this.empty("unavailable", "cli-missing"); this.due = this.now() + USAGE_POLICY.maxBackoff; this.schedule(); return Promise.resolve()
    }
    const generation = this.generation, controller = this.controller = new AbortController()
    this.pending = (async () => {
      try {
        const result = await this.read({ ...this.provider }, controller.signal)
        if (generation !== this.generation || controller.signal.aborted || !this.active()) return
        if ("reason" in result) {
          // A failed fresh process cannot prove the current workspace identity.
          // Discard old numbers instead of showing another account's cache.
          this.scope = null; this.empty("unavailable", result.reason)
          this.due = this.now() + Math.min(USAGE_POLICY.maxBackoff, USAGE_POLICY.poll * 2 ** Math.min(this.failures++, 3) * (0.95 + this.random() * 0.1))
        } else {
          if (this.scope !== result.scope) this.generation++
          this.scope = result.scope; this.failures = 0
          const { fiveHour, weekly } = result.value
          this.publish({ ...this.value, ...result.value, observedAtMs: this.now(), state: fiveHour && weekly ? "ready" : fiveHour || weekly ? "partial" : "unavailable", reason: fiveHour && weekly ? null : "not-provided" })
          this.due = this.now() + USAGE_POLICY.poll; this.age()
        }
      } catch {
        if (generation === this.generation && !controller.signal.aborted) { this.scope = null; this.empty("unavailable", "query-failed"); this.due = this.now() + USAGE_POLICY.maxBackoff }
      } finally { this.controller = null }
    })().finally(() => { this.pending = null; this.schedule() })
    return this.pending
  }
  async dispose() { this.disposed = true; this.cancel(); await this.pending; this.listeners.clear() }
}
