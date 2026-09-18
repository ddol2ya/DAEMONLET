import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { isCharacterId, isPackVersion } from "../../shared/character-pack-contract"
import { parseUpdateFeed, parseUpdateSource, updateSourceKey, type PackUpdateSource, type PackUpdateFeed } from "../../shared/pack-update-contract"

export type PackUpdatePreference = { packId: string; source: PackUpdateSource; autoCheck: boolean; skipped?: string; checkedAt?: number; feed?: PackUpdateFeed; etag?: string }
export class PackUpdatePreferences {
  private rows: PackUpdatePreference[] = []
  private tail: Promise<unknown> = Promise.resolve()
  private writable = true
  constructor(private readonly path: string) {}
  async load() {
    try {
      if ((await stat(this.path)).size > 3 * 1024 * 1024) throw Error("PACK_IO")
      const value = JSON.parse(await readFile(this.path, "utf8"))
      if (value?.schemaVersion !== 1 || !Array.isArray(value.rows) || value.rows.length > 32) throw Error("PACK_IO")
      const ids = new Set<string>()
      this.rows = value.rows.map((r: PackUpdatePreference) => {
        if (!r || !isCharacterId(r.packId) || ids.has(r.packId) || typeof r.autoCheck !== "boolean" || r.skipped !== undefined && !isPackVersion(r.skipped) || r.checkedAt !== undefined && (!Number.isSafeInteger(r.checkedAt) || r.checkedAt < 0) || r.etag !== undefined && (typeof r.etag !== "string" || r.etag.length > 256 || /[\u0000-\u001f\u007f]/.test(r.etag))) throw Error("PACK_IO")
        ids.add(r.packId)
        const source = parseUpdateSource(r.source), feed = r.feed ? parseUpdateFeed(Buffer.from(JSON.stringify(r.feed))) : undefined
        if (feed && feed.packId !== r.packId) throw Error("PACK_IO")
        return { packId: r.packId, source, autoCheck: r.autoCheck, skipped: r.skipped, checkedAt: r.checkedAt, etag: r.etag, feed }
      })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.rows = []; this.writable = false; throw Error("PACK_IO") } }
  }
  get(packId: string, source: PackUpdateSource) { const row = this.rows.find(r => updateSourceKey(r.packId, r.source) === updateSourceKey(packId, source)); return row ? structuredClone(row) : undefined }
  async save(row: PackUpdatePreference) { return this.update(row.packId, () => row) }
  async update(packId: string, change: (previous: PackUpdatePreference | undefined) => PackUpdatePreference) {
    const work = this.tail.catch(() => {}).then(async () => {
      if (!this.writable) throw Error("PACK_IO")
      const row = change(structuredClone(this.rows.find(r => r.packId === packId)))
      const rows = [...this.rows.filter(r => r.packId !== row.packId), structuredClone(row)]
      if (rows.length > 32) throw Error("PACK_LIMIT")
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = this.path + ".tmp-" + randomUUID()
      try {
        const file = await open(temporary, "wx", 0o600)
        try { await file.writeFile(JSON.stringify({ schemaVersion: 1, rows }) + "\n"); await file.sync() } finally { await file.close() }
        await rename(temporary, this.path); this.rows = rows
      } catch { throw Error("PACK_IO") } finally { await rm(temporary, { force: true }) }
    })
    this.tail = work; await work
  }
}
