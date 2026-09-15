import type { AppLanguage } from "./app-language"
export const SIDE_CHAT_LIMITS = { inputPoints: 4000, inputBytes: 16000, responseBytes: 65536, previewBytes: 4096, messages: 100, historyBytes: 2 * 1024 * 1024 } as const
export type ChatExpression = "neutral" | "happy" | "thinking"
export type ChatResponse = { text: string; preview: string; expression: ChatExpression }
export type ChatError = "CHAT_DISABLED" | "CHAT_POLICY_UNENFORCEABLE" | "NO_PARENT" | "BUSY" | "STALE_REQUEST" | "INVALID_REQUEST" | "INPUT_LIMIT" | "HISTORY_LIMIT" | "RESPONSE_INVALID" | "REFUSED" | "STOPPED" | "SESSION_LOST" | "OUTCOME_UNKNOWN" | "PACK_PERSONA" | "REQUEST_LIMITED"
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; preview: string; at: number }
export type SideChatSnapshot = {
  handle: string; epoch: number; enabled: boolean; mode: "hidden" | "compact" | "panel"; language: AppLanguage
  character: { id: string; label: string }; parent: { handle: string; title: string; contextAt: number | null } | null
  candidates: Array<{ handle: string; title: string }>; phase: "idle" | "preparing" | "answering" | "stopped" | "error"
  applying: boolean; error: ChatError | null; notice: "character" | "language" | "parent" | "reset" | null
  messages: ChatMessage[]; draft: string; task: { state: string; checkedAt: number | null }
}
export type ChatRequest = { handle: string; epoch: number; requestId: string; text?: string }
export type ChatAction = "send" | "stop" | "reset" | "draft" | "compact" | "panel" | "hide" | "parent" | "copy"
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
  if (utf8Bytes(raw) > SIDE_CHAT_LIMITS.responseBytes * 6) throw new Error("RESPONSE_INVALID")
  let v: Record<string, unknown>
  try { v = JSON.parse(raw) } catch { throw new Error("RESPONSE_INVALID") }
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "expression,preview,text" || typeof v.text !== "string" || !v.text.trim() || typeof v.preview !== "string" || typeof v.expression !== "string" || utf8Bytes(v.text) > SIDE_CHAT_LIMITS.responseBytes || /[\u0000\ud800-\udfff]/u.test(v.text)) throw new Error("RESPONSE_INVALID")
  const preview = utf8Bytes(v.preview) <= SIDE_CHAT_LIMITS.previewBytes && Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(v.preview)).length <= 120 && v.preview.split(/\r?\n/).length <= 3 && !/[\u0000\ud800-\udfff]/u.test(v.preview) ? v.preview : ""
  return { text: v.text, preview, expression: ["neutral", "happy", "thinking"].includes(v.expression) ? v.expression as ChatExpression : "neutral" }
}
export function validateChatRequest(value: unknown, text = false): ChatRequest {
  const v = value as ChatRequest
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== (text ? "epoch,handle,requestId,text" : "epoch,handle,requestId") || typeof v.handle !== "string" || !/^[\da-f-]{36}$/.test(v.handle) || typeof v.requestId !== "string" || !/^[\da-f-]{36}$/.test(v.requestId) || !Number.isSafeInteger(v.epoch) || v.epoch < 1 || text && !validChatInput(v.text, true)) throw new Error("INVALID_REQUEST")
  return v
}
