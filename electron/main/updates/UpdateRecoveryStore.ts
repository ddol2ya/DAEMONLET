import { mkdir, readFile, stat, unlink } from "node:fs/promises"
import { writeFileSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { gte, valid, prerelease } from "semver"

type Attempt = { schemaVersion: 1; id: string; fromVersion: string; targetVersion: string; failed: boolean }
const stable = (value: unknown): value is string => typeof value === "string" && Boolean(valid(value)) && !prerelease(value)
/** Only version/attempt metadata; never conversation text, paths, credentials or raw errors. */
export class UpdateRecoveryStore {
  private readonly file: string
  private attempt: Attempt | null = null
  constructor(private readonly root: string) { this.file = join(root, "update-attempt.json") }
  async read(currentVersion: string): Promise<Attempt | null> {
    try {
      if ((await stat(this.file)).size > 4096) return null
      const value = JSON.parse(await readFile(this.file, "utf8"))
      if (value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id) || !stable(value.fromVersion) || !stable(value.targetVersion) || typeof value.failed !== "boolean") return null
      this.attempt = { schemaVersion: 1, id: value.id, fromVersion: value.fromVersion, targetVersion: value.targetVersion, failed: value.failed }
      if (valid(currentVersion) && gte(currentVersion, value.targetVersion)) { await this.clear(); return null }
      return this.attempt
    } catch { return null }
  }
  async begin(id: string, fromVersion: string, targetVersion: string) {
    await mkdir(this.root, { recursive: true })
    this.attempt = { schemaVersion: 1, id, fromVersion, targetVersion, failed: false }
    this.write()
  }
  failed(id: string) {
    if (this.attempt?.id !== id) return
    this.attempt.failed = true
    // Error events can race native quit. Persist synchronously while this process
    // still owns the callback; the pre-written pending record remains on failure.
    try { this.write() } catch { /* The pending record already provides next-launch recovery. */ }
  }
  async clear() { await unlink(this.file).catch(() => {}); this.attempt = null }
  private write() {
    const temporary = this.file + "." + this.attempt!.id + ".tmp"
    try {
      writeFileSync(temporary, JSON.stringify(this.attempt), { mode: 0o600, flag: "wx" })
      renameSync(temporary, this.file)
    } finally { try { unlinkSync(temporary) } catch { /* Already renamed or not created. */ } }
  }
}
