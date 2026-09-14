import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { parseUniqueJson } from "../../../adapter/codex/hooks/HookJson"
import { PROTOCOL_TASK_KINDS } from "../../../src/protocol/types"
import { ACTIVITY_ACTIVE_LIMIT, ACTIVITY_HISTORY_LIMIT, ACTIVITY_TOMBSTONE_LIMIT, isActivityId } from "../../shared/activity-contract"
import type { ActivityHistoryData } from "./ActivityStore"

const MAX_BYTES = 1024 * 1024
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const time = (v: unknown): v is number => integer(v) && v <= 8.64e15
const nullableTime = (v: unknown) => v === null || time(v)
const key = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)

export function validateActivityHistory(value: unknown): ActivityHistoryData | null {
  if (!object(value) || !fields(value, ["version", "nextId", "records", "tombstones", "droppedUnread", "lastPrunedAt", "capacityLimited"])
    || value.version !== 1 || !integer(value.nextId) || value.nextId < 1 || value.nextId > 1e15
    || !integer(value.droppedUnread) || !nullableTime(value.lastPrunedAt) || typeof value.capacityLimited !== "boolean"
    || !Array.isArray(value.records) || value.records.length > ACTIVITY_ACTIVE_LIMIT + ACTIVITY_HISTORY_LIMIT
    || !Array.isArray(value.tombstones) || value.tombstones.length > ACTIVITY_TOMBSTONE_LIMIT) return null
  const keys = new Set<string>(), ids = new Set<string>()
  let active = 0, history = 0
  for (const r of value.records) {
    if (!object(r) || !fields(r, ["key", "activityId", "state", "revision", "firstObservedAt", "lastObservedAt", "endedAt", "acknowledgedAt", "confidence", "category", "eventAt"])
      || !key(r.key) || keys.has(r.key) || !isActivityId(r.activityId) || ids.has(r.activityId) || Number(r.activityId.slice(9)) >= value.nextId
      || !["running", "waiting", "completed", "failed", "cancelled", "unknown"].includes(String(r.state))
      || !integer(r.revision) || r.revision < 1 || !time(r.firstObservedAt) || !time(r.lastObservedAt) || !time(r.eventAt)
      || !nullableTime(r.endedAt) || !nullableTime(r.acknowledgedAt)
      || r.confidence !== null && r.confidence !== "observed" && r.confidence !== "authoritative"
      || r.category !== null && !PROTOCOL_TASK_KINDS.includes(r.category as typeof PROTOCOL_TASK_KINDS[number])) return null
    const isActive = r.state === "running" || r.state === "waiting"
    if (isActive ? r.endedAt !== null || r.acknowledgedAt !== null : r.endedAt === null) return null
    if (r.state !== "completed" && r.confidence !== null || r.state !== "completed" && r.state !== "failed" && r.acknowledgedAt !== null) return null
    isActive ? active++ : history++
    keys.add(r.key); ids.add(r.activityId)
  }
  if (active > ACTIVITY_ACTIVE_LIMIT || history > ACTIVITY_HISTORY_LIMIT) return null
  for (const t of value.tombstones) {
    if (!object(t) || !fields(t, ["key", "expiresAt"]) || !key(t.key) || keys.has(t.key) || !time(t.expiresAt)) return null
    keys.add(t.key)
  }
  return structuredClone(value) as ActivityHistoryData
}

export type ActivityHistoryLoad = { data: ActivityHistoryData | null; issue: "corrupt" | "error" | null }
export interface ActivityPersistence {
  load(): Promise<ActivityHistoryLoad>
  save(data: ActivityHistoryData): Promise<void>
}

/** Own private subdirectory, bounded schema, fsync + same-filesystem atomic replacement. */
export class ActivityHistoryStore implements ActivityPersistence {
  readonly directory: string
  readonly path: string
  constructor(userData: string) { this.directory = join(userData, "activity"); this.path = join(this.directory, "history.json") }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new Error("ACTIVITY_STORAGE")
    if (process.platform !== "win32") await chmod(this.directory, 0o700)
  }

  async load(): Promise<ActivityHistoryLoad> {
    try { await this.prepare() } catch { return { data: null, issue: "error" } }
    let contents: string
    try {
      // Windows does not supply O_NOFOLLOW. Check the named entry and compare
      // it with the opened handle before reading or changing permissions.
      const named = await lstat(this.path)
      if (named.isSymbolicLink() || named.nlink !== 1) throw new Error("ACTIVITY_STORAGE")
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        const after = await lstat(this.path)
        if (after.isSymbolicLink() || stat.nlink !== 1 || named.dev !== stat.dev || named.ino !== stat.ino
          || after.dev !== stat.dev || after.ino !== stat.ino) throw new Error("ACTIVITY_STORAGE")
        if (!stat.isFile()) throw new Error("ACTIVITY_CORRUPT")
        if (process.platform !== "win32") await file.chmod(0o600)
        if (stat.size > MAX_BYTES) throw new Error("ACTIVITY_CORRUPT")
        contents = await file.readFile("utf8")
        if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("ACTIVITY_CORRUPT")
      } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: null, issue: null }
      if (error instanceof Error && error.message === "ACTIVITY_CORRUPT") return this.quarantine()
      return { data: null, issue: "error" }
    }
    try {
      const data = validateActivityHistory(parseUniqueJson(contents))
      if (data) return { data, issue: null }
    } catch { /* Invalid JSON is quarantined without logging any of its contents. */ }
    return this.quarantine()
  }

  private async quarantine(): Promise<ActivityHistoryLoad> {
    // One bounded quarantine slot; repeated corrupt files cannot grow an unbounded archive.
    try { await rename(this.path, join(this.directory, "history.corrupt.json")); return { data: null, issue: "corrupt" } }
    catch { return { data: null, issue: "error" } }
  }

  async save(data: ActivityHistoryData): Promise<void> {
    const safe = validateActivityHistory(data)
    if (!safe) throw new Error("ACTIVITY_STORAGE")
    const contents = JSON.stringify(safe) + "\n"
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("ACTIVITY_STORAGE")
    await this.prepare()
    const temporary = join(this.directory, `history.tmp-${randomUUID()}`)
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
      await rename(temporary, this.path)
      if (process.platform !== "win32") {
        const directory = await open(this.directory, constants.O_RDONLY)
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally { await unlink(temporary).catch(() => {}) }
  }
}
