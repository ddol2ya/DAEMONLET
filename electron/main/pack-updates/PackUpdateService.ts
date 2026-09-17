import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, rm, statfs } from "node:fs/promises"
import { join } from "node:path"
import { PACK_LIMITS, PACK_ERRORS, comparePackVersions, type CharacterEntry, type ImportPreview } from "../../shared/character-pack-contract"
import { PACK_UPDATE_ERRORS, PACK_UPDATE_LIMITS, sameUpdateRuntime, supportsUpdateRuntime, updateSourceKey, type PackUpdateSource, type PackUpdateFeed, type PackUpdateState } from "../../shared/pack-update-contract"
import type { CharacterRegistry } from "../CharacterRegistry"
import { applicationInputAllowed } from "../updates/OperationGate"
import { HuggingFacePackProvider, HfRateError } from "./HuggingFacePackProvider"
import { PackUpdatePreferences } from "./PackUpdatePreferences"

type Check = { controller: AbortController; owner?: string; revision: string; source: PackUpdateSource; automatic: boolean }
type Candidate = { id: string; owner: string; packId: string; revision: string; source: PackUpdateSource; feed: PackUpdateFeed; root: string; controller: AbortController; preview?: ImportPreview; applying?: boolean; timer?: ReturnType<typeof setTimeout> }
type Options = {
  registry: CharacterRegistry; dataRoot: string; appVersion: string; provider?: Pick<HuggingFacePackProvider, "feed" | "download">; preferences?: PackUpdatePreferences
  owner: () => string | null; selected: () => string; canApply: (id: string) => boolean
  apply: (preview: ImportPreview, owner: string) => Promise<void>; changed: (states: PackUpdateState[]) => void; now?: () => number
}
export class PackUpdateService {
  private readonly provider: Pick<HuggingFacePackProvider, "feed" | "download">
  private readonly preferences: PackUpdatePreferences
  private readonly root: string
  private readonly now: () => number
  private readonly states = new Map<string, PackUpdateState>()
  private readonly checks = new Map<string, Check>()
  private readonly nextChecks = new Map<string, number>()
  private candidate?: Candidate
  private timer?: ReturnType<typeof setTimeout>
  private unsubscribe?: () => void
  private disposed = false
  private preferenceError = false
  private downloadTask?: Promise<void>
  constructor(private readonly o: Options) {
    this.provider = o.provider ?? new HuggingFacePackProvider()
    this.preferences = o.preferences ?? new PackUpdatePreferences(join(o.dataRoot, "pack-update-preferences.json"))
    this.root = join(o.dataRoot, "pack-update-transactions"); this.now = o.now ?? Date.now
  }
  async start() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await lstat(this.root)).isSymbolicLink()) throw Error("PACK_PATH")
    // Remove only UUID transactions owned by this service, never shared download/cache directories.
    for (const item of await readdir(this.root)) if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item)) await rm(join(this.root, item), { recursive: true, force: true })
    await this.preferences.load().catch(() => { this.preferenceError = true })
    this.unsubscribe = this.o.registry.subscribe(() => this.reconcile())
    this.reconcile(); this.schedule()
  }
  readyForUpdate() { return !this.candidate && !this.downloadTask }
  applying() { return this.candidate?.applying === true }
  snapshot(): PackUpdateState[] { return structuredClone([...this.states.values()]) }
  private emit() { if (!this.disposed) this.o.changed(this.snapshot()) }
  private target(id: string): CharacterEntry & { update: PackUpdateSource } {
    const entry = this.o.registry.get(id)
    if (!entry || entry.source !== "external" || !entry.update || entry.status === "disabled") throw Error("PACK_UPDATE_SOURCE")
    return entry as CharacterEntry & { update: PackUpdateSource }
  }
  private live(id: string, revision: string, source: PackUpdateSource) {
    const entry = this.o.registry.get(id)
    return !this.disposed && entry?.revision === revision && !!entry.update && updateSourceKey(id, entry.update) === updateSourceKey(id, source)
  }
  private requireOwner(owner: string) { if (this.disposed || this.o.owner() !== owner || !applicationInputAllowed()) throw Error("PACK_TRANSACTION") }
  private reconcile() {
    const entries = this.o.registry.snapshot().entries.filter(e => e.source === "external" && e.update && e.status !== "disabled")
    for (const id of this.states.keys()) if (!entries.some(e => e.id === id)) this.states.delete(id)
    for (const e of entries) {
      const source = e.update!, old = this.states.get(e.id), pref = this.preferences.get(e.id, source)
      if (!old || old.revision !== e.revision || updateSourceKey(e.id, old.source) !== updateSourceKey(e.id, source)) this.states.set(e.id, { packId: e.id, revision: e.revision, source, phase: this.candidate?.applying && this.candidate.packId === e.id ? "applying" : this.preferenceError ? "error" : pref ? "idle" : "source-required", autoCheck: pref?.autoCheck ?? false, checkedAt: pref?.checkedAt, ...(this.preferenceError ? { error: "PACK_IO" } : {}) })
    }
    for (const [id, check] of this.checks) if (!this.live(id, check.revision, check.source)) { check.controller.abort(); this.checks.delete(id) }
    const c = this.candidate
    if (c && !c.applying && !this.live(c.packId, c.revision, c.source)) void this.cancel(c.owner).catch(() => {})
    this.emit()
  }
  private set(id: string, patch: Partial<PackUpdateState>) { const old = this.states.get(id); if (old) { this.states.set(id, { ...old, ...patch }); this.emit() } }
  private error(error: unknown) { const code = error instanceof Error ? error.message : ""; return Object.hasOwn(PACK_ERRORS, code) || Object.hasOwn(PACK_UPDATE_ERRORS, code) ? code : "PACK_UPDATE_NETWORK" }
  async check(id: string, owner?: string) {
    if (owner) this.requireOwner(owner)
    const entry = this.target(id), source = entry.update, key = updateSourceKey(id, source), automatic = !owner
    if (this.checks.has(id) || this.candidate?.packId === id) throw Error("PACK_BUSY")
    let pref = this.preferences.get(id, source)
    if (automatic && !pref?.autoCheck) return
    if (this.now() < (this.nextChecks.get(key) ?? 0)) throw Error("PACK_UPDATE_RATE")
    const check: Check = { controller: new AbortController(), owner, revision: entry.revision, source, automatic }
    this.checks.set(id, check); this.nextChecks.set(key, this.now() + PACK_UPDATE_LIMITS.checkIntervalMs)
    const current = () => this.checks.get(id) === check && !check.controller.signal.aborted && this.live(id, entry.revision, source) && (!owner || this.o.owner() === owner)
    this.set(id, { phase: "checking", error: undefined, candidateId: undefined })
    try {
      if (!pref) { pref = { packId: id, source, autoCheck: false }; await this.preferences.save(pref) }
      if (!current()) return
      let result = await this.provider.feed(source, check.controller.signal, pref.etag)
      if (result.notModified && !pref.feed) result = await this.provider.feed(source, check.controller.signal)
      if (!current()) return
      const feed = result.notModified ? pref.feed : result.feed
      if (!feed || feed.packId !== id) throw Error("PACK_UPDATE_METADATA")
      if (pref.feed?.version === feed.version && JSON.stringify(pref.feed.artifact) !== JSON.stringify(feed.artifact)) throw Error("PACK_CONFLICT")
      // Do not revive an auto setting disabled while the request was in flight.
      pref = this.preferences.get(id, source) ?? pref
      await this.preferences.update(id, previous => {
        if (!current() || !previous || updateSourceKey(id, previous.source) !== key) throw Error("PACK_TRANSACTION")
        return { ...previous, checkedAt: this.now(), feed, etag: result.notModified ? previous.etag : result.etag }
      })
      if (!current()) return
      const compare = comparePackVersions(feed.version, entry.version)
      if (compare < 0) throw Error("PACK_DOWNGRADE")
      const compatible = comparePackVersions(feed.minAppVersion, this.o.appVersion) <= 0 && supportsUpdateRuntime(feed.runtime)
      this.set(id, { phase: !compatible ? "app-required" : compare <= 0 ? "latest" : pref.skipped === feed.version ? "skipped" : "available", version: feed.version, notes: feed.notes, bytes: feed.artifact.bytes, checkedAt: this.now(), autoCheck: pref.autoCheck })
    } catch (error) {
      if (error instanceof HfRateError) this.nextChecks.set(key, this.now() + error.retryMs)
      else this.nextChecks.set(key, this.now() + (automatic ? 60 * 60_000 : PACK_UPDATE_LIMITS.checkIntervalMs))
      if (current()) this.set(id, { phase: "error", error: this.error(error) })
    } finally { if (this.checks.get(id) === check) this.checks.delete(id) }
  }
  async auto(id: string, enabled: boolean, owner: string) {
    this.requireOwner(owner)
    const entry = this.target(id), pref = this.preferences.get(id, entry.update)
    if (!pref) throw Error("PACK_UPDATE_SOURCE")
    const check = this.checks.get(id)
    if (!enabled && check?.automatic) { check.controller.abort(); this.checks.delete(id); this.set(id, { phase: "idle" }) }
    await this.preferences.update(id, previous => { if (!previous || updateSourceKey(id, previous.source) !== updateSourceKey(id, entry.update)) throw Error("PACK_TRANSACTION"); return { ...previous, autoCheck: enabled } }); this.set(id, { autoCheck: enabled })
  }
  async skip(id: string, owner: string) {
    this.requireOwner(owner)
    const entry = this.target(id), pref = this.preferences.get(id, entry.update)
    if (!pref?.feed || comparePackVersions(pref.feed.version, entry.version) <= 0) throw Error("PACK_TRANSACTION")
    await this.preferences.update(id, previous => { if (!previous || updateSourceKey(id, previous.source) !== updateSourceKey(id, entry.update)) throw Error("PACK_TRANSACTION"); return { ...previous, skipped: pref.feed!.version } }); this.set(id, { phase: "skipped" })
  }
  async download(id: string, owner: string) {
    this.requireOwner(owner)
    if (this.candidate || this.downloadTask || !this.o.registry.readyForUpdate()) throw Error("PACK_BUSY")
    const entry = this.target(id), pref = this.preferences.get(id, entry.update), feed = pref?.feed
    if (!feed || feed.packId !== id || !supportsUpdateRuntime(feed.runtime) || comparePackVersions(feed.minAppVersion, this.o.appVersion) > 0 || comparePackVersions(feed.version, entry.version) <= 0) throw Error("PACK_INCOMPATIBLE")
    const c: Candidate = { id: randomUUID(), owner, packId: id, revision: entry.revision, source: entry.update, feed, root: "", controller: new AbortController() }
    c.root = join(this.root, c.id); this.candidate = c
    const task = this.receive(c); this.downloadTask = task
    try { await task } finally { if (this.downloadTask === task) this.downloadTask = undefined }
  }
  private assertCandidate(c: Candidate) {
    this.requireOwner(c.owner)
    if (this.candidate !== c || c.controller.signal.aborted || !this.live(c.packId, c.revision, c.source)) throw Error("PACK_TRANSACTION")
  }
  private async receive(c: Candidate) {
    try {
      const disk = await statfs(this.root)
      if (disk.bavail * disk.bsize < c.feed.artifact.bytes * 2 + PACK_LIMITS.payloadBytes + 64 * 1024 * 1024 || this.o.registry.snapshot().storageBytes + PACK_LIMITS.payloadBytes > PACK_LIMITS.storageBytes) throw Error("PACK_SPACE")
      await mkdir(c.root, { mode: 0o700 }); this.assertCandidate(c)
      const file = join(c.root, "download.petchar")
      this.set(c.packId, { phase: "downloading", received: 0, error: undefined })
      let lastProgress = 0
      await this.provider.download(c.source, c.feed, file, c.controller.signal, received => {
        if (this.candidate === c && !c.controller.signal.aborted && this.live(c.packId, c.revision, c.source) && (this.now() - lastProgress > 200 || received === c.feed.artifact.bytes)) { lastProgress = this.now(); this.set(c.packId, { received }) }
      })
      this.assertCandidate(c)
      if (!this.o.registry.readyForUpdate()) throw Error("PACK_BUSY")
      this.set(c.packId, { phase: "verifying" })
      c.preview = await this.o.registry.prepareImport(file, c.owner)
      this.assertCandidate(c)
      const p = c.preview.entry
      // Read the validated staged manifest through the registry, not a second renderer claim.
      const manifest = this.o.registry.preparedManifest(c.preview.token, c.owner)
      if (p.id !== c.packId || p.version !== c.feed.version || !p.update || updateSourceKey(p.id, p.update) !== updateSourceKey(c.packId, c.source) || !sameUpdateRuntime(manifest.runtime, c.feed.runtime) || c.preview.kind !== "update") throw Error("PACK_UPDATE_METADATA")
      c.timer = setTimeout(() => { void this.cancel(c.owner).catch(() => {}) }, Math.max(1, c.preview.expiresAt - this.now()))
      this.set(c.packId, { phase: "ready", candidateId: c.id })
    } catch (error) {
      const live = this.candidate === c && this.live(c.packId, c.revision, c.source)
      await this.discard(c)
      if (live) this.set(c.packId, { phase: c.controller.signal.aborted ? "idle" : "error", error: c.controller.signal.aborted ? undefined : this.error(error), candidateId: undefined })
    }
  }
  async apply(candidateId: string, owner: string) {
    const c = this.candidate
    if (!c || c.id !== candidateId || c.owner !== owner || !c.preview || c.applying) throw Error("PACK_TRANSACTION")
    this.assertCandidate(c)
    if (!this.o.canApply(c.packId)) throw Error("PACK_UPDATE_CHAT_BUSY")
    if (c.preview.expiresAt <= this.now()) { await this.discard(c); throw Error("PACK_TRANSACTION") }
    c.applying = true; clearTimeout(c.timer); this.set(c.packId, { phase: "applying", error: undefined })
    try {
      await this.o.apply(c.preview, owner)
      const current = this.o.registry.get(c.packId)
      if (current?.revision !== c.preview.entry.revision) throw Error("PACK_LOAD")
      this.set(c.packId, { phase: "applied", candidateId: undefined })
    } catch (error) { this.set(c.packId, { phase: "error", candidateId: undefined, error: this.error(error) }); throw error }
    finally { await this.discard(c) }
  }
  private async discard(c: Candidate) {
    clearTimeout(c.timer)
    if (c.preview) await this.o.registry.cancelImport(c.owner)
    await rm(c.root, { recursive: true, force: true })
    if (this.candidate === c) this.candidate = undefined
  }
  async cancel(owner: string, id?: string) {
    for (const [key, check] of this.checks) if (check.owner === owner && (!id || key === id)) { check.controller.abort(); this.checks.delete(key); this.set(key, { phase: "idle" }) }
    const c = this.candidate
    if (!c || c.owner !== owner || id && c.packId !== id || c.applying) return
    c.controller.abort(); await this.o.registry.cancelImport(owner)
    if (this.downloadTask) await this.downloadTask
    else await this.discard(c)
    if (this.live(c.packId, c.revision, c.source)) this.set(c.packId, { phase: "idle", candidateId: undefined, error: undefined })
  }
  private schedule() {
    this.timer = setTimeout(() => { void this.background().finally(() => { if (!this.disposed) this.schedule() }) }, 60_000 + Math.floor(Math.random() * 60_000))
    this.timer.unref?.()
  }
  async background() {
    if (this.disposed || !applicationInputAllowed()) return
    // At most one delayed metadata request per tick; never download or apply automatically.
    for (const state of this.states.values()) {
      const p = this.preferences.get(state.packId, state.source), key = updateSourceKey(state.packId, state.source)
      if (p?.autoCheck && this.now() - (p.checkedAt ?? 0) >= PACK_UPDATE_LIMITS.autoIntervalMs && this.now() >= (this.nextChecks.get(key) ?? 0) && !this.checks.has(state.packId) && this.candidate?.packId !== state.packId) { await this.check(state.packId).catch(() => {}); break }
    }
  }
  async dispose() {
    this.disposed = true; clearTimeout(this.timer); this.unsubscribe?.()
    for (const check of this.checks.values()) check.controller.abort()
    this.checks.clear()
    if (this.candidate && !this.candidate.applying) await this.cancel(this.candidate.owner)
  }
}
