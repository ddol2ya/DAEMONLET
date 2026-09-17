import type { HookSetupDiscovery } from "../../adapter/codex/doctor/HookSetupDoctor"
import type { HookHostInspection, HookLaunchSpec } from "../../adapter/codex/hooks/HookLaunchSpec"
import type { PublicSelfTestResult } from "../../adapter/codex/hooks/HookHostSelfTest"
import type { ConfigurationStatus, HookPlanAction } from "../../adapter/codex/hooks/HookInstallPlan"
import type { HookApplySummary, HookPlanSummary } from "../../adapter/codex/hooks/HookInstallTransaction"
import type { HookEventReceipt } from "../../adapter/codex/hooks/HookEvents"
import type { AdapterOwnership, AdapterStatus } from "./ipc-contract"
import type { DesktopSettingsPatch, DesktopSettingsV1 } from "./desktop-settings"

export type { HookPlanAction, HookPlanSummary, HookApplySummary, PublicSelfTestResult }
export { HOOK_EVENTS } from "../../adapter/codex/hooks/HookEvents"
export type SetupConfigurationStatus = ConfigurationStatus | "feature-disabled" | "policy-blocked" | "capability-unknown" | "host-unavailable"
export type HookReviewStatus = "unknown" | "review-required" | "user-reported-reviewed"
export type ObservationSurface = "cli" | "desktop"
export type HookReception = { status: "unavailable" | "waiting" | "receiving"; lastReceivedAt: number | null; events: HookEventReceipt[] }
export type LiveObservation = {
  active: boolean
  startedAt: number | null
  surface: ObservationSurface | null
  source: "user-selected-surface"
  status: "not-tested" | "partial" | "observed"
  events: HookEventReceipt[]
  interrupt: "not-tested" | "observed" | "unsupported" | "unknown"
  desktopStopAttempt: "not-tested" | "user-reported"
}
export type PublicSetupStatus = {
  schemaVersion: 1
  app: { version: string; running: true; packaged: boolean; platform: string }
  storage: { userDataDisplayPath: string; receiptDirectoryDisplayPath: string }
  onboarding: "unseen" | "shown" | "skipped" | "acknowledged"
  discovery: HookSetupDiscovery | null
  configurationStatus: SetupConfigurationStatus
  configurationWarnings: string[]
  host: HookHostInspection & { mode: HookLaunchSpec["mode"]; executableDisplayPath: string; resourceDisplayPath: string; dataDisplayPath: string; endpoint: string }
  hostSelfTest: PublicSelfTestResult
  adapter: { state: AdapterStatus["state"]; ownership: AdapterOwnership; activeRunCount: number; activeTaskCount: number; codexAvailable?: boolean }
  desktop?: { connected: boolean; activeRunCount: number }
  hookReviewStatus: HookReviewStatus
  live: LiveObservation
  reception: HookReception
  hasRevert: boolean
  checkedAt: number
  issue: string | null
}

export const SETUP_IPC = {
  status: "setup.status.get",
  refresh: "setup.status.refresh",
  prepare: "setup.connection.prepare",
  chooseExecutable: "setup.codex.choose-executable",
  chooseHome: "setup.codex.choose-home",
  plan: "setup.hooks.plan",
  apply: "setup.hooks.apply",
  discardPlan: "setup.hooks.discard-plan",
  selfTest: "setup.host.self-test",
  reviewReported: "setup.review.user-reported",
  observationStart: "setup.observation.start",
  observationStop: "setup.observation.stop",
  desktopStopReported: "setup.observation.desktop-stop-reported",
  onboardingDismiss: "setup.onboarding.dismiss",
  settingsGet: "setup.appearance.get",
  settingsPatch: "setup.appearance.patch",
  resetPosition: "setup.appearance.reset-position",
  bubblePlacement: "setup.appearance.bubble-placement",
  restartAdapter: "setup.adapter.restart",
  exportDiagnostics: "setup.diagnostics.export",
  statusChanged: "setup.status.changed",
  settingsChanged: "setup.appearance.changed",
} as const

export type SetupResponse<T> = { ok: true; value: T } | { ok: false; code: string }

export interface SettingsDesktopApi {
  setBubblePlacement(action: "adjust" | "auto" | "reset"): Promise<void>
  packUpdates: import("./pack-update-contract").PackUpdateApi
  characters: CharacterManageApi
  getStatus(): Promise<PublicSetupStatus>
  refreshStatus(): Promise<PublicSetupStatus>
  prepareConnection(): Promise<PublicSetupStatus>
  chooseCodexExecutable(): Promise<PublicSetupStatus>
  chooseCodexHome(): Promise<PublicSetupStatus>
  planHooks(action: HookPlanAction): Promise<HookPlanSummary>
  applyHookPlan(planId: string): Promise<HookApplySummary>
  discardHookPlan(): Promise<void>
  runHostSelfTest(): Promise<PublicSelfTestResult>
  reportHookReview(): Promise<PublicSetupStatus>
  startLiveObservation(surface: ObservationSurface): Promise<PublicSetupStatus>
  stopLiveObservation(): Promise<PublicSetupStatus>
  reportDesktopStopAttempt(): Promise<PublicSetupStatus>
  dismissOnboarding(choice: "skipped" | "acknowledged"): Promise<void>
  getSettings(): Promise<DesktopSettingsV1>
  updateSettings(patch: DesktopSettingsPatch): Promise<DesktopSettingsV1>
  resetPetPosition(): Promise<void>
  restartAdapter(): Promise<{ restarted: boolean }>
  exportDiagnostics(): Promise<{ saved: boolean }>
  onStatusChanged(listener: (status: PublicSetupStatus) => void): () => void
  onSettingsChanged(listener: (settings: DesktopSettingsV1) => void): () => void
}

declare global { interface Window { settingsDesktop?: SettingsDesktopApi } }
import type { CharacterManageApi } from "./character-pack-contract"
