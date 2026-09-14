import { constants } from "node:fs"
import { open, lstat, realpath, readdir, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import type { NormalizedCodexEvent } from "../types.ts"
import { hasLocalFilePermissions } from "./LocalFilePolicy.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LINE = 64 * 1024, MAX_DELTA = 2 * 1024 * 1024, MAX_SESSIONS = 64
const SESSION_TTL = 24 * 60 * 60 * 1000
type Target = { sessionId: string; source?: "desktop" | "cli"; since: number | null; bootstrap: boolean; touchedAt: number; retryAt: number; turns: Set<string>; path: string | null; file: FileHandle | null; offset: number; dev: number; ino: number; pending: Buffer; skipping: boolean }
export type LocalConversationTarget = { sessionId: string; turnId: string; path: string; source?: "desktop" | "cli" }

/** Reads future lifecycle records for Hook-observed sessions and locally created sessions since start.
 * No renderer/wire-supplied paths, old-history replay, or retained message bodies.
 */
export class CodexLifecycleObserver {
  private readonly targets = new Map<string, Target>()
  private readonly excluded = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private pending: Promise<void> | null = null
  private stopped = false
  private root: string | null = null
  private startedAt: number | null = null
  private nextDiscoveryAt = 0
  constructor(private readonly options: {
    home: string
    onEvent(event: NormalizedCodexEvent): Promise<void>
    onTarget?(target: LocalConversationTarget): void
    now?: () => number
  }) {}
  private now() { return (this.options.now ?? Date.now)() }

  start(): void {
    if (this.timer) return
    this.stopped = false; this.startedAt = this.now()
    this.timer = setInterval(() => { void this.poll() }, 400); this.timer.unref()
    void this.poll()
  }
  private adopt(sessionId: string): Target | null {
    const existing = this.targets.get(sessionId)
    if (existing) return existing
    if (this.targets.size >= MAX_SESSIONS) return null
    const created = sessionId[14] === "7" ? parseInt(sessionId.replaceAll("-", "").slice(0, 12), 16) : 0
    const since = this.startedAt !== null && created >= this.startedAt ? this.startedAt : null
    const target: Target = { sessionId, since, bootstrap: since !== null, touchedAt: this.now(), retryAt: 0, turns: new Set(), path: null, file: null, offset: 0, dev: 0, ino: 0, pending: Buffer.alloc(0), skipping: false }
    this.targets.set(sessionId, target)
    return target
  }
  observe(sessionId: string, turnId?: string): void {
    if (this.stopped || !UUID.test(sessionId)) return
    const target = this.adopt(sessionId)
    if (!target) return
    target.touchedAt = this.now()
    if (turnId && UUID.test(turnId)) {
      const known = target.turns.has(turnId)
      target.turns.add(turnId)
      while (target.turns.size > 128) target.turns.delete(target.turns.values().next().value!)
      if (target.path && !known) this.options.onTarget?.({ sessionId, turnId, path: target.path, source: target.source })
    }
    void this.poll()
  }

  /** Public for deterministic verification; the production owner uses one coalesced timer. */
  poll(): Promise<void> {
    if (this.pending) return this.pending
    if (this.stopped) return Promise.resolve()
    this.pending = this.scan().catch(() => {}).finally(() => { this.pending = null })
    return this.pending
  }
  private async scan(): Promise<void> {
    if (this.startedAt !== null && this.now() >= this.nextDiscoveryAt) {
      this.nextDiscoveryAt = this.now() + 1000
      await this.discover().catch(() => {})
    }
    // A fixed total read budget prevents a busy transcript from monopolizing the utility process.
    let budget = MAX_DELTA
    for (const target of [...this.targets.values()]) {
      if (this.stopped) break
      if (this.now() - target.touchedAt > SESSION_TTL) { await this.close(target); this.targets.delete(target.sessionId); continue }
      try {
        if (!target.file) { if (target.retryAt <= this.now()) await this.pin(target); continue }
        if (budget <= 0) break
        const used = await this.read(target, Math.min(budget, 512 * 1024))
        budget -= used
      } catch { await this.close(target); target.retryAt = this.now() + 5000 }
    }
  }
  private async directory(path: string): Promise<boolean> {
    const info = await lstat(path).catch(() => null)
    return Boolean(info?.isDirectory() && !info.isSymbolicLink() && hasLocalFilePermissions(info))
  }
  private async ensureRoot(): Promise<string | null> {
    if (this.root) return this.root
    const home = await realpath(this.options.home)
    if (!await this.directory(home) || !await this.directory(join(home, "sessions"))) return null
    this.root = join(home, "sessions")
    return this.root
  }
  private async day(at: number): Promise<string | null> {
    let dir = await this.ensureRoot()
    if (!dir) return null
    for (const part of new Date(at).toISOString().slice(0, 10).split("-")) {
      dir = join(dir, part)
      if (!await this.directory(dir)) return null
    }
    return dir
  }
  private async discover(): Promise<void> {
    if (this.startedAt === null) return
    // UUIDv7 supplies a creation clock without reading old transcripts. Only current-day
    // directories are inventoried; all candidate files still go through pin/header checks.
    for (const offset of [0, -86400000, 86400000]) {
      const dir = await this.day(this.now() + offset)
      if (!dir) continue
      const entries = await readdir(dir, { withFileTypes: true })
      if (entries.length > 4096) continue
      for (const entry of entries) {
        if (this.stopped || this.targets.size >= MAX_SESSIONS) return
        if (!entry.isFile()) continue
        const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name)
        if (!match || this.targets.has(match[1]) || this.excluded.has(match[1])) continue
        const created = parseInt(match[1].replaceAll("-", "").slice(0, 12), 16)
        if (created >= this.startedAt && created <= this.now() + 5000) this.adopt(match[1])
      }
    }
  }
  private async pin(target: Target): Promise<void> {
    target.retryAt = this.now() + (target.bootstrap ? 400 : 5000)
    if (!await this.ensureRoot()) return
    // Current ChatGPT uses UUIDv7. Its creation day locates the rollout without walking history.
    const created = target.sessionId[14] === "7" ? parseInt(target.sessionId.replaceAll("-", "").slice(0, 12), 16) : this.now()
    if (!Number.isFinite(created) || created < Date.UTC(2022, 0) || created > this.now() + 86400000) return
    for (const offset of [0, -86400000, 86400000]) {
      const dir = await this.day(created + offset)
      if (!dir) continue
      const entries = await readdir(dir, { withFileTypes: true })
      if (entries.length > 4096) continue
      const names = entries.filter(e => e.isFile() && e.name.endsWith(`-${target.sessionId}.jsonl`) && /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/.test(e.name))
      if (names.length !== 1) continue
      const path = join(dir, names[0].name)
      if (await realpath(path) !== path) continue
      const named = await lstat(path)
      if (!named.isFile() || named.isSymbolicLink() || !hasLocalFilePermissions(named) || named.nlink !== 1) continue
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        const after = await lstat(path)
        if (!info.isFile() || !hasLocalFilePermissions(info) || info.nlink !== 1 || after.isSymbolicLink()
          || named.dev !== info.dev || named.ino !== info.ino || after.dev !== info.dev || after.ino !== info.ino) continue
        const first = Buffer.alloc(MAX_LINE)
        const { bytesRead } = await file.read(first, 0, first.length, 0)
        const end = first.subarray(0, bytesRead).indexOf(10)
        if (end < 0) continue
        const header = JSON.parse(first.subarray(0, end).toString("utf8"))
        if (header.type !== "session_meta" || header.payload?.id !== target.sessionId) continue
        target.source = ["cli", "exec"].includes(header.payload.source) ? "cli" : header.payload.source === "vscode" ? "desktop" : undefined
        if (target.bootstrap && !["cli", "vscode", "exec", "appServer", "app_server"].includes(header.payload.source)) {
          // Internal subagents also have rollout files. Their parent owns their Task
          // events; discovery must not promote them into additional top-level Runs.
          this.targets.delete(target.sessionId); this.excluded.add(target.sessionId)
          while (this.excluded.size > 4096) this.excluded.delete(this.excluded.values().next().value!)
          return
        }
        if (this.stopped) return
        const bootstrap = target.bootstrap
        target.path = path; target.file = file; target.offset = bootstrap ? Math.max(end + 1, info.size - 512 * 1024) : info.size; target.dev = info.dev; target.ino = info.ino
        target.bootstrap = false
        // Pre-existing sessions baseline EOF. New sessions include their first start, but
        // only records newer than observer startup can be emitted (including copied/fork history).
        const last = Buffer.alloc(1)
        if (target.offset) { await file.read(last, 0, 1, target.offset - 1); target.skipping = last[0] !== 10 }
        for (const turnId of target.turns) this.options.onTarget?.({ sessionId: target.sessionId, turnId, path, source: target.source })
        return
      } finally { if (target.file !== file) await file.close() }
    }
  }
  private async read(target: Target, budget: number): Promise<number> {
    const file = target.file!, path = target.path!
    const named = await lstat(path)
    if (!named.isFile() || named.isSymbolicLink() || !hasLocalFilePermissions(named) || named.nlink !== 1 || named.dev !== target.dev || named.ino !== target.ino || await realpath(path) !== path) throw new Error("changed lifecycle file")
    const info = await file.stat()
    if (info.size < target.offset) {
      // Truncation loses observation, not the task itself. A live owner can
      // reconcile it; never tombstone an active turn because a file changed.
      target.offset = info.size; target.pending = Buffer.alloc(0); target.skipping = true
      return 0
    }
    if (info.size - target.offset > MAX_DELTA) {
      // Large tool output can arrive while Codex is reconnecting. Skip the
      // unbounded body, then resume bounded lifecycle framing at its tail.
      target.offset = info.size - MAX_DELTA
      target.pending = Buffer.alloc(0); target.skipping = true
    }
    const size = Math.min(info.size - target.offset, budget)
    if (!size) return 0
    const chunk = Buffer.alloc(size)
    const { bytesRead } = await file.read(chunk, 0, size, target.offset)
    target.offset += bytesRead
    let start = 0
    while (start < bytesRead) {
      const end = chunk.indexOf(10, start), stop = end < 0 ? bytesRead : end
      const part = chunk.subarray(start, stop)
      if (!target.skipping) {
        if (target.pending.length + part.length > MAX_LINE) { target.pending = Buffer.alloc(0); target.skipping = true }
        else target.pending = Buffer.concat([target.pending, part])
      }
      if (end >= 0) {
        if (!target.skipping) await this.line(target, target.pending)
        target.pending = Buffer.alloc(0); target.skipping = false
      }
      start = stop + 1
    }
    return bytesRead
  }
  private async line(target: Target, line: Buffer): Promise<void> {
    if (this.stopped) return
    let row: any
    try { row = JSON.parse(line.toString("utf8")) } catch { return }
    if (row.type !== "event_msg") return
    const p = row.payload, turnId = p?.turn_id, at = Date.parse(row.timestamp)
    if (typeof turnId !== "string" || !UUID.test(turnId) || !Number.isFinite(at) || at > this.now() + 5000 || at < this.now() - SESSION_TTL || target.since !== null && at < target.since) return
    const common = { sessionId: target.sessionId, turnId, observedAt: at, backend: "HOOK_OBSERVER" as const }
    let event: NormalizedCodexEvent
    if (p.type === "task_started") event = { ...common, type: "run.started" }
    else if (p.type === "turn_aborted") event = { ...common, type: "run.cancelled", reason: p.reason === "interrupted" ? "interrupted" : "lifecycle-aborted" }
    else if (p.type === "task_complete") event = { ...common, type: "run.completed", confidence: "hook-stop" }
    else return
    const known = target.turns.has(turnId)
    target.touchedAt = this.now(); target.turns.add(turnId)
    while (target.turns.size > 128) target.turns.delete(target.turns.values().next().value!)
    if (!known) this.options.onTarget?.({ sessionId: target.sessionId, turnId, path: target.path!, source: target.source })
    await this.options.onEvent(event)
  }
  private async close(target: Target): Promise<void> { const file = target.file; target.file = null; target.path = null; target.pending = Buffer.alloc(0); await file?.close().catch(() => {}) }
  async stop(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null
    await this.pending; await Promise.all([...this.targets.values()].map(t => this.close(t))); this.targets.clear(); this.excluded.clear()
  }
}
