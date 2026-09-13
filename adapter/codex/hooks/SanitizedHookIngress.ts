import {
  HOOK_EVENT_NAMES,
  type HookEventName,
  type HookValidationResult,
  type ValidatedHookEvent,
} from "./HookEventValidator"

export type SanitizedHookIngressV1 = {
  payloadVersion: 1
  hookEventName: HookEventName
  sessionId: string
  turnId?: string
  model?: string
  permissionMode?: string
  source?: string
  reason?: string
  toolName?: string
  toolUseId?: string
  agentId?: string
  agentType?: string
  stopHookActive?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const present = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const failure = (code: string, message: string): HookValidationResult => ({ ok: false, code, message })
const permissionModes = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]

export function validateSanitizedHookIngress(value: unknown, observedAt = Date.now()): HookValidationResult {
  if (!isRecord(value) || value.payloadVersion !== 1) return failure("invalid-payload-version", "payloadVersion must be 1")
  const allowed = new Set(["payloadVersion", "hookEventName", "sessionId", "turnId", "model", "permissionMode", "source", "reason", "toolName", "toolUseId", "agentId", "agentType", "stopHookActive"])
  if (Object.keys(value).some((key) => !allowed.has(key))) return failure("unknown-field", "sanitized hook payload contains an unknown field")
  if (!present(value.hookEventName, 64) || !HOOK_EVENT_NAMES.includes(value.hookEventName as HookEventName)) return failure("unknown-event", "hookEventName is unsupported")
  if (!present(value.sessionId)) return failure("invalid-session-id", "sessionId is required")
  const hookEventName = value.hookEventName as HookEventName
  const base = { hookEventName, sessionId: value.sessionId, observedAt }
  if (hookEventName === "SessionEnd") {
    if (!present(value.reason, 256)) return failure("invalid-reason", "SessionEnd reason is required")
    return { ok: true, value: { ...base, hookEventName, reason: value.reason } }
  }
  if (!present(value.model, 256)) return failure("invalid-model", "model is required")
  if (value.permissionMode !== undefined && (!present(value.permissionMode, 64) || !permissionModes.includes(value.permissionMode))) return failure("invalid-permission-mode", "permissionMode is invalid")
  const context = { ...base, model: value.model, ...(present(value.permissionMode, 64) ? { permissionMode: value.permissionMode } : {}) }
  if (hookEventName === "SessionStart") {
    if (!present(value.source, 32) || !["startup", "resume", "clear", "compact"].includes(value.source)) return failure("invalid-source", "SessionStart source is invalid")
    return { ok: true, value: { ...context, hookEventName, source: value.source as "startup" | "resume" | "clear" | "compact" } }
  }
  if (!present(value.turnId)) return failure("invalid-turn-id", `${hookEventName} requires turnId`)
  if (hookEventName === "UserPromptSubmit") return { ok: true, value: { ...context, hookEventName, turnId: value.turnId } }
  if (hookEventName === "PreToolUse" || hookEventName === "PostToolUse") {
    if (!present(value.toolName, 256) || !present(value.toolUseId)) return failure("invalid-tool", `${hookEventName} requires toolName and toolUseId`)
    return { ok: true, value: { ...context, hookEventName, turnId: value.turnId, toolName: value.toolName, toolUseId: value.toolUseId } }
  }
  if (hookEventName === "SubagentStart" || hookEventName === "SubagentStop") {
    if (!present(value.agentId) || !present(value.agentType, 256)) return failure("invalid-agent", `${hookEventName} requires agentId and agentType`)
    return { ok: true, value: { ...context, hookEventName, turnId: value.turnId, agentId: value.agentId, agentType: value.agentType } }
  }
  if (hookEventName === "Interrupt") {
    if (!present(value.permissionMode, 64)) return failure("invalid-permission-mode", "Interrupt requires permissionMode")
    return { ok: true, value: { ...context, hookEventName, turnId: value.turnId, permissionMode: value.permissionMode } }
  }
  if (!present(value.permissionMode, 64) || typeof value.stopHookActive !== "boolean") return failure("invalid-stop", "Stop requires permissionMode and stopHookActive")
  return { ok: true, value: { ...context, hookEventName: "Stop", turnId: value.turnId, permissionMode: value.permissionMode, stopHookActive: value.stopHookActive } }
}

export function parseSanitizedHookIngress(raw: string | Buffer, observedAt = Date.now()): HookValidationResult {
  let value: unknown
  try { value = JSON.parse(raw.toString()) } catch { return failure("malformed-json", "hook input is not valid JSON") }
  return validateSanitizedHookIngress(value, observedAt)
}
