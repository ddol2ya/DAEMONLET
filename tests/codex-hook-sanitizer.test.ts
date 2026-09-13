import { describe, expect, it } from "vitest"
import { sanitizeHookPayload } from "../adapter/codex/hooks/hook-forwarder.mjs"
import { validateSanitizedHookIngress } from "../adapter/codex/hooks/SanitizedHookIngress"

const common = { session_id: "session", cwd: "/home/user/private", model: "gpt", permission_mode: "default", turn_id: "turn" }

describe("source-side hook sanitizer", () => {
  it.each([
    [{ ...common, hook_event_name: "UserPromptSubmit", prompt: "private prompt" }, "UserPromptSubmit"],
    [{ ...common, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tool", tool_input: { command: "secret command" } }, "PreToolUse"],
    [{ ...common, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tool", tool_input: {}, tool_response: "private output" }, "PostToolUse"],
    [{ ...common, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "assistant message" }, "Stop"],
    [{ ...common, hook_event_name: "Interrupt", transcript_path: "/home/user/transcript" }, "Interrupt"],
    [{ session_id: "session", cwd: "/home/user", hook_event_name: "SessionEnd", reason: "other", transcript_path: "/home/user/transcript" }, "SessionEnd"],
  ])("strips raw content for %s", (raw, name) => {
    const sanitized = sanitizeHookPayload(raw)
    expect(sanitized).toMatchObject({ payloadVersion: 1, hookEventName: name, sessionId: "session" })
    expect(validateSanitizedHookIngress(sanitized).ok).toBe(true)
    expect(JSON.stringify(sanitized)).not.toMatch(/private prompt|secret command|private output|assistant message|\/home\/user|transcript|tool_input|tool_response|cwd/)
  })

  it("returns an empty object for invalid raw hooks", () => {
    expect(sanitizeHookPayload({ hook_event_name: "UserPromptSubmit" })).toEqual({})
    expect(sanitizeHookPayload({ ...common, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tool" })).toEqual({})
    expect(sanitizeHookPayload({ ...common, permission_mode: "invalid", hook_event_name: "UserPromptSubmit", prompt: "x" })).toEqual({})
    const { permission_mode: _permission, ...interruptWithoutPermission } = common
    expect(sanitizeHookPayload({ ...interruptWithoutPermission, hook_event_name: "Interrupt" })).toEqual({})
  })
})
