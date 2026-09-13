import { safeLabel } from "../privacy/Redaction.ts"
import type { CodexTaskCategory, NormalizedCodexAction } from "../types.ts"
import type { ValidatedHookEvent } from "./HookEventValidator.ts"

export function classifyHookTool(toolName: string): CodexTaskCategory {
  const value = toolName.toLowerCase()
  if (/bash|shell|exec|command|terminal/.test(value)) return "command"
  if (/write|edit|patch|file/.test(value)) return "file-change"
  if (/web.?search/.test(value)) return "web-search"
  if (/review/.test(value)) return "review"
  if (/dynamic/.test(value)) return "dynamic-tool"
  if (/mcp|__/.test(value)) return "mcp-tool"
  return "other"
}

export function mapHookEvent(event: ValidatedHookEvent): NormalizedCodexAction {
  const backend = "HOOK_OBSERVER" as const
  if (event.hookEventName === "SessionStart") {
    return { kind: "event", event: { type: "session.observed", sessionId: event.sessionId, ...(event.cwd ? { cwd: event.cwd } : {}), model: event.model, observedAt: event.observedAt, backend } }
  }
  if (event.hookEventName === "SessionEnd") {
    return { kind: "session-ended", sessionId: event.sessionId, observedAt: event.observedAt, reason: "session-ended" }
  }
  if (event.hookEventName === "UserPromptSubmit") {
    return { kind: "event", event: { type: "run.started", sessionId: event.sessionId, turnId: event.turnId, observedAt: event.observedAt, backend } }
  }
  if (event.hookEventName === "Stop") {
    return { kind: "event", event: { type: "run.completed", sessionId: event.sessionId, turnId: event.turnId, observedAt: event.observedAt, backend, confidence: "hook-stop" } }
  }
  if (event.hookEventName === "Interrupt") {
    return { kind: "event", event: { type: "run.cancelled", sessionId: event.sessionId, turnId: event.turnId, observedAt: event.observedAt, backend, reason: "user-interrupted" } }
  }
  if (event.hookEventName === "PreToolUse" || event.hookEventName === "PostToolUse") {
    // Only the blocking input tool has a Pre/Post interval matching a user wait.
    // Async questions and arbitrary long-running tools are not waiting signals.
    if (["request_user_input", "functions.request_user_input"].includes(event.toolName)) {
      const common = { sessionId: event.sessionId, turnId: event.turnId, requestId: event.toolUseId, observedAt: event.observedAt, backend }
      return { kind: "event", event: event.hookEventName === "PreToolUse"
        ? { ...common, type: "run.waiting", reason: "user-input" }
        : { ...common, type: "run.resumed" } }
    }
    return {
      kind: "event",
      event: {
        type: event.hookEventName === "PreToolUse" ? "task.started" : "task.completed",
        sessionId: event.sessionId,
        turnId: event.turnId,
        taskId: event.toolUseId,
        category: classifyHookTool(event.toolName),
        label: safeLabel(event.toolName, "Tool"),
        observedAt: event.observedAt,
      },
    }
  }
  if (event.hookEventName === "SubagentStart" || event.hookEventName === "SubagentStop") {
    return {
      kind: "event",
      event: {
        type: event.hookEventName === "SubagentStart" ? "task.started" : "task.completed",
        sessionId: event.sessionId,
        turnId: event.turnId,
        taskId: event.agentId,
        category: "subagent",
        label: safeLabel(event.agentType, "Subagent"),
        observedAt: event.observedAt,
      },
    }
  }
  throw new Error("unreachable hook event")
}
