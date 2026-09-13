import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseHookEvent, validateHookEvent } from "../adapter/codex/hooks/HookEventValidator.ts"

const common = { session_id: "session-1", cwd: "/private/work", model: "gpt-test", permission_mode: "default" }
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(resolve("tests/fixtures/codex-hooks", name), "utf8"))

describe("Codex hook validation", () => {
  it.each([
    [{ ...common, hook_event_name: "SessionStart", source: "startup" }, "SessionStart"],
    [fixture("session-end-v0.147.0.json"), "SessionEnd"],
    [{ ...common, hook_event_name: "UserPromptSubmit", turn_id: "turn-1", prompt: "private prompt" }, "UserPromptSubmit"],
    [{ ...common, hook_event_name: "PreToolUse", turn_id: "turn-1", tool_name: "Bash", tool_use_id: "tool-1", tool_input: { command: "private" } }, "PreToolUse"],
    [{ ...common, hook_event_name: "PostToolUse", turn_id: "turn-1", tool_name: "Bash", tool_use_id: "tool-1", tool_input: {}, tool_response: "private output" }, "PostToolUse"],
    [{ ...common, hook_event_name: "SubagentStart", turn_id: "turn-1", agent_id: "agent-1", agent_type: "worker" }, "SubagentStart"],
    [{ ...common, hook_event_name: "SubagentStop", turn_id: "turn-1", agent_id: "agent-1", agent_type: "worker" }, "SubagentStop"],
    [{ ...common, hook_event_name: "Stop", turn_id: "turn-1", stop_hook_active: false, last_assistant_message: "private response" }, "Stop"],
    [{ ...common, hook_event_name: "Interrupt", turn_id: "turn-1", transcript_path: "/private/transcript" }, "Interrupt"],
  ])("accepts and strips %s", (input, name) => {
    const result = validateHookEvent(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.hookEventName).toBe(name)
      const serialized = JSON.stringify(result.value)
      expect(serialized).not.toContain("private prompt")
      expect(serialized).not.toContain("private output")
      expect(serialized).not.toContain("private response")
      expect(serialized).not.toContain("transcript")
      expect(serialized).not.toContain("command")
    }
  })

  it("accepts the installed SessionEnd wire without turn context and discards transcript_path", () => {
    const result = validateHookEvent(fixture("session-end-v0.147.0.json"), 100)
    expect(result).toEqual({
      ok: true,
      value: {
        sessionId: "fixture-session",
        cwd: "/fixture/workspace",
        observedAt: 100,
        hookEventName: "SessionEnd",
        reason: "other",
      },
    })
    expect(JSON.stringify(result)).not.toContain("transcript_path")
    const { transcript_path: _transcript, ...withoutTranscript } = fixture("session-end-v0.147.0.json")
    expect(validateHookEvent(withoutTranscript).ok).toBe(true)
  })

  it("accepts and strips both string and null Stop messages while rejecting invalid or missing values", () => {
    const nullMessage = fixture("stop-null-message-v0.147.0.json")
    const stringMessage = { ...nullMessage, last_assistant_message: "fixture assistant message" }
    for (const input of [nullMessage, stringMessage]) {
      const result = validateHookEvent(input)
      expect(result.ok).toBe(true)
      expect(JSON.stringify(result)).not.toContain("assistant message")
      expect(JSON.stringify(result)).not.toContain("last_assistant_message")
    }
    expect(validateHookEvent({ ...nullMessage, last_assistant_message: 1 })).toMatchObject({ ok: false, code: "invalid-stop" })
    const { last_assistant_message: _removed, ...missing } = nullMessage
    expect(validateHookEvent(missing)).toMatchObject({ ok: false, code: "invalid-stop" })
    const { permission_mode: _permission, ...missingPermission } = nullMessage
    expect(validateHookEvent(missingPermission)).toMatchObject({ ok: false, code: "invalid-permission-mode" })
  })

  it("accepts the official Interrupt wire and requires its turn and permission context", () => {
    const input = { ...common, hook_event_name: "Interrupt", turn_id: "turn-1", transcript_path: "/private/transcript" }
    expect(validateHookEvent(input, 100)).toEqual({
      ok: true,
      value: {
        sessionId: "session-1",
        cwd: "/private/work",
        observedAt: 100,
        model: "gpt-test",
        permissionMode: "default",
        hookEventName: "Interrupt",
        turnId: "turn-1",
      },
    })
    const { turn_id: _turn, ...missingTurn } = input
    expect(validateHookEvent(missingTurn)).toMatchObject({ ok: false, code: "invalid-turn-id" })
    const { permission_mode: _permission, ...missingPermission } = input
    expect(validateHookEvent(missingPermission)).toMatchObject({ ok: false, code: "invalid-permission-mode" })
  })

  it("rejects missing identity, missing turn ids, unknown events, malformed JSON, and oversized input", () => {
    expect(validateHookEvent({ ...common, session_id: "", hook_event_name: "SessionStart", source: "startup" }).ok).toBe(false)
    expect(validateHookEvent({ ...common, hook_event_name: "UserPromptSubmit", prompt: "x" }).ok).toBe(false)
    expect(validateHookEvent({ ...common, hook_event_name: "Other" }).ok).toBe(false)
    expect(parseHookEvent("{").ok).toBe(false)
    expect(parseHookEvent(`{"padding":"${"x".repeat(64 * 1024)}"}`).ok).toBe(false)
  })
})
