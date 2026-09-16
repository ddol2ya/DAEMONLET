import type { AppLanguage } from "./app-language"
export const SIDE_CHAT_LIMITS = { inputPoints: 4000, inputBytes: 16000, responseBytes: 65536, previewBytes: 4096, messages: 100, historyBytes: 2 * 1024 * 1024 } as const
export type ChatExpression = "neutral" | "happy" | "thinking"
export type ChatResponse = { text: string; preview: string; expression: ChatExpression }
export const CHAT_ERRORS = ["READ_ACCESS_DENIED", "READ_LIMIT", "TURN_FAILED", "CHAT_DISABLED", "CHAT_PROFILE_MISSING", "CHAT_MODEL_UNAVAILABLE", "CHAT_RUNTIME_MISSING", "CHAT_RUNTIME_UNSUPPORTED", "CHAT_AUTH_REQUIRED", "CHAT_MANAGED_POLICY", "CHAT_EXECUTION_POLICY", "PARENT_UNSUPPORTED", "PARENT_CAPABILITIES", "CHAT_POLICY_UNENFORCEABLE", "NO_PARENT", "BUSY", "STALE_REQUEST", "INVALID_REQUEST", "INPUT_LIMIT", "HISTORY_LIMIT", "RESPONSE_LIMIT", "RESPONSE_INVALID", "REFUSED", "STOPPED", "SESSION_LOST", "OUTCOME_UNKNOWN", "PACK_PERSONA", "REQUEST_LIMITED"] as const
export const CHAT_PREPARATION_ERRORS = ["CHAT_PLATFORM_UNVERIFIED", "CHAT_SETTINGS_UNREADABLE", "CHAT_AUTH_IDENTITY_UNAVAILABLE", "CHAT_AUTH_UNAVAILABLE", "CHAT_ACCOUNT_CHANGED", "PARENT_NO_COMPLETED_TURN", "PARENT_LOOKUP_LIMIT", "PARENT_ACCESS", "RATE_LIMITED", "USAGE_LIMIT", "NETWORK_ERROR", "AUTH_EXPIRED", "ACCESS_DENIED"] as const
export type ChatError = typeof CHAT_ERRORS[number] | typeof CHAT_PREPARATION_ERRORS[number]
export type ChatReadiness = { phase: "unchecked" | "checking" | "ready" | "blocked"; code: ChatError | null; version?: string; model?: string; checkedAt: number | null }
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; preview: string; at: number }
export type ChatSubmission = { requestId: string; draftRevision: number }
export type SideChatSnapshot = {
  readiness?: ChatReadiness
  consentRequired?: boolean
  offNotice?: boolean
  hasMoreParents?: boolean
  parentQuery?: string
  connectionMode?: "official-same-home" | "unavailable"
  attachments?: Array<{ path: string; startLine: number; endLine: number; readAt: number; truncated: boolean }>
  handle: string; epoch: number; enabled: boolean; mode: "hidden" | "compact" | "panel"; language: AppLanguage
  character: { id: string; label: string }; parent: { handle: string; title: string; contextAt: number | null } | null
  candidates: Array<{ handle: string; title: string }>; phase: "idle" | "preparing" | "answering" | "stopped" | "error"
  applying: boolean; requiresNewConversation: boolean; error: ChatError | null; notice: "character" | "language" | "parent" | "reset" | null
  messages: ChatMessage[]; draft: string; draftRevision: number; acceptedSubmission: ChatSubmission | null; task: { state: string; checkedAt: number | null }
}
export type ChatRequest = { handle: string; epoch: number; requestId: string; text?: string; draftRevision?: number }
export type ChatAction = "send" | "stop" | "reset" | "draft" | "compact" | "panel" | "hide" | "parent" | "copy" | "attach" | "detach" | "remove-attachment" | "check" | "pick-cli" | "discover-cli" | "help" | "enable" | "search" | "more" | "dismiss-notice"
export type ChatResult = { ok: true; value: SideChatSnapshot } | { ok: false; code: ChatError }
export type SideChatApi = { get(): Promise<ChatResult>; action(action: ChatAction, request: ChatRequest): Promise<ChatResult>; onChanged(listener: (snapshot: SideChatSnapshot) => void): () => void }
export const SIDE_CHAT_IPC = { get: "side-chat:get", action: "side-chat:action", changed: "side-chat:changed" } as const
export const SIDE_CHAT_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["text", "preview", "expression"],
  properties: { text: { type: "string" }, preview: { type: "string" }, expression: { type: "string", enum: ["neutral", "happy", "thinking"] } },
} as const
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength
export function validChatInput(text: unknown, allowEmpty = false): text is string {
  return typeof text === "string" && (allowEmpty || Boolean(text.trim())) && Array.from(text).length <= SIDE_CHAT_LIMITS.inputPoints && utf8Bytes(text) <= SIDE_CHAT_LIMITS.inputBytes && !/[\u0000\ud800-\udfff]/u.test(text)
}
export function parseChatResponse(raw: string): ChatResponse {
  if (utf8Bytes(raw) > SIDE_CHAT_LIMITS.responseBytes * 6) throw new Error("RESPONSE_LIMIT")
  let v: Record<string, unknown>
  try { v = JSON.parse(raw) } catch { throw new Error("RESPONSE_INVALID") }
  if (v && typeof v.text === "string" && utf8Bytes(v.text) > SIDE_CHAT_LIMITS.responseBytes) throw new Error("RESPONSE_LIMIT")
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "expression,preview,text" || typeof v.text !== "string" || !v.text.trim() || typeof v.preview !== "string" || typeof v.expression !== "string" || utf8Bytes(v.text) > SIDE_CHAT_LIMITS.responseBytes || /[\u0000\ud800-\udfff]/u.test(v.text)) throw new Error("RESPONSE_INVALID")
  const preview = utf8Bytes(v.preview) <= SIDE_CHAT_LIMITS.previewBytes && Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(v.preview)).length <= 120 && v.preview.split(/\r?\n/).length <= 3 && !/[\u0000\ud800-\udfff]/u.test(v.preview) ? v.preview : ""
  return { text: v.text, preview, expression: ["neutral", "happy", "thinking"].includes(v.expression) ? v.expression as ChatExpression : "neutral" }
}
export function validateChatRequest(value: unknown, action: ChatAction): ChatRequest {
  const v = value as ChatRequest
  const revision = action === "send" || action === "draft"
  const text = revision || ["parent", "copy", "attach", "remove-attachment", "search"].includes(action)
  const keys = revision ? "draftRevision,epoch,handle,requestId,text" : text ? "epoch,handle,requestId,text" : "epoch,handle,requestId"
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== keys || typeof v.handle !== "string" || !/^[\da-f-]{36}$/.test(v.handle) || typeof v.requestId !== "string" || !/^[\da-f-]{36}$/.test(v.requestId) || !Number.isSafeInteger(v.epoch) || v.epoch < 1 || revision && (!Number.isSafeInteger(v.draftRevision) || v.draftRevision! < 0) || text && !validChatInput(v.text, true)) throw new Error("INVALID_REQUEST")
  return v
}
