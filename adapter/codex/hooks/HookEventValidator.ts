export const MAX_HOOK_BYTES = 64 * 1024

export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
] as const

export type HookEventName = typeof HOOK_EVENT_NAMES[number]
const HOOK_PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const

type HookBase = {
  sessionId: string
  cwd?: string
  observedAt: number
}

type HookTurnContext = HookBase & {
  model: string
  permissionMode?: string
}

export type ValidatedHookEvent =
  | (HookTurnContext & { hookEventName: "SessionStart"; source: "startup" | "resume" | "clear" | "compact" })
  | (HookBase & { hookEventName: "SessionEnd"; reason: string })
  | (HookTurnContext & { hookEventName: "UserPromptSubmit"; turnId: string })
  | (HookTurnContext & { hookEventName: "PreToolUse" | "PostToolUse"; turnId: string; toolName: string; toolUseId: string })
  | (HookTurnContext & { hookEventName: "SubagentStart" | "SubagentStop"; turnId: string; agentId: string; agentType: string })
  | (HookTurnContext & { hookEventName: "Stop"; turnId: string; stopHookActive: boolean; permissionMode: string })
  | (HookTurnContext & { hookEventName: "Interrupt"; turnId: string; permissionMode: string })

export type HookValidationResult = { ok: true; value: ValidatedHookEvent } | { ok: false; code: string; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const presentString = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const failure = (code: string, message: string): HookValidationResult => ({ ok: false, code, message })

export function parseHookEvent(raw: string | Buffer, observedAt = Date.now()): HookValidationResult {
  const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
  if (byteLength > MAX_HOOK_BYTES) return failure("body-too-large", `hook input exceeds ${MAX_HOOK_BYTES} bytes`)
  let value: unknown
  try {
    value = JSON.parse(raw.toString())
  } catch {
    return failure("malformed-json", "hook input is not valid JSON")
  }
  return validateHookEvent(value, observedAt)
}

export function validateHookEvent(value: unknown, observedAt = Date.now()): HookValidationResult {
  if (!isRecord(value)) return failure("invalid-input", "hook input must be an object")
  if (!presentString(value.session_id, 512)) return failure("invalid-session-id", "session_id is required")
  if (!presentString(value.cwd, 4_096)) return failure("invalid-cwd", "cwd is required")
  if (!presentString(value.hook_event_name, 64) || !HOOK_EVENT_NAMES.includes(value.hook_event_name as HookEventName)) {
    return failure("unknown-event", "hook_event_name is unsupported")
  }

  const base: HookBase = {
    sessionId: value.session_id,
    cwd: value.cwd,
    observedAt,
  }
  const name = value.hook_event_name as HookEventName

  if (name === "SessionEnd") {
    if (!presentString(value.reason, 256)) return failure("invalid-reason", "SessionEnd reason is required")
    if (value.transcript_path !== undefined && value.transcript_path !== null && typeof value.transcript_path !== "string") {
      return failure("invalid-transcript-path", "SessionEnd transcript_path must be a string or null")
    }
    return { ok: true, value: { ...base, hookEventName: name, reason: value.reason } }
  }

  if (!presentString(value.model, 256)) return failure("invalid-model", "model is required")
  if (value.permission_mode !== undefined && (!presentString(value.permission_mode, 64) || !HOOK_PERMISSION_MODES.includes(value.permission_mode as typeof HOOK_PERMISSION_MODES[number]))) {
    return failure("invalid-permission-mode", "permission_mode is invalid")
  }
  const context: HookTurnContext = {
    ...base,
    model: value.model,
    ...(typeof value.permission_mode === "string" ? { permissionMode: value.permission_mode } : {}),
  }

  if (name === "SessionStart") {
    if (!presentString(value.source, 32) || !["startup", "resume", "clear", "compact"].includes(value.source)) return failure("invalid-source", "SessionStart source is invalid")
    return { ok: true, value: { ...context, hookEventName: name, source: value.source as "startup" | "resume" | "clear" | "compact" } }
  }
  if (!presentString(value.turn_id, 512)) return failure("invalid-turn-id", `${name} requires turn_id`)

  if (name === "UserPromptSubmit") {
    if (!presentString(value.prompt, MAX_HOOK_BYTES)) return failure("invalid-prompt", "UserPromptSubmit prompt is required")
    return { ok: true, value: { ...context, hookEventName: name, turnId: value.turn_id } }
  }
  if (name === "PreToolUse" || name === "PostToolUse") {
    if (!presentString(value.tool_name, 256) || !presentString(value.tool_use_id, 512)) return failure("invalid-tool", `${name} requires tool_name and tool_use_id`)
    if (!Object.hasOwn(value, "tool_input")) return failure("invalid-tool-input", `${name} requires tool_input`)
    if (name === "PostToolUse" && !Object.hasOwn(value, "tool_response")) return failure("invalid-tool-response", "PostToolUse requires tool_response")
    return { ok: true, value: { ...context, hookEventName: name, turnId: value.turn_id, toolName: value.tool_name, toolUseId: value.tool_use_id } }
  }
  if (name === "SubagentStart" || name === "SubagentStop") {
    if (!presentString(value.agent_id, 512) || !presentString(value.agent_type, 256)) return failure("invalid-agent", `${name} requires agent_id and agent_type`)
    return { ok: true, value: { ...context, hookEventName: name, turnId: value.turn_id, agentId: value.agent_id, agentType: value.agent_type } }
  }
  if (name === "Interrupt") {
    if (!presentString(value.permission_mode, 64)) return failure("invalid-permission-mode", "Interrupt requires permission_mode")
    return { ok: true, value: { ...context, hookEventName: name, turnId: value.turn_id, permissionMode: value.permission_mode } }
  }
  if (!presentString(value.permission_mode, 64)) return failure("invalid-permission-mode", "Stop requires permission_mode")
  if (typeof value.stop_hook_active !== "boolean" || (value.last_assistant_message !== null && typeof value.last_assistant_message !== "string")) {
    return failure("invalid-stop", "Stop requires stop_hook_active and nullable last_assistant_message")
  }
  return { ok: true, value: { ...context, hookEventName: "Stop", turnId: value.turn_id, stopHookActive: value.stop_hook_active, permissionMode: value.permission_mode } }
}
