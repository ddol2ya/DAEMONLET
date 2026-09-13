import { activityCorrelationKey as correlation } from "../../../adapter/codex/privacy/CanonicalId"
import type { AcceptedProtocolFrame, ProtocolConnectionState, ProtocolTaskKind } from "../../../src/protocol/types"
import { PROTOCOL_TASK_KINDS } from "../../../src/protocol/types"
import { ACTIVITY_ACTIVE_LIMIT, ACTIVITY_HISTORY_AGE_MS, ACTIVITY_HISTORY_LIMIT, ACTIVITY_TOMBSTONE_LIMIT, type ActivityAckRequest, type ActivityEntry, type ActivitySnapshot, type ActivityState } from "../../shared/activity-contract"

export type ActivityRecord = Omit<ActivityEntry, "name" | "unread" | "freshness" | "canOpenConversation"> & { key: string; eventAt: number }
export type ActivityHistoryData = {
  version: 1
  nextId: number
  records: ActivityRecord[]
  tombstones: Array<{ key: string; expiresAt: number }>
  droppedUnread: number
  lastPrunedAt: number | null
  capacityLimited: boolean
}
const active = (s: ActivityState) => s === "running" || s === "waiting"
const final = (s: ActivityState) => s === "completed" || s === "failed" || s === "cancelled"
const unread = (r: ActivityRecord) => (r.state === "completed" || r.state === "failed") && r.acknowledgedAt === null
const priority = (r: ActivityRecord) => r.state === "waiting" ? 0 : unread(r) ? r.state === "failed" ? 1 : 2 : r.state === "running" ? 3 : 4
// Keep arbitrary valid wire IDs out of persistence as well as out of the DTO.

/** Deterministic state transitions. No timers, I/O, renderer or character ownership. */
export class ActivityStore {
  private readonly records = new Map<string, ActivityRecord>()
  private readonly confirmed = new Set<string>()
  private readonly tombstones = new Map<string, number>()
  private nextId = 1
  private connection: ProtocolConnectionState = "DISCONNECTED"
  private droppedUnread = 0
  private lastPrunedAt: number | null = null
  private capacityLimited = false
  private lastObservedAt: number | null = null

  constructor(private readonly now: () => number = Date.now) {}

  restore(data: ActivityHistoryData): void {
    this.records.clear(); this.confirmed.clear(); this.tombstones.clear()
    this.nextId = data.nextId
    this.droppedUnread = data.droppedUnread
    this.lastPrunedAt = data.lastPrunedAt
    this.capacityLimited = data.capacityLimited
    for (const r of data.records) this.records.set(r.key, { ...r })
    for (const t of data.tombstones) this.tombstones.set(t.key, t.expiresAt)
    this.lastObservedAt = data.records.length ? Math.max(...data.records.map(r => r.lastObservedAt)) : null
    this.connection = "DISCONNECTED"
    this.prune()
  }

  setConnection(state: ProtocolConnectionState): boolean {
    if (state === this.connection) return false
    this.connection = state
    if (state !== "READY") this.confirmed.clear()
    return true
  }

  accept(frame: AcceptedProtocolFrame): boolean {
    if (frame.source !== "codex-adapter" || frame.frameType !== "event" && frame.frameType !== "snapshot") return false
    const at = this.now()
    const capacityBefore = this.capacityLimited
    let changed = this.prune()
    if (frame.frameType === "snapshot") {
      const present = new Set(frame.payload.activeRuns.map(r => correlation(r.runId)))
      for (const r of this.records.values()) {
        if (active(r.state) && !present.has(r.key) && frame.sentAt >= r.eventAt) {
          this.transition(r, "unknown", at, frame.sentAt)
          changed = true
        }
      }
      for (const run of frame.payload.activeRuns) {
        const r = this.obtain(run.runId, at, frame.sentAt)
        if (!r || final(r.state) || frame.sentAt < r.eventAt) continue
        this.transition(r, run.waitingFor ? "waiting" : "running", at, frame.sentAt)
        r.category = run.tasks.map(t => t.kind).find((k): k is ProtocolTaskKind => k !== undefined && PROTOCOL_TASK_KINDS.includes(k)) ?? null
        this.confirmed.add(r.key)
        changed = true
      }
      this.lastObservedAt = at
      changed = true
    } else {
      const event = frame.payload
      const key = correlation(event.runId)
      let r = this.records.get(key)
      // Child activity is optional reference information, never a new top-level Run.
      if (event.type.startsWith("task.") || event.type === "run.progress") {
        if (!r || !active(r.state) || frame.sentAt < r.eventAt) return changed
        const category = "kind" in event && event.kind && PROTOCOL_TASK_KINDS.includes(event.kind) ? event.kind : r.category
        if (category === r.category && this.confirmed.has(key)) return changed
        r.category = category
        r.lastObservedAt = at; r.eventAt = frame.sentAt
        this.confirmed.add(key)
        this.lastObservedAt = at
        return true
      }
      const terminal = event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
      r = this.obtain(event.runId, at, frame.sentAt, terminal) ?? undefined
      if (!r || final(r.state) || frame.sentAt < r.eventAt) return changed || this.capacityLimited !== capacityBefore
      switch (event.type) {
        case "run.started":
          this.transition(r, r.state === "waiting" ? "waiting" : "running", at, frame.sentAt)
          break
        case "run.waiting": this.transition(r, "waiting", at, frame.sentAt); break
        case "run.resumed": this.transition(r, "running", at, frame.sentAt); break
        case "run.completed":
          this.transition(r, "completed", at, frame.sentAt)
          r.confidence = event.confidence ?? "observed"
          break
        case "run.failed": this.transition(r, "failed", at, frame.sentAt); break
        case "run.cancelled":
          this.transition(r, ["user-interrupted", "interrupted"].includes(event.reason ?? "") ? "cancelled" : "unknown", at, frame.sentAt)
          break
      }
      this.confirmed.add(key)
      this.lastObservedAt = at
      changed = true
    }
    return this.prune() || changed || this.capacityLimited !== capacityBefore
  }

  acknowledge(request: ActivityAckRequest): boolean {
    const targets = new Map(request.targets.map(t => [t.activityId, t.revision]))
    let changed = false
    for (const r of this.records.values()) {
      if (unread(r) && targets.get(r.activityId) === r.revision) {
        r.acknowledgedAt = this.now(); r.revision++; changed = true
      }
    }
    return changed
  }

  navigationKey(target: { activityId: string; revision: number }): string | null {
    const r = [...this.records.values()].find(r => r.activityId === target.activityId)
    return r?.revision === target.revision ? r.key : null
  }

  prune(): boolean {
    const now = this.now()
    let changed = false
    for (const [key, expiresAt] of this.tombstones) if (expiresAt <= now) { this.tombstones.delete(key); changed = true }
    const history = [...this.records.values()].filter(r => !active(r.state))
    const remove = (r: ActivityRecord) => {
      this.records.delete(r.key); this.confirmed.delete(r.key)
      if (unread(r)) { this.droppedUnread = Math.min(Number.MAX_SAFE_INTEGER, this.droppedUnread + 1); this.lastPrunedAt = now }
      const expiresAt = (r.endedAt ?? r.lastObservedAt) + ACTIVITY_HISTORY_AGE_MS
      if (expiresAt > now) this.tombstones.set(r.key, expiresAt)
      changed = true
    }
    for (const r of history) if ((r.endedAt ?? r.lastObservedAt) + ACTIVITY_HISTORY_AGE_MS <= now) remove(r)
    const remaining = history.filter(r => this.records.has(r.key)).sort((a, b) => Number(unread(a)) - Number(unread(b)) || (a.endedAt ?? a.lastObservedAt) - (b.endedAt ?? b.lastObservedAt) || a.activityId.localeCompare(b.activityId))
    for (const r of remaining.slice(0, Math.max(0, remaining.length - ACTIVITY_HISTORY_LIMIT))) remove(r)
    while (this.tombstones.size > ACTIVITY_TOMBSTONE_LIMIT) { this.tombstones.delete(this.tombstones.keys().next().value!); this.capacityLimited = true }
    return changed
  }

  exportHistory(): ActivityHistoryData {
    return { version: 1, nextId: this.nextId, records: [...this.records.values()].map(r => ({ ...r })), tombstones: [...this.tombstones].map(([key, expiresAt]) => ({ key, expiresAt })), droppedUnread: this.droppedUnread, lastPrunedAt: this.lastPrunedAt, capacityLimited: this.capacityLimited }
  }

  view(): Pick<ActivitySnapshot, "entries" | "counts" | "priority" | "connection" | "lastObservedAt" | "droppedUnread" | "lastPrunedAt" | "capacityLimited"> {
    const sorted = [...this.records.values()].sort((a, b) => priority(a) - priority(b) || (b.endedAt ?? b.lastObservedAt) - (a.endedAt ?? a.lastObservedAt) || a.activityId.localeCompare(b.activityId))
    const entries = sorted.map((r): ActivityEntry => ({
      activityId: r.activityId, name: `작업 ${r.activityId.slice(9).padStart(2, "0")}`, state: r.state, revision: r.revision,
      firstObservedAt: r.firstObservedAt, lastObservedAt: r.lastObservedAt, endedAt: r.endedAt,
      acknowledgedAt: r.acknowledgedAt, unread: unread(r), confidence: r.confidence, category: r.category,
      freshness: active(r.state) && (this.connection !== "READY" || !this.confirmed.has(r.key)) ? "rechecking" : "observed",
    }))
    const counts = { running: 0, waiting: 0, failed: 0, completed: 0, attention: 0 }
    for (const r of entries) {
      if (r.state === "running" || r.state === "waiting") counts[r.state]++
      else if (r.unread && (r.state === "failed" || r.state === "completed")) counts[r.state]++
    }
    counts.attention = counts.waiting + counts.failed + counts.completed
    return { entries, counts, priority: counts.waiting ? "waiting" : counts.failed ? "failed" : counts.completed ? "completed" : counts.running ? "running" : "idle", connection: this.connection, lastObservedAt: this.lastObservedAt, droppedUnread: this.droppedUnread, lastPrunedAt: this.lastPrunedAt, capacityLimited: this.capacityLimited }
  }

  private obtain(runId: string, at: number, eventAt: number, terminal = false): ActivityRecord | null {
    const key = correlation(runId)
    const existing = this.records.get(key)
    if (existing && (active(existing.state) || final(existing.state) || terminal)) return existing
    if (this.tombstones.has(key)) return null
    if (!terminal && [...this.records.values()].filter(r => active(r.state)).length >= ACTIVITY_ACTIVE_LIMIT || this.nextId >= 1e15) { this.capacityLimited = true; return null }
    if (existing) return existing
    const r: ActivityRecord = { key, activityId: `activity-${this.nextId++}`, state: "running", revision: 1, firstObservedAt: at, lastObservedAt: at, endedAt: null, acknowledgedAt: null, confidence: null, category: null, eventAt }
    this.records.set(key, r)
    return r
  }

  private transition(r: ActivityRecord, state: ActivityState, at: number, eventAt: number): void {
    if (r.state !== state) r.revision++
    r.state = state; r.lastObservedAt = at; r.eventAt = eventAt
    r.endedAt = active(state) ? null : at
    r.acknowledgedAt = null
    r.confidence = null
  }
}
