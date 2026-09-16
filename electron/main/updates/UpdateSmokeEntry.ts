// Standalone QA entry. Never imported by main.ts or included in a release candidate.
declare const __APP_QA__: boolean
import { app, autoUpdater, dialog } from "electron"
import { MacUpdater, NsisUpdater } from "electron-updater"
import { readFile, writeFile, mkdir, unlink, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { release, homedir } from "node:os"
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs"
import { AppController } from "../AppController"
import { CharacterRegistry } from "../CharacterRegistry"
import { createPackValidator } from "../CharacterPackWorker"
import { configureDesktopIdentity } from "../DesktopIdentity"
import { installAppProtocol, registerAppScheme } from "../AppProtocol"
import { prepareDesktopAdapterPorts } from "../DesktopAdapterConfig"
import { OfficialUpdateEngine } from "./OfficialUpdater"
import { validateRelease } from "./ReleasePolicy"
import type { UpdateService } from "./UpdateService"
import { applicationInputAllowed } from "./OperationGate"
if (!__APP_QA__) throw Error("UPDATE_SMOKE_ONLY")
registerAppScheme(); app.enableSandbox()
let controller: AppController | null = null
void (async () => {
  const config = JSON.parse(readFileSync(join(process.resourcesPath, "update-smoke.json"), "utf8"))
  const handoffCase = process.argv.find(value => value.startsWith("--update-handoff-case="))?.split("=")[1]
  const recoveryCheck = process.argv.includes("--update-recovery-check")
  if (handoffCase) {
    if (!config.handoffFailures || !["cleanup-before", "cleanup-after", "install-throw", "install-event"].includes(handoffCase)) throw Error("UPDATE_SMOKE_ONLY")
    const originalProfile = config.profile
    config.output = join(config.output, "handoff-" + handoffCase)
    config.profile = join(config.output, "profile")
    config.cacheName += "-handoff-" + handoffCase
    config.failures = false
    mkdirSync(config.profile, { recursive: true })
    for (const file of ["desktop-settings.json", "side-chat.json"]) if (!existsSync(join(config.profile, file))) copyFileSync(join(originalProfile, file), join(config.profile, file))
  }
  const feed = new URL(config.feed)
  if (feed.protocol !== "http:" || feed.hostname !== "127.0.0.1" || !config.profile || !config.output) throw Error("UPDATE_SMOKE_ONLY")
  process.env.DAEMONLET_DATA_HOME = config.profile
  process.env.CODEX_PET_PROTOCOL_PORT = String(config.protocolPort)
  process.env.CODEX_PET_HOOK_PORT = String(config.hookPort)
  configureDesktopIdentity(app)
  if (!app.requestSingleInstanceLock()) return app.quit()
  app.on("window-all-closed", () => {})
  app.on("before-quit", event => { if (controller && !controller.canExit) { event.preventDefault(); void controller.quit() } })
  await app.whenReady(); if (process.platform === "darwin") app.setActivationPolicy("accessory")
  await prepareDesktopAdapterPorts()
  await mkdir(config.profile, { recursive: true })
  const dataRoot = join(app.getAppPath(), "dist")
  const characters = new CharacterRegistry(config.profile, join(dataRoot, "characters"), createPackValidator(join(__dirname, "character-pack-worker.cjs")))
  await characters.initialize({ deferRig: true })
  if (config.pack && !characters.snapshot().entries.some(entry => entry.source === "external")) {
    const preview = await characters.prepareImport(config.pack, "isolated-update-review")
    const entry = await characters.commitImport(preview.token, "isolated-update-review")
    const settingsFile = join(config.profile, "desktop-settings.json")
    const settings = JSON.parse(await readFile(settingsFile, "utf8")); settings.characterId = entry.id
    await writeFile(settingsFile, JSON.stringify(settings))
  }
  installAppProtocol(dataRoot, undefined, characters)
  let nativeDownloads = 0; autoUpdater.on("update-downloaded", () => { nativeDownloads++ })
  const mac = process.platform === "darwin"
  const cacheBase = mac ? join(homedir(), "Library", "Caches") : process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  const Updater = mac ? MacUpdater : NsisUpdater
  const updater = new Updater({ provider: "generic", url: feed.href })
  if (handoffCase) {
    const providerConfig = join(config.output, "provider.yml")
    await writeFile(providerConfig, JSON.stringify({ provider: "generic", url: feed.href, updaterCacheDirName: config.cacheName }))
    updater.updateConfigPath = providerConfig
  }
  const unsignedAllowed = () => Boolean((controller as unknown as { settings?: { allowUnsignedWindowsUpdates?: boolean } } | null)?.settings?.allowUnsignedWindowsUpdates)
  const engine = new OfficialUpdateEngine(updater, join(cacheBase, config.cacheName), unsignedAllowed)
  // Failure injection is confined to this excluded QA entry. Real controller
  // cleanup/recovery runs; the OS installation operation is replaced explicitly.
  let providerChecks = 0, confirming = false
  const check = engine.check.bind(engine)
  engine.check = async () => { providerChecks++; return check() }
  const nativeDialog = dialog.showMessageBox.bind(dialog)
  dialog.showMessageBox = (async (...args: unknown[]) => {
    const options = args.at(-1) as Electron.MessageBoxOptions
    if (confirming && options.type === "question") return { response: 1, checkboxChecked: false }
    if (handoffCase && options.type === "error") {
      const owner = controller as any
      if (handoffCase === "cleanup-before" || owner.updates.snapshot().phase !== "error" || !owner.quitting || owner.canExit || owner.settingsWindow.window !== null) throw Error("Incorrect destructive-cleanup recovery")
      writeFileSync(join(config.output, "handoff-result.json"), JSON.stringify({
        case: handoffCase, status: "PASS", actualAppControllerCleanup: true,
        actualNativeInstallation: false, nativeDialogSubstituted: true,
        state: owner.updates.snapshot(), settingsDestroyed: owner.settingsWindow.window === null,
        quitting: owner.quitting, inputLocked: !applicationInputAllowed(), canExitWhileNoticeOpen: owner.canExit,
        recoveryRecord: JSON.parse(readFileSync(join(config.profile, "update-attempt.json"), "utf8")),
        actualModelCalls: 0,
      }, null, 2))
      return { response: 0, checkboxChecked: false }
    }
    return (nativeDialog as (...args: unknown[]) => Promise<Electron.MessageBoxReturnValue>)(...args)
  }) as typeof dialog.showMessageBox
  updater.on("error", error => writeFileSync(join(config.output, "engine-error.json"), JSON.stringify({ message: error.message, stack: error.stack })))
  const target = { platform: process.platform, arch: process.arch, osVersion: release(), kind: mac ? "mac" as const : "nsis" as const, automatic: true }
  controller = new AppController(__dirname, characters, undefined, undefined, {
    engine: () => engine, ...(mac || handoffCase ? { platform: async () => target } : {}), fetchLatest: undefined, autoCheck: () => Boolean(handoffCase && recoveryCheck),
    confirmInstall: async () => {
      await writeFile(join(config.output, "test-consent.json"), JSON.stringify({ userAuthorizedIsolatedUpdateTest: true, unsignedWindowsFixtureConsent: config.unsignedWindows === true, productionDialogBypassedOnlyInQa: true }))
      confirming = true
      try { return await (controller as any).confirmUpdateRestart() } finally { confirming = false }
    },
  })
  await controller.start()
  const settings = JSON.parse(await readFile(join(config.profile, "desktop-settings.json"), "utf8"))
  const inventory = characters.snapshot().entries.map(({ id, revision }) => ({ id, revision }))
  const data = { pid: process.pid, version: app.getVersion(), executable: process.execPath, settings, inventory, actualModelCalls: 0, productionFeed: false, preferencesSha256: createHash("sha256").update(await readFile(join(config.profile, "side-chat.json"))).digest("hex") }
  await appendFile(join(config.output, "boots.jsonl"), JSON.stringify(data) + "\n")
  await writeFile(join(config.output, "boot-" + app.getVersion() + ".json"), JSON.stringify(data, null, 2))
  if (app.getVersion() === config.nextVersion) { await writeFile(join(config.output, "replacement-complete.json"), JSON.stringify(data, null, 2)); return }

  const service = (controller as unknown as { updates: UpdateService }).updates
  if (handoffCase && recoveryCheck) {
    const before = service.snapshot(), checksBeforeManualRetry = providerChecks
    if (before.reason !== "PREVIOUS_UPDATE_INCOMPLETE" || checksBeforeManualRetry !== 0) throw Error("Missing manual recovery state")
    const settingsWindow = (controller as any).settingsWindow.window
    if (!settingsWindow) throw Error("Recovery did not open existing Settings")
    await service.act({ action: "check" })
    if (service.snapshot().phase !== "available") throw Error("Manual retry did not recover")
    await writeFile(join(config.output, "recovery-result.json"), JSON.stringify({ status: "PASS", before, checksBeforeManualRetry, after: service.snapshot(), providerChecks, existingSettingsOpened: true, automaticInstallCalls: 0, actualModelCalls: 0 }, null, 2))
    await controller.quit(); return
  }

  const failureRecord = join(config.output, "failure-checks.json")
  if (config.failures && !existsSync(failureRecord)) {
    const checks: Array<{ mode: string; status: string; error: string }> = []
    for (const mode of ["corrupt", "disconnect", "cancel", "size", ...(mac ? ["signature"] : [])]) {
      const probe = new Updater({ provider: "generic", url: new URL(mode + "/", feed.href).href })
      const cacheName = config.cacheName + "-" + mode, configPath = join(config.output, "probe-" + mode + ".yml")
      await writeFile(configPath, JSON.stringify({ provider: "generic", url: new URL(mode + "/", feed.href).href, updaterCacheDirName: cacheName }))
      probe.updateConfigPath = configPath
      const testEngine = new OfficialUpdateEngine(probe, join(cacheBase, cacheName), unsignedAllowed)
      const candidate = validateRelease(await testEngine.check(), app.getVersion(), target)
      if (!candidate) throw Error("Failure fixture did not produce a newer candidate")
      const cancellation = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = mode !== "cancel"; cancellation.abort() }, mode === "cancel" ? 100 : 25000)
      let rejection: unknown
      try { await testEngine.download(candidate, cancellation.signal, () => {}); if (mode === "signature") await testEngine.prepare() }
      catch (error) { rejection = error }
      finally { clearTimeout(timer) }
      if (!rejection || timedOut || nativeDownloads !== 0) throw Error("Failure fixture did not reject before staging: " + mode)
      checks.push({ mode, status: "PASS", error: String(rejection) })
    }
    await writeFile(failureRecord, JSON.stringify({ engine: "electron-updater@6.8.9", actualLocalTransport: true, checks, currentVersionUnchanged: app.getVersion(), noInstallerHandoff: true }, null, 2))
  }

  await service.act({ action: "check" })
  if (service.snapshot().phase !== "available") throw Error("expected available: " + JSON.stringify(service.snapshot()))
  const candidateId = service.snapshot().candidateId!
  await service.act({ action: "download", candidateId })
  if (service.snapshot().phase !== "downloaded") throw Error("expected downloaded: " + JSON.stringify(service.snapshot()))
  await writeFile(join(config.output, "download-only.json"), JSON.stringify({ version: app.getVersion(), state: service.snapshot(), autoInstallOnAppQuit: updater.autoInstallOnAppQuit, nativeDownloads, engine: "electron-updater@6.8.9" }))
  if (handoffCase) {
    const owner = controller as any, save = owner.store.save.bind(owner.store)
    engine.prepare = async () => {} // Do not stage an OS update in a fault-injection case.
    if (handoffCase === "cleanup-before") owner.store.save = async () => { throw Error("QA_SAVE_FAILURE") }
    if (handoffCase === "cleanup-after") owner.integration.dispose = async () => { throw Error("QA_CLEANUP_FAILURE") }
    if (handoffCase === "install-throw") updater.quitAndInstall = () => { throw Error("QA_INSTALL_THROW") }
    if (handoffCase === "install-event") updater.quitAndInstall = () => { setTimeout(() => updater.emit("error", Error("QA_INSTALL_EVENT")), 25) }
    await service.act({ action: "installAndRestart", candidateId })
    if (handoffCase === "cleanup-before") {
      if (service.snapshot().reason !== "SAVE_FAILED" || owner.quitting || !applicationInputAllowed() || !owner.settingsWindow.window) throw Error("UI was not recovered before destructive cleanup")
      await writeFile(join(config.output, "handoff-result.json"), JSON.stringify({ case: handoffCase, status: "PASS", actualAppControllerCleanup: true, actualNativeInstallation: false, state: service.snapshot(), settingsDestroyed: false, inputLocked: false, actualModelCalls: 0 }, null, 2))
      owner.store.save = save
      await controller.quit(); return
    }
    setTimeout(() => { console.error("Expected failure exit did not occur"); app.exit(2) }, 5000)
    return
  }
  // The driver writes this approval file only after inspecting the download-only evidence.
  const timer = setInterval(async () => { try {
    const later = await readFile(join(config.output, "quit-later"), "utf8").catch(() => "")
    if (later === config.nextVersion) { clearInterval(timer); await unlink(join(config.output, "quit-later")); await controller!.quit(); return }
    if (await readFile(join(config.output, "approve-install"), "utf8") !== config.nextVersion) return; clearInterval(timer); await service.act({ action: "installAndRestart", candidateId }); if (service.snapshot().phase === "error") throw Error(JSON.stringify(service.snapshot())) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { clearInterval(timer); await writeFile(join(config.output, "failure.json"), JSON.stringify({ message: error instanceof Error ? error.message : String(error) })) } } }, 500)
})().catch(async error => { console.error(error); app.exit(1) })
