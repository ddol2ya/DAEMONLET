import { publishHookEndpoint } from "./hooks/HookEndpoint.ts"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { CodexRunRegistry } from "./CodexRunRegistry.ts"
import type { CodexAdapterConfig } from "./CodexAdapterConfig.ts"
import type { CodexAdapterDiagnostics, NormalizedCodexAction } from "./types.ts"
import { mapHookEvent } from "./hooks/HookEventMapper.ts"
import { HookIngressServer } from "./hooks/HookIngressServer.ts"
import { loadOrCreateAdapterToken } from "./persistence/AdapterToken.ts"
import { AdapterStateStore } from "./persistence/AdapterStateStore.ts"
import { ProtocolSourceServer } from "./protocol/ProtocolSourceServer.ts"
import { AppServerProcess } from "./app-server/AppServerProcess.ts"
import { validateAppServerNotification } from "./app-server/AppServerEventValidator.ts"
import { mapAppServerNotification } from "./app-server/AppServerEventMapper.ts"
import { diagnosticId } from "./privacy/CanonicalId.ts"
import { LiveActivityReconciler } from "./lifecycle/LiveActivityReconciler.ts"
import type { LiveActivitySnapshot } from "./lifecycle/LiveActivity.ts"
import { CodexLifecycleObserver, type LocalConversationTarget } from "./lifecycle/CodexLifecycleObserver.ts"

const execFileAsync = promisify(execFile)

type MaintenanceTimer = ReturnType<typeof setInterval>

export type CodexAdapterServiceOptions = {
  now?: () => number
  setMaintenanceTimer?: (callback: () => Promise<void>, delay: number) => MaintenanceTimer
  clearMaintenanceTimer?: (timer: MaintenanceTimer) => void
  onConversationTarget?: (target: LocalConversationTarget) => void
  onSourceAvailability?: (available: boolean) => void
}

export class CodexAdapterService {
  readonly config: CodexAdapterConfig
  readonly registry: CodexRunRegistry
  readonly store: AdapterStateStore
  private protocol: ProtocolSourceServer | null = null
  private ingress: HookIngressServer | null = null
  private appServer: AppServerProcess | null = null
  private appServerUnsubscribe: (() => void) | null = null
  private status: CodexAdapterDiagnostics["status"] = "STOPPED"
  private warnings: string[] = []
  private persistence = Promise.resolve()
  private staleTimer: ReturnType<typeof setInterval> | null = null
  private readonly sourceInstanceId = randomUUID()
  private codexVersion: string | null = null
  private readonly eventTrace: CodexAdapterDiagnostics["eventTrace"] = []
  private lifecycle: CodexLifecycleObserver | null = null
  private readonly live: LiveActivityReconciler

  constructor(config: CodexAdapterConfig, private readonly options: CodexAdapterServiceOptions = {}) {
    this.config = config
    if (config.mode === "APP_SERVER_ATTACH") throw new Error("APP_SERVER_ATTACH is disabled because cross-client fan-out has not been verified")
    this.registry = new CodexRunRegistry({ staleTtlMs: config.staleTtlMs, recoveryTtlMs: config.recoveryTtlMs, now: options.now })
    this.store = new AdapterStateStore(config.dataDir)
    this.live = new LiveActivityReconciler(this.registry, {
      now: options.now,
      snapshot: () => this.protocol?.publishSnapshot(),
      target: value => { this.options.onConversationTarget?.(value); this.lifecycle?.observe(value.sessionId, value.turnId) },
      available: value => this.options.onSourceAvailability?.(value),
    })
  }

  async start(): Promise<void> {
    if (this.status !== "STOPPED") return
    this.status = "STARTING"
    try {
      await this.store.ensureDirectory()
      // Hook observer mode is driven entirely by authenticated ingress. It
      // neither needs a CLI nor executes a PATH candidate during app startup;
      // Settings' bounded doctor owns verified CLI discovery and probing.
      if (this.config.mode !== "HOOK_OBSERVER") {
        try {
          this.codexVersion = (await execFileAsync(this.config.codexPath, ["--version"], { timeout: 5_000, maxBuffer: 64 * 1024 })).stdout.trim()
        } catch { this.warnings.push("Codex binary version could not be read") }
      }
      const loaded = await this.store.load()
      if (loaded.warning) this.warnings.push(loaded.warning)
      if (loaded.state) this.registry.restore(loaded.state.registry)
      this.registry.cleanupStale()

      this.protocol = new ProtocolSourceServer({ provider: this.registry, host: this.config.protocolHost, port: this.config.protocolPort, sourceInstanceId: this.sourceInstanceId })
      await this.protocol.start()

      if (this.config.mode === "HOOK_OBSERVER") {
        this.lifecycle = new CodexLifecycleObserver({ home: this.config.codexHome, now: this.options.now,
          onEvent: event => this.apply({ kind: "event", event }), onTarget: value => this.live.target(value) })
        this.lifecycle.start()
        for (const run of this.registry.getIdMappings()) this.lifecycle.observe(run.sessionId, run.turnId)
        const { token } = await loadOrCreateAdapterToken(this.config.dataDir)
        this.ingress = new HookIngressServer({ token, host: this.config.hookHost, port: this.config.hookPort, onEvent: (event) => {
          this.lifecycle?.observe(event.sessionId, "turnId" in event ? event.turnId : undefined)
          return this.apply(mapHookEvent(event))
        } })
        await this.ingress.start()
        if (process.platform === "win32") await publishHookEndpoint(this.config.dataDir, Number(new URL(this.ingress.getDiagnostics().endpoint).port))
      } else {
        this.appServer = new AppServerProcess(this.config.codexPath)
        const client = await this.appServer.start()
        await client.initialize({ name: "daemonlet_codex_pet_adapter", title: "Daemonlet for Codex Adapter", version: "0.2.0" })
        this.appServerUnsubscribe = client.onNotification((method, params) => {
          const validated = validateAppServerNotification(method, params)
          if (!validated.ok) return void this.warnings.push(`rejected app-server notification: ${validated.code}`)
          if (!validated.value) return
          const event = mapAppServerNotification(validated.value)
          if (event) void this.apply({ kind: "event", event })
        })
      }

      await this.persist()
      const schedule = this.options.setMaintenanceTimer ?? ((callback: () => Promise<void>, delay: number) => setInterval(() => { void callback() }, delay))
      const maintenanceIntervalMs = Math.max(1_000, Math.min(60_000, this.config.recoveryTtlMs, this.config.staleTtlMs))
      this.staleTimer = schedule(() => this.runMaintenance(), maintenanceIntervalMs)
      if (typeof this.staleTimer === "object") this.staleTimer.unref?.()
      this.status = "READY"
    } catch (error) {
      this.status = "ERROR"
      await this.stopResources()
      throw error
    }
  }

  private async apply(action: NormalizedCodexAction): Promise<void> {
    let accepted = false
    let eventType: string
    let backend: CodexAdapterDiagnostics["mode"]
    let turnId: string | null
    let observedAt: number
    if (action.kind === "session-ended") {
      accepted = this.registry.cancelSession(action.sessionId, action.reason).length > 0
      eventType = "session.ended"
      backend = "HOOK_OBSERVER"
      turnId = null
      observedAt = action.observedAt
    } else {
      accepted = this.registry.apply(action.event) !== null
      eventType = action.event.type
      backend = "backend" in action.event ? action.event.backend : this.config.mode
      turnId = "turnId" in action.event ? action.event.turnId : null
      observedAt = action.event.observedAt
    }
    this.eventTrace.push({
      eventType,
      backend,
      sessionHash: diagnosticId(action.kind === "session-ended" ? action.sessionId : action.event.sessionId),
      turnHash: turnId ? diagnosticId(turnId) : null,
      decision: accepted ? "accepted" : "ignored",
      latencyMs: Math.max(0, Date.now() - observedAt),
    })
    if (this.eventTrace.length > 256) this.eventTrace.splice(0, this.eventTrace.length - 256)
    this.live.refreshPresence()
    await this.persist()
  }

  observeLiveActivity(value: LiveActivitySnapshot): void {
    this.live.update(value)
    void this.persist()
  }

  private persist(): Promise<void> {
    this.persistence = this.persistence.then(() => this.store.save(this.registry.exportState())).catch((error) => {
      this.warnings.push(`state persistence failed: ${error instanceof Error ? error.message : "unknown error"}`)
      this.status = "DEGRADED"
    })
    return this.persistence
  }

  private async runMaintenance(): Promise<void> {
    if (this.registry.cleanupStale().length > 0) await this.persist()
  }

  private async stopResources(): Promise<void> {
    await this.lifecycle?.stop(); this.lifecycle = null
    if (this.staleTimer) (this.options.clearMaintenanceTimer ?? clearInterval)(this.staleTimer)
    this.staleTimer = null
    this.appServerUnsubscribe?.()
    this.appServerUnsubscribe = null
    await Promise.allSettled([this.ingress?.stop(), this.protocol?.stop(), this.appServer?.stop()])
    this.ingress = null
    this.protocol = null
    this.appServer = null
  }

  async stop(): Promise<void> {
    if (this.status === "STOPPED") return
    await this.persist()
    await this.stopResources()
    this.status = "STOPPED"
  }

  getDiagnostics(): CodexAdapterDiagnostics {
    const registry = this.registry.getDiagnostics()
    const ingress = this.ingress?.getDiagnostics() ?? { endpoint: `http://${this.config.hookHost}:${this.config.hookPort}/hook`, accepted: 0, rejected: 0, authFailures: 0, timeouts: 0, lastEventAt: null }
    const client = this.appServer?.client
    return {
      mode: this.config.mode,
      status: this.status,
      codexPath: this.config.codexPath,
      codexVersion: this.codexVersion,
      sourceInstanceId: this.sourceInstanceId,
      hookIngress: ingress,
      appServer: {
        processState: this.appServer?.processState ?? "STOPPED",
        handshakeState: client?.handshakeState ?? "NEW",
        pendingRequests: client?.pendingRequestCount ?? 0,
        lastNotification: client?.lastNotification ?? null,
        lastError: client?.lastError ?? this.appServer?.stderrSummary ?? null,
      },
      activeRunCount: registry.activeRunCount,
      activeTaskCount: registry.activeTaskCount,
      provisionalRecoveredRunCount: registry.provisionalRecoveredRunCount,
      recoveredRunCount: this.registry.recoveredRunCount,
      staleRunCount: this.registry.staleRunCount,
      protocolClientCount: this.protocol?.clientCount ?? 0,
      lastPersistenceAt: this.store.lastPersistenceAt,
      warnings: [...this.warnings.slice(-20), ...registry.warnings],
      eventTrace: structuredClone(this.eventTrace),
      idMappings: this.registry.getIdMappings(),
    }
  }
}
