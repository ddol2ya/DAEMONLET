import { dialog, ipcMain, type IpcMainInvokeEvent } from "electron"
import { writeFile } from "node:fs/promises"
import { CodexIntegrationController, publicSetupError } from "./CodexIntegrationController"
import { SettingsWindowController } from "./SettingsWindowController"
import { isTrustedSender } from "./SecurityPolicy"
import { SETUP_IPC, type HookPlanAction, type SetupResponse } from "../shared/codex-integration-contract"
import { validateDesktopSettingsPatch, type DesktopSettingsPatch, type DesktopSettingsV1 } from "../shared/desktop-settings"
import { createSetupDiagnostics } from "./SetupDiagnostics"

export class SettingsIpcController {
  private registered = false
  private readonly channels: string[] = []
  private unsubscribe: (() => void) | null = null
  private bucket = { owner: "", start: 0, count: 0 }
  private nativeDialogOpen = false

  constructor(private readonly options: {
    window: SettingsWindowController
    integration: CodexIntegrationController
    devServerUrl?: string
    getSettings: () => DesktopSettingsV1
    updateSettings: (patch: DesktopSettingsPatch) => DesktopSettingsV1
    resetPosition: () => void
    restartAdapter: () => Promise<{ restarted: boolean }>
    characterAllowed?: (id: string) => boolean
  }) {}

  private bind<T>(channel: string, arity: number, action: (owner: string, args: unknown[]) => T | Promise<T>): void {
    this.channels.push(channel)
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SetupResponse<T>> => {
      if (!isTrustedSender(event, this.options.window.window, "settings", this.options.devServerUrl)) return { ok: false, code: "UNTRUSTED_SENDER" }
      const owner = this.options.window.currentOwner()
      if (!owner) return { ok: false, code: "SETTINGS_NOT_READY" }
      const now = Date.now()
      if (this.bucket.owner !== owner || now - this.bucket.start >= 1000) this.bucket = { owner, start: now, count: 0 }
      if (++this.bucket.count > 24) return { ok: false, code: "REQUEST_LIMITED" }
      if (args.length !== arity) return { ok: false, code: "INVALID_REQUEST" }
      try { return { ok: true, value: await action(owner, args) } }
      catch (error) { return { ok: false, code: publicSetupError(error) } }
    })
  }

  private async nativeDialog<T>(action: () => Promise<T>): Promise<T> {
    if (this.nativeDialogOpen) throw new Error("OPERATION_IN_PROGRESS")
    this.nativeDialogOpen = true
    try { return await action() } finally { this.nativeDialogOpen = false }
  }

  register(): void {
    if (this.registered) return
    this.registered = true
    const { integration, window } = this.options
    this.bind(SETUP_IPC.status, 0, () => integration.getStatus())
    this.bind(SETUP_IPC.refresh, 0, () => integration.refresh(true))
    this.bind(SETUP_IPC.prepare, 0, (owner) => integration.prepareConnection(owner))
    this.bind(SETUP_IPC.chooseExecutable, 0, (owner) => this.nativeDialog(async () => {
      const choice = await dialog.showOpenDialog(window.window!, { title: "Codex 앱 또는 실행 파일 선택", properties: ["openFile", "showHiddenFiles"] })
      return choice.canceled || !choice.filePaths[0] ? integration.getStatus() : integration.selectExecutable(choice.filePaths[0], owner)
    }))
    this.bind(SETUP_IPC.chooseHome, 0, (owner) => this.nativeDialog(async () => {
      const choice = await dialog.showOpenDialog(window.window!, { title: "사용자 Codex Home 선택", properties: ["openDirectory", "showHiddenFiles"] })
      return choice.canceled || !choice.filePaths[0] ? integration.getStatus() : integration.selectHome(choice.filePaths[0], owner)
    }))
    this.bind(SETUP_IPC.plan, 1, (owner, [action]) => {
      if (typeof action !== "string" || !["install", "repair", "uninstall", "revert-owned-change"].includes(action)) throw new Error("PLAN_BLOCKED")
      return integration.planHooks(action as HookPlanAction, owner)
    })
    this.bind(SETUP_IPC.apply, 1, (owner, [id]) => {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("PLAN_UNKNOWN")
      return integration.applyHookPlan(id, owner)
    })
    this.bind(SETUP_IPC.discardPlan, 0, (owner) => integration.discardHookPlan(owner))
    this.bind(SETUP_IPC.selfTest, 0, (owner) => integration.runHostSelfTest(owner))
    this.bind(SETUP_IPC.reviewReported, 0, (owner) => integration.reportHookReview(owner))
    this.bind(SETUP_IPC.observationStart, 1, (owner, [surface]) => {
      if (surface !== "cli" && surface !== "desktop") throw new Error("OWNED_ADAPTER_REQUIRED")
      return integration.startLiveObservation(surface, owner)
    })
    this.bind(SETUP_IPC.observationStop, 0, (owner) => integration.stopLiveObservation(owner))
    this.bind(SETUP_IPC.desktopStopReported, 0, (owner) => integration.reportDesktopStopAttempt(owner))
    this.bind(SETUP_IPC.onboardingDismiss, 1, async (owner, [choice]) => {
      if (choice !== "skipped" && choice !== "acknowledged") throw new Error("PLAN_BLOCKED")
      await integration.dismissOnboarding(choice, owner)
      if (choice === "skipped") window.window?.close()
    })
    this.bind(SETUP_IPC.settingsGet, 0, () => structuredClone(this.options.getSettings()))
    this.bind(SETUP_IPC.settingsPatch, 1, (_owner, [value]) => {
      const patch = validateDesktopSettingsPatch(value, this.options.characterAllowed)
      if (!patch) throw new Error("PLAN_BLOCKED")
      return this.options.updateSettings(patch)
    })
    this.bind(SETUP_IPC.resetPosition, 0, () => this.options.resetPosition())
    this.bind(SETUP_IPC.restartAdapter, 0, () => this.nativeDialog(this.options.restartAdapter))
    this.bind(SETUP_IPC.exportDiagnostics, 0, () => this.nativeDialog(async () => {
      const report = createSetupDiagnostics(integration.getStatus())
      const choice = await dialog.showSaveDialog(window.window!, { title: "Daemonlet 진단 내보내기", defaultPath: "daemonlet-setup-diagnostics.json", filters: [{ name: "JSON", extensions: ["json"] }], properties: ["showOverwriteConfirmation", "createDirectory"] })
      if (choice.canceled || !choice.filePath) return { saved: false }
      await writeFile(choice.filePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      return { saved: true }
    }))
    this.unsubscribe = integration.subscribe((value) => window.send(SETUP_IPC.statusChanged, value))
  }

  broadcastSettings(value: DesktopSettingsV1): void { this.options.window.send(SETUP_IPC.settingsChanged, structuredClone(value)) }
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const channel of this.channels.splice(0)) ipcMain.removeHandler(channel)
    this.registered = false
  }
}
