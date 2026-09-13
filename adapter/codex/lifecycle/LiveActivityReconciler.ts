import type { CodexRunRegistry } from "../CodexRunRegistry.ts"
import type { LiveActivitySnapshot, LiveSession } from "./LiveActivity.ts"
import { hasValidOwnerObservation, liveObservationTime, preferLiveSession } from "./LiveActivity.ts"
import type { LocalConversationTarget } from "./CodexLifecycleObserver.ts"

/** Combines live desktop/CLI ownership with the authenticated Hook registry. */
export class LiveActivityReconciler {
  private previous = new Map<string, LiveSession>()
  private readonly sources = new Map<string, "desktop" | "cli">()
  private desktopConnected: boolean | null = null
  constructor(private readonly registry: CodexRunRegistry, private readonly options: {
    snapshot(): void
    target(value: LocalConversationTarget): void
    available(value: boolean): void
    now?: () => number
  }) {}
  target(value: LocalConversationTarget): void {
    if (value.source) this.sources.set(value.sessionId, value.source)
    while (this.sources.size > 256) this.sources.delete(this.sources.keys().next().value!)
    this.options.target(value)
    this.refreshPresence()
  }
  refreshPresence(): void {
    if (this.desktopConnected === null) return
    this.options.available(this.desktopConnected || [...this.registry.runs.values()].some(run => !run.recovery && this.sources.get(run.sessionId) !== "desktop"))
  }
  update(value: LiveActivitySnapshot): void {
    this.desktopConnected = value.desktopConnected
    const current = new Map<string, LiveSession>()
    for (const session of value.sessions) {
      const previous = current.get(session.sessionId)
      current.set(session.sessionId, previous ? preferLiveSession(previous, session) : session)
    }
    const nextPrevious = new Map(current)
    const lost = new Set<string>()
    let removed = false
    for (const [id, previous] of this.previous) if (!current.has(id) && previous.turnId) {
      const at = typeof value.inventoryAt === "number" && Number.isFinite(value.inventoryAt) && value.inventoryAt >= 0 ? value.inventoryAt : liveObservationTime(previous)
      if (at !== null && this.registry.forgetObservedTurn(id, previous.turnId, at)) removed = true
      else if ([...this.registry.runs.values()].some(run => run.sessionId === id && run.turnId === previous.turnId)) nextPrevious.set(id, previous)
    }
    // Full desktop exit also clears Hook-observed desktop runs that had not yet
    // reached follower discovery. Confirmed CLI work keeps presentation active.
    if (!value.desktopConnected) for (const run of this.registry.runs.values()) {
      if ((this.sources.get(run.sessionId) === "desktop" || run.recovery) && current.get(run.sessionId)?.source !== "cli") lost.add(run.sessionId)
    }
    removed = this.registry.forgetSessions(lost) || removed
    for (const id of lost) nextPrevious.delete(id)
    if (removed) this.options.snapshot()
    for (const session of current.values()) {
      if (!session.turnId) continue
      const observedAt = liveObservationTime(session)
      if (observedAt === null || session.observation?.kind === "owner" && !session.observation.valid || this.registry.isSupersededObservation(session.sessionId, session.turnId, observedAt)) continue
      this.sources.set(session.sessionId, session.source)
      this.options.target({ sessionId: session.sessionId, turnId: session.turnId, path: session.path, source: session.source })
      const identity = { sessionId: session.sessionId, turnId: session.turnId, backend: "HOOK_OBSERVER" as const, observedAt }
      if (this.registry.forgetOtherTurns(session.sessionId, session.turnId, observedAt)) this.options.snapshot()
      if (session.status === "running") {
        this.registry.apply({ ...identity, type: "run.started" })
        this.registry.confirmLive(session.sessionId, session.turnId, hasValidOwnerObservation(session) && session.waitingKnown !== false ? session.waiting : undefined, observedAt)
      } else if (session.status === "completed") this.registry.apply({ ...identity, type: "run.completed", confidence: "authoritative" })
      else if (session.status === "failed") this.registry.apply({ ...identity, type: "run.failed" })
      else if (session.status === "interrupted") this.registry.apply({ ...identity, type: "run.cancelled", reason: "interrupted" })
    }
    this.previous = nextPrevious
    while (this.previous.size > 256) this.previous.delete(this.previous.keys().next().value!)
    this.refreshPresence()
  }
}
