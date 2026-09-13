import type { ProtocolCompletionConfidence, ProtocolConnectionState, ProtocolTaskKind } from "../../src/protocol/types"

export const ACTIVITY_HISTORY_LIMIT = 100
export const ACTIVITY_HISTORY_DAYS = 7
export const ACTIVITY_HISTORY_AGE_MS = ACTIVITY_HISTORY_DAYS * 24 * 60 * 60 * 1000
export const ACTIVITY_ACTIVE_LIMIT = 64
export const ACTIVITY_TOMBSTONE_LIMIT = 2048

export type ActivityState = "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown"
export type ActivityPriority = "waiting" | "failed" | "completed" | "running" | "idle"
export type ActivityEntry = {
  activityId: string
  name: string
  state: ActivityState
  revision: number
  firstObservedAt: number
  lastObservedAt: number
  endedAt: number | null
  acknowledgedAt: number | null
  unread: boolean
  confidence: ProtocolCompletionConfidence | null
  category: ProtocolTaskKind | null
  freshness: "observed" | "rechecking"
  canOpenConversation?: boolean
}
export type ActivityCounts = { running: number; waiting: number; failed: number; completed: number; attention: number }
export type ActivitySnapshot = {
  revision: number
  connection: ProtocolConnectionState
  lastObservedAt: number | null
  counts: ActivityCounts
  priority: ActivityPriority
  entries: ActivityEntry[]
  storage: "pending" | "saved" | "error"
  historyRecovered: boolean
  droppedUnread: number
  lastPrunedAt: number | null
  capacityLimited: boolean
  navigation: "none" | "app" | "thread"
}
export type ActivityAckTarget = { activityId: string; revision: number }
export type ActivityAckRequest = { targets: ActivityAckTarget[] }
export type ActivityResponse<T> = { ok: true; value: T } | { ok: false; code: "INVALID_REQUEST" | "UNTRUSTED_SENDER" | "REQUEST_LIMITED" | "UNAVAILABLE" | "OPEN_FAILED" | "STALE_TARGET" }
export type ActivityApi = {
  getSnapshot(): Promise<ActivityResponse<ActivitySnapshot>>
  acknowledge(request: ActivityAckRequest): Promise<ActivityResponse<ActivitySnapshot>>
  openResult(target: ActivityAckTarget): Promise<ActivityResponse<ActivitySnapshot>>
  openCodex(): Promise<ActivityResponse<null>>
  openConversation(target: ActivityAckTarget): Promise<ActivityResponse<null>>
  openList(): Promise<ActivityResponse<null>>
  setCollapsed(value: boolean): Promise<ActivityResponse<boolean>>
  setInteractionLocked(value: boolean, pressed?: boolean): void
  onInteractionStarted(listener: () => void): () => void
  setPointerInteractive(value: boolean): void
  reportHeight(value: number): void
  onChanged(listener: (value: ActivitySnapshot) => void): () => void
}
export const ACTIVITY_IPC = {
  get: "activity:get", acknowledge: "activity:acknowledge", changed: "activity:changed", openCodex: "activity:open-codex",
  openList: "activity:open-list", setCollapsed: "activity:set-collapsed",
  openConversation: "activity:open-conversation",
  openResult: "activity:open-result",
} as const

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
export const isActivityId = (v: unknown): v is string => typeof v === "string" && /^activity-[1-9][0-9]{0,14}$/.test(v)
export function validateActivityAck(value: unknown): ActivityAckRequest | null {
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.targets) || value.targets.length > ACTIVITY_HISTORY_LIMIT) return null
  const seen = new Set<string>()
  const targets: ActivityAckTarget[] = []
  for (const v of value.targets) {
    if (!record(v) || Object.keys(v).length !== 2 || !isActivityId(v.activityId) || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1 || seen.has(v.activityId)) return null
    seen.add(v.activityId)
    targets.push({ activityId: v.activityId, revision: v.revision as number })
  }
  return { targets }
}

export function activitySummary(value: Pick<ActivitySnapshot, "connection" | "counts">): string {
  const { running, waiting, failed, completed } = value.counts
  return `${value.connection === "READY" ? "" : "재확인 중 · 마지막 관찰: "}입력 필요 ${waiting} · 미확인 실패 ${failed} · 미확인 종료 ${completed} · 실행 중 ${running}`
}
