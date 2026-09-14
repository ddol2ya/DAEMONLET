import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { HookSetupDoctor, type HookSetupDiscovery } from "../../adapter/codex/doctor/HookSetupDoctor"
import { allEventSupport, hookHandler, inspectHookConfiguration, type HookPlanAction } from "../../adapter/codex/hooks/HookInstallPlan"
import { HookInstallTransaction, canonicalCodexHome, discoverLegacyHandlers, readHookTarget, type HookApplySummary, type HookPlanSummary, type InstallationBinding } from "../../adapter/codex/hooks/HookInstallTransaction"
import { parseHooksFile } from "../../adapter/codex/hooks/HookJson"
import { hashFile, hashText, hookHostRevision, inspectHookHost, type HookHostInspection, type HookLaunchSpec } from "../../adapter/codex/hooks/HookLaunchSpec"
import { notTestedHost, runHookHostSelfTest, type PublicSelfTestResult } from "../../adapter/codex/hooks/HookHostSelfTest"
import type { PublicSetupStatus, ObservationSurface, SetupConfigurationStatus } from "../shared/codex-integration-contract"
import type { SanitizedAdapterDiagnostics } from "../shared/ipc-contract"
import { CodexIntegrationStore } from "./CodexIntegrationStore"
import { HookLiveObservation } from "./HookLiveObservation"
import { currentHookReception } from "./HookReception"
import { CodexAppLauncher } from "./activity/CodexAppLauncher"

type Options = {
  userData: string
  launchSpec: HookLaunchSpec
  appVersion: string
  packaged: boolean
  platform?: NodeJS.Platform
  getDesktopConnection?: () => { connected: boolean; activeRunCount: number }
  getAdapterDiagnostics: () => SanitizedAdapterDiagnostics
  getFreshAdapterDiagnostics: () => Promise<SanitizedAdapterDiagnostics | null>
  doctor?: HookSetupDoctor
  inspectHost?: typeof inspectHookHost
  selfTest?: typeof runHookHostSelfTest
  // Dependency used by the explicitly built isolated smoke driver only. The
  // production AppController never sets this and has no runtime bypass flag.
  testLocationPolicy?: (spec: HookLaunchSpec) => boolean
}

export const publicSetupError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "SETUP_OPERATION_FAILED"
  const allowed = new Set([
    "PLAN_UNKNOWN", "PLAN_STALE", "PLAN_EXPIRED", "PLAN_BLOCKED", "PLAN_OWNER_MISMATCH", "PLAN_SUPERSEDED", "ACTIVE_RUN", "TARGET_BUSY", "TARGET_NOT_WRITABLE",
    "UNSAFE_FILE", "UNSAFE_DIRECTORY", "UNSAFE_CODEX_HOME", "INVALID_CODEX_HOME", "SYMLINK_CODEX_HOME", "NON_CANONICAL_ROOT", "FILE_TOO_LARGE",
    "OPERATION_IN_PROGRESS", "CONFIGURATION_UNAVAILABLE", "INTEGRATION_STORE_UNREADABLE", "INTEGRATION_STORE_CHANGED", "PROBE_CANCELLED",
    "OWNED_ADAPTER_REQUIRED", "DESKTOP_OBSERVATION_REQUIRED", "NO_HOOKS_TO_REVIEW", "ENOSPC", "FILESYSTEM_ERROR", "SETUP_CLOSED",
    "ABORT_RECEIPT_WRITE_FAILED", "COMMIT_OUTCOME_UNKNOWN",
  ])
  if (allowed.has(message)) return message
  return message.startsWith("refusing to modify invalid hooks.json") ? "INVALID_HOOK_CONFIGURATION" : "SETUP_OPERATION_FAILED"
}

export class CodexIntegrationController {
  private readonly options: Options
  private readonly store: CodexIntegrationStore
  private readonly doctor: HookSetupDoctor
  private readonly observation = new HookLiveObservation()
  private readonly listeners = new Set<(status: PublicSetupStatus) => void>()
  private readonly hostInspector: typeof inspectHookHost
  private readonly selfTestRunner: typeof runHookHostSelfTest
  private discovery: HookSetupDiscovery | null = null
  private host: HookHostInspection = { available: false, reason: "host-unavailable", fingerprint: null, runAsNode: "unknown", temporaryLocation: false }
  private hostTest = notTestedHost()
  private configurationStatus: SetupConfigurationStatus = "capability-unknown"
  private configurationWarnings: string[] = []
  private validationFingerprint: string | null = null
  private reviewRequired = false
  private hasRevert = false
  private managedHandlerCount = 0
  private issue: string | null = null
  private refreshing: Promise<PublicSetupStatus> | null = null
  private operation: string | null = null
  private applying: { id: string; owner: string; promise: Promise<HookApplySummary> } | null = null
  private transaction: HookInstallTransaction | null = null
  private selfTestAbort: AbortController | null = null
  private selfTestPending: Promise<PublicSelfTestResult> | null = null
  private closed = false
  private checkedAt = Date.now()
  private windowOwner: string | null = null
  private hostRevision: string | null = null

  constructor(options: Options) {
    this.options = options
    this.store = new CodexIntegrationStore(options.userData)
    this.doctor = options.doctor ?? new HookSetupDoctor({ additionalExecutables: async () => {
      const bundled = await new CodexAppLauncher().bundledExecutable()
      return bundled ? [bundled] : []
    } })
    this.hostInspector = options.inspectHost ?? inspectHookHost
    this.selfTestRunner = options.selfTest ?? runHookHostSelfTest
  }

  async start(): Promise<boolean> {
    const loaded = await this.store.load()
    this.issue = loaded.issue
    if (loaded.issue || loaded.value.onboarding !== "unseen") return false
    await this.store.save({ ...loaded.value, onboarding: "shown" })
    return true
  }

  windowOpened(owner: string): void { this.windowOwner = owner; void this.refresh().catch(() => {}) }
  windowClosed(owner: string): void {
    this.transaction?.invalidateOwner(owner)
    if (this.windowOwner === owner) this.windowOwner = null
    this.selfTestAbort?.abort()
    if (!this.applying) this.doctor.invalidate()
    this.observation.stop()
  }

  subscribe(listener: (status: PublicSetupStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): PublicSetupStatus { const value = this.getStatus(); for (const listener of this.listeners) listener(value); return value }

  getStatus(): PublicSetupStatus {
    const adapter = this.options.getAdapterDiagnostics()
    this.observation.update(adapter.hookEvents, this.discovery?.capability.events ?? allEventSupport("unknown"), adapter.adapterOwnership === "OWNED_UTILITY")
    const stored = this.store.get()
    return {
      schemaVersion: 1, app: { version: this.options.appVersion, running: true, packaged: this.options.packaged, platform: this.options.platform ?? process.platform },
      storage: { userDataDisplayPath: this.options.userData, receiptDirectoryDisplayPath: join(this.options.userData, "hook-installer") },
      onboarding: stored.onboarding, discovery: this.discovery ? structuredClone(this.discovery) : null,
      configurationStatus: this.configurationStatus, configurationWarnings: [...this.configurationWarnings],
      host: { ...this.host, mode: this.options.launchSpec.mode, executableDisplayPath: this.options.launchSpec.executablePath, resourceDisplayPath: this.options.launchSpec.forwarderPath, dataDisplayPath: this.options.launchSpec.dataDir, endpoint: this.options.launchSpec.hookEndpoint },
      hostSelfTest: structuredClone(this.hostTest),
      adapter: { state: adapter.state, ownership: adapter.adapterOwnership, activeRunCount: adapter.activeRunCount, activeTaskCount: adapter.activeTaskCount, codexAvailable: adapter.codexAvailable },
      desktop: this.options.getDesktopConnection?.() ?? { connected: false, activeRunCount: 0 },
      hookReviewStatus: stored.reviewedFingerprint !== null && stored.reviewedFingerprint === this.validationFingerprint ? "user-reported-reviewed" : this.reviewRequired || stored.reviewedFingerprint !== null ? "review-required" : "unknown",
      live: this.observation.get(), reception: currentHookReception(adapter), hasRevert: this.hasRevert, checkedAt: this.checkedAt, issue: this.issue,
    }
  }

  notifyAdapterChanged(): void {
    const value = this.options.getAdapterDiagnostics()
    if (value.state !== "READY" || value.adapterOwnership !== "OWNED_UTILITY") this.observation.reset()
    this.emit()
  }

  async refresh(force = false): Promise<PublicSetupStatus> {
    if (this.closed) throw new Error("SETUP_CLOSED")
    if (this.operation) return this.getStatus()
    if (this.refreshing) return this.refreshing
    const task = this.refreshInternal(force).finally(() => { this.refreshing = null })
    this.refreshing = task
    return task
  }

  /** Read-only preparation; Hook writes and Codex's own review remain explicit. */
  async prepareConnection(owner: string): Promise<PublicSetupStatus> {
    this.requireOwner(owner)
    const status = await this.refresh(true)
    this.requireOwner(owner)
    if (status.host.available && status.hostSelfTest.status !== "passed") await this.runHostSelfTest(owner)
    this.requireOwner(owner)
    return this.getStatus()
  }

  private async refreshInternal(force: boolean): Promise<PublicSetupStatus> {
    try {
      const discovery = await this.doctor.inspect(this.store.get().selection, force)
      const revision = await hookHostRevision(this.options.launchSpec)
      const host = !force && this.hostRevision === revision ? this.host : await this.hostInspector(this.options.launchSpec)
      this.hostRevision = revision
      const snapshot = await readHookTarget(discovery.home.path)
      const legacyHandlers = await discoverLegacyHandlers(snapshot.before, await hashFile(this.options.launchSpec.forwarderPath).catch(() => null))
      const inspectionTransaction = new HookInstallTransaction({ codexHome: discovery.home.path, storageRoot: join(this.options.userData, "hook-installer"), context: { desiredHandler: hookHandler(this.options.launchSpec), legacyHandlers }, support: discovery.capability.events, getBinding: () => this.binding() })
      const receipts = await inspectionTransaction.receipts()
      await inspectionTransaction.dispose()
      const inspection = inspectHookConfiguration(parseHooksFile(snapshot.before), { desiredHandler: hookHandler(this.options.launchSpec), legacyHandlers, receipts: receipts.identities }, discovery.capability.events)
      const fingerprint = hashText(JSON.stringify([host.fingerprint, discovery.configFingerprint, discovery.executable.fingerprint, discovery.executable.version, discovery.capability, snapshot.hash]))
      if (this.validationFingerprint !== null && this.validationFingerprint !== fingerprint) {
        this.observation.reset()
        if (this.windowOwner && !this.applying) this.transaction?.invalidateOwner(this.windowOwner)
      }
      if (this.hostTest.hostFingerprint !== host.fingerprint) this.hostTest = notTestedHost()
      this.validationFingerprint = fingerprint
      this.discovery = discovery
      this.host = host
      this.hasRevert = receipts.last !== null && !["diverged", "unavailable"].includes(receipts.recovery)
      this.managedHandlerCount = inspection.managed
      this.configurationWarnings = [...inspection.conflicts.slice(0, 64), ...discovery.warnings,
        ...(discovery.inlineOwnedConflict ? ["INLINE_OWNED_HOOK_CONFLICT"] : []),
        ...(receipts.recovery === "diverged" || receipts.recovery === "unavailable" ? ["RECEIPT_RECOVERY_REQUIRED"] : []),
        ...(receipts.recovery === "committed" ? ["COMMITTED_RECEIPT_RECOVERED"] : []),
        ...(receipts.recovery === "not-committed" ? ["PREPARED_CHANGE_NOT_COMMITTED"] : []),
        ...(host.temporaryLocation ? ["PERMANENT_APP_LOCATION_REQUIRED"] : [])]
      this.configurationStatus = inspection.status
      if (!host.available) this.configurationStatus = "host-unavailable"
      else if (discovery.policy === "blocked") this.configurationStatus = "policy-blocked"
      else if (discovery.feature === "disabled") this.configurationStatus = "feature-disabled"
      else if (discovery.inlineOwnedConflict || inspection.conflicts.length || discovery.warnings.includes("CONFIG_UNREADABLE_OR_INVALID")) this.configurationStatus = "configuration-conflict"
      else if (!discovery.capability.contractId) this.configurationStatus = "capability-unknown"
      this.issue = null
    } catch (error) { this.issue = publicSetupError(error); this.configurationStatus = "configuration-conflict" }
    this.checkedAt = Date.now()
    return this.emit()
  }

  private async binding(action: HookPlanAction = "install"): Promise<InstallationBinding> {
    const discovery = await this.doctor.inspect(this.store.get().selection, true)
    const host = await this.hostInspector(this.options.launchSpec)
    const adapter = await this.options.getFreshAdapterDiagnostics()
    const blockers: string[] = []
    const installing = action === "install" || action === "repair"
    if (installing) {
    if (!host.available || !host.fingerprint) blockers.push("HOST_UNAVAILABLE")
    if (!this.options.packaged || !["darwin", "win32"].includes(this.options.platform ?? process.platform)) blockers.push("PACKAGED_APP_REQUIRED")
    if (host.temporaryLocation && !this.options.testLocationPolicy?.(this.options.launchSpec)) blockers.push("PERMANENT_APP_LOCATION_REQUIRED")
    if (this.hostTest.status !== "passed" || this.hostTest.hostFingerprint !== host.fingerprint) blockers.push("HOST_SELF_TEST_REQUIRED")
    if (!discovery.capability.contractId) blockers.push("CAPABILITY_CONTRACT_UNKNOWN")
    if (discovery.feature !== "enabled") blockers.push(discovery.feature === "disabled" ? "HOOK_FEATURE_DISABLED" : "HOOK_FEATURE_UNKNOWN")
    if (discovery.policy === "blocked") blockers.push("MANAGED_POLICY_BLOCKED")
    if (discovery.inlineOwnedConflict) blockers.push("INLINE_OWNED_HOOK_CONFLICT")
    if (discovery.warnings.includes("CONFIG_UNREADABLE_OR_INVALID")) blockers.push("CONFIG_UNREADABLE_OR_INVALID")
    }
    if (!adapter || adapter.adapterOwnership === "EXTERNAL_PROCESS" || adapter.state === "STARTING" || adapter.state === "ERROR" || adapter.state === "DEGRADED") blockers.push("ADAPTER_STATE_UNCONFIRMED")
    return {
      targetPath: join(discovery.home.path, "hooks.json"),
      hostFingerprint: host.fingerprint ?? "unavailable", configFingerprint: discovery.configFingerprint,
      capabilityFingerprint: hashText(JSON.stringify([discovery.home.path, discovery.executable.fingerprint, discovery.executable.version, discovery.capability, discovery.feature, discovery.policy])),
      targetVersion: discovery.executable.version, appVersion: this.options.appVersion, busy: (adapter?.activeRunCount ?? 0) > 0, blockers,
    }
  }

  private async exclusive<T>(operation: string, task: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("SETUP_CLOSED")
    if (this.operation) throw new Error("OPERATION_IN_PROGRESS")
    this.operation = operation
    try { if (this.refreshing) await this.refreshing; return await task() } finally { this.operation = null; this.emit() }
  }

  private requireOwner(owner: string): void {
    if (this.closed || this.windowOwner !== owner) throw new Error("PLAN_OWNER_MISMATCH")
  }

  async selectExecutable(path: string, owner: string): Promise<PublicSetupStatus> {
    return this.exclusive("select-executable", async () => {
      this.requireOwner(owner)
      const selected = await realpath(path)
      const canonical = selected.endsWith(".app") ? await realpath(join(selected, "Contents/Resources/codex")) : selected
      this.requireOwner(owner)
      const stored = this.store.get()
      await this.store.save({ ...stored, selection: { ...stored.selection, executablePath: canonical }, reviewedFingerprint: null })
      this.transaction?.invalidateOwner(owner)
      this.observation.reset()
      this.doctor.invalidate()
      return this.refreshInternal(true)
    })
  }

  async selectHome(path: string, owner: string): Promise<PublicSetupStatus> {
    return this.exclusive("select-home", async () => {
      this.requireOwner(owner)
      const canonical = await canonicalCodexHome(path)
      await readHookTarget(canonical)
      this.requireOwner(owner)
      const stored = this.store.get()
      await this.store.save({ ...stored, selection: { ...stored.selection, codexHome: canonical }, reviewedFingerprint: null })
      this.transaction?.invalidateOwner(owner)
      this.observation.reset()
      this.doctor.invalidate()
      return this.refreshInternal(true)
    })
  }

  async planHooks(action: HookPlanAction, owner: string): Promise<HookPlanSummary> {
    return this.exclusive("plan", async () => {
      this.requireOwner(owner)
      await this.refreshInternal(true)
      if (!this.discovery || this.issue) throw new Error("CONFIGURATION_UNAVAILABLE")
      const snapshot = await readHookTarget(this.discovery.home.path)
      const legacyHandlers = await discoverLegacyHandlers(snapshot.before, await hashFile(this.options.launchSpec.forwarderPath).catch(() => null))
      await this.transaction?.dispose()
      this.transaction = new HookInstallTransaction({
        codexHome: this.discovery.home.path, storageRoot: join(this.options.userData, "hook-installer"),
        context: { desiredHandler: hookHandler(this.options.launchSpec), legacyHandlers }, support: this.discovery.capability.events,
        getBinding: () => this.binding(action),
      })
      this.requireOwner(owner)
      const summary = await this.transaction.prepare(action, owner)
      if (this.windowOwner !== owner) { this.transaction.invalidateOwner(owner); throw new Error("PLAN_OWNER_MISMATCH") }
      return summary
    })
  }

  applyHookPlan(planId: string, owner: string): Promise<HookApplySummary> {
    this.requireOwner(owner)
    if (this.applying?.id === planId && this.applying.owner === owner) return this.applying.promise
    const promise = this.exclusive("apply", async () => {
      this.requireOwner(owner)
      if (!this.transaction) throw new Error("PLAN_UNKNOWN")
      const result = await this.transaction.apply(planId, owner)
      if (result.changed) {
        this.reviewRequired = true
        this.observation.reset()
        // This app-owned preference write is separate from the Hook receipt.
        // Its failure must never report the committed Hook change as cancelled.
        await this.store.save({ ...this.store.get(), reviewedFingerprint: null }).catch(() => { this.issue = "INTEGRATION_STORE_CHANGED" })
      }
      await this.refreshInternal(true)
      return result
    })
    this.applying = { id: planId, owner, promise }
    void promise.finally(() => { if (this.applying?.promise === promise) this.applying = null }).catch(() => {})
    return promise
  }

  discardHookPlan(owner: string): void { this.requireOwner(owner); this.transaction?.invalidateOwner(owner) }

  runHostSelfTest(owner: string): Promise<PublicSelfTestResult> {
    this.requireOwner(owner)
    if (this.selfTestPending) return this.selfTestPending
    const task = this.exclusive("self-test", async () => {
      this.requireOwner(owner)
      const abort = new AbortController()
      this.selfTestAbort = abort
      try {
        this.hostTest = await this.selfTestRunner(this.options.launchSpec, abort.signal)
        if (this.windowOwner === owner) await this.refreshInternal(false)
        return structuredClone(this.hostTest)
      } finally { this.selfTestAbort = null }
    }).finally(() => { this.selfTestPending = null })
    this.selfTestPending = task
    return task
  }

  async reportHookReview(owner: string): Promise<PublicSetupStatus> {
    return this.exclusive("review", async () => {
      this.requireOwner(owner)
      await this.refreshInternal(true)
      this.requireOwner(owner)
      if (this.issue || this.managedHandlerCount === 0 || !this.validationFingerprint || ["not-installed", "configuration-conflict", "host-unavailable"].includes(this.configurationStatus)) throw new Error("NO_HOOKS_TO_REVIEW")
      await this.store.save({ ...this.store.get(), reviewedFingerprint: this.validationFingerprint })
      this.reviewRequired = false
      return this.emit()
    })
  }

  async startLiveObservation(surface: ObservationSurface, owner: string): Promise<PublicSetupStatus> {
    return this.exclusive("observe", async () => {
      this.requireOwner(owner)
      await this.refreshInternal(true)
      const adapter = await this.options.getFreshAdapterDiagnostics()
      this.requireOwner(owner)
      if (!adapter || adapter.adapterOwnership !== "OWNED_UTILITY" || adapter.state !== "READY") throw new Error("OWNED_ADAPTER_REQUIRED")
      this.observation.start(surface, adapter.hookEvents)
      return this.emit()
    })
  }
  stopLiveObservation(owner: string): PublicSetupStatus { this.requireOwner(owner); this.observation.stop(); return this.emit() }
  reportDesktopStopAttempt(owner: string): PublicSetupStatus { this.requireOwner(owner); this.observation.reportDesktopStopAttempt(); return this.emit() }

  async dismissOnboarding(choice: "skipped" | "acknowledged", owner: string): Promise<void> {
    return this.exclusive("dismiss-onboarding", async () => {
      this.requireOwner(owner)
      await this.store.save({ ...this.store.get(), onboarding: choice })
      this.emit()
    })
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.listeners.clear()
    this.selfTestAbort?.abort()
    this.doctor.dispose()
    await Promise.allSettled([this.transaction?.dispose(), this.selfTestPending, this.refreshing])
    await this.store.flush()
    this.observation.reset()
  }
}
