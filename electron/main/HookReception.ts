import { sanitizeHookReceipts } from "../../adapter/codex/hooks/HookEvents"
import type { SanitizedAdapterDiagnostics } from "../shared/ipc-contract"
import type { HookReception } from "../shared/codex-integration-contract"

/** Receipts from this running adapter, without a user-started observation
 * session. This proves receipt only, never Codex trust or a Desktop/CLI source. */
export function currentHookReception(adapter: SanitizedAdapterDiagnostics): HookReception {
  const available = adapter.state === "READY" && adapter.adapterOwnership === "OWNED_UTILITY"
  const events = sanitizeHookReceipts(available ? adapter.hookEvents : undefined)
  const received = events.filter(event => event.count > 0 && event.lastReceivedAt !== null)
  return {
    status: !available ? "unavailable" : received.length ? "receiving" : "waiting",
    lastReceivedAt: received.length ? Math.max(...received.map(event => event.lastReceivedAt!)) : null,
    events,
  }
}
