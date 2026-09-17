import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, statfs } from "node:fs/promises"
import { join, dirname, resolve, sep } from "node:path"
import { PACK_LIMITS, isCharacterId, isRevision, comparePackVersions, type CharacterEntry, type CharacterSnapshot, type ImportPreview, type CharacterSelection, type PackProgress } from "../shared/character-pack-contract"
import { parsePackManifest } from "../shared/character-pack-validation"
import { packAssetUrl } from "../shared/character-pack-path"
import { boundedFile, containedFile, sha256, type ValidatedPack } from "./CharacterPackAssets"
import type { PackValidator } from "./CharacterPackWorker"

type StoredEntry = { id: string; current: string; previous?: string; revisions: string[] }
type Index = { schemaVersion: 1; generation: number; entries: StoredEntry[] }
type Pending = { token: string; owner: string; root: string; controller: AbortController; expiresAt: number; generation: number; pack?: ValidatedPack; committing?: boolean; kind?: ImportPreview["kind"]; timer: ReturnType<typeof setTimeout> }
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

function parseIndex(value: unknown): Index {
  const index = value as Index
  if (!index || index.schemaVersion !== 1 || !Number.isSafeInteger(index.generation) || index.generation < 0 || !Array.isArray(index.entries) || index.entries.length > 32) throw new Error("PACK_IO")
  const ids = new Set<string>()
  for (const e of index.entries) {
    if (!isCharacterId(e.id) || ids.has(e.id) || !isRevision(e.current) || e.previous !== undefined && !isRevision(e.previous) || !Array.isArray(e.revisions) || e.revisions.length > 32 || !e.revisions.includes(e.current) || e.previous && !e.revisions.includes(e.previous) || e.revisions.some(r => !isRevision(r))) throw new Error("PACK_IO")
    ids.add(e.id)
  }
  return index
}

export class CharacterRegistry {
  private root: string
  private index: Index = { schemaVersion: 1, generation: 0, entries: [] }
  private readonly builtin = new Map<string, CharacterEntry>()
  private readonly inventories = new Map<string, ValidatedPack>()
  private readonly verified = new Map<string, ValidatedPack>()
  private readonly failures = new Map<string, string>()
  private readonly listeners = new Set<(value: CharacterSnapshot) => void>()
  private pending: Pending | null = null
  private busy = false
  private usedBytes = 0
  private viewGeneration = 0
  private warning: string | undefined
  private writable = true

  constructor(userData: string, private readonly builtinRoot: string, private readonly validate: PackValidator) { this.root = join(userData, "characters") }
  private revisionRoot(id: string, revision: string) { return join(this.root, "packs", id, "revisions", revision) }
  private key(id: string, revision: string) { return `${id}/${revision}` }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("PACK_BUSY")
    if (!this.writable) throw new Error("PACK_IO")
    this.busy = true
    try { return await work() } finally { this.busy = false }
  }

  async initialize(options: { deferRig?: boolean } = {}): Promise<void> {
    const catalog = JSON.parse(await readFile(join(this.builtinRoot, "catalog.json"), "utf8")) as { characters: string[] }
    for (const path of catalog.characters) {
      const c = JSON.parse(await readFile(join(this.builtinRoot, path), "utf8")) as { id: string; label: string; poses: unknown[] }
      if (!isCharacterId(c.id) || this.builtin.has(c.id)) throw new Error("Invalid built-in catalog")
      this.builtin.set(c.id, { id: c.id, name: c.label, source: "builtin", version: "builtin", revision: "builtin", manifestUrl: `pet://app/characters/${path}`, status: "ready", bytes: 0, poseCount: c.poses.length })
    }
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      if ((await lstat(this.root)).isSymbolicLink()) throw new Error("PACK_PATH")
      this.root = await realpath(this.root)
      await this.ensureDirectory(join(this.root, "staging"))
      await this.ensureDirectory(join(this.root, "packs"))
      const primary = join(this.root, "registry.json")
      try { this.index = parseIndex(JSON.parse(await readFile(primary, "utf8"))) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try { this.index = parseIndex(JSON.parse(await readFile(`${primary}.previous`, "utf8"))); await this.atomicWrite(primary, this.index); this.warning = "캐릭터 목록의 이전 정상 저장본을 복원했습니다." }
          catch (backupError) { if ((backupError as NodeJS.ErrnoException).code !== "ENOENT") throw backupError }
        } else {
          if (["EACCES", "EIO", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
          this.index = parseIndex(JSON.parse(await readFile(`${primary}.previous`, "utf8")))
          // Keep corrupt bytes for diagnosis; restore only a valid committed index.
          await rename(primary, `${primary}.corrupt-${Date.now()}`)
          await this.atomicWrite(primary, this.index)
          this.warning = "캐릭터 목록의 이전 정상 저장본을 복원했습니다."
        }
      }
      for (const entry of this.index.entries) {
        if (this.builtin.has(entry.id)) { this.failures.set(entry.id, "PACK_BUILTIN"); continue }
        for (const revision of entry.revisions) {
          try {
            const directory = this.revisionRoot(entry.id, revision)
            await this.requireDirectory(directory)
            const pack = await this.validate({ kind: "directory", path: directory, rig: !options.deferRig && revision === entry.current })
            if (pack.revision !== revision || pack.manifest.id !== entry.id) throw new Error("PACK_INTEGRITY")
            this.inventories.set(this.key(entry.id, revision), pack)
            if (!options.deferRig && revision === entry.current) this.verified.set(this.key(entry.id, revision), pack)
          } catch { if (revision === entry.current) this.failures.set(entry.id, "PACK_INTEGRITY") }
        }
      }
      await this.recoverStaging()
      this.usedBytes = await this.diskUsage()
    } catch {
      this.writable = false
      this.warning = "캐릭터 저장소를 읽지 못했습니다. 저장된 선택은 보존하며 기본 제공 캐릭터를 표시합니다."
    }
  }

  private entryFor(pack: ValidatedPack, previous?: ValidatedPack): CharacterEntry {
    const m = pack.manifest
    return { id: m.id, name: m.name, source: "external", version: m.version, revision: pack.revision, manifestUrl: packAssetUrl(m.id, pack.revision, m.entry), status: "ready", bytes: pack.bytes, poseCount: pack.poseCount,
      ...(m.update ? { update: m.update } : {}), ...(m.author ? { author: m.author } : {}), ...(m.thumbnail ? { thumbnailUrl: packAssetUrl(m.id, pack.revision, m.thumbnail) } : {}),
      ...(previous ? { previousVersion: previous.manifest.version } : {}), ...(m.profile ? { profile: m.profile } : {}), ...(m.unsupportedReactions ? { unsupportedReactions: m.unsupportedReactions } : {}),
    }
  }
  readyForUpdate(): boolean { return !this.busy && !this.pending }
  snapshot(): CharacterSnapshot {
    const external = this.index.entries.filter(e => !this.builtin.has(e.id)).map(e => {
      const pack = this.verified.get(this.key(e.id, e.current)), previous = e.previous ? this.inventories.get(this.key(e.id, e.previous)) : undefined
      const inventory = this.inventories.get(this.key(e.id, e.current))
      return pack ? this.entryFor(pack, previous) : inventory && !this.failures.has(e.id) ? { ...this.entryFor(inventory, previous), status: "pending" as const, manifestUrl: "", thumbnailUrl: undefined } : { id: e.id, name: e.id, source: "external" as const, version: "—", revision: e.current, manifestUrl: "", status: "disabled" as const, error: this.failures.get(e.id) ?? "PACK_UNAVAILABLE", bytes: 0, poseCount: 0 }
    })
    return structuredClone({ generation: this.index.generation + this.viewGeneration, entries: [...this.builtin.values(), ...external], storageBytes: this.usedBytes, storageLimitBytes: PACK_LIMITS.storageBytes, ...(this.warning ? { warning: this.warning } : {}) })
  }
  manifest(id: string) { const e = this.index.entries.find(e => e.id === id); return e ? structuredClone(this.inventories.get(this.key(id, e.current))?.manifest) : undefined }
  get(id: string): CharacterEntry | undefined { return this.snapshot().entries.find(e => e.id === id) }
  isAvailable = (id: string): boolean => this.get(id)?.status === "ready"
  requireSelection(selection: CharacterSelection): CharacterEntry {
    if (!selection || !isCharacterId(selection.id)) throw new Error("PACK_UNAVAILABLE")
    const entry = this.get(selection.id)
    if (!entry || entry.status !== "ready" || entry.revision !== selection.revision) throw new Error("PACK_UNAVAILABLE")
    return entry
  }
  /** Defer expensive rig decoding, never the asset authorization gate. */
  async ensureReady(selection: CharacterSelection, progress?: (value: PackProgress) => void): Promise<CharacterEntry> {
    const entry = this.get(selection.id)
    if (!entry || entry.revision !== selection.revision || entry.status === "disabled") throw new Error("PACK_UNAVAILABLE")
    if (entry.status === "ready") return entry
    return this.exclusive(async () => {
      const directory = this.revisionRoot(entry.id, entry.revision)
      try {
        await this.requireDirectory(directory)
        const pack = await this.validate({ kind: "directory", path: directory }, undefined, progress)
        if (pack.revision !== entry.revision || pack.manifest.id !== entry.id) throw new Error("PACK_INTEGRITY")
        this.verified.set(this.key(entry.id, entry.revision), pack)
        this.viewGeneration++
        this.changed()
        return this.requireSelection(selection)
      } catch (error) { this.failures.set(entry.id, "PACK_INTEGRITY"); this.viewGeneration++; this.changed(); throw error }
    })
  }
  catalog() { return { schemaVersion: 1, generation: this.index.generation + this.viewGeneration, characters: this.snapshot().entries.filter(e => e.status === "ready").map(e => e.manifestUrl) } }
  subscribe(listener: (snapshot: CharacterSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private changed() { const value = this.snapshot(); for (const listener of this.listeners) listener(value) }

  async prepareImport(source: string, owner: string, progress?: (value: PackProgress) => void): Promise<ImportPreview> {
    return this.exclusive(async () => {
      await this.cancelImport(owner)
      if (this.pending) throw new Error("PACK_BUSY")
      const disk = await statfs(this.root)
      if (disk.bavail * disk.bsize < PACK_LIMITS.archiveBytes + PACK_LIMITS.payloadBytes + 64 * 1024 * 1024) throw new Error("PACK_SPACE")
      const token = randomUUID(), root = join(this.root, "staging", token), controller = new AbortController()
      await mkdir(root, { mode: 0o700 })
      const expiresAt = Date.now() + PACK_LIMITS.transactionMs
      const pending: Pending = { token, owner, root, controller, expiresAt, generation: this.index.generation,
        timer: setTimeout(() => { void this.cancelImport(owner) }, PACK_LIMITS.transactionMs) }
      this.pending = pending
      try {
        const pack = await this.validate({ kind: "archive", path: source, transactionRoot: root }, controller.signal, progress)
        if (controller.signal.aborted || this.pending !== pending) throw new Error("PACK_CANCELLED")
        if (this.builtin.has(pack.manifest.id)) throw new Error("PACK_BUILTIN")
        const stored = this.index.entries.find(e => e.id === pack.manifest.id), current = this.get(pack.manifest.id)
        let kind: ImportPreview["kind"] = "install"
        if (stored) {
          for (const revision of stored.revisions) {
            const old = this.inventories.get(this.key(stored.id, revision))
            if (old?.manifest.version === pack.manifest.version && old.revision !== pack.revision) throw new Error("PACK_CONFLICT")
          }
          if (stored.current === pack.revision) kind = "installed"
          else if (current && current.status !== "disabled") {
            const compare = comparePackVersions(pack.manifest.version, current.version)
            if (compare < 0) throw new Error("PACK_DOWNGRADE")
            if (compare === 0) throw new Error("PACK_CONFLICT")
            kind = "update"
          } else kind = "update"
        }
        this.usedBytes = await this.diskUsage()
        if (this.usedBytes + (kind === "installed" ? 0 : pack.bytes) > PACK_LIMITS.storageBytes) throw new Error("PACK_SPACE")
        if (!stored && this.index.entries.length >= 32 || stored && stored.revisions.length >= 32 && !stored.revisions.includes(pack.revision)) throw new Error("PACK_LIMIT")
        pending.pack = pack; pending.kind = kind
        return { token, entry: this.entryFor(pack), kind, expiresAt, compatible: true, ...(current ? { previousVersion: current.version } : {}) }
      } catch (error) { await this.discard(pending); throw error }
    })
  }

  preparedManifest(token: string, owner: string) {
    const p = this.pending
    if (!p?.pack || p.token !== token || p.owner !== owner || p.expiresAt <= Date.now() || p.controller.signal.aborted) throw Error("PACK_TRANSACTION")
    return structuredClone(p.pack.manifest)
  }
  async commitImport(token: string, owner: string): Promise<CharacterEntry> {
    return this.exclusive(async () => {
      const pending = this.pending
      if (!pending || pending.owner !== owner || pending.token !== token || !pending.pack || pending.expiresAt < Date.now() || pending.generation !== this.index.generation || pending.controller.signal.aborted) throw new Error("PACK_TRANSACTION")
      const pack = pending.pack, id = pack.manifest.id
      pending.committing = true; clearTimeout(pending.timer)
      if (pending.kind === "installed") { await this.discard(pending); return this.get(id)! }
      // Staging is application-owned and the checked bytes are the bytes moved below.
      const next = structuredClone(this.index), old = next.entries.find(e => e.id === id)
      const directory = this.revisionRoot(id, pack.revision)
      try {
        await this.ensureDirectory(dirname(directory))
        await this.atomicWrite(join(pending.root, "journal.json"), { id, revision: pack.revision })
        if (pending.controller.signal.aborted) throw new Error("PACK_CANCELLED")
        if (!old?.revisions.includes(pack.revision)) await rename(join(pending.root, "payload"), directory)
        if (old) { old.previous = old.current; old.current = pack.revision; old.revisions = [...new Set([...old.revisions, pack.revision])] }
        else next.entries.push({ id, current: pack.revision, revisions: [pack.revision] })
        if (pending.controller.signal.aborted) throw new Error("PACK_CANCELLED")
        await this.commitIndex(next)
      } catch (error) {
        if (!this.index.entries.some(e => e.id === id && e.revisions.includes(pack.revision))) await this.removeRevision(id, pack.revision)
        await this.discard(pending); throw error
      }
      this.inventories.set(this.key(id, pack.revision), pack)
      this.verified.set(this.key(id, pack.revision), pack)
      this.failures.delete(id)
      await this.discard(pending).catch(() => {})
      this.usedBytes = await this.diskUsage().catch(() => this.usedBytes + pack.bytes)
      this.changed()
      return this.get(id)!
    })
  }

  async cancelImport(owner: string): Promise<void> {
    if (this.pending?.owner !== owner) return
    const pending = this.pending
    pending.controller.abort()
    // During validation its caller owns cleanup, after worker termination.
    if (pending.pack && !pending.committing) await this.discard(pending)
  }
  private async discard(pending: Pending) {
    clearTimeout(pending.timer)
    if (this.pending === pending) this.pending = null
    await rm(pending.root, { recursive: true, force: true })
  }
  async rollback(selection: CharacterSelection): Promise<void> {
    return this.exclusive(async () => {
      const currentEntry = this.get(selection.id)
      if (!currentEntry || currentEntry.status === "disabled" || currentEntry.revision !== selection.revision) throw new Error("PACK_UNAVAILABLE")
      const next = structuredClone(this.index), entry = next.entries.find(e => e.id === selection.id)
      if (!entry || !entry.previous || !this.inventories.has(this.key(entry.id, entry.previous))) throw new Error("PACK_UNAVAILABLE")
      // Archived revisions keep integrity-checked metadata at startup. Decode
      // and validate the complete rig before making any of their assets live.
      const directory = this.revisionRoot(entry.id, entry.previous)
      await this.requireDirectory(directory)
      const pack = await this.validate({ kind: "directory", path: directory })
      if (pack.revision !== entry.previous || pack.manifest.id !== entry.id) throw new Error("PACK_INTEGRITY")
      this.verified.set(this.key(entry.id, entry.previous), pack)
      const current = entry.current; entry.current = entry.previous; entry.previous = current
      await this.commitIndex(next); this.changed()
    })
  }
  async remove(selection: CharacterSelection): Promise<void> {
    return this.exclusive(async () => {
      if (this.builtin.has(selection.id)) throw new Error("PACK_BUILTIN")
      const stored = this.index.entries.find(e => e.id === selection.id && e.current === selection.revision)
      if (!stored) throw new Error("PACK_UNAVAILABLE")
      const next = structuredClone(this.index); next.entries = next.entries.filter(e => e.id !== selection.id)
      await this.commitIndex(next)
      for (const revision of stored.revisions) { await this.removeRevision(stored.id, revision); this.verified.delete(this.key(stored.id, revision)); this.inventories.delete(this.key(stored.id, revision)) }
      this.usedBytes = await this.diskUsage(); this.changed()
    })
  }
  async readPersonaAsset(selection: CharacterSelection, path: string): Promise<Uint8Array> {
    if (selection.id === "gpichan" && selection.revision === "builtin") return boundedFile(join(this.builtinRoot, "gpichan"), path, 64 * 1024)
    const pack = this.verified.get(this.key(selection.id, selection.revision))
    const expected = pack?.manifest.files.find(f => f.path === path)
    const file = await this.resolveAsset(selection.id, selection.revision, path)
    if (!file || !expected || expected.bytes > 64 * 1024) throw new Error("PACK_PERSONA")
    const bytes = await boundedFile(this.revisionRoot(selection.id, selection.revision), path, 64 * 1024)
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error("PACK_PERSONA")
    return bytes
  }
  async resolveAsset(id: string, revision: string, path: string): Promise<string | null> {
    const entry = this.index.entries.find(e => e.id === id)
    if (!entry?.revisions.includes(revision)) return null
    const pack = this.verified.get(this.key(id, revision))
    if (!pack?.manifest.files.some(f => f.path === path)) return null
    const root = this.revisionRoot(id, revision)
    try { await this.requireDirectory(root); return await containedFile(root, path) } catch { return null }
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.tmp-${randomUUID()}`, file = await open(temporary, "wx", 0o600)
    try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  }
  private async commitIndex(next: Index) {
    next.generation = this.index.generation + 1
    const file = join(this.root, "registry.json")
    await this.atomicWrite(`${file}.previous`, this.index)
    await this.atomicWrite(file, next)
    this.index = next
  }
  private async ensureDirectory(directory: string) {
    if (directory !== this.root && !directory.startsWith(this.root + sep)) throw new Error("PACK_PATH")
    let path = this.root
    for (const part of directory.slice(this.root.length).split(sep).filter(Boolean)) {
      path = join(path, part); await mkdir(path, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e })
      if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error("PACK_PATH")
    }
  }
  private async requireDirectory(directory: string) {
    if (!directory.startsWith(this.root + sep) || await realpath(directory) !== resolve(directory)) throw new Error("PACK_PATH")
  }
  private async diskUsage(): Promise<number> {
    const walk = async (path: string): Promise<number> => {
      let total = 0
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) total += await walk(join(path, entry.name))
        else if (entry.isFile()) total += (await lstat(join(path, entry.name))).size
      }
      return total
    }
    return walk(join(this.root, "packs"))
  }
  private async removeRevision(id: string, revision: string) {
    const root = this.revisionRoot(id, revision)
    try {
      await this.requireDirectory(root)
      const manifestPath = await containedFile(root, "pack.json"), bytes = await readFile(manifestPath), manifest = parsePackManifest(bytes)
      if (manifest.id !== id) return
      // Only unchanged inventory files are owned. User-added/modified files remain.
      for (const f of manifest.files) {
        try { const file = await containedFile(root, f.path); if ((await lstat(file)).size === f.bytes && sha256(await readFile(file)) === f.sha256) await rm(file) } catch { /* Preserve unknown data. */ }
      }
      await rm(manifestPath)
      const prune = async (dir: string) => { for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await prune(join(dir, e.name)); await rmdir(dir).catch(() => {}) }
      await prune(root)
    } catch { /* Never recursively delete an unverified revision. */ }
  }
  private async recoverStaging() {
    const staging = join(this.root, "staging")
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      if (!uuid.test(entry.name) || !entry.isDirectory()) continue
      const root = join(staging, entry.name)
      try {
        const journal = JSON.parse(await readFile(join(root, "journal.json"), "utf8")) as { id: string; revision: string }
        if (isCharacterId(journal.id) && isRevision(journal.revision) && !this.index.entries.some(e => e.id === journal.id && e.revisions.includes(journal.revision))) await this.removeRevision(journal.id, journal.revision)
      } catch { /* A transaction may have stopped before revision finalization. */ }
      await rm(root, { recursive: true, force: true })
    }
  }
  async dispose(): Promise<void> { if (this.pending) { this.pending.controller.abort(); clearTimeout(this.pending.timer) } this.listeners.clear() }
}
