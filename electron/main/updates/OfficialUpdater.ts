import { app, autoUpdater } from "electron"
import { MacUpdater, NsisUpdater, type AppUpdater } from "electron-updater"
import { CancellationToken } from "builder-util-runtime"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat, statfs, mkdir, realpath, lstat, readFile, access } from "node:fs/promises"
import { constants } from "node:fs"
import { join, dirname, sep } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir, release } from "node:os"
import { UPDATE_REPOSITORY, type UpdatePlatform, type VerifiedRelease } from "./ReleasePolicy"
import { BUNDLE_ID } from "../../shared/app-identity.mjs"
const run = promisify(execFile)
export interface UpdateEngine {
  check(): Promise<unknown>
  download(candidate: VerifiedRelease, signal: AbortSignal, progress: (percent: number) => void): Promise<void>
  verify(candidate: VerifiedRelease): Promise<void>
  prepare(): Promise<void>
  install(): void
}
export async function detectUpdatePlatform(allowUnsignedWindows = false): Promise<UpdatePlatform> {
  const target: UpdatePlatform = { platform: process.platform, arch: process.arch, osVersion: release(), kind: "unsupported", automatic: false, reason: "UNSUPPORTED_INSTALL" }
  if (!app.isPackaged) return { ...target, reason: "DEVELOPMENT_BUILD" }
  if (process.platform === "darwin" && process.arch === "arm64") {
    target.kind = "mac"
    try {
      const bundle = await realpath(join(process.execPath, "../../.."))
      if (!(bundle.startsWith("/Applications/") || bundle.startsWith(join(homedir(), "Applications") + sep)) || bundle.includes("AppTranslocation")) throw Error("INSTALL_LOCATION")
      await access(dirname(bundle), constants.W_OK)
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { timeout: 20000 })
      await run("/usr/sbin/spctl", ["--assess", "--type", "execute", bundle], { timeout: 20000 })
      return { ...target, automatic: true, reason: undefined }
    } catch { return { ...target, reason: "MAC_INSTALL_OR_TRUST" } }
  }
  if (process.platform === "win32" && process.arch === "x64") {
    target.kind = "portable"
    try {
      const marker = JSON.parse(await readFile(join(dirname(process.execPath), "daemonlet-install.json"), "utf8"))
      if (marker.appId !== BUNDLE_ID || marker.scope !== "currentUser" || marker.kind !== "nsis") return target
      target.kind = "nsis"
      const config = JSON.parse(await readFile(join(process.resourcesPath, "app-update.yml"), "utf8"))
      if (config.publisherName === undefined && allowUnsignedWindows) {
        await access(dirname(process.execPath), constants.W_OK)
        return { ...target, automatic: true, reason: "UNVERIFIED_PUBLISHER" }
      }
      if (!Array.isArray(config.publisherName) || !config.publisherName.length || config.publisherName.some((x: unknown) => typeof x !== "string" || !x)) throw Error("WINDOWS_PUBLISHER_REQUIRED")
      // Use the updater's standard Authenticode verifier, never a permissive override.
      const verifier = new NsisUpdater(UPDATE_REPOSITORY)
      verifier.autoDownload = false; verifier.autoInstallOnAppQuit = false
      const failure = await verifier.verifyUpdateCodeSignature(config.publisherName, process.execPath)
      if (failure) throw Error("WINDOWS_PUBLISHER_REQUIRED")
      await access(dirname(process.execPath), constants.W_OK)
      return { ...target, automatic: true, reason: undefined }
    } catch { return { ...target, reason: target.kind === "nsis" ? "WINDOWS_PUBLISHER_REQUIRED" : "PORTABLE_MANUAL" } }
  }
  return target
}
/** Only the official provider is constructed here. QA constructs its engine in a separate entry point. */
export function createOfficialUpdateEngine(allowUnsignedWindows: () => boolean = () => false): UpdateEngine {
  const updater = process.platform === "darwin" ? new MacUpdater(UPDATE_REPOSITORY) : new NsisUpdater(UPDATE_REPOSITORY)
  return new OfficialUpdateEngine(updater, join(process.platform === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local") : join(homedir(), "Library", "Caches"), "daemonlet-for-codex-updater"), allowUnsignedWindows)
}
export class OfficialUpdateEngine implements UpdateEngine {
  private file: string | null = null
  constructor(private readonly updater: AppUpdater, private readonly cacheRoot: string, private readonly allowUnsignedWindows: () => boolean = () => false) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.autoRunAppAfterInstall = true
    updater.allowDowngrade = false
    updater.allowPrerelease = false
    updater.disableDifferentialDownload = true
    updater.disableWebInstaller = true
    updater.logger = null
    // check/download errors reject their promises; install errors remain observable.
    updater.on("error", () => {})
  }
  async check(): Promise<unknown> { return (await this.updater.checkForUpdates())?.updateInfo }
  async download(candidate: VerifiedRelease, signal: AbortSignal, progress: (percent: number) => void): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true })
    if ((await lstat(this.cacheRoot)).isSymbolicLink()) throw Error("INVALID_DOWNLOAD")
    const pending = join(this.cacheRoot, "pending")
    await mkdir(pending, { recursive: true })
    if ((await lstat(pending)).isSymbolicLink()) throw Error("INVALID_DOWNLOAD")
    const space = await statfs(this.cacheRoot)
    if (space.bavail * space.bsize < candidate.size * 3 + 100 * 1024 ** 2) throw Object.assign(Error("DISK_FULL"), { code: "ENOSPC" })
    const token = new CancellationToken()
    const abort = () => token.cancel()
    signal.addEventListener("abort", abort, { once: true })
    const onProgress = (value: { percent: number }) => progress(value.percent)
    this.updater.on("download-progress", onProgress)
    try {
      if (signal.aborted) throw Error("CANCELLED")
      const files = await this.updater.downloadUpdate(token)
      if (signal.aborted || files.length !== 1) throw Error("CANCELLED")
      this.file = files[0]
      await this.verify(candidate)
    } finally { signal.removeEventListener("abort", abort); this.updater.removeListener("download-progress", onProgress) }
  }
  async verify(candidate: VerifiedRelease): Promise<void> {
    if (!this.file || (await lstat(this.file)).isSymbolicLink()) throw Error("INVALID_DOWNLOAD")
    const file = await realpath(this.file), cache = await realpath(this.cacheRoot)
    if (!file.startsWith(cache + sep) || !(await stat(file)).isFile() || (await stat(file)).size !== candidate.size) throw Error("INVALID_SIZE")
    const hash = createHash("sha512")
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    if (hash.digest("base64") !== candidate.sha512) throw Error("INVALID_DIGEST")
    if (process.platform === "win32") {
      const config = JSON.parse(await readFile(join(process.resourcesPath, "app-update.yml"), "utf8"))
      if (config.publisherName === undefined) {
        if (!this.allowUnsignedWindows()) throw Error("INVALID_SIGNATURE")
      } else if (!Array.isArray(config.publisherName) || !config.publisherName.length || await (this.updater as NsisUpdater).verifyUpdateCodeSignature(config.publisherName, file)) throw Error("INVALID_SIGNATURE")
    }
    // Squirrel.Mac verifies the app's designated signing requirement before staging.
    // Download does not stage: autoInstallOnAppQuit is false in fixed 6.8.9.
  }
  async prepare(): Promise<void> {
    if (process.platform !== "darwin") return
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); autoUpdater.removeListener("error", failed); autoUpdater.removeListener("update-downloaded", ready) }
      const failed = (error: Error) => { cleanup(); reject(error) }
      const ready = () => { cleanup(); resolve() }
      const timer = setTimeout(() => failed(Error("UPDATE_FAILED")), 120_000)
      autoUpdater.once("error", failed); autoUpdater.once("update-downloaded", ready)
      try { autoUpdater.checkForUpdates() } catch (error) { failed(error as Error) }
    })
  }
  install(): void {
    if (process.platform === "win32") process.env.DAEMONLET_OWNED_UPDATE_PID = String(process.pid)
    this.updater.quitAndInstall(process.platform === "win32", true)
  }
}
