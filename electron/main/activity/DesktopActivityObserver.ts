import { DesktopIpcClient, DESKTOP_IPC_VERSIONS, type DesktopIpc, type DesktopMessage } from "../control/DesktopIpcClient"
import { readDesktopThreadCatalog, type DesktopThreadMetadata } from "../control/DesktopThreadCatalog"
import { applyDesktopPatches, desktopLiveState, projectDesktopState } from "../control/DesktopConversationState"
import type { LiveActivitySnapshot, LiveSession } from "../../../adapter/codex/lifecycle/LiveActivity"
import { liveObservationTime, preferLiveSession } from "../../../adapter/codex/lifecycle/LiveActivity"
import { readOpenCodexSessions } from "./OpenCliSessions"

const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value))
type Followed = { metadata: DesktopThreadMetadata; owner: string; epoch: number; ownerAvailable: boolean; revisionFloor: number; revision: number | null; state: Record<string, any> | null; confirmed: LiveSession | null; followedAt: number; requestedAt: number | null; retryAt: number; retries: number }
type Options = {
  home: string
  onSnapshot(value: LiveActivitySnapshot): void
  connect?(closed: () => void): Promise<DesktopIpc>
  catalog?(): Promise<DesktopThreadMetadata[]>
  cli?(): Promise<LiveSession[] | null>
  now?(): number
}

/** Passive follower of already owned conversations. Never resumes a session,
 * sends input, or ties application presence to a visible/minimized window.
 */
export class DesktopActivityObserver {
  private ipc: DesktopIpc | null = null
  private desktopPresent = false
  private readonly followed = new Map<string, Followed>()
  private readonly checked = new Map<string, number>()
  private openSessions: LiveSession[] = []
  private inventoryAt: number | undefined
  private nextOwnerEpoch = 0
  private ownershipGeneration = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private pending: Promise<void> | null = null
  private stopped = false
  private nextScanAt = 0
  private lastSnapshot = ""
  private lastPublishedAt = -Infinity
  constructor(private readonly options: Options) {}
  private now() { return (this.options.now ?? Date.now)() }
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => { void this.poll() }, 1000); this.timer.unref()
    void this.poll()
  }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pending) return this.pending
    this.pending = this.scan().catch(() => {}).finally(() => { this.pending = null })
    return this.pending
  }
  private async scan(): Promise<void> {
    if (this.now() < this.nextScanAt) return
    this.nextScanAt = this.now() + 3000
    // A failed OS inventory is unknown: do not discard verified CLI sessions.
    const readStartedAt = this.now()
    const cli = await (this.options.cli?.() ?? readOpenCodexSessions(this.options.home)).catch(() => null)
    if (this.stopped) return
    if (cli !== null) { this.openSessions = cli; this.inventoryAt = readStartedAt }
    if (!this.ipc) {
      let candidate: DesktopIpc | null = null, closed = false
      try {
        candidate = await (this.options.connect?.(() => {
          closed = true
          if (candidate && this.ipc === candidate) this.disconnected(candidate.lastCloseReason)
        }) ?? DesktopIpcClient.connect(() => {
          closed = true
          if (candidate && this.ipc === candidate) this.disconnected(candidate.lastCloseReason)
        }, this.options.home))
        if (this.stopped || closed) { candidate.close(); return }
        this.ipc = candidate
        this.ownershipGeneration++
        this.desktopPresent = true
        this.ipc.onBroadcast(message => { if (this.ipc === candidate) this.broadcast(message) })
      } catch { this.desktopPresent = false; this.followed.clear(); this.publish(); return }
    }
    this.publish()
    const ipc = this.ipc
    const recent = await (this.options.catalog?.() ?? readDesktopThreadCatalog(this.options.home)).catch(() => [])
    const candidates = [...this.followed.values()].map(value => value.metadata)
    for (const item of recent) if (!this.followed.has(item.id)) candidates.push(item)
    // Bound discovery and retain active followers even as other tasks become recent.
    for (let i = 0; i < Math.min(64, candidates.length); i += 8) {
      if (this.stopped || ipc !== this.ipc) return
      await Promise.all(candidates.slice(i, i + 8).map(async metadata => {
        const current = this.followed.get(metadata.id)
        if (current && this.now() - current.followedAt < 15_000) return
        if (!current && (this.followed.size >= 32 || this.now() - (this.checked.get(metadata.id) ?? -Infinity) < 9000)) return
        this.checked.set(metadata.id, this.now())
        try {
          const generation = this.ownershipGeneration
          const answer = await ipc.request("thread-owner-discovery", { hostId: "local", conversationId: metadata.id }, undefined, 700)
          if (this.stopped || ipc !== this.ipc || generation !== this.ownershipGeneration || !current && this.followed.size >= 32 || !record(answer.result) || answer.result.supportsUntrustedAppInput !== true) return
          const sameOwner = current?.owner === answer.handledByClientId && current.ownerAvailable
          if (current && !sameOwner) this.invalidate(current)
          const item: Followed = sameOwner ? current
            : { metadata, owner: answer.handledByClientId, epoch: ++this.nextOwnerEpoch, ownerAvailable: true, revisionFloor: 0, revision: null, state: null, confirmed: current?.confirmed ?? null, followedAt: 0, requestedAt: readStartedAt, retryAt: 0, retries: 0 }
          this.followed.set(metadata.id, item)
          // Existing followers already receive patches. Re-sending `follow`
          // would make Codex serialize all historical images every poll.
          if (item !== current || item.revision === null) this.follow(item)
          else item.followedAt = this.now()
        } catch {
          if (current?.confirmed?.status === "running") current.followedAt = this.now()
          else this.followed.delete(metadata.id)
        }
      }))
    }
    const retain = new Set(candidates.map(item => item.id))
    for (const id of this.checked.keys()) if (!retain.has(id)) this.checked.delete(id)
    this.publish()
  }
  private follow(item: Followed): void {
    if (this.now() < item.retryAt) return
    item.followedAt = this.now()
    item.requestedAt = item.followedAt
    item.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(++item.retries, 6))
    try { this.ipc?.follow(item.metadata.id, item.owner, true) } catch { /* Retry on the next scan. */ }
  }
  private invalidate(item: Followed): void {
    if (item.confirmed) {
      const evidence = item.confirmed.observation
      item.confirmed = { ...item.confirmed, observation: evidence?.kind === "owner" ? { ...evidence, valid: false } : { kind: "owner", ownerId: item.owner, epoch: item.epoch ?? 0, revision: item.revision ?? 0, valid: false } }
    }
    item.state = null; item.revision = null; item.followedAt = -Infinity
  }
  private broadcast(message: DesktopMessage): void {
    const params = message.params
    if (!record(params) || this.stopped) return
    if (message.method === "client-status-changed" && message.version === DESKTOP_IPC_VERSIONS["client-status-changed"]) {
      // Window owner churn is not application exit. Preserve confirmed activity
      // while rediscovering; only broker disconnect clears desktop presence.
      if (params.status === "connected" || params.status === "disconnected") {
        this.ownershipGeneration++
        this.nextScanAt = 0; this.checked.clear()
        for (const item of this.followed.values()) if (item.owner === params.clientId) {
          this.invalidate(item); item.ownerAvailable = false
        }
        this.publish()
      }
      return
    }
    const item = this.followed.get(params.conversationId)
    if (!item || item.ownerAvailable === false || params.hostId !== "local" || message.sourceClientId !== item.owner) return
    if (message.method === "thread-stream-following-status-requested" && message.version === DESKTOP_IPC_VERSIONS["thread-stream-following-status-requested"]) { this.follow(item); return }
    if (message.method !== "thread-stream-state-changed") return
    const change = params.change
    try {
      if (message.version !== DESKTOP_IPC_VERSIONS["thread-stream-state-changed"] || !record(change) || !Number.isSafeInteger(change.revision) || change.revision < 0) throw new Error("Invalid stream")
      if (change.revision < (item.revisionFloor ?? item.revision ?? 0)) return
      if (item.revision !== null && change.revision === item.revision) {
        if (change.type === "snapshot") item.requestedAt = null
        return
      }
      item.revisionFloor = Math.max(item.revisionFloor ?? 0, change.revision)
      const observedAt = change.type === "snapshot" ? item.requestedAt ?? this.now() : this.now()
      if (change.type === "snapshot") {
        const state = projectDesktopState(change.conversationState)
        if (!record(state) || state.id !== item.metadata.id) throw new Error("Invalid snapshot")
        item.state = state; item.revision = change.revision; item.retryAt = 0; item.retries = 0; item.requestedAt = null
      } else if (change.type === "patches" && item.state && change.baseRevision === item.revision && change.revision > change.baseRevision) {
        item.state = applyDesktopPatches(item.state, change.patches); item.revision = change.revision
      } else throw new Error("Stream gap")
      const live = desktopLiveState(item.state, item.metadata.id)
      if (live.type !== "unknown") {
        const turnId = live.turn?.id ?? null, status = live.type === "active" ? "running" : live.turn?.status === "inProgress" ? "idle" : live.turn?.status ?? "idle"
        const previous = item.confirmed, evidence = previous?.observation
        const unchanged = previous && liveObservationTime(previous) !== null && previous.turnId === turnId && previous.status === status && previous.waiting === live.waiting && evidence?.kind === "owner" && evidence.ownerId === item.owner && evidence.epoch === item.epoch
        item.confirmed = { sessionId: item.metadata.id, turnId, source: "desktop", path: item.metadata.path, status, waiting: live.waiting,
          observedAt: unchanged ? previous.observedAt : observedAt,
          observation: { kind: "owner", ownerId: item.owner, epoch: item.epoch ?? 0, revision: change.revision, valid: true, validatedAt: observedAt } }
      }
      else if (item.confirmed?.observation?.kind === "owner") item.confirmed = { ...item.confirmed, observation: { ...item.confirmed.observation, valid: false } }
    } catch {
      this.invalidate(item)
      // Retry/partial history cannot manufacture a terminal state or hide work.
      this.nextScanAt = 0
    }
    this.publish()
  }
  private disconnected(reason?: string | null): void {
    this.ownershipGeneration++
    this.ipc = null; this.checked.clear(); this.nextScanAt = 0
    if (reason?.startsWith("PROTOCOL_")) {
      // A parser/schema rejection is not evidence that Codex exited.
      for (const item of this.followed.values()) { this.invalidate(item); item.ownerAvailable = false }
    } else { this.desktopPresent = false; this.followed.clear() }
    this.publish()
  }
  private publish(): void {
    if (this.stopped) return
    // Writable Codex handles plus verified lifecycle metadata can recover
    // large histories whose owner cannot send a complete IPC snapshot.
    // Select by the evidence's original time, keeping invalidated owner caches
    // only when no newer observation supersedes them.
    const sessions = new Map<string, LiveSession>()
    for (const item of [...this.openSessions.filter(item => item.source === "cli" || this.desktopPresent), ...[...this.followed.values()].flatMap(item => item.confirmed ? [item.confirmed] : [])]) {
      const previous = sessions.get(item.sessionId)
      sessions.set(item.sessionId, previous ? preferLiveSession(previous, item) : item)
    }
    const value: LiveActivitySnapshot = { desktopConnected: this.desktopPresent, sessions: [...sessions.values()], inventoryAt: this.inventoryAt }
    const key = JSON.stringify(value)
    if (key !== this.lastSnapshot || this.now() - this.lastPublishedAt >= 30_000) { this.lastSnapshot = key; this.lastPublishedAt = this.now(); this.options.onSnapshot(value) }
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer); this.timer = null
    this.ipc?.close(); this.ipc = null
    await this.pending; this.followed.clear(); this.checked.clear(); this.openSessions = []
  }
}
