export const TASK_CONTROL_TEXT_LIMIT = 16_000
export type ControlledThread = {
  key: string; title: string; project: string; revision: number;
  state: "idle" | "running" | "waiting" | "failed" | "unknown";
  canSend: boolean; canStop: boolean; canOpenConversation: boolean;
}
export type TaskControlSnapshot = {
  revision: number; connection: "disconnected" | "connecting" | "ready" | "error";
  source: "shared" | "desktop"; autoConnect: boolean;
  socketPath: string; threads: ControlledThread[]; selectedKey: string | null;
  pending: boolean; issue: TaskControlError | null; needsClient: boolean;
}
export type TaskControlError = "UNTRUSTED_SENDER" | "INVALID_REQUEST" | "REQUEST_LIMITED" | "UNAVAILABLE" | "UNSAFE_SOCKET" | "CONNECT_FAILED" | "PROTOCOL_UNSUPPORTED" | "STALE_TARGET" | "ACTION_FAILED" | "OUTCOME_UNKNOWN" | "OPERATION_PENDING" | "OPEN_FAILED"
export type TaskControlResponse<T> = { ok: true; value: T } | { ok: false; code: TaskControlError }
export type TaskControlTarget = { key: string; revision: number; actionId: string }
export type TaskControlSend = TaskControlTarget & { text: string }
export type DictationSnapshot = { sessionId: string | null; state: "idle" | "starting" | "listening" | "stopping" | "error"; text: string; error: "UNAVAILABLE" | "PERMISSION_DENIED" | "ON_DEVICE_UNAVAILABLE" | "AUDIO_UNAVAILABLE" | "RECOGNITION_FAILED" | null }
export type TaskControlApi = {
  openConversation(key: string): Promise<TaskControlResponse<null>>
  getView(): Promise<TaskControlResponse<{ view: "activity" | "control"; collapsed: boolean }>>
  getSnapshot(): Promise<TaskControlResponse<TaskControlSnapshot>>
  connect(socketPath: string): Promise<TaskControlResponse<TaskControlSnapshot>>
  connectDesktop(): Promise<TaskControlResponse<TaskControlSnapshot>>
  disconnect(): Promise<TaskControlResponse<TaskControlSnapshot>>
  refresh(): Promise<TaskControlResponse<TaskControlSnapshot>>
  select(key: string): Promise<TaskControlResponse<TaskControlSnapshot>>
  send(request: TaskControlSend): Promise<TaskControlResponse<TaskControlSnapshot>>
  stop(request: TaskControlTarget): Promise<TaskControlResponse<TaskControlSnapshot>>
  setView(view: "activity" | "control", collapsed: boolean): Promise<TaskControlResponse<null>>
  startDictation(sessionId: string): Promise<TaskControlResponse<null>>
  stopDictation(sessionId: string): Promise<TaskControlResponse<null>>
  onChanged(listener: (value: TaskControlSnapshot) => void): () => void
  onDictation(listener: (value: DictationSnapshot) => void): () => void
  onViewChanged(listener: (value: { view: "activity" | "control"; collapsed: boolean }) => void): () => void
}
export const TASK_CONTROL_IPC = {
  connectDesktop: "task-control:connect-desktop",
  openConversation: "task-control:open-conversation", get: "task-control:get", getView: "task-control:get-view", viewChanged: "task-control:view-changed", connect: "task-control:connect", disconnect: "task-control:disconnect", refresh: "task-control:refresh", select: "task-control:select", send: "task-control:send", stop: "task-control:stop", view: "task-control:view", changed: "task-control:changed", dictationStart: "task-control:dictation-start", dictationStop: "task-control:dictation-stop", dictation: "task-control:dictation",
} as const
export const isControlKey = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)
export function validateControlTarget(value: unknown, send: boolean): TaskControlTarget | TaskControlSend | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== (send ? 4 : 3) || !isControlKey(v.key) || !isControlKey(v.actionId) || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1) return null
  if (send && (typeof v.text !== "string" || !v.text.trim() || new TextEncoder().encode(v.text).length > TASK_CONTROL_TEXT_LIMIT || v.text.includes("\0"))) return null
  return { key: v.key, revision: v.revision as number, actionId: v.actionId, ...(send ? { text: v.text as string } : {}) }
}
