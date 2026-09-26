export const CODEX_USAGE_IPC = { get: "codex-usage:get", refresh: "codex-usage:refresh", changed: "codex-usage:changed" } as const
export type CodexUsageReason = "not-signed-in" | "api-key-account" | "unsupported-account" | "cli-missing" | "cli-unsupported" | "query-failed" | "invalid-response" | "not-provided"
export type CodexQuotaWindow = { windowDurationMins: 300 | 10080; usedPercent: number; resetsAtMs: number | null; freshness: "fresh" | "stale" | "reset-pending" }
export type CodexUsageSnapshot = {
  revision: number; enabled: boolean; state: "disabled" | "loading" | "ready" | "partial" | "stale" | "unavailable"
  reason: CodexUsageReason | null; observedAtMs: number | null
  fiveHour: CodexQuotaWindow | null; weekly: CodexQuotaWindow | null; ordinaryUsageAllowed: boolean | null
}
export type UsageResponse = { ok: true; value: CodexUsageSnapshot } | { ok: false; code: "UNTRUSTED_SENDER" | "INVALID_REQUEST" | "REQUEST_LIMITED" | "UNAVAILABLE" }
export type CodexUsageApi = { getSnapshot(): Promise<UsageResponse>; refresh(): Promise<UsageResponse>; onChanged(listener: (value: CodexUsageSnapshot) => void): () => void }
export const emptyCodexUsage = (): CodexUsageSnapshot => ({ revision: 0, enabled: false, state: "disabled", reason: null, observedAtMs: null, fiveHour: null, weekly: null, ordinaryUsageAllowed: null })
export function newerCodexUsage(old: CodexUsageSnapshot, next: CodexUsageSnapshot) { return next.revision > old.revision ? next : old }
