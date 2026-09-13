import { createHash, randomUUID } from "node:crypto"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import type { ControlledThread, TaskControlSnapshot, TaskControlTarget, TaskControlSend } from "../../shared/task-control-contract"
import { belongsToLocalCodexHome } from "./CodexThreadLauncher"
import { connectAppServerSocket, type ControlRpc } from "./AppServerSocketClient"
import { DesktopControlConnection } from "./DesktopControlConnection"

const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v))
const wireId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x20]/.test(v)
const text = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : ""
type ThreadRecord = ControlledThread & { threadId: string; turnId: string | null; rolloutPath: string | null }
type Connector = (path: string, closed: () => void) => Promise<ControlRpc>

/** No transcript/history persistence; opaque UI keys are scoped to one explicit connection. */
export class TaskControlService {
  private rpc: ControlRpc | null = null
  private generation = 0
  private revision = 0
  private connection: TaskControlSnapshot["connection"] = "disconnected"
  private source: TaskControlSnapshot["source"] = "shared"
  private autoConnect = false
  private autoTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 1000
  private socketPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control/app-server-control.sock")
  private readonly threads = new Map<string, ThreadRecord>()
  private selectedKey: string | null = null
  private pending = false
  private issue: TaskControlSnapshot["issue"] = null
  private readonly clientRequests = new Set<string>()
  private eventEpoch = 0
  private refreshAgain = false
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshing: Promise<TaskControlSnapshot> | null = null
  private readonly listeners = new Set<(value: TaskControlSnapshot) => void>()
  private readonly actions = new Map<string, { signature: string; result: Promise<TaskControlSnapshot> }>()
  private unsubscribes: Array<() => void> = []
  constructor(private readonly connector: Connector = connectAppServerSocket, private readonly desktopConnector: Connector = (_path, closed) => DesktopControlConnection.connect(closed)) {}
  snapshot(): TaskControlSnapshot { return { revision: this.revision, connection: this.connection, source: this.source, autoConnect: this.autoConnect, socketPath: this.socketPath, threads: [...this.threads.values()].map(({ threadId: _, turnId: __, rolloutPath: ___, ...value }) => ({ ...value, canSend: value.canSend && this.connection === "ready" && !this.pending, canStop: value.canStop && this.connection === "ready" && !this.pending, canOpenConversation: value.canOpenConversation && this.connection === "ready" })), selectedKey: this.selectedKey, pending: this.pending, issue: this.issue, needsClient: Boolean(this.selectedKey && this.clientRequests.has(this.threads.get(this.selectedKey)?.threadId ?? "")) } }
  subscribe(listener: (value: TaskControlSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(): TaskControlSnapshot { this.revision++; const value = this.snapshot(); for (const listener of this.listeners) listener(value); return value }

  async connect(path: string): Promise<TaskControlSnapshot> {
    return this.connectBackend(path, this.connector, "shared", false)
  }
  connectDesktop(): TaskControlSnapshot {
    if (this.pending) throw new Error("OPERATION_PENDING")
    this.disconnect(); this.source = "desktop"; this.autoConnect = true; this.retryDelay = 1000
    void this.attemptDesktopConnection()
    return this.snapshot()
  }
  private async attemptDesktopConnection(): Promise<void> {
    if (!this.autoConnect || this.source !== "desktop" || this.connection === "ready" || this.connection === "connecting") return
    try { await this.connectBackend(this.socketPath, this.desktopConnector, "desktop", true); this.retryDelay = 1000 }
    catch { this.scheduleDesktopReconnect() }
  }
  private scheduleDesktopReconnect(): void {
    if (!this.autoConnect || this.autoTimer) return
    this.autoTimer = setTimeout(() => { this.autoTimer = null; void this.attemptDesktopConnection() }, this.retryDelay)
    this.autoTimer.unref(); this.retryDelay = Math.min(15000, this.retryDelay * 2)
  }
  private async connectBackend(path: string, connector: Connector, source: TaskControlSnapshot["source"], automatic: boolean): Promise<TaskControlSnapshot> {
    if (this.pending || this.connection === "connecting") throw new Error("OPERATION_PENDING")
    this.disconnect(!automatic); this.source = source; const generation = this.generation
    this.socketPath = path; this.connection = "connecting"; this.issue = null; this.publish()
    try {
      const rpc = await connector(path, () => {
        if (this.generation !== generation) return
        this.connection = "error"; this.issue = "CONNECT_FAILED"; this.rpc = null
        if (this.timer) clearInterval(this.timer); this.timer = null
        this.publish()
        this.scheduleDesktopReconnect()
      })
      if (this.generation !== generation) { rpc.close(); throw new Error("UNAVAILABLE") }
      this.rpc = rpc
      this.unsubscribes.push(rpc.onNotification((method, params) => {
        if (!record(params)) return
        if (["turn/started", "turn/completed", "thread/status/changed", "thread/closed"].includes(method)) {
          this.eventEpoch++; this.refreshAgain = true
          if ((method === "turn/completed" || method === "thread/closed") && typeof params.threadId === "string") this.clientRequests.delete(params.threadId)
          // Invalidate click-time revisions immediately, before the authoritative refresh.
          const item = [...this.threads.values()].find(r => r.threadId === params.threadId)
          if (method === "thread/closed" && item?.key === this.selectedKey) this.selectedKey = null
          if (item) { item.revision++; item.canSend = false; item.canStop = false; this.publish() }
          void this.refresh().catch(() => {})
        }
        if (method === "serverRequest/resolved" && typeof params.threadId === "string") { this.clientRequests.delete(params.threadId); this.publish() }
      }))
      this.unsubscribes.push(rpc.onServerRequest(request => {
        const params = request.params
        if (!record(params) || ![...this.threads.values()].some(r => r.threadId === params.threadId)) return
        // This companion never auto-approves permissions or answers agent questions.
        // The original full client remains responsible for these shared requests.
        this.clientRequests.add(params.threadId as string); this.publish()
      }))
      this.connection = "ready"
      await this.refresh()
      this.timer = setInterval(() => { void this.refresh().catch(() => {}) }, 2500); this.timer.unref()
      return this.publish()
    } catch (error) {
      if (generation === this.generation) { this.rpc?.close(); this.rpc = null; this.connection = "error"; this.issue = error instanceof Error && ["UNSAFE_SOCKET", "CONNECT_FAILED", "UNAVAILABLE", "PROTOCOL_UNSUPPORTED"].includes(error.message) ? error.message as TaskControlSnapshot["issue"] : "CONNECT_FAILED"; this.publish() }
      throw new Error(this.issue ?? "CONNECT_FAILED")
    }
  }
  disconnect(stopAutomatic = true): TaskControlSnapshot {
    if (stopAutomatic) this.autoConnect = false
    if (this.autoTimer) clearTimeout(this.autoTimer); this.autoTimer = null
    this.generation++; if (this.timer) clearInterval(this.timer); this.timer = null
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.rpc?.close(); this.rpc = null; this.refreshing = null
    this.connection = "disconnected"; this.threads.clear(); this.selectedKey = null; this.pending = false; this.clientRequests.clear(); this.refreshAgain = false; this.eventEpoch++; this.issue = null; this.actions.clear()
    return this.publish()
  }
  async refresh(): Promise<TaskControlSnapshot> {
    if (this.refreshing) return this.refreshing
    const rpc = this.rpc, generation = this.generation
    if (!rpc || this.connection !== "ready") throw new Error("UNAVAILABLE")
    const refresh = this.loadThreads(rpc, generation).catch(() => {
      if (generation === this.generation) { this.issue = "PROTOCOL_UNSUPPORTED"; for (const item of this.threads.values()) { item.canSend = false; item.canStop = false; item.revision++ }; this.publish() }
      throw new Error("PROTOCOL_UNSUPPORTED")
    }).finally(() => {
      if (this.refreshing === refresh) this.refreshing = null
      if (generation === this.generation && rpc === this.rpc && this.refreshAgain && this.connection === "ready") { this.refreshAgain = false; void this.refresh().catch(() => {}) }
    })
    this.refreshing = refresh
    return refresh
  }
  private async loadThreads(rpc: ControlRpc, generation: number): Promise<TaskControlSnapshot> {
    const eventEpoch = this.eventEpoch, startedAt = Date.now()
    const loaded = await rpc.request("thread/loaded/list", { limit: 32 })
    if (!record(loaded) || !Array.isArray(loaded.data) || loaded.data.length > 32 || !loaded.data.every(wireId)) throw new Error("PROTOCOL_UNSUPPORTED")
    const next = new Map<string, ThreadRecord>()
    // Bounded sequential reads avoid bursts against the user's shared server.
    for (const threadId of loaded.data) {
      if (generation !== this.generation || Date.now() - startedAt > 12_000) throw new Error("UNAVAILABLE")
      const meta = await rpc.request("thread/read", { threadId, includeTurns: false })
      if (!record(meta) || !record(meta.thread) || meta.thread.id !== threadId || !record(meta.thread.status)) throw new Error("PROTOCOL_UNSUPPORTED")
      const thread = meta.thread
      if (thread.ephemeral === true || (thread.status as Record<string, unknown>).type === "notLoaded") continue // Codex 0.153 cannot resume/page ephemeral threads.
      const turns = await rpc.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
      if (!record(turns) || !Array.isArray(turns.data) || turns.data.length > 1) throw new Error("PROTOCOL_UNSUPPORTED")
      const turn = turns.data[0]
      if (turn !== undefined && (!record(turn) || !wireId(turn.id) || !["inProgress", "completed", "failed", "interrupted"].includes(String(turn.status)))) throw new Error("PROTOCOL_UNSUPPORTED")
      const old = [...this.threads.values()].find(r => r.threadId === threadId)
      const status = (thread.status as Record<string, unknown>).type
      const flags = (thread.status as Record<string, unknown>).activeFlags
      const running = status === "active" && record(turn) && turn.status === "inProgress"
      const state: ControlledThread["state"] = running ? Array.isArray(flags) && flags.some(f => f === "waitingOnApproval" || f === "waitingOnUserInput") ? "waiting" : "running" : status === "idle" ? record(turn) && turn.status === "failed" ? "failed" : "idle" : "unknown"
      const turnId = running && record(turn) ? turn.id as string : null
      const rolloutPath = typeof thread.path === "string" && thread.path.length <= 4096 ? thread.path : null
      const canOpenConversation = belongsToLocalCodexHome(rolloutPath, threadId, process.env.CODEX_HOME ?? join(homedir(), ".codex"))
      const item: ThreadRecord = { rolloutPath, canOpenConversation, key: old?.key ?? randomUUID(), threadId, turnId, title: text(thread.name, 120) || `연결된 작업 ${next.size + 1}`, project: basename(text(thread.cwd, 2048)), revision: old?.revision ?? 1, state, canSend: state !== "unknown" && thread.canAcceptDirectInput !== false, canStop: running }
      if (old && (old.state !== state || old.turnId !== turnId || old.title !== item.title || old.canSend !== item.canSend || old.canStop !== item.canStop)) item.revision++
      next.set(item.key, item)
    }
    if (generation !== this.generation || rpc !== this.rpc) throw new Error("UNAVAILABLE")
    if (eventEpoch !== this.eventEpoch) { this.refreshAgain = true; return this.snapshot() }
    this.threads.clear(); for (const [key, item] of next) this.threads.set(key, item)
    const retained = new Set([...next.values()].map(r => r.threadId))
    for (const id of this.clientRequests) if (!retained.has(id)) this.clientRequests.delete(id)
    if (this.selectedKey && !this.threads.has(this.selectedKey)) this.selectedKey = null
    this.issue = null
    return this.publish()
  }
  async select(key: string): Promise<TaskControlSnapshot> {
    if (this.pending) throw new Error("OPERATION_PENDING")
    const item = this.threads.get(key), rpc = this.rpc, generation = this.generation
    if (!item || !rpc || this.connection !== "ready") throw new Error("STALE_TARGET")
    this.pending = true; this.publish()
    try {
      // Rejoin only a thread already loaded in THIS server; never resume historical files.
      await this.refresh()
      if (generation !== this.generation || !this.threads.has(key)) throw new Error("STALE_TARGET")
      const resumed = await rpc.request("thread/resume", { threadId: item.threadId, excludeTurns: true })
      if (generation !== this.generation) throw new Error("STALE_TARGET")
      if (!record(resumed) || !record(resumed.thread) || resumed.thread.id !== item.threadId) throw new Error("PROTOCOL_UNSUPPORTED")
      this.selectedKey = key
      return await this.refresh()
    } finally { if (generation === this.generation) { this.pending = false; this.publish() } }
  }
  async navigationTarget(key: string): Promise<{ threadId: string; socketPath: string; rolloutPath: string | null }> {
    if (this.pending || this.connection !== "ready" || key !== this.selectedKey) throw new Error("STALE_TARGET")
    const generation = this.generation
    await this.refresh()
    const item = this.threads.get(key)
    if (generation !== this.generation || key !== this.selectedKey || !item) throw new Error("STALE_TARGET")
    return { threadId: item.threadId, socketPath: this.socketPath, rolloutPath: item.rolloutPath }
  }
  send(request: TaskControlSend): Promise<TaskControlSnapshot> { return this.act("send", request) }
  stop(request: TaskControlTarget): Promise<TaskControlSnapshot> { return this.act("stop", request) }
  private act(kind: "send" | "stop", request: TaskControlTarget | TaskControlSend): Promise<TaskControlSnapshot> {
    const signature = createHash("sha256").update(JSON.stringify([kind, request.key, request.revision, "text" in request ? request.text : null])).digest("hex")
    const existing = this.actions.get(request.actionId)
    if (existing) return existing.signature === signature ? existing.result : Promise.reject(new Error("INVALID_REQUEST"))
    if (this.pending) return Promise.reject(new Error("OPERATION_PENDING"))
    if (this.actions.size >= 64) this.actions.delete(this.actions.keys().next().value!)
    const result = this.perform(kind, request)
    // Remember rejected/uncertain writes too: never automatically repeat a possibly accepted send.
    this.actions.set(request.actionId, { signature, result })
    return result
  }
  private async perform(kind: "send" | "stop", request: TaskControlTarget | TaskControlSend): Promise<TaskControlSnapshot> {
    const rpc = this.rpc, generation = this.generation
    const before = this.threads.get(request.key)
    if (!rpc || this.connection !== "ready" || request.key !== this.selectedKey || !before || before.revision !== request.revision) throw new Error("STALE_TARGET")
    this.pending = true; this.issue = null; this.publish()
    let sent = false
    try {
      await this.refresh()
      const item = this.threads.get(request.key)
      if (generation !== this.generation || !item || item.revision !== request.revision || request.key !== this.selectedKey) throw new Error("STALE_TARGET")
      if (kind === "stop" && (!item.canStop || !item.turnId) || kind === "send" && !item.canSend) throw new Error("STALE_TARGET")
      sent = true
      if (kind === "stop") await rpc.request("turn/interrupt", { threadId: item.threadId, turnId: item.turnId })
      else {
        const input = [{ type: "text", text: (request as TaskControlSend).text, text_elements: [] }]
        if (item.turnId) await rpc.request("turn/steer", { threadId: item.threadId, expectedTurnId: item.turnId, clientUserMessageId: request.actionId, input })
        else await rpc.request("turn/start", { threadId: item.threadId, clientUserMessageId: request.actionId, input })
      }
      // A successful stop RPC means requested; the UI waits for observed terminal status.
      if (generation === this.generation) await this.refresh().catch(() => {})
      return this.snapshot()
    } catch (error) {
      if (generation === this.generation) { this.issue = error instanceof Error && error.message === "STALE_TARGET" ? "STALE_TARGET" : sent ? error instanceof Error && ["app-server request failed", "ACTION_FAILED"].includes(error.message) ? "ACTION_FAILED" : "OUTCOME_UNKNOWN" : "ACTION_FAILED"; this.publish() }
      throw new Error(this.issue ?? (sent ? "OUTCOME_UNKNOWN" : "ACTION_FAILED"))
    } finally { if (generation === this.generation) { this.pending = false; this.publish() } }
  }
  dispose(): void { this.disconnect(); this.listeners.clear() }
}
