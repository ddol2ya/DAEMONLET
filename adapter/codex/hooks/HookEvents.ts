export const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "Interrupt"] as const
export type HookEventName = typeof HOOK_EVENTS[number]
export type HookEventReceipt = { event: HookEventName; count: number; lastReceivedAt: number | null }

export const emptyHookReceipts = (): HookEventReceipt[] => HOOK_EVENTS.map((event) => ({ event, count: 0, lastReceivedAt: null }))

// Use an explicit allowlist even across the worker boundary. No raw body,
// session/run/task IDs, hashes of IDs, arbitrary event names or stderr.
export function sanitizeHookReceipts(value: unknown): HookEventReceipt[] {
  if (!Array.isArray(value)) return emptyHookReceipts()
  return HOOK_EVENTS.map((event) => {
    const entry = value.find((item) => item && typeof item === "object" && item.event === event)
    return {
      event,
      count: Number.isSafeInteger(entry?.count) && entry.count >= 0 ? Math.min(entry.count, 1_000_000_000) : 0,
      lastReceivedAt: Number.isSafeInteger(entry?.lastReceivedAt) && entry.lastReceivedAt > 0 ? entry.lastReceivedAt : null,
    }
  })
}
