import { utilityProcess, type UtilityProcess } from "electron"
import { WebSocket } from "ws"
import type { AdapterWorkerCommand, AdapterWorkerMessage } from "../utility/codex-adapter-worker"
import type { AdapterOwnership, AdapterStatus, SanitizedAdapterDiagnostics } from "../shared/ipc-contract"
import type { DesktopAdapterRuntimeConfig } from "./DesktopAdapterConfig"
import { homedir } from "node:os"
import { join } from "node:path"
import { activityCorrelationKey, canonicalRunId } from "../../adapter/codex/privacy/CanonicalId"
import { belongsToLocalCodexHome, isThreadUuid } from "./control/CodexThreadLauncher"

type TimerHandle = ReturnType<typeof setTimeout>

type SupervisorOptions = {
  workerPath: string
  config: DesktopAdapterRuntimeConfig
  allowExternalReuse?: boolean
  fork?: typeof utilityProcess.fork
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
  probe?: (endpoint: string) => Promise<boolean>
  externalProbeIntervalMs?: number
  externalFailureThreshold?: number
  killProcess?: (pid: number) => void
  codexHome?: string
}

export async function probeExternalAdapter(
  endpoint = "ws://127.0.0.1:4174/events",
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* probe cleanup */ }
      resolve(value)
    }
    const socket = new WebSocket(endpoint, { perMessageDeflate: false })
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once("open", () => socket.send(JSON.stringify({
      protocolVersion: 1,
      commandType: "client.hello",
      requestId: `supervisor-probe-${Date.now()}`,
      clientId: "electron-adapter-supervisor-probe",
      supportedProtocolVersions: [1],
    })))
    socket.once("message", (data, binary) => {
      if (binary) return finish(false)
      try {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>
        finish(frame.frameType === "hello" && frame.source === "codex-adapter" && frame.protocolVersion === 1)
      } catch { finish(false) }
    })
    socket.once("error", () => finish(false))
    socket.once("close", () => finish(false))
  })
}

export class AdapterSupervisor {
  private readonly sideChats = new Set<string>()
  private sideChatGeneration = 0
  private sideChatWaiters = new Map<number, () => void>()
  async excludeSideChat(id: string): Promise<void> {
    if (!isThreadUuid(id) || this.sideChats.size >= 512 || this.diagnostics.adapterOwnership === "EXTERNAL_PROCESS") throw new Error("CHAT_POLICY_UNENFORCEABLE")
    this.sideChats.add(id)
    const child = this.child, generation = ++this.sideChatGeneration
    if (!child) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.sideChatWaiters.delete(generation); reject(new Error("CHAT_POLICY_UNENFORCEABLE")) }, 3000)
      this.sideChatWaiters.set(generation, () => { clearTimeout(timer); resolve() })
      child.postMessage({ type: "exclude-side-chats", ids: [...this.sideChats], generation } satisfies AdapterWorkerCommand)
    })
  }
  private child: UtilityProcess | null = null
  private state: AdapterStatus = { state: "STOPPED", message: null, restartCount: 0 }
  private diagnostics: SanitizedAdapterDiagnostics
  private readonly listeners = new Set<(status: AdapterStatus) => void>()
  private readonly diagnosticListeners = new Set<(value: SanitizedAdapterDiagnostics) => void>()
  private readonly conversationTargets = new Map<string, { threadId: string; rolloutPath: string }>()
  private readonly conversationListeners = new Set<(keys: ReadonlySet<string>) => void>()
  private readonly restartTimes: number[] = []
  private restartTimer: TimerHandle | null = null
  private externalMonitorTimer: TimerHandle | null = null
  private quitting = false
  private expectedExit = false
  private portConflict = false
  private lifecycleGeneration = 0

  constructor(private readonly options: SupervisorOptions) {
    this.diagnostics = {
      state: "STOPPED",
      message: null,
      restartCount: 0,
      adapterOwnership: "NONE",
      protocolEndpoint: options.config.protocolEndpoint,
      hookEndpoint: options.config.hookEndpoint,
      activeRunCount: 0,
      activeTaskCount: 0,
      provisionalRecoveredRunCount: 0,
      protocolClientCount: 0,
      externalProbeFailures: 0,
      lastExternalProbeAt: null,
      warnings: [],
    }
  }

  async start(): Promise<void> {
    if (this.child || this.state.state === "STARTING" || this.state.state === "EXTERNAL_RUNNING" || this.state.state === "READY") return
    const generation = ++this.lifecycleGeneration
    this.quitting = false
    this.expectedExit = false
    this.portConflict = false
    this.stopExternalMonitor()
    this.setOwnership("NONE")
    this.setState({ state: "STARTING", message: null, restartCount: this.restartTimes.length })
    const allowExternalReuse = this.options.allowExternalReuse !== false
    if (allowExternalReuse && await this.probe()) {
      if (generation !== this.lifecycleGeneration || this.quitting) return
      this.useExternalAdapter("Using an existing Codex adapter")
      return
    }
    if (generation !== this.lifecycleGeneration || this.quitting) return
    this.spawn()
  }

  private spawn(): void {
    this.stopExternalMonitor()
    this.setOwnership("NONE")
    this.expectedExit = false
    this.portConflict = false
    const fork = this.options.fork ?? utilityProcess.fork
    const config = this.options.config
    const child = fork(this.options.workerPath, [], {
      serviceName: "Daemonlet Codex Adapter",
      env: {
        ...process.env,
        CODEX_PET_DATA_DIR: config.dataDir,
        CODEX_PET_PROTOCOL_PORT: String(config.protocolPort),
        CODEX_PET_HOOK_PORT: String(config.hookPort),
      },
      stdio: "ignore",
    })
    this.child = child
    child.on("message", (message) => this.onMessage(child, message as AdapterWorkerMessage))
    child.once("exit", (code) => this.onExit(child, code))
    child.postMessage({ type: "exclude-side-chats", ids: [...this.sideChats], generation: this.sideChatGeneration } satisfies AdapterWorkerCommand)
    child.postMessage({ type: "start", mode: "HOOK_OBSERVER" } satisfies AdapterWorkerCommand)
  }

  private onMessage(child: UtilityProcess, message: AdapterWorkerMessage): void {
    if (this.child !== child || !message || typeof message !== "object") return
    if (message.type === "side-chat-excluded") { this.sideChatWaiters.get(message.generation)?.(); this.sideChatWaiters.delete(message.generation); return }
    if (message.type === "source-availability" && typeof message.available === "boolean") {
      this.setState({ ...this.state, codexAvailable: message.available })
      return
    }
    if (message.type === "conversation-target") {
      const t = message.value
      if (t && this.sideChats.has(t.sessionId)) return
      const home = this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")
      if (!t || typeof t.sessionId !== "string" || typeof t.turnId !== "string" || typeof t.path !== "string" || t.path.length > 4096 || !isThreadUuid(t.sessionId) || !isThreadUuid(t.turnId) || !belongsToLocalCodexHome(t.path, t.sessionId, home)) return
      const key = activityCorrelationKey(canonicalRunId(t.sessionId, t.turnId))
      if (this.conversationTargets.get(key)?.rolloutPath === t.path) return
      this.conversationTargets.set(key, { threadId: t.sessionId, rolloutPath: t.path })
      while (this.conversationTargets.size > 256) this.conversationTargets.delete(this.conversationTargets.keys().next().value!)
      this.emitConversationKeys()
      return
    }
    if (message.type === "ready") {
      if (message.protocolEndpoint !== this.options.config.protocolEndpoint || message.hookEndpoint !== this.options.config.hookEndpoint) {
        this.setState({ state: "ERROR", message: "Adapter worker reported unexpected endpoints", restartCount: this.restartTimes.length })
        child.postMessage({ type: "stop" } satisfies AdapterWorkerCommand)
        return
      }
      this.restartTimes.length = 0
      this.setOwnership("OWNED_UTILITY")
      this.setState({ ...this.state, state: "READY", message: null, restartCount: 0 })
    }
    if (message.type === "diagnostics") {
      this.diagnostics = {
        ...message.value,
        ...this.state,
        adapterOwnership: this.diagnostics.adapterOwnership,
        externalProbeFailures: this.diagnostics.externalProbeFailures,
        lastExternalProbeAt: this.diagnostics.lastExternalProbeAt,
        restartCount: this.restartTimes.length,
      }
      this.emitDiagnostics()
    }
    if (message.type === "warning") {
      this.addWarning(message.message)
      this.portConflict = message.code === "PORT_IN_USE" || message.message.includes("EADDRINUSE")
      this.setState({ state: "ERROR", message: message.message, restartCount: this.restartTimes.length })
      child.postMessage({ type: "stop" } satisfies AdapterWorkerCommand)
    }
    if (message.type === "stopped" && this.expectedExit) this.setState({ state: "STOPPED", message: message.reason, restartCount: this.restartTimes.length })
  }

  private onExit(child: UtilityProcess, code: number | null): void {
    if (this.child !== child) return
    this.child = null
    this.setOwnership("NONE")
    if (this.quitting || this.expectedExit) {
      this.setState({ state: "STOPPED", message: null, restartCount: this.restartTimes.length })
      return
    }
    if (this.portConflict) {
      this.portConflict = false
      const generation = this.lifecycleGeneration
      void this.recoverPortConflict(generation)
      return
    }
    const now = this.now()
    while (this.restartTimes.length && now - this.restartTimes[0] > 60_000) this.restartTimes.shift()
    if (this.restartTimes.length >= 3) {
      this.setState({ state: "ERROR", message: `Adapter restart limit reached after exit ${String(code)}`, restartCount: this.restartTimes.length })
      return
    }
    const delay = [500, 1_000, 2_000][this.restartTimes.length]
    this.restartTimes.push(now)
    this.setState({ state: "STARTING", message: `Adapter exited (${String(code)}); restarting`, restartCount: this.restartTimes.length })
    this.restartTimer = this.setTimer(() => { this.restartTimer = null; this.spawn() }, delay)
  }

  private async recoverPortConflict(generation: number): Promise<void> {
    const external = await this.probe()
    if (generation !== this.lifecycleGeneration || this.quitting) return
    if (external) {
      this.useExternalAdapter("Owned adapter port was claimed by a verified external Codex adapter")
      return
    }
    this.stopExternalMonitor()
    this.setOwnership("NONE")
    this.setState({ state: "ERROR", message: "Adapter port is in use by an unverified process", restartCount: this.restartTimes.length })
  }

  private useExternalAdapter(message: string): void {
    this.setOwnership("EXTERNAL_PROCESS")
    this.diagnostics.externalProbeFailures = 0
    this.setState({ state: "EXTERNAL_RUNNING", message, restartCount: this.restartTimes.length })
    this.scheduleExternalProbe()
  }

  private scheduleExternalProbe(): void {
    this.stopExternalMonitor()
    if (this.state.state !== "EXTERNAL_RUNNING" || this.quitting) return
    this.externalMonitorTimer = this.setTimer(() => {
      this.externalMonitorTimer = null
      void this.checkExternalAdapter()
    }, this.options.externalProbeIntervalMs ?? 5_000)
    if (typeof this.externalMonitorTimer === "object") this.externalMonitorTimer.unref?.()
  }

  private async checkExternalAdapter(): Promise<void> {
    if (this.state.state !== "EXTERNAL_RUNNING" || this.quitting) return
    const generation = this.lifecycleGeneration
    this.diagnostics.lastExternalProbeAt = this.now()
    const healthy = await this.probe()
    if (generation !== this.lifecycleGeneration || this.state.state !== "EXTERNAL_RUNNING" || this.quitting) return
    if (healthy) {
      this.diagnostics.externalProbeFailures = 0
      this.emitDiagnostics()
      this.scheduleExternalProbe()
      return
    }
    this.diagnostics.externalProbeFailures++
    this.addWarning(`External Codex adapter health probe failed (${this.diagnostics.externalProbeFailures})`)
    if (this.diagnostics.externalProbeFailures < (this.options.externalFailureThreshold ?? 2)) {
      this.scheduleExternalProbe()
      return
    }
    this.stopExternalMonitor()
    this.setOwnership("NONE")
    this.setState({ state: "STARTING", message: "External adapter unavailable; starting owned utility", restartCount: this.restartTimes.length })
    this.spawn()
  }

  async restart(): Promise<void> {
    this.restartTimes.length = 0
    this.clearRestartTimer()
    this.stopExternalMonitor()
    await this.stop(false)
    this.expectedExit = false
    await this.start()
  }

  requestDiagnostics(): void {
    this.child?.postMessage({ type: "get-diagnostics" } satisfies AdapterWorkerCommand)
  }

  requestFreshDiagnostics(timeoutMs = 1000): Promise<SanitizedAdapterDiagnostics | null> {
    if (!this.child) return Promise.resolve(this.getDiagnostics())
    return new Promise((resolve) => {
      const unsubscribe = this.subscribeDiagnostics((value) => { clearTimeout(timer); unsubscribe(); resolve(value) })
      const timer = setTimeout(() => { unsubscribe(); resolve(null) }, timeoutMs)
      this.requestDiagnostics()
    })
  }

  crashOwnedWorkerForSmokeTest(): boolean {
    if (typeof __APP_QA__ !== "undefined" && !__APP_QA__ || process.env.ELECTRON_SMOKE_TEST !== "1" || this.diagnostics.adapterOwnership !== "OWNED_UTILITY") return false
    const pid = this.child?.pid
    if (!pid) return false
    try {
      const kill = this.options.killProcess ?? ((value: number) => process.kill(value, "SIGKILL"))
      kill(pid)
      return true
    } catch {
      return false
    }
  }

  async stop(quitting = true): Promise<void> {
    ++this.lifecycleGeneration
    this.quitting = quitting
    this.expectedExit = true
    this.clearRestartTimer()
    this.stopExternalMonitor()
    const child = this.child
    if (!child) {
      this.setOwnership("NONE")
      this.setState({ state: "STOPPED", message: null, restartCount: this.restartTimes.length })
      return
    }
    child.postMessage({ type: "stop" } satisfies AdapterWorkerCommand)
    await new Promise<void>((resolve) => {
      let settled = false
      let timer: TimerHandle | null = null
      const finish = () => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve() } }
      child.once("exit", finish)
      timer = setTimeout(() => { if (this.child === child) child.kill(); finish() }, 2_000)
    })
  }

  subscribe(listener: (status: AdapterStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeDiagnostics(listener: (value: SanitizedAdapterDiagnostics) => void): () => void {
    this.diagnosticListeners.add(listener)
    return () => this.diagnosticListeners.delete(listener)
  }

  subscribeConversationKeys(listener: (keys: ReadonlySet<string>) => void): () => void {
    this.conversationListeners.add(listener); listener(new Set(this.conversationTargets.keys()))
    return () => this.conversationListeners.delete(listener)
  }
  conversationTarget(key: string): { threadId: string; rolloutPath: string } | null {
    const t = this.conversationTargets.get(key)
    return t ? { ...t } : null
  }
  private emitConversationKeys(): void {
    for (const listener of this.conversationListeners) listener(new Set(this.conversationTargets.keys()))
  }

  getStatus(): AdapterStatus { return { ...this.state } }
  getDiagnostics(): SanitizedAdapterDiagnostics { return { ...this.diagnostics, ...this.state, warnings: [...this.diagnostics.warnings] } }

  private probe(): Promise<boolean> {
    return (this.options.probe ?? probeExternalAdapter)(this.options.config.protocolEndpoint)
  }

  private now(): number { return (this.options.now ?? Date.now)() }
  private setTimer(callback: () => void, delay: number): TimerHandle { return (this.options.setTimer ?? setTimeout)(callback, delay) }

  private clearRestartTimer(): void {
    if (this.restartTimer) (this.options.clearTimer ?? clearTimeout)(this.restartTimer)
    this.restartTimer = null
  }

  private stopExternalMonitor(): void {
    if (this.externalMonitorTimer) (this.options.clearTimer ?? clearTimeout)(this.externalMonitorTimer)
    this.externalMonitorTimer = null
  }

  private setOwnership(value: AdapterOwnership): void {
    if (value !== "OWNED_UTILITY" && this.conversationTargets.size) { this.conversationTargets.clear(); this.emitConversationKeys() }
    this.diagnostics.adapterOwnership = value
    this.emitDiagnostics()
  }

  private addWarning(message: string): void {
    if (this.diagnostics.warnings.at(-1) !== message) this.diagnostics.warnings.push(message.slice(0, 1_000))
    if (this.diagnostics.warnings.length > 20) this.diagnostics.warnings.splice(0, this.diagnostics.warnings.length - 20)
    this.emitDiagnostics()
  }

  private emitDiagnostics(): void {
    for (const listener of this.diagnosticListeners) listener(this.getDiagnostics())
  }

  private setState(value: AdapterStatus): void {
    this.state = value
    this.diagnostics = { ...this.diagnostics, ...value }
    for (const listener of this.listeners) listener({ ...value })
    this.emitDiagnostics()
  }
}
