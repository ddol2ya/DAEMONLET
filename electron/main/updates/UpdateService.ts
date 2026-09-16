import { valid, prerelease, gt } from "semver"
import { randomUUID } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { UpdateAction, UpdateSnapshot } from "../../shared/update-contract"
import { RELEASE_ROOT, validateRelease, type UpdatePlatform, type VerifiedRelease } from "./ReleasePolicy"
import type { UpdateEngine } from "./OfficialUpdater"
const DAY = 24 * 60 * 60 * 1000
const publicErrors = new Set(["INVALID_METADATA", "INVALID_VERSION", "WRONG_PACKAGE", "UNSUPPORTED_OS", "INVALID_DIGEST", "INVALID_SIZE", "INVALID_SIGNATURE", "INVALID_DOWNLOAD", "PACK_BUSY", "SAVE_FAILED", "OS_SHUTDOWN", "NETWORK", "RATE_LIMITED"])
export class UpdateService {
  private state: UpdateSnapshot
  private listeners = new Set<(value: UpdateSnapshot) => void>()
  private candidate: VerifiedRelease | null = null
  private generation = 0
  private download: AbortController | null = null
  private disposed = false
  private timer: ReturnType<typeof setInterval> | null = null
  private nextAuto = 0
  private failures = 0
  private etag: string | undefined
  private cachedTag: string | undefined
  private lastManual = 0
  private policyBusy = false
  constructor(private readonly options: {
    version: string; platform: () => Promise<UpdatePlatform>; engine: () => UpdateEngine; dataRoot: string;
    setUnsignedWindowsPolicy?: (enabled: boolean) => Promise<boolean>;
    autoCheck: () => boolean; confirmInstall: () => Promise<boolean>;
    prepareShutdown: () => Promise<void>; handoff: () => void; resume: () => void;
    openExternal: (url: string) => Promise<void>;
    fetchLatest?: (etag?: string) => Promise<{ status: number; etag?: string; tag?: string }>;
    now?: () => number;
  }) { this.state = { phase: "idle", currentVersion: options.version } }
  private engine: UpdateEngine | null = null
  snapshot(): UpdateSnapshot { return structuredClone(this.state) }
  subscribe(listener: (value: UpdateSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<UpdateSnapshot>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.snapshot()) }
  private now() { return this.options.now?.() ?? Date.now() }
  async start() {
    try {
      const stored = JSON.parse(await readFile(join(this.options.dataRoot, "update-check.json"), "utf8"))
      if (Number.isFinite(stored.nextAuto)) this.nextAuto = Math.min(Math.max(stored.nextAuto, 0), this.now() + 7 * DAY)
      if (typeof stored.etag === "string" && stored.etag.length <= 300 && !/[\r\n]/.test(stored.etag)) this.etag = stored.etag
      if (typeof stored.tag === "string" && /^v\d+\.\d+\.\d+$/.test(stored.tag)) this.cachedTag = stored.tag
    } catch { /* Missing or invalid metadata cache never resets user preferences. */ }
    this.timer = setInterval(() => { void this.check(true) }, 60_000); this.timer.unref()
    void this.check(true)
  }
  async act(action: UpdateAction): Promise<UpdateSnapshot> {
    if (this.disposed || this.policyBusy) return this.snapshot()
    if (action.action === "setUnsignedWindowsPolicy") {
      if (["preparing", "handoff"].includes(this.state.phase) || !this.options.setUnsignedWindowsPolicy) return this.snapshot()
      this.policyBusy = true
      try { if (await this.options.setUnsignedWindowsPolicy(action.enabled)) { this.generation++; this.download?.abort(); this.candidate = null; this.engine = null; this.publish({ phase: "idle", reason: undefined, candidateId: undefined, version: undefined, progress: undefined }) } }
      finally { this.policyBusy = false }
    }
    else if (action.action === "check") await this.check(false)
    else if (action.action === "openRelease") await this.options.openExternal(this.candidate?.releaseUrl ?? RELEASE_ROOT + "/latest")
    else if (action.action === "cancelDownload") { if (this.download) { this.generation++; this.download.abort(); this.publish({ phase: "available", progress: undefined }) } }
    else if ("candidateId" in action && action.candidateId === this.state.candidateId && this.candidate) {
      if (action.action === "download" && this.state.phase === "available" && !this.download) await this.fetchDownload()
      if (action.action === "installAndRestart" && this.state.phase === "downloaded") await this.install()
    }
    return this.snapshot()
  }
  async check(automatic: boolean): Promise<void> {
    if (this.disposed || this.download || ["checking", "downloading", "downloaded", "preparing", "handoff"].includes(this.state.phase)) return
    if (automatic && (!this.options.autoCheck() || this.now() < this.nextAuto)) return
    if (!automatic && this.now() - this.lastManual < 10_000) return
    if (!automatic) this.lastManual = this.now()
    const generation = ++this.generation
    this.candidate = null
    this.publish({ phase: "checking", candidateId: undefined, version: undefined, reason: undefined, progress: undefined })
    try {
      const platform = await this.options.platform()
      if (generation !== this.generation || this.disposed) return
      if (platform.kind === "unsupported") { this.publish({ phase: "blocked", reason: platform.reason }); return }
      // Conditional public metadata request is a rate-limit/cache gate, never a second asset selector.
      if (this.options.fetchLatest) {
        const result = await this.options.fetchLatest(this.etag)
        if (generation !== this.generation || this.disposed) return
        if (result.status === 403 || result.status === 429) throw Error("RATE_LIMITED")
        if (result.status !== 200 && result.status !== 304) throw Error("NETWORK")
        this.etag = result.etag ?? this.etag; this.cachedTag = result.tag ?? this.cachedTag
        const latest = this.cachedTag?.replace(/^v/, "")
        if (!latest || !valid(latest) || prerelease(latest)) throw Error("INVALID_VERSION")
        if (!gt(latest, this.options.version)) { this.failures = 0; this.publish({ phase: "upToDate", checkedAt: this.now() }); return }
      }
      this.engine ??= this.options.engine()
      const info = await this.engine.check()
      if (generation !== this.generation || this.disposed) return
      this.candidate = validateRelease(info, this.options.version, platform)
      this.failures = 0
      this.publish(this.candidate ? { phase: platform.automatic ? "available" : "manualOnly", reason: platform.reason, candidateId: randomUUID(), version: this.candidate.version, checkedAt: this.now() } : { phase: "upToDate", checkedAt: this.now() })
    } catch (error) {
      this.failures++
      if (generation === this.generation) this.publish({ phase: "error", reason: this.reason(error) })
    } finally {
      this.nextAuto = this.now() + Math.min(7 * DAY, DAY * 2 ** Math.min(3, this.failures))
      await mkdir(this.options.dataRoot, { recursive: true }).then(() => writeFile(join(this.options.dataRoot, "update-check.json"), JSON.stringify({ nextAuto: this.nextAuto, etag: this.etag, tag: this.cachedTag }), { mode: 0o600 })).catch(() => {})
    }
  }
  private reason(error: unknown) { const code = (error as { code?: string })?.code; if (code === "ENOSPC") return "DISK_FULL"; const message = error instanceof Error ? error.message : ""; return publicErrors.has(message) ? message : "UPDATE_FAILED" }
  private async fetchDownload() {
    const candidate = this.candidate!, generation = ++this.generation, controller = new AbortController()
    this.download = controller
    this.publish({ phase: "downloading", progress: 0, reason: undefined })
    try {
      const platform = await this.options.platform()
      if (!platform.automatic) throw Error("INVALID_SIGNATURE")
      await this.engine!.download(candidate, controller.signal, percent => { if (generation === this.generation) this.publish({ progress: Math.max(0, Math.min(100, percent)) }) })
      if (generation === this.generation && !controller.signal.aborted && !this.disposed) this.publish({ phase: "downloaded", progress: 100 })
    } catch (error) { if (generation === this.generation && !this.disposed) this.publish({ phase: controller.signal.aborted ? "available" : "error", reason: controller.signal.aborted ? undefined : this.reason(error) }) }
    finally { if (this.download === controller) this.download = null }
  }
  private async install() {
    this.publish({ phase: "preparing", reason: undefined })
    try {
      // No input, child, draft or window is touched before explicit native consent.
      const confirmed = await this.options.confirmInstall()
      if (this.disposed) return
      if (!confirmed) { this.publish({ phase: "downloaded" }); return }
      const platform = await this.options.platform()
      if (this.disposed) return
      if (!platform.automatic) throw Error("INVALID_SIGNATURE")
      await this.engine!.verify(this.candidate!)
      if (this.disposed) return
      await this.engine!.prepare()
      if (this.disposed) return
      // Owned cleanup disposes this service; the application handoff independently
      // checks OS shutdown after cleanup and before native installer launch.
      await this.options.prepareShutdown()
      this.publish({ phase: "handoff" })
      this.options.handoff()
      this.engine!.install()
    } catch (error) { if (!this.disposed) { this.options.resume(); this.publish({ phase: "error", reason: this.reason(error) }) } }
  }
  dispose() { this.disposed = true; this.generation++; this.download?.abort(); if (this.timer) clearInterval(this.timer); this.timer = null }
}
