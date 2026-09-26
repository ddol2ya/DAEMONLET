import type { CodexQuotaWindow, CodexUsageSnapshot } from "../../shared/codex-usage-contract"
export const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
export type NormalizedUsage = Pick<CodexUsageSnapshot, "fiveHour" | "weekly" | "ordinaryUsageAllowed">
/** A malformed explicit Codex bucket never falls back to a different bucket.
 * Missing/null legacy IDs are accepted; duplicate durations invalidate that slot. */
export function normalizeCodexUsage(input: unknown): NormalizedUsage | null {
  const response = record(input)
  if (!response) return null
  const map = record(response.rateLimitsByLimitId)
  if (response.rateLimitsByLimitId != null && !map) return null
  const explicit = map && Object.hasOwn(map, "codex")
  const quota = record(explicit ? map.codex : response.rateLimits)
  if (!quota || quota.limitId != null && quota.limitId !== "codex") return null
  const windows = [quota.primary, quota.secondary].map(record)
  const window = (duration: 300 | 10080): CodexQuotaWindow | null => {
    const candidates = windows.filter(w => w?.windowDurationMins === duration)
    if (candidates.length !== 1) return null
    const w = candidates[0]!, used = w.usedPercent, reset = w.resetsAt
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > Number.MAX_SAFE_INTEGER) return null
    // Millisecond-looking timestamps and invalid Date values are not guessed.
    const resetsAtMs = typeof reset === "number" && Number.isSafeInteger(reset) && reset >= 0 && reset <= 253402300799 ? reset * 1000 : null
    return { windowDurationMins: duration, usedPercent: used, resetsAtMs, freshness: "fresh" }
  }
  return { fiveHour: window(300), weekly: window(10080), ordinaryUsageAllowed: typeof response.ordinaryUsageAllowed === "boolean" ? response.ordinaryUsageAllowed : null }
}
