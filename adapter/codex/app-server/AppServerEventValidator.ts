import type { CodexTaskCategory } from "../types.ts"
import { redactDiagnosticText, safeLabel } from "../privacy/Redaction.ts"

type AppTurn = { id: string; status: "completed" | "interrupted" | "failed" | "inProgress"; errorMessage?: string }
type AppItem = { id: string; category: CodexTaskCategory; label: string; status?: "inProgress" | "completed" | "failed" | "declined" }

export type ValidatedAppServerNotification =
  | { method: "turn/started" | "turn/completed"; threadId: string; turn: AppTurn; observedAt: number }
  | { method: "item/started" | "item/completed"; threadId: string; turnId: string; item: AppItem | null; observedAt: number }

export type AppServerNotificationResult =
  | { ok: true; value: ValidatedAppServerNotification | null; ignored?: string }
  | { ok: false; code: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
const statuses = ["completed", "interrupted", "failed", "inProgress"]

function readTurn(value: unknown): AppTurn | null {
  if (!isRecord(value) || !text(value.id) || !statuses.includes(String(value.status))) return null
  const errorMessage = isRecord(value.error) ? redactDiagnosticText(value.error.message) : undefined
  return { id: value.id, status: value.status as AppTurn["status"], ...(errorMessage ? { errorMessage } : {}) }
}

function readItem(value: unknown): AppItem | null | false {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (["userMessage", "hookPrompt", "agentMessage", "plan", "reasoning", "contextCompaction", "imageView", "sleep", "subAgentActivity"].includes(value.type)) return null
  if (!text(value.id)) return false
  const status = ["inProgress", "completed", "failed", "declined"].includes(String(value.status)) ? value.status as AppItem["status"] : undefined
  switch (value.type) {
    case "commandExecution": return { id: value.id, category: "command", label: "Command", ...(status ? { status } : {}) }
    case "fileChange": return { id: value.id, category: "file-change", label: "File change", ...(status ? { status } : {}) }
    case "mcpToolCall": return { id: value.id, category: "mcp-tool", label: safeLabel(value.tool, "MCP tool"), ...(status ? { status } : {}) }
    case "dynamicToolCall": return { id: value.id, category: "dynamic-tool", label: safeLabel(value.tool, "Dynamic tool"), ...(status ? { status } : {}) }
    case "collabAgentToolCall": return { id: value.id, category: "subagent", label: "Subagent", ...(status ? { status } : {}) }
    case "webSearch": return { id: value.id, category: "web-search", label: "Web search", ...(status ? { status } : {}) }
    case "imageGeneration": return { id: value.id, category: "other", label: "Image generation", ...(status ? { status } : {}) }
    case "enteredReviewMode":
    case "exitedReviewMode": return { id: value.id, category: "review", label: "Review" }
    default: return false
  }
}

export function validateAppServerNotification(method: string, params: unknown, observedAt = Date.now()): AppServerNotificationResult {
  if (!["turn/started", "turn/completed", "item/started", "item/completed"].includes(method)) return { ok: true, value: null, ignored: "unknown-method" }
  if (!isRecord(params) || !text(params.threadId)) return { ok: false, code: "invalid-notification" }
  if (method === "turn/started" || method === "turn/completed") {
    const turn = readTurn(params.turn)
    if (!turn) return { ok: false, code: "invalid-turn" }
    if (method === "turn/started" && turn.status !== "inProgress") return { ok: false, code: "invalid-turn-status" }
    return { ok: true, value: { method, threadId: params.threadId, turn, observedAt } }
  }
  if (!text(params.turnId)) return { ok: false, code: "invalid-turn-id" }
  const item = readItem(params.item)
  if (item === false) return { ok: false, code: "invalid-item" }
  return { ok: true, value: { method: method as "item/started" | "item/completed", threadId: params.threadId, turnId: params.turnId, item, observedAt } }
}
