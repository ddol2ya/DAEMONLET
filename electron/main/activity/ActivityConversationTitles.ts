import type { DesktopThreadMetadata } from "../control/DesktopThreadCatalog"
import { sameLocalCodexConversationPath } from "../control/CodexThreadLauncher"

type Target = { threadId: string; rolloutPath: string }

/** Ephemeral labels for already verified conversation targets, using the existing metadata index. */
export class ActivityConversationTitles {
  private targets = new Map<string, Target>()
  private catalog: readonly DesktopThreadMetadata[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private reading: Promise<void> | null = null
  private requested = false
  private version = 0
  private disposed = false
  constructor(private readonly read: () => Promise<readonly DesktopThreadMetadata[]>, private readonly publish: (titles: ReadonlyMap<string, string>) => void) {}

  setTargets(targets: ReadonlyMap<string, Target>): void {
    if (this.disposed) return
    const next = new Map([...targets].slice(0, 256).map(([key, target]) => [key, { ...target }]))
    if (next.size === this.targets.size && [...next].every(([key, t]) => this.targets.get(key)?.threadId === t.threadId && this.targets.get(key)?.rolloutPath === t.rolloutPath)) return
    this.targets = next; this.version++; this.publishTitles()
    if (!next.size) { if (this.timer) clearInterval(this.timer); this.timer = null; this.catalog = []; return }
    if (!this.timer) { this.timer = setInterval(() => { void this.refresh() }, 5000); this.timer.unref?.() }
    void this.refresh()
  }

  refresh(): Promise<void> {
    if (this.disposed || !this.targets.size) return Promise.resolve()
    this.requested = true
    if (!this.reading) this.reading = this.drain().finally(() => { this.reading = null })
    return this.reading
  }
  private async drain(): Promise<void> {
    while (this.requested && !this.disposed && this.targets.size) {
      this.requested = false
      const version = this.version
      const rows = await this.read().catch(() => [])
      if (this.disposed) return
      if (version !== this.version) { this.requested = true; continue }
      this.catalog = rows.slice(0, 64); this.publishTitles()
    }
  }
  private publishTitles(): void {
    const titles = new Map<string, string>()
    for (const [key, target] of this.targets) {
      const row = this.catalog.find(row => row.id === target.threadId && sameLocalCodexConversationPath(row.path, target.rolloutPath, row.id))
      const title = row?.title.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120)
      if (title) titles.set(key, title)
    }
    this.publish(titles)
  }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.targets.clear(); this.catalog = [] }
}
