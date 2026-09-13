import { open, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { mkdir } from "node:fs/promises"
import { defaultDesktopSettings, normalizeDesktopSettings, type DesktopSettingsV1 } from "../shared/desktop-settings"

export type SettingsLoadResult = { value: DesktopSettingsV1; warning: string | null; quarantinedPath: string | null }

export class WindowBoundsStore {
  readonly path: string
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.path = join(userDataPath, "desktop-settings.json")
  }

  async load(characterAllowed?: (id: string) => boolean): Promise<SettingsLoadResult> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown
      const normalized = normalizeDesktopSettings(parsed, characterAllowed)
      if (normalized.migrated) await this.save(normalized.value)
      return { value: normalized.value, warning: normalized.warnings[0] ?? null, quarantinedPath: null }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: defaultDesktopSettings(), warning: null, quarantinedPath: null }
      const quarantinedPath = `${this.path}.corrupt-${Date.now()}`
      try { await rename(this.path, quarantinedPath) } catch { /* preserve the original error as the diagnostic */ }
      return { value: defaultDesktopSettings(), warning: "Corrupt desktop settings were quarantined and defaults restored", quarantinedPath }
    }
  }

  save(value: DesktopSettingsV1): Promise<void> {
    // A bounds debounce and shutdown can save in the same millisecond. Keep
    // snapshots in request order and wait for the previous atomic rename.
    const text = `${JSON.stringify(value, null, 2)}\n`
    const write = () => this.writeSnapshot(text)
    const pending = this.pendingWrite.then(write, write)
    this.pendingWrite = pending.catch(() => {})
    return pending
  }

  private async writeSnapshot(text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`
    const handle = await open(temporary, "w", 0o600)
    try {
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.path)
  }
}
