export const UPDATE_IPC = { snapshot: "updates:snapshot", action: "updates:action", changed: "updates:changed", open: "updates:open" } as const
export type UpdatePhase = "idle" | "checking" | "upToDate" | "available" | "manualOnly" | "blocked" | "downloading" | "downloaded" | "preparing" | "handoff" | "error"
export type UpdateSnapshot = { phase: UpdatePhase; currentVersion: string; version?: string; candidateId?: string; progress?: number; reason?: string; checkedAt?: number }
export type UpdateAction = { action: "check" | "cancelDownload" | "openRelease" } | { action: "download" | "installAndRestart"; candidateId: string }
export function parseUpdateAction(value: unknown): UpdateAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (["check", "cancelDownload", "openRelease"].includes(String(input.action)) && Object.keys(input).length === 1) return input as UpdateAction
  if (["download", "installAndRestart"].includes(String(input.action)) && Object.keys(input).sort().join() === "action,candidateId" && typeof input.candidateId === "string" && /^[a-f0-9-]{36}$/.test(input.candidateId)) return input as UpdateAction
  return null
}
export type UpdateDesktopApi = { onOpen(listener: () => void): () => void; snapshot(): Promise<UpdateSnapshot>; act(value: UpdateAction): Promise<UpdateSnapshot>; onChanged(listener: (value: UpdateSnapshot) => void): () => void }
declare global { interface Window { updateDesktop?: UpdateDesktopApi } }
