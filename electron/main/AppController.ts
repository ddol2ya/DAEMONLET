declare const __APP_QA__: boolean
import { RELEASE_ROOT } from "./updates/ReleasePolicy"
import { UpdateService } from "./updates/UpdateService"
import { UpdateIpcController } from "./updates/UpdateIpcController"
import { createOfficialUpdateEngine, detectUpdatePlatform } from "./updates/OfficialUpdater"
import { setApplicationInputLocked, applicationInputAllowed } from "./updates/OperationGate"
import { SideChatService } from "./side-chat/SideChatService"
import { CodexSideChatBackend } from "./side-chat/SideChatBackend"
import type { ChatParent } from "./side-chat/SideChatBackend"
import { connectVerifiedSideChat } from "./side-chat/SideChatPolicy"
import { SideChatPreferences } from "./side-chat/SideChatPreferences"
import { SideChatSetupController } from "./side-chat/SideChatSetupController"
import { PersonaResolver } from "./side-chat/PersonaResolver"
import { WindowDragController } from "./WindowDragController"
import { automaticBubblePlacement } from "../shared/bubble-placement"
import { validWindowDragRequest } from "../shared/window-drag"
import { SideChatEntryController } from "./side-chat/SideChatEntryController"
import { SideChatIpcController } from "./SideChatIpcController"
import { appLanguage, appText, setAppLanguage } from "./AppLanguage"
import type { StartupWindow } from "./StartupWindow"
import { app, dialog, ipcMain, powerMonitor, screen, session, shell, net, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from "electron"
import { join, resolve } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { AdapterSupervisor } from "./AdapterSupervisor"
import { LabWindowController } from "./LabWindowController"
import { PetWindowController } from "./PetWindowController"
import { ProtocolBridge } from "./ProtocolBridge"
import { createDesktopAdapterRuntimeConfig, type DesktopAdapterRuntimeConfig } from "./DesktopAdapterConfig"
import { TrayController, type TrayActions } from "./TrayController"
import { WindowBoundsStore } from "./WindowBoundsStore"
import { denyAllPermissions, isTrustedProtocolSender, isTrustedSender } from "./SecurityPolicy"
import { recoverWindowBounds, validateDesktopSettingsPatch, windowSizeForScale, type DesktopSettingsPatch, type DesktopSettingsV1, type DisplayLike } from "../shared/desktop-settings"
import { IPC, type AdapterStatus, type ProtocolConnectResult, type SanitizedAdapterDiagnostics } from "../shared/ipc-contract"
import { validatePetReadyInfo, validateShortMessage } from "../shared/runtime-validation"
import { CodexIntegrationController } from "./CodexIntegrationController"
import { SettingsWindowController } from "./SettingsWindowController"
import { SettingsIpcController } from "./SettingsIpcController"
import type { SetupSmokeContext } from "./SetupSmoke"
import { CharacterIpcController } from "./CharacterIpcController"
import type { CharacterRegistry } from "./CharacterRegistry"
import { CHARACTER_IPC, isCharacterId, type CharacterSelection } from "../shared/character-pack-contract"
import { ActivityService } from "./activity/ActivityService"
import { ActivityConversationTitles } from "./activity/ActivityConversationTitles"
import { readDesktopThreadCatalog, readDesktopThreadCatalogPage } from "./control/DesktopThreadCatalog"
import { homedir } from "node:os"
import { ActivityHistoryStore } from "./activity/ActivityHistoryStore"
import { createActivityClient } from "./activity/createActivityClient"
import { CodexAppLauncher } from "./activity/CodexAppLauncher"
import { ActivityWindowController } from "./ActivityWindowController"
import { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import { BubblePresentationIpcController } from "./BubblePresentationIpcController"
import { TaskControlIpcController } from "./TaskControlIpcController"
import { CodexThreadLauncher } from "./control/CodexThreadLauncher"
import { TaskControlService } from "./control/TaskControlService"
import { DictationService } from "./control/DictationService"
import { ActivityIpcController } from "./ActivityIpcController"

const RECOVERY_SMOKE_SESSION_ID = "smoke-recovery-session"
const RECOVERY_SMOKE_CONFIRMED_TURN_ID = "smoke-confirmed-turn"

export class AppController {
  private readonly sideChat: SideChatService = new SideChatService(parent => new CodexSideChatBackend(() => {
    const options = this.sideChatSetup.options()
    return connectVerifiedSideChat({ ...options, codexHome: parent.sourceHome ?? options.codexHome, authHome: options.codexHome })
  }, id => this.adapter.excludeSideChat(id)))
  private readonly sideChatSetup: SideChatSetupController = new SideChatSetupController(this.sideChat, new SideChatPreferences(app.getPath("userData")),
    () => this.integration.sideChatSelection(), () => this.activityBubble.window, () => this.updateSettings({ sideChatEnabled: true }))
  private readonly chatEntry = new SideChatEntryController(this.sideChat, {
    revealPet: async signal => { if (this.quitting) return false; this.showPet(); return this.pet.reveal(signal) },
    focus: () => this.activityBubble.focusConversation(),
    refreshParents: query => this.refreshChatParents(query), check: () => this.sideChatSetup.check(),
  })
  private readonly petDrag = new WindowDragController({
    window: () => this.pet.window, cursor: () => screen.getCursorScreenPoint(), startCursor: () => this.pet.takeDragStart(),
    workArea: point => screen.getDisplayNearestPoint(point).workArea, allowed: () => !this.quitting && this.settings.visible,
    lock: active => this.pet.setDragging(active), finish: (bounds, committed) => { if (committed) this.captureBounds(bounds) },
  })
  private sideChatPage = { offset: 0, query: "", generation: 0 }
  private readonly sideChatIpc: SideChatIpcController
  private readonly personaResolver: PersonaResolver
  private personaGeneration = 0
  private settings!: DesktopSettingsV1
  private readonly store = new WindowBoundsStore(app.getPath("userData"))
  private readonly tray = new TrayController()
  private readonly adapterConfig: DesktopAdapterRuntimeConfig
  private readonly protocol: ProtocolBridge
  private readonly activity: ActivityService
  private readonly activityTitles: ActivityConversationTitles
  private readonly activityWindow: ActivityWindowController
  private readonly activityBubble: ActivityBubbleWindowController
  private readonly activityIpc: ActivityIpcController
  private readonly bubbleIpc: BubblePresentationIpcController
  private readonly taskControl = new TaskControlService()
  private readonly dictation: DictationService
  private readonly taskControlIpc: TaskControlIpcController
  private readonly codexApp = new CodexAppLauncher()
  private readonly threadLauncher = new CodexThreadLauncher({ app: this.codexApp })
  private readonly devServerUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL
  private readonly pet: PetWindowController
  private readonly lab: LabWindowController
  private readonly adapter: AdapterSupervisor
  private readonly integration: CodexIntegrationController
  private readonly settingsWindow: SettingsWindowController
  private readonly settingsIpc: SettingsIpcController
  private readonly characterIpc: CharacterIpcController
  private unavailableSelection: string | null = null
  private lastReady: CharacterSelection | null = null
  private readonly readyWaiters = new Set<{ selection: CharacterSelection; finish: (error?: Error) => void }>()
  private readonly subscriptions: Array<() => void> = []
  private settingsPoll: ReturnType<typeof setInterval> | null = null
  private restartPending = false
  private readonly warnings: string[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private trayVisibilityTimer: ReturnType<typeof setTimeout> | null = null
  private readonly updates: UpdateService
  private readonly updateIpc: UpdateIpcController
  private exitReady = false
  private quitPromise: Promise<void> | null = null
  private updatePreparing = false
  private osEnding = false
  get canExit(): boolean { return this.exitReady }
  private quitting = false
  private trayCreated = false
  private dockFallbackRestored = false
  private smokeFinishing = false
  private readonly smokeReadyCharacters = new Set<string>()

  constructor(private readonly dirname: string, private readonly characters: CharacterRegistry, private readonly setupSmoke?: SetupSmokeContext, private readonly startup?: StartupWindow, updateSmoke?: Partial<ConstructorParameters<typeof UpdateService>[0]>) {
    this.adapterConfig = createDesktopAdapterRuntimeConfig()
    this.protocol = new ProtocolBridge(this.adapterConfig.protocolEndpoint)
    const preload = (name: string) => join(dirname, `${name}-preload.cjs`)
    this.activity = new ActivityService(createActivityClient(this.adapterConfig.protocolEndpoint), new ActivityHistoryStore(app.getPath("userData")))
    this.activityTitles = new ActivityConversationTitles(() => readDesktopThreadCatalog(process.env.CODEX_HOME ?? join(homedir(), ".codex")), titles => this.activity.setConversationTitles(titles))
    this.activityWindow = new ActivityWindowController(preload("activity"), this.devServerUrl)
    this.dictation = new DictationService(join(app.isPackaged ? process.resourcesPath : dirname, "native/DaemonletDictation.app/Contents/MacOS/DaemonletDictation"), undefined, process.platform, appLanguage)
    this.activityBubble = new ActivityBubbleWindowController(preload("activity"), this.devServerUrl, () => this.dictation.cancel(), () => { this.chatEntry.cancel(); this.sideChat.setMode("hidden") }, placement => this.updateSettings({ bubblePlacement: placement }))
    this.personaResolver = new PersonaResolver((selection, path) => this.characters.readPersonaAsset(selection, path))
    this.sideChatIpc = new SideChatIpcController(this.sideChat, this.activityBubble, this.devServerUrl, this.sideChatSetup, (query, more) => this.refreshChatParents(query, more), () => this.chatEntry.cancel())
    this.subscriptions.push(this.sideChat.subscribe(() => this.activityBubble.updateChat(this.sideChat.snapshot())))
    this.bubbleIpc = new BubblePresentationIpcController(this.activityBubble, this.devServerUrl)
    this.taskControlIpc = new TaskControlIpcController(this.activityBubble, this.taskControl, this.dictation, this.devServerUrl, Date.now, this.threadLauncher)
    this.activityIpc = new ActivityIpcController(this.activityWindow, this.activity, this.codexApp, this.devServerUrl, Date.now, this.activityBubble, async key => {
      const target = this.adapter.conversationTarget(key)
      if (!target) throw new Error("UNAVAILABLE")
      await this.threadLauncher.open(target)
    }, (key, activityId) => this.openSideChat(key, activityId))
    this.pet = new PetWindowController({
      preloadPath: preload("pet"),
      devServerUrl: this.devServerUrl,
      onBoundsChanged: (bounds) => this.captureBounds(bounds),
      onWarning: (message) => this.warn(message),
      onCloseRequested: () => { if (!this.quitting) this.updateSettings({ visible: false }) },
      onContextMenu: (window) => { this.tray.popup(window) },
    })
    this.lab = new LabWindowController(preload("lab"), this.devServerUrl, (message) => this.warn(message))
    const workerPath = app.isPackaged ? join(process.resourcesPath, "codex", "codex-adapter-worker.cjs") : join(dirname, "codex", "codex-adapter-worker.cjs")
    this.adapter = new AdapterSupervisor({
      workerPath,
      config: this.adapterConfig,
      // Never attach the test app to another installation's adapter.
      allowExternalReuse: __APP_QA__ && process.env.ELECTRON_SMOKE_ADAPTER_MODE === "external",
    })
    this.integration = new CodexIntegrationController({
      userData: app.getPath("userData"), appVersion: app.getVersion(), packaged: app.isPackaged,
      // Calculate the application executable here in Main, never in the utility worker.
      launchSpec: {
        mode: app.isPackaged ? process.platform === "win32" ? "packaged-windows-host" : "packaged-electron-node" : "development-node",
        executablePath: app.isPackaged ? process.platform === "win32" ? join(process.resourcesPath, "codex", "hook-host.exe") : process.execPath : process.env.CODEX_PET_DEV_NODE_PATH ?? process.env.npm_node_execpath ?? process.execPath,
        forwarderPath: app.isPackaged ? join(process.resourcesPath, "codex", "hook-forwarder.mjs") : join(dirname, "codex", "hook-forwarder.mjs"),
        dataDir: this.adapterConfig.dataDir, hookEndpoint: process.platform === "win32" ? "discover" : this.adapterConfig.hookEndpoint,
      },
      getDesktopConnection: () => { const value = this.taskControl.snapshot(); return { connected: value.source === "desktop" && value.connection === "ready", activeRunCount: value.threads.filter(item => item.state === "running").length } },
      getAdapterDiagnostics: () => this.adapter.getDiagnostics(),
      getFreshAdapterDiagnostics: () => this.adapter.requestFreshDiagnostics(),
      ...(__SETUP_SMOKE__ ? setupSmoke?.integrationOptions : {}),
    })
    this.settingsWindow = new SettingsWindowController({
      preloadPath: preload("settings"), devServerUrl: this.devServerUrl,
      taskbarVisible: () => this.dockFallbackRestored,
      onOpened: (owner) => {
        this.integration.windowOpened(owner)
        if (!this.settingsPoll) this.settingsPoll = setInterval(() => { this.adapter.requestDiagnostics(); void this.integration.refresh().catch(() => {}) }, 3000)
      },
      onClosed: (owner) => {
        this.integration.windowClosed(owner)
        void this.characters.cancelImport(owner)
        if (this.settingsPoll) clearInterval(this.settingsPoll)
        this.settingsPoll = null
      },
    })
    this.updates = new UpdateService({
      version: app.getVersion(), dataRoot: app.getPath("userData"), platform: () => detectUpdatePlatform(this.settings?.allowUnsignedWindowsUpdates), engine: () => createOfficialUpdateEngine(() => this.settings?.allowUnsignedWindowsUpdates ?? false),
      setUnsignedWindowsPolicy: enabled => this.setUnsignedWindowsPolicy(enabled),
      autoCheck: () => this.settings?.updateAutoCheck ?? false,
      confirmInstall: () => this.confirmUpdateRestart(), prepareShutdown: () => this.prepareUpdateExit(),
      handoff: () => { if (this.osEnding) throw Error("OS_SHUTDOWN"); this.exitReady = true },
      resume: () => { this.updatePreparing = false; setApplicationInputLocked(false); this.rebuildTray() },
      openExternal: url => shell.openExternal(url),
      fetchLatest: async etag => {
        const response = await net.fetch(RELEASE_ROOT + "/latest", { headers: { Accept: "application/json", ...(etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(15_000) })
        const info = response.status === 200 ? await response.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean } : null
        if (info?.draft || info?.prerelease) throw Error("INVALID_VERSION")
        return { status: response.status, etag: response.headers.get("etag") ?? undefined, tag: info?.tag_name }
      },
      ...(__APP_QA__ ? updateSmoke : {}),
    })
    this.updateIpc = new UpdateIpcController(this.updates, this.settingsWindow, this.devServerUrl)
    this.settingsIpc = new SettingsIpcController({
      window: this.settingsWindow, integration: this.integration, devServerUrl: this.devServerUrl,
      getSettings: () => this.settings, updateSettings: (patch) => this.updateSettings(patch),
      bubblePlacement: action => this.editBubblePlacement(action),
      resetPosition: () => this.resetPosition(), restartAdapter: () => this.restartAdapterSafely(),
      characterAllowed: this.characters.isAvailable,
    })
    this.characterIpc = new CharacterIpcController({ registry: characters, settings: this.settingsWindow, pet: () => this.pet.window, lab: () => this.lab.window, devServerUrl: this.devServerUrl,
      select: value => this.selectCharacter(value), selected: () => this.unavailableSelection ?? this.settings.characterId })
  }

  async start(): Promise<void> {
    const loaded = await this.store.load(isCharacterId)
    this.settings = loaded.value
    setAppLanguage(this.settings.language)
    const selected = this.characters.get(this.settings.characterId)
    if (selected?.status === "pending") await this.characters.ensureReady(selected, value => this.startup?.progress(value)).catch(() => {})
    this.startup?.message("캐릭터를 화면에 준비하고 있어요.")
    if (!this.characters.isAvailable(this.settings.characterId)) { this.unavailableSelection = this.settings.characterId; this.settings.characterId = "gpichan"; this.warn("저장된 캐릭터를 사용할 수 없어 기본 캐릭터를 표시합니다. 원래 선택은 보존됩니다.") }
    if (loaded.warning) this.warn(loaded.warning)
    this.settings.bounds = this.recover(this.settings.bounds)
    denyAllPermissions(session.defaultSession)
    this.registerIpc()
    this.settingsIpc.register()
    this.updateIpc.register()
    void this.updates.start()
    this.characterIpc.register()
    this.sideChatIpc.register()
    this.sideChat.configure(this.settings.sideChatEnabled, this.settings.language)
    await this.sideChatSetup.load()
    let sideChatSelection = JSON.stringify(this.integration.sideChatSelection())
    this.subscriptions.push(this.integration.subscribe(() => {
      const selection = JSON.stringify(this.integration.sideChatSelection())
      if (selection !== sideChatSelection) { sideChatSelection = selection; this.sideChatSetup.invalidate() }
    }))
    this.activityIpc.register()
    this.bubbleIpc.register()
    this.taskControlIpc.register()
    this.subscriptions.push(this.taskControl.subscribe(() => { this.integration.notifyAdapterChanged(); this.sideChat.updateTask(this.sideChat.parentThreadId(), this.taskControl.observedChatTask(this.sideChat.parentThreadId()), Date.now()) }))
    this.taskControl.connectDesktop()
    this.subscriptions.push(this.activity.subscribe(value => { this.rebuildTray(); this.activityBubble.update(value) }))
    await this.activity.start()
    void this.codexApp.available().then(available => { if (!this.quitting) this.activity.setNavigation(available ? "app" : "none") })
    this.subscriptions.push(this.characters.subscribe(snapshot => {
      const active = snapshot.entries.find(e => e.id === this.settings.characterId)
      if (active && this.lastReady?.id === active.id && this.lastReady.revision !== active.revision) { this.sideChat.beginCharacterApply(); this.personaGeneration++ }
      this.pet.send(CHARACTER_IPC.changed, snapshot)
      this.settingsWindow.send(CHARACTER_IPC.changed, snapshot)
      if (this.lab.window && !this.lab.window.isDestroyed()) this.lab.window.webContents.send(CHARACTER_IPC.changed, snapshot)
      if (this.unavailableSelection && this.characters.isAvailable(this.unavailableSelection)) this.updateSettings({ characterId: this.unavailableSelection })
      this.rebuildTray()
    }))
    this.subscriptions.push(this.adapter.subscribe((status) => this.onAdapterStatus(status)))
    this.subscriptions.push(this.adapter.subscribeDiagnostics(() => { this.rebuildTray(); this.integration.notifyAdapterChanged() }))
    this.subscriptions.push(this.adapter.subscribeConversationKeys(keys => {
      this.activity.setConversationKeys(keys)
      this.activityTitles.setTargets(new Map([...keys].flatMap(key => { const target = this.adapter.conversationTarget(key); return target ? [[key, target] as const] : [] })))
    }))
    const packagedMac = app.isPackaged && process.platform === "darwin"
    if (packagedMac) app.setActivationPolicy("accessory")
    if (this.settings.adapterAutoStart) void this.adapter.start().catch((error) => this.warn(error instanceof Error ? error.message : String(error)))
    this.pet.create(this.settings)
    if (this.pet.window) this.activityBubble.attach(this.pet.window, this.settings)
    this.trayCreated = this.tray.create(this.settings, this.adapter.getStatus(), this.trayActions())
    if (!this.trayCreated) this.restoreResidentAccess()
    else if (!packagedMac && app.isPackaged && this.trayCreated) app.dock?.hide()
    if (packagedMac && this.trayCreated) {
      this.trayVisibilityTimer = setTimeout(() => {
        this.trayVisibilityTimer = null
        const forceOffscreen = __APP_QA__ && process.env.ELECTRON_SMOKE_TEST === "1" && process.env.ELECTRON_SMOKE_FORCE_TRAY_OFFSCREEN === "1"
        if (!forceOffscreen && this.tray.isVisibleOn(screen.getAllDisplays().map((display) => display.bounds))) return
        this.restoreResidentAccess()
        this.warn("macOS did not place the menu-bar item; Dock access restored. Right-click the character to open the menu.")
      }, 1_000)
      this.trayVisibilityTimer.unref()
    }
    screen.on("display-added", this.onDisplaysChanged)
    screen.on("display-removed", this.onDisplaysChanged)
    screen.on("display-metrics-changed", this.onDisplaysChanged)
    powerMonitor.on("resume", this.onResume)
    powerMonitor.on("shutdown", this.onSystemShutdown)
    this.pet.window?.on("query-session-end", this.onSystemShutdown)
    if (await this.integration.start()) this.settingsWindow.open()
    if (__SETUP_SMOKE__ && this.setupSmoke) void this.setupSmoke.run({
      settings: this.settingsWindow, integration: this.integration, pet: this.pet, adapter: this.adapter,
      getDesktopSettings: () => structuredClone(this.settings), quit: () => this.quit(),
    })
  }

  private restoreResidentAccess(): void {
    this.dockFallbackRestored = true
    if (process.platform === "darwin") app.setActivationPolicy("regular")
    const window = this.settingsWindow.open()
    window.setSkipTaskbar(false)
    this.warn("메뉴바·트레이를 표시하지 못해 설정 창에서 접근할 수 있도록 복구했습니다.")
  }
  activate(): void { this.showPet(); if (this.dockFallbackRestored) this.restoreResidentAccess() }
  showPet(): void {
    if (this.quitting || this.updatePreparing) return
    this.onDisplaysChanged()
    if (this.pet.window?.isMinimized()) this.pet.window.restore()
    this.updateSettings({ visible: true })
  }

  private onSystemShutdown = () => { this.osEnding = true; this.updates.dispose() }

  private async setUnsignedWindowsPolicy(enabled: boolean): Promise<boolean> {
    if (process.platform !== "win32" || this.quitting || this.updatePreparing) return false
    if (enabled && !this.settings.allowUnsignedWindowsUpdates) {
      const answer = await dialog.showMessageBox(this.settingsWindow.window!, { type: "warning", title: appText("서명 없는 Windows 업데이트 허용"),
        message: appText("발행자 서명을 확인하지 않은 설치 파일을 실행하도록 허용할까요?"),
        detail: appText("공식 GitHub 출처·HTTPS·버전·파일 해시는 확인하지만 발행자의 신원은 보증하지 않습니다. 배포 계정이 침해되면 악성 설치 파일이 실행될 수 있습니다. 다운로드와 설치·재시작은 계속 직접 승인해야 합니다. Windows 보안 설정은 바꾸지 않습니다."),
        buttons: [appText("취소"), appText("이 기기에서 허용")], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1 || this.quitting || this.updatePreparing) return false
    }
    const previous = this.settings.allowUnsignedWindowsUpdates
    this.settings.allowUnsignedWindowsUpdates = enabled
    try { await this.store.save(this.savedSettings()) } catch (error) { this.settings.allowUnsignedWindowsUpdates = previous; throw error }
    this.settingsIpc.broadcastSettings(this.settings)
    return true
  }

  private async confirmUpdateRestart(): Promise<boolean> {
    if (this.osEnding || this.quitting || (!this.characters.readyForUpdate() || this.readyWaiters.size > 0)) throw Error(this.osEnding ? "OS_SHUTDOWN" : "PACK_BUSY")
    const chat = this.sideChat.snapshot()
    const running = chat.phase === "answering" || chat.phase === "preparing"
    const answer = await dialog.showMessageBox({ type: "question", title: appText("업데이트 및 재시작"),
      message: appText(running ? "자식 응답을 중단하고 업데이트할까요?" : "업데이트를 적용하고 다시 시작할까요?"),
      detail: appText("임시 대화·초안·첨부는 재시작하면 사라집니다. 설정·캐릭터팩·위치는 보존됩니다. 부모 Codex 작업은 계속 실행됩니다.") + (process.platform === "darwin" ? "\n" + appText("승인 후 Mac이 업데이트를 준비하면 다음 앱 종료 때 적용될 수 있습니다.") : ""),
      buttons: [appText("취소"), appText(running ? "자식 중단 및 재시작" : "업데이트 및 재시작")], defaultId: 0, cancelId: 0 })
    if (answer.response !== 1) return false
    if (this.osEnding || (!this.characters.readyForUpdate() || this.readyWaiters.size > 0)) throw Error(this.osEnding ? "OS_SHUTDOWN" : "PACK_BUSY")
    this.updatePreparing = true; setApplicationInputLocked(true); this.rebuildTray()
    return true
  }

  private async prepareUpdateExit(): Promise<void> {
    if (this.osEnding) throw Error("OS_SHUTDOWN")
    if ((!this.characters.readyForUpdate() || this.readyWaiters.size > 0)) throw Error("PACK_BUSY")
    this.placementOpening?.abort(); this.activityBubble.cancelPlacement(); this.petDrag.cancel()
    if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = null
    try { await this.store.save(this.savedSettings()) } catch { throw Error("SAVE_FAILED") }
    await this.sideChat.stop()
    this.dictation.cancel()
    // Fail before destroying windows if owned resource cleanup cannot complete.
    await this.adapter.stop(true)
    if (this.osEnding) throw Error("OS_SHUTDOWN")
    await this.cleanupForExit()
  }

  async quit(): Promise<void> {
    if (this.updatePreparing && !this.osEnding) return
    this.quitPromise ??= this.cleanupForExit().then(() => { this.exitReady = true; app.quit() })
    await this.quitPromise
  }

  private async cleanupForExit(): Promise<void> {
    if (this.quitting) return
    this.placementOpening?.abort()
    this.activityBubble.cancelPlacement()
    this.petDrag.cancel()
    this.quitting = true
    setApplicationInputLocked(true)
    this.updates.dispose()
    this.chatEntry.cancel()
    this.startup?.close()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.trayVisibilityTimer) clearTimeout(this.trayVisibilityTimer)
    this.trayVisibilityTimer = null
    if (this.settingsPoll) clearInterval(this.settingsPoll)
    this.settingsPoll = null
    this.sideChatIpc.dispose()
    await this.sideChat.dispose()
    this.settingsWindow.destroy()
    this.activityWindow.destroy()
    this.activityBubble.destroy()
    this.activityIpc.dispose()
    this.bubbleIpc.dispose()
    this.taskControlIpc.dispose()
    this.settingsIpc.dispose()
    this.updateIpc.dispose()
    this.characterIpc.dispose()
    for (const waiter of this.readyWaiters) waiter.finish(new Error("PACK_CANCELLED"))
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    this.activityTitles.dispose()
    await this.activity.dispose()
    await this.integration.dispose()
    await Promise.allSettled([this.store.save(this.savedSettings()), this.adapter.stop(true), this.characters.dispose()])
    this.protocol.dispose()
    this.pet.destroy()
    this.lab.destroy()
    this.tray.destroy()
    screen.removeListener("display-added", this.onDisplaysChanged)
    screen.removeListener("display-removed", this.onDisplaysChanged)
    screen.removeListener("display-metrics-changed", this.onDisplaysChanged)
    powerMonitor.removeListener("resume", this.onResume)
    powerMonitor.removeListener("shutdown", this.onSystemShutdown)
  }

  private registerIpc(): void {
    const trustedPet = (event: IpcMainInvokeEvent | IpcMainEvent) => isTrustedSender(event, this.pet.window, "pet", this.devServerUrl)
    const trustedProtocol = (event: IpcMainInvokeEvent | IpcMainEvent) => isTrustedProtocolSender(event, this.pet.window, this.lab.window, this.devServerUrl)
    const requirePet = (event: IpcMainInvokeEvent | IpcMainEvent) => { if (!trustedPet(event)) throw new Error("untrusted IPC sender") }
    const requireKnown = (event: IpcMainInvokeEvent | IpcMainEvent) => { if (!trustedProtocol(event)) throw new Error("untrusted IPC sender") }

    ipcMain.handle(IPC.settingsGet, (event) => { requirePet(event); return structuredClone(this.settings) })
    ipcMain.handle(IPC.settingsPatch, (event, value: unknown) => {
      requirePet(event)
      const patch = validateDesktopSettingsPatch(value, this.characters.isAvailable)
      if (!patch) throw new Error("invalid desktop settings patch")
      return this.updateSettings(patch)
    })
    ipcMain.handle(IPC.layoutSet, (event, enabled: unknown) => { requirePet(event); if (typeof enabled !== "boolean") throw new Error("invalid layout state"); this.setLayoutMode(enabled) })
    ipcMain.handle(IPC.windowDrag, (event, value: unknown, ...extra) => { requirePet(event); if (extra.length || !validWindowDragRequest(value)) throw Error("invalid drag request"); return this.petDrag.request(value) })
    ipcMain.handle(IPC.resetPosition, (event) => { requirePet(event); this.resetPosition() })
    ipcMain.handle(IPC.mousePassthrough, (event, ignore: unknown) => { requirePet(event); if (typeof ignore !== "boolean") throw new Error("invalid passthrough state"); this.pet.setMousePassthrough(ignore) })
    ipcMain.on(IPC.interactionLock, (event, locked: unknown) => { if (trustedPet(event) && typeof locked === "boolean") this.pet.setInteractionLocked(locked) })
    ipcMain.on(IPC.petReady, (event, value: unknown) => {
      const info = validatePetReadyInfo(value)
      if (!trustedPet(event) || !info) return
      const requested = this.characters.get(this.settings.characterId)
      if (!requested || info.characterId !== requested.id || (info.revision ?? "builtin") !== requested.revision) return
      this.lastReady = { id: requested.id, revision: requested.revision }
      void this.refreshPersona(this.lastReady)
      for (const waiter of this.readyWaiters) if (waiter.selection.id === requested.id && waiter.selection.revision === requested.revision) waiter.finish()
      if (__APP_QA__ && process.env.ELECTRON_SMOKE_TEST === "1") this.smokeReadyCharacters.add(info.characterId)
      this.startup?.close()
      this.pet.reportReady()
      this.pet.send(IPC.adapterStatus, this.adapter.getStatus())
      if (__APP_QA__ && process.env.ELECTRON_SMOKE_TEST === "1") void this.finishSmoke(info.characterId)
    })
    ipcMain.on(IPC.alphaFailure, (event, value: unknown) => { if (trustedPet(event)) { const message = validateShortMessage(value); if (message) this.warn(`Alpha hit test: ${message}`) } })
    ipcMain.on(CHARACTER_IPC.loadFailed, (event, value: CharacterSelection) => { if (trustedPet(event) && value && typeof value.id === "string" && typeof value.revision === "string") void this.characterLoadFailed(value).catch(() => this.warn("캐릭터 복원에 실패했습니다.")) })
    ipcMain.handle(IPC.adapterRestart, async (event) => { requirePet(event); await this.restartAdapterSafely() })
    ipcMain.handle(IPC.adapterDiagnostics, (event) => { requirePet(event); this.adapter.requestDiagnostics(); return this.adapter.getDiagnostics() })
    ipcMain.handle(IPC.petReload, (event) => { requirePet(event); this.pet.reload() })
    ipcMain.handle(IPC.protocolConnect, async (event): Promise<ProtocolConnectResult> => {
      requireKnown(event)
      try {
        await this.protocol.connect(event.sender)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        }
      }
    })
    ipcMain.handle(IPC.protocolDisconnect, (event) => { requireKnown(event); this.protocol.disconnect(event.sender.id) })
    ipcMain.on(IPC.protocolSend, (event, command: unknown) => { if (!trustedProtocol(event)) return; try { this.protocol.send(event.sender.id, command) } catch (error) { this.warn(error instanceof Error ? error.message : String(error)) } })
  }

  private setLayoutMode(enabled: boolean): void {
    this.petDrag.cancel()
    this.activityBubble.setLayoutMode(enabled)
    this.pet.setLayoutMode(enabled)
  }

  private updateSettings(patch: DesktopSettingsPatch): DesktopSettingsV1 {
    if (!applicationInputAllowed()) return structuredClone(this.settings)
    if (patch.visible === false || patch.characterId !== undefined) { this.placementOpening?.abort(); this.activityBubble.cancelPlacement() }
    if (patch.visible === false || patch.scale !== undefined || patch.characterId !== undefined) this.petDrag.cancel()
    if (patch.visible === false || patch.sideChatEnabled === false) { this.chatEntry.cancel(); this.sideChat.setMode("hidden") }
    if (patch.characterId !== undefined) {
      if (!this.characters.isAvailable(patch.characterId)) throw new Error("PACK_UNAVAILABLE")
      this.unavailableSelection = null
    }
    if (patch.characterId !== undefined && patch.characterId !== this.settings.characterId) {
      this.activityBubble.presentation.begin(); this.sideChat.beginCharacterApply(); this.personaGeneration++
    }
    const previousScale = this.settings.scale, previousChatEnabled = this.settings.sideChatEnabled
    Object.assign(this.settings, patch)
    if (patch.language !== undefined) setAppLanguage(this.settings.language)
    this.sideChat.configure(this.settings.sideChatEnabled, this.settings.language)
    if (previousChatEnabled !== this.settings.sideChatEnabled) this.sideChatSetup.invalidate()
    if ((patch.language !== undefined || patch.sideChatEnabled === true) && this.lastReady) void this.refreshPersona(this.lastReady)
    if (patch.scale !== undefined && patch.scale !== previousScale) {
      const size = windowSizeForScale(patch.scale)
      const current = this.pet.window?.getBounds() ?? this.settings.bounds
      const centerX = current.x + current.width / 2
      const centerY = current.y + current.height / 2
      const next = this.recover({ ...current, x: Math.round(centerX - size / 2), y: Math.round(centerY - size / 2), width: size, height: size, displayId: this.settings.bounds.displayId })
      this.settings.bounds = next
      this.pet.setBounds(next)
    }
    this.pet.applySettings(this.settings)
    this.activityBubble.applySettings(this.settings)
    this.settingsIpc.broadcastSettings(this.settings)
    this.persistSoon()
    this.rebuildTray()
    return structuredClone(this.settings)
  }

  private captureBounds(bounds: Rectangle): void {
    if (this.petDrag.active) return
    const display = screen.getDisplayMatching(bounds)
    this.settings.bounds = { ...bounds, displayId: display.id }
    this.persistSoon()
  }

  private recover(bounds: DesktopSettingsV1["bounds"]): DesktopSettingsV1["bounds"] {
    const displays = screen.getAllDisplays() as unknown as DisplayLike[]
    return recoverWindowBounds(bounds, displays, screen.getPrimaryDisplay() as unknown as DisplayLike)
  }

  private resetPosition(): void {
    this.petDrag.cancel()
    this.settings.bounds = this.recover({ ...this.settings.bounds, x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER, displayId: null })
    this.pet.setBounds(this.settings.bounds)
    this.updateSettings({ visible: true })
  }

  private readonly onDisplaysChanged = () => {
    this.petDrag.cancel()
    const recovered = this.recover(this.pet.window?.getBounds() ? { ...this.pet.window.getBounds(), displayId: this.settings.bounds.displayId } : this.settings.bounds)
    this.settings.bounds = recovered
    this.pet.setBounds(recovered)
    this.activityBubble.sync()
    this.persistSoon()
  }

  private readonly onResume = () => {
    this.onDisplaysChanged()
    this.protocol.reconnectAll()
    this.activity.reconnect()
    this.adapter.requestDiagnostics()
    this.pet.setMousePassthrough(false)
  }

  private persistSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.store.save(this.savedSettings()).catch((error) => this.warn(String(error))) }, 350)
  }

  private savedSettings(): DesktopSettingsV1 { return { ...this.settings, characterId: this.unavailableSelection ?? this.settings.characterId } }
  private async refreshPersona(selection: CharacterSelection) {
    const requested = this.characters.get(this.settings.characterId)
    if (requested?.id !== selection.id || requested.revision !== selection.revision) return
    const generation = ++this.personaGeneration
    try {
      const binding = await this.personaResolver.resolve(selection, this.settings.language)
      if (generation === this.personaGeneration && this.lastReady?.id === binding.id && this.lastReady.revision === binding.revision) this.sideChat.applyPersona(binding)
    } catch { if (generation === this.personaGeneration) this.sideChat.personaFailed() }
  }
  private async openSideChat(key?: string, activityId?: string) {
    this.placementOpening?.abort(); this.activityBubble.cancelPlacement()
    const target = key ? this.adapter.conversationTarget(key) : null
    await this.chatEntry.open(target ? { threadId: target.threadId, activityId } : undefined, Boolean(activityId))
  }
  private placementOpening: AbortController | null = null
  private async editBubblePlacement(action: "adjust" | "auto" | "reset") {
    this.placementOpening?.abort()
    if (action !== "adjust") { this.activityBubble.cancelPlacement(); this.updateSettings({ bubblePlacement: automaticBubblePlacement() }); return }
    this.chatEntry.cancel()
    const opening = this.placementOpening = new AbortController()
    this.showPet()
    if (await this.pet.reveal(opening.signal) && !opening.signal.aborted && !this.quitting) this.activityBubble.beginPlacement()
    if (this.placementOpening === opening) this.placementOpening = null
  }
  private async refreshChatParents(query?: string, more = false) {
    if (!this.settings.sideChatEnabled || this.quitting) return
    const home = this.sideChatSetup.options().codexHome, epoch = this.sideChat.snapshot().epoch
    const page = this.sideChatPage
    page.query = query ?? page.query; page.offset = more ? page.offset + 64 : 0
    const generation = ++page.generation
    const catalog = await readDesktopThreadCatalogPage(home, { offset: page.offset, query: page.query }).catch(() => ({ items: [], hasMore: false }))
    if (!this.settings.sideChatEnabled || this.quitting || generation !== page.generation || epoch !== this.sideChat.snapshot().epoch) return
    const tasks = new Map<string, string>()
    for (const entry of this.activity.snapshot().entries.slice().sort((a, b) => b.lastObservedAt - a.lastObservedAt)) {
      const key = this.activity.conversationKey({ activityId: entry.activityId, revision: entry.revision })
      const target = key ? this.adapter.conversationTarget(key) : null
      if (target && !tasks.has(target.threadId)) tasks.set(target.threadId, entry.activityId)
    }
    const candidates: ChatParent[] = catalog.items.map(item => ({ threadId: item.id, title: item.title, cwd: item.cwd, sourceHome: home, activityId: tasks.get(item.id) }))
    this.sideChat.setCandidates(candidates)
    this.sideChat.setPreparation({ hasMoreParents: catalog.hasMore, parentQuery: page.query })
  }
  private async selectCharacter(selection: CharacterSelection): Promise<void> {
    this.petDrag.cancel()
    await this.characters.ensureReady(selection, value => this.settingsWindow.send(CHARACTER_IPC.progress, value))
    if (this.lastReady?.id === selection.id && this.lastReady.revision === selection.revision && this.settings.characterId === selection.id) { this.updateSettings({ characterId: selection.id }); return }
    await new Promise<void>((resolveReady, reject) => {
      const waiter = { selection, finish: (error?: Error) => { clearTimeout(timer); this.readyWaiters.delete(waiter); error ? reject(error) : resolveReady() } }
      const timer = setTimeout(() => { waiter.finish(new Error("PACK_LOAD")); void this.characterLoadFailed(selection) }, 45_000)
      this.readyWaiters.add(waiter)
      this.updateSettings({ characterId: selection.id })
    })
  }
  private async characterLoadFailed(selection: CharacterSelection) {
    const current = this.characters.get(this.settings.characterId)
    if (current?.id !== selection.id || current.revision !== selection.revision) return
    for (const waiter of this.readyWaiters) if (waiter.selection.id === selection.id && waiter.selection.revision === selection.revision) waiter.finish(new Error("PACK_LOAD"))
    this.personaGeneration++; this.sideChat.characterFailed()
    this.warn("새 캐릭터를 표시하지 못해 이전 정상 캐릭터로 돌아갑니다.")
    if (current.source === "external" && current.previousVersion && this.lastReady?.id === current.id && this.lastReady.revision !== current.revision) {
      await this.characters.rollback(selection)
    } else {
      const fallback = this.lastReady && this.characters.isAvailable(this.lastReady.id) && this.lastReady.id !== current.id ? this.lastReady.id : "gpichan"
      if (current.id !== fallback) this.updateSettings({ characterId: fallback })
    }
  }

  private onAdapterStatus(status: AdapterStatus): void {
    this.pet.send(IPC.adapterStatus, status)
    this.rebuildTray()
  }

  private warn(message: string): void {
    this.warnings.push(message.slice(0, 1_000))
    if (this.warnings.length > 20) this.warnings.shift()
    this.rebuildTray()
  }

  private trayActions(): TrayActions {
    return {
      inputLocked: () => this.updatePreparing || this.quitting,
      checkUpdates: () => { this.updateIpc.open(); void this.updates.act({ action: "check" }) },
      activity: () => this.activity.snapshot(),
      openSideChat: () => { void this.openSideChat() },
      openTaskControl: () => { this.updateSettings({ visible: true, taskBubblesEnabled: true }); this.activityBubble.setView("control", false) },
      openActivity: () => {
        this.activityWindow.open()
        void this.codexApp.available().then(available => { if (!this.quitting) this.activity.setNavigation(available ? "app" : "none") })
      },
      characters: () => this.characters.snapshot().entries,
      bubblePlacement: action => { void this.editBubblePlacement(action) },
      toggleVisible: () => this.updateSettings({ visible: !this.settings.visible }),
      setLayout: (enabled) => { if (enabled && !this.settings.visible) this.updateSettings({ visible: true }); this.setLayoutMode(enabled) },
      resetPosition: () => this.resetPosition(),
      updateSettings: (patch) => {
        if (patch.characterId) { const entry = this.characters.get(patch.characterId); if (entry) void this.selectCharacter(entry).catch(() => this.warn("캐릭터를 준비하지 못했습니다.")); return }
        const validated = validateDesktopSettingsPatch(patch, this.characters.isAvailable); if (validated) this.updateSettings(validated) },
      openMotionLab: () => this.lab.open(),
      openSettings: () => this.settingsWindow.open(),
      reloadPet: () => this.pet.reload(),
      restartAdapter: () => { void this.restartAdapterSafely() },
      diagnostics: () => ({ ...this.adapter.getDiagnostics(), warnings: [...this.adapter.getDiagnostics().warnings, ...this.warnings] }),
      quit: () => { void this.quit() },
    }
  }

  private rebuildTray(): void { if (this.settings) this.tray.update(this.settings, this.adapter.getStatus(), this.trayActions()) }

  private async restartAdapterSafely(): Promise<{ restarted: boolean }> {
    if (this.restartPending) return { restarted: false }
    this.restartPending = true
    try {
      const diagnostics = await this.adapter.requestFreshDiagnostics()
      if (!diagnostics || diagnostics.adapterOwnership === "EXTERNAL_PROCESS") return { restarted: false }
      if (diagnostics.activeRunCount > 0) {
        const choice = await dialog.showMessageBox({ type: "warning", title: appText("Adapter 재시작"), message: appText("진행 중인 작업의 Pet 표시가 끊길 수 있습니다."), detail: appText("Codex 작업은 강제로 취소하지 않습니다. 작업이 끝난 뒤 재시작할 수도 있습니다."), buttons: [appText("취소"), appText("재시작")], defaultId: 0, cancelId: 0 })
        if (choice.response !== 1) return { restarted: false }
      }
      await this.adapter.restart()
      this.protocol.reconnectAll()
      this.activity.reconnect()
      return { restarted: true }
    } finally { this.restartPending = false }
  }

  private async waitForAdapterDiagnostics(
    predicate: (value: SanitizedAdapterDiagnostics) => boolean,
    timeoutMs = 15_000,
  ): Promise<SanitizedAdapterDiagnostics> {
    const deadline = Date.now() + timeoutMs
    let value = this.adapter.getDiagnostics()
    while (Date.now() < deadline) {
      this.adapter.requestDiagnostics()
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      value = this.adapter.getDiagnostics()
      if (predicate(value)) return value
    }
    throw new Error(`Adapter diagnostics condition timed out: ${JSON.stringify({ state: value.state, activeRunCount: value.activeRunCount, provisionalRecoveredRunCount: value.provisionalRecoveredRunCount })}`)
  }

  private async runRecoverySmoke(): Promise<Record<string, unknown>> {
    if (__APP_QA__) {
    const initial = await this.waitForAdapterDiagnostics((value) => value.activeRunCount === 2 && value.provisionalRecoveredRunCount === 2)
    const utilityCrashTriggered = this.adapter.crashOwnedWorkerForSmokeTest()
    let restartStarted = false
    let utilityRestartObserved = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = this.adapter.getStatus().state
      if (state === "STARTING") restartStarted = true
      if (restartStarted && state === "READY") {
        utilityRestartObserved = true
        break
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    const afterCrash = await this.waitForAdapterDiagnostics((value) => value.activeRunCount === 2 && value.provisionalRecoveredRunCount === 2)
    const token = (await readFile(join(this.adapterConfig.dataDir, "adapter-token"), "utf8")).trim()
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const confirmationResponse = await fetch(this.adapterConfig.hookEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        payloadVersion: 1,
        hookEventName: "PostToolUse",
        sessionId: RECOVERY_SMOKE_SESSION_ID,
        turnId: RECOVERY_SMOKE_CONFIRMED_TURN_ID,
        model: "smoke-model",
        toolName: "Bash",
        toolUseId: "smoke-unknown-task",
      }),
    })
    const afterConfirmation = await this.waitForAdapterDiagnostics((value) => value.activeRunCount === 2 && value.provisionalRecoveredRunCount === 1)
    const afterExpiry = await this.waitForAdapterDiagnostics((value) => (
      value.activeRunCount === 1
      && value.provisionalRecoveredRunCount === 0
      && value.warnings.some((warning) => warning.includes("recovery-not-confirmed"))
    ), 20_000)
    const interruptResponse = await fetch(this.adapterConfig.hookEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        payloadVersion: 1,
        hookEventName: "Interrupt",
        sessionId: RECOVERY_SMOKE_SESSION_ID,
        turnId: RECOVERY_SMOKE_CONFIRMED_TURN_ID,
        model: "smoke-model",
        permissionMode: "default",
      }),
    })
    const final = await this.waitForAdapterDiagnostics((value) => value.activeRunCount === 0 && value.provisionalRecoveredRunCount === 0)
    const diagnosticText = JSON.stringify(final.warnings)
    return {
      productionRecoveryTtlMs: 120_000,
      recentRunsRestoredProvisionally: initial.activeRunCount === 2 && initial.provisionalRecoveredRunCount === 2,
      utilityCrashTriggered,
      utilityRestartObserved,
      runsRestoredProvisionallyAfterCrash: afterCrash.activeRunCount === 2 && afterCrash.provisionalRecoveredRunCount === 2,
      unknownChildCompletionAccepted: confirmationResponse.status === 202,
      unknownChildCompletionConfirmedRun: afterConfirmation.activeRunCount === 2 && afterConfirmation.provisionalRecoveredRunCount === 1,
      unconfirmedRunExpired: afterExpiry.activeRunCount === 1 && afterExpiry.provisionalRecoveredRunCount === 0,
      cancelReason: afterExpiry.warnings.some((warning) => warning.includes("recovery-not-confirmed")) ? "recovery-not-confirmed" : null,
      confirmedRunUsesNormalStaleTtl: afterExpiry.activeRunCount === 1,
      confirmedRunInterruptAccepted: interruptResponse.status === 202,
      finalActiveRunCount: final.activeRunCount,
      rawIdsInWarnings: diagnosticText.includes(RECOVERY_SMOKE_SESSION_ID) || diagnosticText.includes(RECOVERY_SMOKE_CONFIRMED_TURN_ID),
    }
  }

    return {}
  }

  private async finishSmoke(characterId: string): Promise<void> {
    if (__APP_QA__) {
    const { runSideChatPackSmoke } = await import("./SideChatPackSmoke")
    const { runHybridBubbleSmoke } = await import("./HybridBubbleSmoke")
    const { runDialogueSmoke } = await import("./DialogueSmoke")
    const { runTaskControlSmoke } = await import("./TaskControlSmoke")
    const { runDesktopControlSmoke } = await import("./DesktopControlSmoke")
    const { runActivitySmoke, runActivityRestoreSmoke } = await import("./ActivitySmoke")
    const { runRestartDetectionSmoke } = await import("./RestartDetectionSmoke")
    const { runResultOpenSmoke } = await import("./ResultOpenSmoke")
    if (this.smokeFinishing) return
    this.smokeFinishing = true
    for (let attempt = 0; attempt < 150; attempt++) {
      const protocol = this.protocol.getDiagnostics()
      const adapterState = this.adapter.getStatus().state
      if ((adapterState === "READY" || adapterState === "EXTERNAL_RUNNING") && protocol.openClientCount >= 1 && protocol.sources.includes("codex-adapter") && protocol.snapshotCount >= 1) break
      if (attempt % 10 === 0) this.adapter.requestDiagnostics()
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    if (process.env.ELECTRON_SMOKE_ACTIVITY_PHASE === "restore" && process.env.ELECTRON_SMOKE_ACTIVITY_EVIDENCE && process.env.ELECTRON_SMOKE_RESULT) {
      try {
        const result = await runActivityRestoreSmoke(this.activity, this.activityWindow, process.env.ELECTRON_SMOKE_ACTIVITY_EVIDENCE)
        await writeFile(resolve(process.env.ELECTRON_SMOKE_RESULT), JSON.stringify(result) + "\n")
      } catch {
        await writeFile(resolve(process.env.ELECTRON_SMOKE_RESULT), JSON.stringify({ restored: false }) + "\n")
      }
      await this.quit()
      return
    }
    let recoveryValidation: Record<string, unknown> | null = null
    if (process.env.ELECTRON_SMOKE_RECOVERY === "1") {
      try {
        recoveryValidation = await this.runRecoverySmoke()
      } catch (error) {
        this.warn(`Recovery smoke: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const path = process.env.ELECTRON_SMOKE_RESULT
    const win = this.pet.window
    const bellEvidenceDirectory = process.env.ELECTRON_SMOKE_BELL_EVIDENCE
    const bellEvidenceCapture = { idle: false, writing: false, interrupted: false, memoCheck: false }
    const captureCanvas = async (target: Electron.BrowserWindow, filename: string) => {
      if (!bellEvidenceDirectory || target.isDestroyed()) return false
      const dataUrl = await target.webContents.executeJavaScript(`document.querySelector('canvas[aria-label="Anime2.5DRig WebGL canvas"], canvas')?.toDataURL('image/png') ?? null`)
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) return false
      await mkdir(resolve(bellEvidenceDirectory), { recursive: true })
      await writeFile(resolve(bellEvidenceDirectory, filename), Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"))
      return true
    }
    let motionLabProtocolReady = false
    let petConnectionSurvivedLabClose = false
    try {
      const lab = this.lab.open()
      if (lab.webContents.isLoadingMainFrame()) {
        await new Promise<void>((resolveLoad, rejectLoad) => {
          const timer = setTimeout(() => rejectLoad(new Error("Motion Lab load timed out")), 15_000)
          lab.webContents.once("did-finish-load", () => { clearTimeout(timer); resolveLoad() })
        })
      }
      motionLabProtocolReady = await lab.webContents.executeJavaScript(`(async () => {
        const waitFor = async (check, timeout = 15000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            const value = check();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Motion Lab protocol UI timed out');
        };
        const select = await waitFor(() => [...document.querySelectorAll('select')].find(node => [...node.options].some(option => option.value === 'CODEX_ADAPTER')));
        select.value = 'CODEX_ADAPTER';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const button = await waitFor(() => document.querySelector('[data-testid="protocol-connect"]'));
        button.click();
        await waitFor(() => document.querySelector('[data-testid="protocol-connection"] dd')?.textContent === 'READY');
        return true;
      })()`)
      if (bellEvidenceDirectory && characterId === "bell") {
        await lab.webContents.executeJavaScript(`(async () => {
          const waitFor = async (check, timeout = 15000) => {
            const started = Date.now();
            while (Date.now() - started < timeout) {
              const value = check();
              if (value) return value;
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Memo Check evidence timed out');
          };
          document.querySelector('[data-testid="behavior-manual"]')?.click();
          const select = await waitFor(() => document.querySelector('[data-testid="pose-selector"]:not([disabled])'));
          select.value = 'memo-check';
          select.dispatchEvent(new Event('change', { bubbles: true }));
          document.querySelector('[data-testid="pose-load"]')?.click();
          await waitFor(() => document.querySelector('[data-testid="pose-load-status"] dd')?.textContent === 'ready');
          document.querySelector('[data-testid="pose-enter"]')?.click();
          await waitFor(() => document.querySelector('[data-testid="pose-state"] dd')?.textContent === 'ACTIVE_LOOP');
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return true;
        })()`)
        bellEvidenceCapture.memoCheck = await captureCanvas(lab, "bell-memo-check.png")
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      const twoClients = this.protocol.openClientCount >= 2
      this.lab.destroy()
      for (let attempt = 0; attempt < 30 && this.protocol.openClientCount !== 1; attempt++) await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      petConnectionSurvivedLabClose = twoClients && this.protocol.openClientCount === 1
    } catch (error) {
      this.warn(`Motion Lab smoke: ${error instanceof Error ? error.message : String(error)}`)
      this.lab.destroy()
    }
    if (win && !win.isDestroyed() && bellEvidenceDirectory && characterId === "bell") {
      bellEvidenceCapture.idle = await captureCanvas(win, "bell-idle.png")
      const tokenPath = join(this.adapterConfig.dataDir, "adapter-token")
      if (existsSync(tokenPath)) {
        const token = (await readFile(tokenPath, "utf8")).trim()
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
        const common = { payloadVersion: 1, sessionId: "bell-evidence-session", turnId: "bell-evidence-turn", model: "smoke-model", permissionMode: "default" }
        const started = await fetch(this.adapterConfig.hookEndpoint, { method: "POST", headers, body: JSON.stringify({ ...common, hookEventName: "UserPromptSubmit" }) })
        if (started.status === 202) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
          bellEvidenceCapture.writing = await captureCanvas(win, "bell-writing.png")
          const interrupted = await fetch(this.adapterConfig.hookEndpoint, { method: "POST", headers, body: JSON.stringify({ ...common, hookEventName: "Interrupt" }) })
          if (interrupted.status === 202) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
            bellEvidenceCapture.interrupted = await captureCanvas(win, "bell-interrupted.png")
          }
        }
      }
    }
    let characterReloadCount = 0
    const characterReloadFailures: string[] = []
    const characterSelections: Array<{ id: string; ready: boolean }> = []
    let retiredCharactersRejected = false
    if (win && !win.isDestroyed()) {
      retiredCharactersRejected = await win.webContents.executeJavaScript(`(async () => {
        for (const characterId of ['bell', 'momo', 'longhair', 'asuma-toki', 'asuma-toki-v2']) {
          try { await window.petDesktop.updateSettings({ characterId }); return false } catch {}
        }
        return (await window.petDesktop.getSettings()).characterId === 'gpichan'
      })()`)
      for (const id of ["gpichan"] as const) {
        // Selecting the already active single built-in does not reload the model.
        if (id !== characterId) this.smokeReadyCharacters.delete(id)
        await win.webContents.executeJavaScript(`window.petDesktop.updateSettings(${JSON.stringify({ characterId: id })})`)
        for (let attempt = 0; attempt < 300 && !this.smokeReadyCharacters.has(id); attempt++) await new Promise((resolveWait) => setTimeout(resolveWait, 50))
        characterSelections.push({ id, ready: this.smokeReadyCharacters.has(id) })
        if (bellEvidenceDirectory && this.smokeReadyCharacters.has(id)) await captureCanvas(win, `${id}-selected.png`)
      }
      for (let cycle = 0; cycle < 3; cycle++) {
        this.smokeReadyCharacters.delete("gpichan")
        win.webContents.reload()
        for (let attempt = 0; attempt < 150 && !this.smokeReadyCharacters.has("gpichan"); attempt++) await new Promise((resolveWait) => setTimeout(resolveWait, 50))
        if (!this.smokeReadyCharacters.has("gpichan")) {
          characterReloadFailures.push(`reload-${cycle + 1}`)
          break
        }
        characterReloadCount++
      }
    }
    let alphaClickThrough = { transparentPasses: false, opaqueInteractive: false, transparentRelease: false, captureLossUnlock: false, layoutLock: false }
    let visibilitySync = { closeHidden: false, settingFalse: false, persistedFalse: false, petHiddenBeforeActivate: false, dockActivateShowedPet: false, visiblePersistedTrue: false }
    if (win && !win.isDestroyed()) {
      await win.webContents.executeJavaScript(`(async () => {
        const canvas = document.querySelector('canvas');
        const move = (x, y) => canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
        move(1, 1); await new Promise(resolve => setTimeout(resolve, 45)); move(1, 1); await new Promise(resolve => setTimeout(resolve, 45));
      })()`)
      const transparentPasses = this.pet.getMousePolicy().effective
      await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('canvas').dispatchEvent(new PointerEvent('pointermove', { clientX: innerWidth / 2, clientY: innerHeight / 2 }));
        await new Promise(resolve => setTimeout(resolve, 45));
      })()`)
      const opaqueInteractive = !this.pet.getMousePolicy().effective
      await win.webContents.executeJavaScript(`(async () => {
        const canvas = document.querySelector('canvas');
        const setPointerCapture = canvas.setPointerCapture;
        const releasePointerCapture = canvas.releasePointerCapture;
        canvas.setPointerCapture = () => {};
        canvas.releasePointerCapture = () => {};
        try {
          canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 91, clientX: innerWidth / 2, clientY: innerHeight / 2 }));
          canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 91, clientX: 1, clientY: 1 }));
        } finally {
          canvas.setPointerCapture = setPointerCapture;
          canvas.releasePointerCapture = releasePointerCapture;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      })()`)
      const transparentRelease = this.pet.getMousePolicy().effective && !this.pet.getMousePolicy().interactionLocked
      await win.webContents.executeJavaScript(`(async () => {
        const canvas = document.querySelector('canvas');
        const setPointerCapture = canvas.setPointerCapture;
        canvas.setPointerCapture = () => {};
        try {
          canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 92, clientX: innerWidth / 2, clientY: innerHeight / 2 }));
          canvas.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 92 }));
        } finally {
          canvas.setPointerCapture = setPointerCapture;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      })()`)
      const captureLossUnlock = !this.pet.getMousePolicy().effective && !this.pet.getMousePolicy().interactionLocked
      this.setLayoutMode(true)
      const layoutLock = !this.pet.getMousePolicy().effective
      this.setLayoutMode(false)
      alphaClickThrough = { transparentPasses, opaqueInteractive, transparentRelease, captureLossUnlock, layoutLock }
      win.close()
      await new Promise((resolveWait) => setTimeout(resolveWait, 450))
      const persistedAfterClose = await this.store.load()
      const closeHidden = !win.isVisible()
      const settingFalse = !this.settings.visible
      const persistedFalse = !persistedAfterClose.value.visible
      app.emit("activate")
      await new Promise((resolveWait) => setTimeout(resolveWait, 450))
      let persistedAfterActivate = await this.store.load()
      // Native move/activation callbacks may restart the 350 ms save debounce.
      // Await the persisted condition instead of racing a fixed 450 ms delay.
      for (let n = 0; n < 20 && !persistedAfterActivate.value.visible; n++) {
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
        persistedAfterActivate = await this.store.load()
      }
      const dockActivateShowedPet = this.settings.visible && win.isVisible()
      visibilitySync = { closeHidden, settingFalse, persistedFalse, petHiddenBeforeActivate: closeHidden, dockActivateShowedPet, visiblePersistedTrue: persistedAfterActivate.value.visible }
    }
    let dialogueValidation: Record<string, unknown> | null = null
    if (win && !win.isDestroyed() && process.env.ELECTRON_SMOKE_DIALOGUE_EVIDENCE) {
      try {
        dialogueValidation = await runDialogueSmoke({
          window: win,
          speechWindow: () => this.activityBubble.speech.window,
          evidenceDirectory: process.env.ELECTRON_SMOKE_DIALOGUE_EVIDENCE,
          dataDirectory: this.adapterConfig.dataDir,
          hookEndpoint: this.adapterConfig.hookEndpoint,
          updateSettings: (patch) => { this.updateSettings(patch) },
          selectCharacter: async (id) => {
            this.smokeReadyCharacters.delete(id)
            this.updateSettings({ characterId: id })
            win.webContents.reload()
            for (let attempt = 0; attempt < 150 && !this.smokeReadyCharacters.has(id); attempt++) await new Promise((resolveWait) => setTimeout(resolveWait, 40))
            if (!this.smokeReadyCharacters.has(id)) throw new Error("Dialogue character load timed out")
          },
          setLayout: (enabled) => this.setLayoutMode(enabled),
          getMousePassthrough: () => this.pet.getMousePolicy().effective,
          loadSettings: async () => (await this.store.load()).value,
        })
      } catch (error) {
        this.warn(error instanceof Error && error.message.startsWith("Dialogue ") ? error.message : "Dialogue packaged smoke failed.")
      }
    }
    let activityValidation: Awaited<ReturnType<typeof runActivitySmoke>> | null = null
    if (win && !win.isDestroyed() && process.env.ELECTRON_SMOKE_ACTIVITY_EVIDENCE) {
      try {
        const reload = async () => {
          this.smokeReadyCharacters.delete(this.settings.characterId)
          win.webContents.reload()
          for (let attempt = 0; attempt < 400 && !this.smokeReadyCharacters.has(this.settings.characterId); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
          if (!this.smokeReadyCharacters.has(this.settings.characterId)) throw new Error("Activity renderer reload timed out")
        }
        activityValidation = await runActivitySmoke({
          activity: this.activity, window: this.activityWindow, bubble: this.activityBubble, pet: win,
          evidenceDirectory: process.env.ELECTRON_SMOKE_ACTIVITY_EVIDENCE, userData: app.getPath("userData"),
          dataDirectory: this.adapterConfig.dataDir, hookEndpoint: this.adapterConfig.hookEndpoint,
          updateSettings: patch => { this.updateSettings(patch) },
          selectCharacter: async id => {
            this.smokeReadyCharacters.delete(id)
            this.updateSettings({ characterId: id })
            for (let attempt = 0; attempt < 400 && !this.smokeReadyCharacters.has(id); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
            if (!this.smokeReadyCharacters.has(id)) throw new Error("Activity character change timed out")
          },
          reloadPet: reload, bridgeClients: () => this.protocol.openClientCount,
          showMenu: () => { if (this.activityWindow.window) this.tray.popup(this.activityWindow.window) },
          stopAdapter: () => this.adapter.stop(true), startAdapter: async () => { await this.adapter.start() },
          verifyRestart: process.env.ELECTRON_SMOKE_RESTART_EVIDENCE ? () => runRestartDetectionSmoke({
            activity: this.activity, bubble: this.activityBubble, list: this.activityWindow, pet: win, launcher: this.threadLauncher,
            home: process.env.CODEX_HOME!, dataDir: this.adapterConfig.dataDir, hookEndpoint: this.adapterConfig.hookEndpoint,
            evidenceDirectory: process.env.ELECTRON_SMOKE_RESTART_EVIDENCE!,
            reloadPet: reload,
          }) : undefined,
          verifyResultOpen: process.env.ELECTRON_SMOKE_RESULT_OPEN_EVIDENCE ? () => runResultOpenSmoke({
            activity: this.activity, bubble: this.activityBubble, list: this.activityWindow, launcher: this.threadLauncher,
            home: process.env.CODEX_HOME!, evidenceDirectory: process.env.ELECTRON_SMOKE_RESULT_OPEN_EVIDENCE!,
          }) : undefined,
        })
      } catch (error) { this.warn(error instanceof Error && /^(Activity |Restart smoke|Result open smoke)/.test(error.message) ? error.message : "Activity packaged smoke failed.") }
    }
    let hybridValidation: Awaited<ReturnType<typeof runHybridBubbleSmoke>> | null = null
    if (win && !win.isDestroyed() && process.env.ELECTRON_SMOKE_HYBRID_EVIDENCE) {
      try {
        const reload = async () => {
          this.smokeReadyCharacters.delete(this.settings.characterId)
          win.webContents.reload()
          for (let attempt = 0; attempt < 400 && !this.smokeReadyCharacters.has(this.settings.characterId); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
          if (!this.smokeReadyCharacters.has(this.settings.characterId)) throw new Error("Hybrid smoke: renderer reload timed out")
        }
        hybridValidation = await runHybridBubbleSmoke({
          pet: win, bubble: this.activityBubble, list: this.activityWindow, activity: this.activity, dictation: this.dictation,
          evidenceDirectory: process.env.ELECTRON_SMOKE_HYBRID_EVIDENCE, dataDirectory: this.adapterConfig.dataDir, hookEndpoint: this.adapterConfig.hookEndpoint,
          updateSettings: patch => { this.updateSettings(patch) }, setLayout: value => this.setLayoutMode(value), reloadPet: reload,
          selectCharacter: async id => {
            if (id === this.settings.characterId) return
            this.smokeReadyCharacters.delete(id)
            this.updateSettings({ characterId: id })
            for (let attempt = 0; attempt < 400 && !this.smokeReadyCharacters.has(id); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
            if (!this.smokeReadyCharacters.has(id)) throw new Error("Hybrid smoke: character change timed out")
          },
        })
      } catch (error) { this.warn(error instanceof Error && error.message.startsWith("Hybrid smoke") ? error.message : "Hybrid smoke failed") }
    }
    let desktopControlValidation: Awaited<ReturnType<typeof runDesktopControlSmoke>> | null = null
    if (process.env.ELECTRON_SMOKE_DESKTOP_CONTROL_EVIDENCE) {
      try { desktopControlValidation = await runDesktopControlSmoke({ bubble: this.activityBubble, control: this.taskControl, home: process.env.CODEX_HOME!, evidenceDirectory: process.env.ELECTRON_SMOKE_DESKTOP_CONTROL_EVIDENCE }) }
      catch (error) { this.warn(error instanceof Error && error.message.startsWith("Desktop control smoke") ? error.message : "Desktop control smoke failed") }
    }
    let taskControlValidation: Awaited<ReturnType<typeof runTaskControlSmoke>> | null = null
    if (process.env.ELECTRON_SMOKE_TASK_CONTROL_EVIDENCE) {
      try { taskControlValidation = await runTaskControlSmoke({ bubble: this.activityBubble, control: this.taskControl, dictation: this.dictation, launcher: this.threadLauncher, evidenceDirectory: process.env.ELECTRON_SMOKE_TASK_CONTROL_EVIDENCE }) }
      catch (error) { this.warn(error instanceof Error ? error.message : "Task control packaged smoke failed") }
    }
    let sideChatPackValidation: Awaited<ReturnType<typeof runSideChatPackSmoke>> | null = null
    if (process.env.ELECTRON_SMOKE_SIDE_CHAT_PACKS && win) {
      try { sideChatPackValidation = await runSideChatPackSmoke({ registry: this.characters, service: this.sideChat, resolver: this.personaResolver, pet: win, select: value => this.selectCharacter(value), output: process.env.ELECTRON_SMOKE_SIDE_CHAT_PACKS }) }
      catch { this.warn("Side chat pack switch smoke failed") }
    }
    const adapterDiagnostics = this.adapter.getDiagnostics()
    const protocolDiagnostics = this.protocol.getDiagnostics()
    const result = {
      appReady: app.isReady(),
      customProtocolHandled: win?.webContents.getURL().startsWith(this.devServerUrl ? "http://127.0.0.1:4173/" : "pet://app/") ?? false,
      petWindowCreated: Boolean(win && !win.isDestroyed()),
      secureWebPreferences: win ? (win.webContents as typeof win.webContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences() : null,
      preloadLoaded: true,
      webgl: true,
      characterId,
      characterReloadCount,
      characterReloadFailures,
      characterSelections,
      retiredCharactersRejected,
      alphaClickThrough,
      visibilitySync,
      packaged: app.isPackaged,
      appName: app.getName(),
      userData: app.getPath("userData"),
      adapterDataDir: this.adapterConfig.dataDir,
      availableCharacters: this.characters.snapshot().entries.map(({ id, source }) => ({ id, source })),
      packagedResourcesPresent: !app.isPackaged || existsSync(join(process.resourcesPath, "codex", "codex-adapter-worker.cjs")) && existsSync(join(process.resourcesPath, "codex", "hook-forwarder.mjs")),
      adapterSupervisorState: this.adapter.getStatus().state,
      adapterOwnership: adapterDiagnostics.adapterOwnership,
      adapterProtocolEndpoint: this.adapterConfig.protocolEndpoint,
      adapterHookEndpoint: this.adapterConfig.hookEndpoint,
      externalAdapterReused: adapterDiagnostics.adapterOwnership === "EXTERNAL_PROCESS",
      protocolBridgeClients: this.protocol.clientCount,
      protocolConnectionState: protocolDiagnostics.sources.includes("codex-adapter") && protocolDiagnostics.snapshotCount >= 1 ? "READY" : protocolDiagnostics.openClientCount ? "OPEN" : "CLOSED",
      protocolSource: protocolDiagnostics.sources[0] ?? null,
      protocolSnapshotCount: protocolDiagnostics.snapshotCount,
      motionLabProtocolReady,
      petConnectionSurvivedLabClose,
      bellEvidenceCapture: bellEvidenceDirectory ? bellEvidenceCapture : null,
      trayCreated: this.trayCreated,
      trayOffscreenDetected: this.dockFallbackRestored,
      dockPolicyRestored: this.dockFallbackRestored,
      petHiddenBeforeActivate: visibilitySync.petHiddenBeforeActivate,
      dockActivateShowedPet: visibilitySync.dockActivateShowedPet,
      visibleSetting: this.settings.visible,
      language: this.settings.language,
      trayLabel: appText(this.settings.visible ? "캐릭터 숨기기" : "캐릭터 표시"),
      recoveryValidation,
      dialogueValidation,
      hybridValidation,
      activityValidation,
      taskControlValidation,
      desktopControlValidation,
      sideChatPackValidation,
      settingsPath: "userData/desktop-settings.json",
      warnings: this.warnings,
      rendererProcessGone: false,
    }
    if (path) await writeFile(resolve(path), `${JSON.stringify(result, null, 2)}\n`, "utf8")
    process.stdout.write(`ELECTRON_SMOKE_RESULT ${process.env.ELECTRON_SMOKE_DIALOGUE_EVIDENCE || process.env.ELECTRON_SMOKE_HYBRID_EVIDENCE ? "bubble validation recorded" : JSON.stringify(result)}\n`)
    await this.quit()
    }
  }
}
