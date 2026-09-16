import type { ChatError } from "../../shared/side-chat-contract"

/** Only documented structured enum/status fields. Never display server messages,
 * request bodies, personal paths, credentials, or inferred regex matches. */
export function officialTurnError(value: unknown): ChatError {
  const info = value && typeof value === "object" ? (value as any).codexErrorInfo : null
  if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") return "USAGE_LIMIT"
  if (info === "rateLimitExceeded" || info === "serverOverloaded") return "RATE_LIMITED"
  if (info === "unauthorized") return "AUTH_EXPIRED"
  if (info === "contextWindowExceeded") return "HISTORY_LIMIT"
  if (info === "cyberPolicy" || info === "misalignmentPolicyViolation") return "REFUSED"
  if (info && typeof info === "object") {
    for (const key of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
      if (!Object.hasOwn(info, key)) continue
      const status = info[key]?.httpStatusCode
      if (status === 401) return "AUTH_EXPIRED"
      if (status === 403) return "ACCESS_DENIED"
      if (status === 429) return "RATE_LIMITED"
      return key === "responseStreamDisconnected" || key === "responseTooManyFailedAttempts" ? "OUTCOME_UNKNOWN" : "NETWORK_ERROR"
    }
  }
  return "TURN_FAILED"
}
