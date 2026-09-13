import { CharacterEventProtocolClient } from "../../../src/protocol/CharacterEventProtocolClient"
import { ActivityStore } from "./ActivityStore"
import type { ActivityPersistence } from "./ActivityHistoryStore"
import type { ActivityAckRequest, ActivitySnapshot } from "../../shared/activity-contract"

/** One app-lifetime owner. Windows only subscribe to display DTOs. */
export class ActivityService {
  private readonly store: ActivityStore
  private readonly listeners = new Set<(value: ActivitySnapshot) => void>()
  private readonly unsubscribes: Array<() => void> = []
  private revision = 0
  private storage: ActivitySnapshot["storage"] = "saved"
  private historyRecovered = false
  private navigation: ActivitySnapshot["navigation"] = "none"
  private conversationKeys = new Set<string>()
  private conversationTitles = new Map<string, string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private retentionTimer: ReturnType<typeof setInterval> | null = null
  private writing: Promise<void> | null = null
  private dirty = false
  private started = false
  private disposed = false

  constructor(private readonly client: CharacterEventProtocolClient, private readonly persistence: ActivityPersistence, now: () => number = Date.now) {
    this.store = new ActivityStore(now)
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    const loaded = await this.persistence.load().catch(() => ({ data: null, issue: "error" as const }))
    if (this.disposed) return
    if (loaded.data) this.store.restore(loaded.data)
    this.historyRecovered = loaded.issue === "corrupt"
    if (loaded.issue === "error") this.storage = "error"
    this.unsubscribes.push(this.client.subscribeAccepted(frame => {
      if (this.store.accept(frame)) { this.persistSoon(); this.publish() }
    }))
    this.unsubscribes.push(this.client.subscribeDiagnostics(() => {
      const diagnostics = this.client.getDiagnostics()
      const connection = diagnostics.source && diagnostics.source !== "codex-adapter" ? "ERROR" : diagnostics.connectionState
      if (this.store.setConnection(connection)) this.publish()
    }))
    // One bounded maintenance timer, independent of rendering and window visibility.
    this.retentionTimer = setInterval(() => { if (this.store.prune()) { this.persistSoon(); this.publish() } }, 60_000)
    this.retentionTimer.unref?.()
    if (loaded.data) this.persistSoon() // Commit retention pruning after restoration.
    this.publish()
    void this.client.connect().catch(() => {}) // Protocol client owns its reconnect/backoff policy.
  }

  snapshot(): ActivitySnapshot {
    const view = this.store.view()
    return { ...view, entries: view.entries.map(entry => {
      const key = this.store.navigationKey(entry) ?? ""
      return { ...entry, name: this.conversationTitles.get(key) ?? entry.name, canOpenConversation: this.navigation !== "none" && this.conversationKeys.has(key) }
    }), revision: this.revision, storage: this.storage, historyRecovered: this.historyRecovered, navigation: this.navigation }
  }
  setConversationKeys(keys: ReadonlySet<string>): void {
    this.conversationKeys = new Set(keys)
    for (const key of this.conversationTitles.keys()) if (!keys.has(key)) this.conversationTitles.delete(key)
    this.publish()
  }
  setConversationTitles(titles: ReadonlyMap<string, string>): void {
    if (this.disposed) return
    const next = new Map<string, string>()
    for (const [key, value] of titles) {
      const title = value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120)
      if (this.conversationKeys.has(key) && title) next.set(key, title)
    }
    if (next.size === this.conversationTitles.size && [...next].every(([key, title]) => this.conversationTitles.get(key) === title)) return
    this.conversationTitles = next; this.publish()
  }
  conversationKey(target: { activityId: string; revision: number }): string | null {
    const key = this.store.navigationKey(target)
    return key && this.conversationKeys.has(key) ? key : null
  }
  subscribe(listener: (value: ActivitySnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  acknowledge(request: ActivityAckRequest): ActivitySnapshot {
    if (this.store.acknowledge(request)) { this.persistSoon(); this.publish() }
    return this.snapshot()
  }
  setNavigation(value: ActivitySnapshot["navigation"]): void { if (this.navigation !== value) { this.navigation = value; this.publish() } }
  reconnect(): void { if (!this.disposed && this.started) { this.client.disconnect(); void this.client.connect().catch(() => {}) } }

  private publish(): void {
    this.revision++
    const value = this.snapshot()
    for (const listener of this.listeners) listener(value)
  }

  private persistSoon(): void {
    this.dirty = true
    if (this.storage !== "error") this.storage = "pending"
    // Do not postpone indefinitely under a steady stream of events.
    if (this.saveTimer || this.writing || this.disposed) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush() }, 350)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.writing) { await this.writing; if (this.dirty && this.storage !== "error") await this.flush(); return }
    if (!this.dirty) return
    this.dirty = false
    const data = this.store.exportHistory()
    this.writing = Promise.resolve().then(() => this.persistence.save(data)).then(() => { this.storage = this.dirty ? "pending" : "saved" }, () => { this.storage = "error"; this.dirty = true }).finally(() => { this.writing = null; this.publish() })
    await this.writing
    if (this.dirty && this.storage !== "error") await this.flush()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.conversationTitles.clear()
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.client.dispose()
    if (this.retentionTimer) clearInterval(this.retentionTimer)
    this.retentionTimer = null
    await this.flush()
    this.listeners.clear()
  }
}
