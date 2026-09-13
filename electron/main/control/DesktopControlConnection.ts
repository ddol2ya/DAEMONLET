import { homedir } from "node:os"
import { join } from "node:path"
import type { ControlRpc } from "./AppServerSocketClient"
import { DesktopIpcClient, DESKTOP_IPC_VERSIONS, type DesktopIpc, type DesktopMessage } from "./DesktopIpcClient"
import { readDesktopThreadCatalog, type DesktopThreadMetadata } from "./DesktopThreadCatalog"
import { applyDesktopPatches, desktopLiveState, projectDesktopState } from "./DesktopConversationState"
import { isThreadUuid } from "./CodexThreadLauncher"

const record = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v))
type OwnedThread = DesktopThreadMetadata & { ownerClientId: string }
type SnapshotWaiter = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Normalizes the existing desktop owner's follower protocol for the task-control service.
 * The App Server-shaped methods below are local adapter operations, never sent to desktop IPC.
 */
export class DesktopControlConnection implements ControlRpc {
  private readonly threads = new Map<string, OwnedThread>()
  private readonly ownership = new Map<string, { owner: string | null; checkedAt: number; updatedAt: number }>()
  private selected: OwnedThread | null = null
  private state: Record<string, any> | null = null
  private streamRevision: number | null = null
  private closed = false
  private catalogReadAt = 0
  private scanning: Promise<void> | null = null
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  private readonly waiters = new Set<SnapshotWaiter>()
  private readonly notifications = new Set<(method: string, params: unknown) => void>()
  private readonly requests = new Set<(request: Record<string, unknown>) => void>()
  private readonly unsubscribe: () => void
  constructor(private readonly ipc: DesktopIpc, private readonly catalog: () => Promise<DesktopThreadMetadata[]>) {
    this.unsubscribe = ipc.onBroadcast(message => this.broadcast(message))
  }
  static async connect(onClosed: () => void, home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<DesktopControlConnection> {
    const ipc = await DesktopIpcClient.connect(onClosed, home)
    return new DesktopControlConnection(ipc, () => readDesktopThreadCatalog(home))
  }
  onNotification(listener: (method: string, params: unknown) => void): () => void { this.notifications.add(listener); return () => this.notifications.delete(listener) }
  onServerRequest(listener: (request: Record<string, unknown>) => void): () => void { this.requests.add(listener); return () => this.requests.delete(listener) }
  private emit(method: string, threadId: string): void { for (const listener of this.notifications) listener(method, { threadId }) }

  private async scan(): Promise<void> {
    if (this.scanning) return this.scanning
    if (this.catalogReadAt && Date.now() - this.catalogReadAt < 2500) return
    const scan = this.scanCatalog().finally(() => { if (this.scanning === scan) this.scanning = null })
    this.scanning = scan; return scan
  }
  private async scanCatalog(): Promise<void> {
    const recent = await this.catalog()
    const candidates = (this.selected ? [this.selected, ...recent.filter(item => item.id !== this.selected?.id)] : recent).slice(0, 64), next = new Map<string, OwnedThread>(), started = Date.now()
    // Ownership discovery never resumes a saved thread. Only a live owner can accept it.
    for (let i = 0; i < candidates.length && next.size < 32 && Date.now() - started < 6000; i += 4) {
      const group = await Promise.all(candidates.slice(i, i + 4).map(async item => {
        if (!isThreadUuid(item.id)) return null
        const cached = this.ownership.get(item.id)
        if (cached && Date.now() - cached.checkedAt < 15000 && (cached.owner !== null || cached.updatedAt === item.updatedAt)) return cached.owner ? { ...item, ownerClientId: cached.owner } : null
        try {
          const owner = await this.ipc.request("thread-owner-discovery", { hostId: "local", conversationId: item.id }, undefined, 900)
          if (this.closed) return null
          const supported = record(owner.result) && owner.result.supportsUntrustedAppInput === true
          this.ownership.set(item.id, { owner: supported ? owner.handledByClientId : null, checkedAt: Date.now(), updatedAt: item.updatedAt })
          return supported ? { ...item, ownerClientId: owner.handledByClientId } : null
        } catch (error) {
          if (!this.closed && error instanceof Error && error.message === "STALE_TARGET") this.ownership.set(item.id, { owner: null, checkedAt: Date.now(), updatedAt: item.updatedAt })
          return null
        }
      }))
      if (this.closed) throw new Error("UNAVAILABLE")
      for (const item of group) if (item && next.size < 32) next.set(item.id, item)
    }
    if (this.selected) {
      const retained = next.get(this.selected.id)
      if (!retained || retained.ownerClientId !== this.selected.ownerClientId) this.unselect()
    }
    this.threads.clear(); for (const [id, item] of next) this.threads.set(id, item)
    const keep = new Set(candidates.map(item => item.id))
    for (const id of this.ownership.keys()) if (!keep.has(id)) this.ownership.delete(id)
    this.catalogReadAt = Date.now()
  }
  private thread(id: string): OwnedThread {
    const item = this.threads.get(id)
    if (this.closed || !item) throw new Error("STALE_TARGET")
    return item
  }
  private readThread(id: string): Record<string, unknown> {
    const item = this.thread(id), live = desktopLiveState(this.selected?.id === id ? this.state : null, id)
    return { id, name: item.title, cwd: item.cwd, path: item.path, ephemeral: false, canAcceptDirectInput: live.type === "idle", status: { type: live.type, activeFlags: live.waiting ? ["waitingOnUserInput"] : [] } }
  }
  async request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed || !record(params)) throw new Error("UNAVAILABLE")
    if (method === "thread/loaded/list") { await this.scan(); return { data: [...this.threads.keys()], nextCursor: null } }
    if (!isThreadUuid(params.threadId)) throw new Error("INVALID_REQUEST")
    const id = params.threadId
    if (method === "thread/read") return { thread: this.readThread(id) }
    if (method === "thread/turns/list") {
      this.thread(id)
      const live = desktopLiveState(this.selected?.id === id ? this.state : null, id)
      return { data: live.turn ? [live.turn] : [], nextCursor: null }
    }
    if (method === "thread/resume") {
      const item = this.thread(id)
      await this.verifyOwner(item)
      if (this.selected?.id !== id || this.selected?.ownerClientId !== item.ownerClientId) { this.unselect(); this.selected = item }
      await this.syncSelected()
      return { thread: this.readThread(id) }
    }
    if (!["turn/start", "turn/steer", "turn/interrupt"].includes(method) || this.selected?.id !== id) throw new Error("INVALID_REQUEST")
    const item = this.thread(id)
    await this.verifyOwner(item); await this.syncSelected()
    if (this.selected?.id !== id || this.selected?.ownerClientId !== item.ownerClientId) throw new Error("STALE_TARGET")
    const live = desktopLiveState(this.state, id)
    if (method === "turn/interrupt") {
      if (live.type !== "active" || live.turn?.id !== params.turnId || !isThreadUuid(params.turnId)) throw new Error("STALE_TARGET")
      const answer = await this.ipc.request("thread-follower-interrupt-turn", { conversationId: id, mode: "user-stop", expectedTurnId: params.turnId }, item.ownerClientId)
      if (!record(answer.result) || answer.result.ok !== true || answer.result.interruptedTurnId !== params.turnId) throw new Error("OUTCOME_UNKNOWN")
      return {}
    }
    const input = params.input
    if (!Array.isArray(input) || input.length !== 1 || !record(input[0]) || input[0].type !== "text" || typeof input[0].text !== "string" || !input[0].text.trim() || Buffer.byteLength(input[0].text) > 16000 || !isThreadUuid(params.clientUserMessageId)) throw new Error("INVALID_REQUEST")
    const clientUserMessageId = params.clientUserMessageId
    if (method === "turn/steer") {
      if (live.type !== "active" || live.turn?.id !== params.expectedTurnId) throw new Error("STALE_TARGET")
      // Installed desktop follower-steer has no atomic expected-turn contract and
      // may retry against a newly active turn. Never dispatch through this path.
      throw new Error("PROTOCOL_UNSUPPORTED")
    } else {
      if (live.type !== "idle") throw new Error("STALE_TARGET")
      await this.ipc.request("thread-follower-start-turn", { conversationId: id, turnStart: { request: { threadId: id, input, clientUserMessageId }, context: { inheritThreadSettings: true } } }, item.ownerClientId)
    }
    return {}
  }
  private async verifyOwner(item: OwnedThread): Promise<void> {
    const owner = await this.ipc.request("thread-owner-discovery", { hostId: "local", conversationId: item.id }, item.ownerClientId, 1500)
    if (this.closed || owner.handledByClientId !== item.ownerClientId || !record(owner.result) || owner.result.supportsUntrustedAppInput !== true) throw new Error("STALE_TARGET")
  }
  private syncSelected(): Promise<void> {
    const selected = this.selected
    if (!selected || this.closed) return Promise.reject(new Error("STALE_TARGET"))
    return new Promise((resolve, reject) => {
      const waiter: SnapshotWaiter = { resolve, reject, timer: setTimeout(() => { this.waiters.delete(waiter); reject(new Error("PROTOCOL_UNSUPPORTED")) }, 5000) }
      waiter.timer.unref(); this.waiters.add(waiter)
      try { this.ipc.follow(selected.id, selected.ownerClientId, true) }
      catch { clearTimeout(waiter.timer); this.waiters.delete(waiter); reject(new Error("CONNECT_FAILED")) }
    })
  }
  private broadcast(message: DesktopMessage): void {
    const selected = this.selected, params = message.params
    if (!record(params)) return
    if (message.method === "client-status-changed") {
      if (params.status === "connected") for (const [id, cached] of this.ownership) { if (!cached.owner) this.ownership.delete(id) }
      if (params.status === "disconnected") {
        for (const [id, cached] of this.ownership) if (cached.owner === params.clientId) this.ownership.delete(id)
        if (params.clientId === selected?.ownerClientId) this.unselect()
      }
      this.catalogReadAt = 0; return
    }
    if (!selected) return
    if (message.method === "thread-stream-following-status-requested" && params.hostId === "local" && params.conversationId === selected.id && message.version === DESKTOP_IPC_VERSIONS["thread-stream-following-status-requested"] && message.sourceClientId === selected.ownerClientId) { this.ipc.follow(selected.id, selected.ownerClientId, true); return }
    if (message.method !== "thread-stream-state-changed" || params.hostId !== "local" || params.conversationId !== selected.id || message.sourceClientId !== selected.ownerClientId) return
    const change = params.change, before = JSON.stringify(desktopLiveState(this.state, selected.id))
    try {
      if (message.version !== DESKTOP_IPC_VERSIONS["thread-stream-state-changed"] || !record(change) || !Number.isSafeInteger(change.revision) || change.revision < 0) throw new Error("PROTOCOL_UNSUPPORTED")
      if (change.type === "snapshot") {
        if (this.streamRevision !== null && change.revision < this.streamRevision) return
        const state = projectDesktopState(change.conversationState)
        if (!record(state) || state.id !== selected.id) throw new Error("PROTOCOL_UNSUPPORTED")
        this.state = state; this.streamRevision = change.revision
        for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.resolve() }; this.waiters.clear()
      } else if (change.type === "patches" && this.state && change.baseRevision === this.streamRevision && change.revision > change.baseRevision) {
        this.state = applyDesktopPatches(this.state, change.patches); this.streamRevision = change.revision
      } else throw new Error("PROTOCOL_UNSUPPORTED")
    } catch { this.state = null; this.streamRevision = null; this.scheduleResync() }
    const live = desktopLiveState(this.state, selected.id)
    if (before !== JSON.stringify(live)) {
      this.emit("thread/status/changed", selected.id)
      if (live.waiting) for (const listener of this.requests) listener({ method: "desktop/pending-request", params: { threadId: selected.id } })
      else this.emit("serverRequest/resolved", selected.id)
    }
  }
  private scheduleResync(): void {
    if (this.closed || this.resyncTimer || !this.selected) return
    this.resyncTimer = setTimeout(() => { this.resyncTimer = null; void this.syncSelected().catch(() => {}) }, 1000)
    this.resyncTimer.unref()
  }
  private unselect(): void {
    const previous = this.selected
    this.selected = null; this.state = null; this.streamRevision = null
    if (this.resyncTimer) clearTimeout(this.resyncTimer); this.resyncTimer = null
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error("STALE_TARGET")) }; this.waiters.clear()
    if (previous) {
      try { this.ipc.follow(previous.id, previous.ownerClientId, false) } catch {}
      this.emit("thread/closed", previous.id)
    }
  }
  close(): void { if (this.closed) return; this.closed = true; this.unselect(); this.unsubscribe(); this.ipc.close(); this.threads.clear(); this.ownership.clear(); this.notifications.clear(); this.requests.clear() }
}
