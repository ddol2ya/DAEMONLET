export type LiveObservation =
  | { kind: "owner"; ownerId: string; epoch: number; revision: number; valid: boolean; validatedAt?: number }
  | { kind: "rollout"; readStartedAt: number }

export type LiveSession = {
  sessionId: string
  turnId: string | null
  source: "desktop" | "cli"
  path: string
  status: "running" | "completed" | "failed" | "interrupted" | "idle"
  waiting: boolean
  waitingKnown?: false
  observedAt?: number
  observation?: LiveObservation
}
export type LiveActivitySnapshot = { desktopConnected: boolean; sessions: LiveSession[]; inventoryAt?: number }

export const liveObservationTime = (session: LiveSession): number | null =>
  typeof session.observedAt === "number" && Number.isFinite(session.observedAt) && session.observedAt >= 0 ? session.observedAt : null

export const hasValidOwnerObservation = (session: LiveSession): boolean =>
  session.observation?.kind === "owner" && session.observation.valid

/** Compare the original evidence, never the time a cached view is republished. */
export function preferLiveSession(a: LiveSession, b: LiveSession): LiveSession {
  const left = liveObservationTime(a), right = liveObservationTime(b)
  if (left !== right) {
    if (left === null) return b
    if (right === null) return a
    return right > left ? b : a
  }
  if (hasValidOwnerObservation(a) !== hasValidOwnerObservation(b)) return hasValidOwnerObservation(b) ? b : a
  const stale = (value: LiveSession) => value.observation?.kind === "owner" && !value.observation.valid
  if (stale(a) !== stale(b)) return stale(a) ? b : a
  return a
}
