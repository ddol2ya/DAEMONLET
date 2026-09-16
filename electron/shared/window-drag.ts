export type WindowDragRequest = { action: "begin" } | { action: "move" | "end" | "cancel"; id: string }
export type WindowDragReply = { id: string | null }
export const DRAG_THRESHOLD_DIP = 4
export function validWindowDragRequest(value: unknown): value is WindowDragRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return v.action === "begin" ? Object.keys(v).join() === "action"
    : ["move", "end", "cancel"].includes(String(v.action)) && Object.keys(v).sort().join() === "action,id" && typeof v.id === "string" && /^[a-f0-9-]{36}$/.test(v.id)
}
