// Standalone QA entry. Never imported by main.ts or included in a release candidate.
declare const __APP_QA__: boolean
import { app, autoUpdater } from "electron"
import { MacUpdater } from "electron-updater"
import { readFile, writeFile, mkdir, unlink, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { release, homedir } from "node:os"
import { readFileSync, writeFileSync } from "node:fs"
import { AppController } from "../AppController"
import { CharacterRegistry } from "../CharacterRegistry"
import { createPackValidator } from "../CharacterPackWorker"
import { configureDesktopIdentity } from "../DesktopIdentity"
import { installAppProtocol, registerAppScheme } from "../AppProtocol"
import { prepareDesktopAdapterPorts } from "../DesktopAdapterConfig"
import { OfficialUpdateEngine } from "./OfficialUpdater"
import type { UpdateService } from "./UpdateService"
if (!__APP_QA__) throw Error("UPDATE_SMOKE_ONLY")
registerAppScheme(); app.enableSandbox()
let controller: AppController | null = null
void (async () => {
  const config = JSON.parse(readFileSync(join(process.resourcesPath, "update-smoke.json"), "utf8"))
  const feed = new URL(config.feed)
  if (feed.protocol !== "http:" || feed.hostname !== "127.0.0.1" || !config.profile || !config.output) throw Error("UPDATE_SMOKE_ONLY")
  process.env.DAEMONLET_DATA_HOME = config.profile
  process.env.CODEX_PET_PROTOCOL_PORT = String(config.protocolPort)
  process.env.CODEX_PET_HOOK_PORT = String(config.hookPort)
  configureDesktopIdentity(app)
  if (!app.requestSingleInstanceLock()) return app.quit()
  app.on("window-all-closed", () => {})
  app.on("before-quit", event => { if (controller && !controller.canExit) { event.preventDefault(); void controller.quit() } })
  await app.whenReady(); app.setActivationPolicy("accessory")
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
  const updater = new MacUpdater({ provider: "generic", url: feed.href })
  const engine = new OfficialUpdateEngine(updater, join(homedir(), "Library", "Caches", config.cacheName))
  updater.on("error", error => writeFileSync(join(config.output, "engine-error.json"), JSON.stringify({ message: error.message, stack: error.stack })))
  const target = { platform: "darwin", arch: "arm64", osVersion: release(), kind: "mac" as const, automatic: true }
  controller = new AppController(__dirname, characters, undefined, undefined, {
    engine: () => engine, platform: async () => target, fetchLatest: undefined, autoCheck: () => false,
    confirmInstall: async () => { await writeFile(join(config.output, "test-consent.json"), JSON.stringify({ userAuthorizedIsolatedUpdateTest: true, productionDialogBypassedOnlyInQa: true })); return true },
  })
  await controller.start()
  const settings = JSON.parse(await readFile(join(config.profile, "desktop-settings.json"), "utf8"))
  const inventory = characters.snapshot().entries.map(({ id, revision }) => ({ id, revision }))
  const data = { version: app.getVersion(), executable: process.execPath, settings, inventory, actualModelCalls: 0, productionFeed: false, preferencesSha256: createHash("sha256").update(await readFile(join(config.profile, "side-chat.json"))).digest("hex") }
  await appendFile(join(config.output, "boots.jsonl"), JSON.stringify(data) + "\n")
  await writeFile(join(config.output, "boot-" + app.getVersion() + ".json"), JSON.stringify(data, null, 2))
  if (app.getVersion() === config.nextVersion) { await writeFile(join(config.output, "replacement-complete.json"), JSON.stringify(data, null, 2)); return }
  const service = (controller as unknown as { updates: UpdateService }).updates
  await service.act({ action: "check" })
  if (service.snapshot().phase !== "available") throw Error("expected available: " + JSON.stringify(service.snapshot()))
  const candidateId = service.snapshot().candidateId!
  await service.act({ action: "download", candidateId })
  if (service.snapshot().phase !== "downloaded") throw Error("expected downloaded: " + JSON.stringify(service.snapshot()))
  await writeFile(join(config.output, "download-only.json"), JSON.stringify({ version: app.getVersion(), state: service.snapshot(), autoInstallOnAppQuit: updater.autoInstallOnAppQuit, nativeDownloads, engine: "electron-updater@6.8.9" }))
  // The driver writes this approval file only after inspecting the download-only evidence.
  const timer = setInterval(async () => { try {
    const later = await readFile(join(config.output, "quit-later"), "utf8").catch(() => "")
    if (later === config.nextVersion) { clearInterval(timer); await unlink(join(config.output, "quit-later")); await controller!.quit(); return }
    if (await readFile(join(config.output, "approve-install"), "utf8") !== config.nextVersion) return; clearInterval(timer); await service.act({ action: "installAndRestart", candidateId }); if (service.snapshot().phase === "error") throw Error(JSON.stringify(service.snapshot())) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { clearInterval(timer); await writeFile(join(config.output, "failure.json"), JSON.stringify({ message: error instanceof Error ? error.message : String(error) })) } } }, 500)
})().catch(async error => { console.error(error); app.exit(1) })
