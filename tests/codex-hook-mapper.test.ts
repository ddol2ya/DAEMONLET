import { describe, expect, it } from "vitest"
import { CodexRunRegistry } from "../adapter/codex/CodexRunRegistry.ts"
import { canonicalRunId, canonicalTaskId } from "../adapter/codex/privacy/CanonicalId.ts"
import { mapHookEvent } from "../adapter/codex/hooks/HookEventMapper.ts"
import { validateHookEvent } from "../adapter/codex/hooks/HookEventValidator.ts"

const base = { session_id: "session", cwd: "/work", model: "model", permission_mode: "default", turn_id: "turn" }
const mapped = (input: Record<string, unknown>) => {
  const validated = validateHookEvent({ ...base, ...input }, 100)
  if (!validated.ok) throw new Error(validated.message)
  return mapHookEvent(validated.value)
}

describe("Hook event mapper and registry", () => {
  it("tracks blocking input waits, ignores async tools as waiting, and recovers pending questions", () => {
    const registry = new CodexRunRegistry({ now: () => 100 })
    const apply = (input: Record<string, unknown>, target = registry) => {
      const action = mapped(input)
      return action.kind === "event" ? target.apply(action.event) : null
    }
    apply({ hook_event_name: "UserPromptSubmit", prompt: "private prompt" })
    const tool = (hook: "PreToolUse" | "PostToolUse", id: string, name = "functions.request_user_input") => ({ hook_event_name: hook, tool_name: name, tool_use_id: id, tool_input: { questions: "private questions" }, ...(hook === "PostToolUse" ? { tool_response: "private answer" } : {}) })
    expect(apply(tool("PreToolUse", "question-1"))).toMatchObject({ type: "run.waiting", reason: "user-input" })
    expect(apply(tool("PreToolUse", "question-1"))).toBeNull()
    expect(apply(tool("PreToolUse", "async-question", "functions.request_user_input_async"))).toMatchObject({ type: "task.started" })
    expect(registry.getSnapshot()[0].waitingFor).toBe("user-input")
    expect(JSON.stringify(registry.exportState())).not.toMatch(/private/)
    const restored = new CodexRunRegistry({ now: () => 101 })
    restored.restore(registry.exportState())
    expect(restored.getSnapshot()[0].waitingFor).toBe("user-input")
    expect(apply(tool("PostToolUse", "question-1"), restored)).toMatchObject({ type: "run.resumed" })
    expect(restored.getSnapshot()[0].waitingFor).toBeUndefined()
    expect(apply(tool("PreToolUse", "question-1"), restored)).toBeNull()
    expect(apply(tool("PostToolUse", "not-started"))).toBeNull()
    expect(apply(tool("PreToolUse", "not-started"))).toBeNull()
  })

  it("maps run and task lifecycle idempotently without leaking raw data", () => {
    const registry = new CodexRunRegistry()
    const events: unknown[] = []
    registry.subscribe((event) => events.push(event))
    const start = mapped({ hook_event_name: "UserPromptSubmit", prompt: "secret prompt" })
    expect(start.kind).toBe("event")
    if (start.kind === "event") {
      registry.apply(start.event)
      registry.apply(start.event)
    }
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      const action = mapped({ hook_event_name, tool_name: "Bash", tool_use_id: "tool", tool_input: { command: "secret command" }, ...(hook_event_name === "PostToolUse" ? { tool_response: "secret output" } : {}) })
      if (action.kind === "event") registry.apply(action.event)
    }
    const stop = mapped({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "secret answer" })
    if (stop.kind === "event") {
      registry.apply(stop.event)
      registry.apply(stop.event)
    }
    expect(events.map((event) => (event as { type: string }).type)).toEqual(["run.started", "task.started", "task.completed", "run.completed"])
    // The public kind enum may say "command"; raw command fields/content remain forbidden.
    expect(events[1]).toMatchObject({ kind: "command" })
    expect(events[2]).toMatchObject({ kind: "command" })
    expect(JSON.stringify(events, (key, value) => key === "kind" && value === "command" ? undefined : value)).not.toMatch(/secret|command|output|answer/)
  })

  it("handles Post-before-Pre, late events, session end, TTL, and limits safely", () => {
    let now = 1_000
    const registry = new CodexRunRegistry({ now: () => now, staleTtlMs: 100, maxRuns: 1, maxTasksPerRun: 1 })
    const start = mapped({ hook_event_name: "UserPromptSubmit", prompt: "x" })
    if (start.kind === "event") registry.apply(start.event)
    const post = mapped({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tool", tool_input: {}, tool_response: {} })
    if (post.kind === "event") registry.apply(post.event)
    const pre = mapped({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tool", tool_input: {} })
    if (pre.kind === "event") expect(registry.apply(pre.event)).toBeNull()
    expect(registry.getSnapshot()[0].tasks).toHaveLength(0)
    expect(registry.cancelSession("session")).toHaveLength(1)
    if (post.kind === "event") expect(registry.apply(post.event)).toBeNull()
    if (start.kind === "event") expect(registry.apply(start.event)).toBeNull()

    const staleRegistry = new CodexRunRegistry({ now: () => now, staleTtlMs: 100 })
    staleRegistry.apply({ type: "run.started", sessionId: "s", turnId: "t", observedAt: now, backend: "HOOK_OBSERVER" })
    now += 101
    expect(staleRegistry.cleanupStale()).toMatchObject([{ type: "run.cancelled", reason: "stale-adapter-state" }])
  })

  it("cancels official SessionEnd runs and completes Stop(null) runs without retaining raw fields", () => {
    const registry = new CodexRunRegistry()
    const events: unknown[] = []
    registry.subscribe((event) => events.push(event))

    const sessionEndStart = mapped({ session_id: "end-session", turn_id: "end-turn", hook_event_name: "UserPromptSubmit", prompt: "private prompt" })
    if (sessionEndStart.kind === "event") registry.apply(sessionEndStart.event)
    const sessionEndInput = {
      session_id: "end-session",
      cwd: "/fixture/workspace",
      transcript_path: null,
      hook_event_name: "SessionEnd",
      reason: "other",
    }
    const validatedEnd = validateHookEvent(sessionEndInput, 101)
    expect(validatedEnd.ok).toBe(true)
    if (validatedEnd.ok) {
      const action = mapHookEvent(validatedEnd.value)
      expect(action).toMatchObject({ kind: "session-ended", sessionId: "end-session" })
      if (action.kind === "session-ended") registry.cancelSession(action.sessionId, action.reason)
    }
    expect(registry.getSnapshot()).toEqual([])

    const stopStart = mapped({ session_id: "stop-session", turn_id: "stop-turn", hook_event_name: "UserPromptSubmit", prompt: "private prompt" })
    if (stopStart.kind === "event") registry.apply(stopStart.event)
    const stop = mapped({ session_id: "stop-session", turn_id: "stop-turn", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: null })
    if (stop.kind === "event") registry.apply(stop.event)

    expect(registry.getSnapshot()).toEqual([])
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "run.started",
      "run.cancelled",
      "run.started",
      "run.completed",
    ])
    expect(JSON.stringify({ validatedEnd, stop, events })).not.toMatch(/transcript_path|last_assistant_message|private prompt/)
  })

  it("cancels an interrupted Run immediately, clears child tasks, and ignores late terminal events", () => {
    const registry = new CodexRunRegistry()
    const events: unknown[] = []
    registry.subscribe((event) => events.push(event))

    const start = mapped({ hook_event_name: "UserPromptSubmit", prompt: "private prompt" })
    const task = mapped({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tool", tool_input: { command: "private" } })
    const interrupt = mapped({ hook_event_name: "Interrupt", transcript_path: "/private/transcript" })
    for (const action of [start, task, interrupt]) if (action.kind === "event") registry.apply(action.event)

    expect(interrupt).toMatchObject({ kind: "event", event: { type: "run.cancelled", reason: "user-interrupted" } })
    expect(registry.getSnapshot()).toEqual([])
    expect(events.map((event) => (event as { type: string }).type)).toEqual(["run.started", "task.started", "run.cancelled"])

    const lateStop = mapped({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: null })
    const latePost = mapped({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tool", tool_input: {}, tool_response: {} })
    if (interrupt.kind === "event") expect(registry.apply(interrupt.event)).toBeNull()
    if (lateStop.kind === "event") expect(registry.apply(lateStop.event)).toBeNull()
    if (latePost.kind === "event") expect(registry.apply(latePost.event)).toBeNull()
    expect(events).toHaveLength(3)
    expect(JSON.stringify({ interrupt, events })).not.toMatch(/private|transcript/)
  })

  it("maps subagents as child tasks", () => {
    const start = mapped({ hook_event_name: "SubagentStart", agent_id: "a", agent_type: "worker" })
    const stop = mapped({ hook_event_name: "SubagentStop", agent_id: "a", agent_type: "worker" })
    expect(start).toMatchObject({ kind: "event", event: { type: "task.started", category: "subagent", taskId: "a" } })
    expect(stop).toMatchObject({ kind: "event", event: { type: "task.completed", category: "subagent", taskId: "a" } })
  })

  it("creates stable bounded IDs with unambiguous part boundaries", () => {
    expect(canonicalRunId("ab", "c")).not.toBe(canonicalRunId("a", "bc"))
    expect(canonicalTaskId("s", "t", "a")).toBe(canonicalTaskId("s", "t", "a"))
    expect(canonicalTaskId("s", "t", "a")).toMatch(/^codex-task-[A-Za-z0-9_-]{32}$/)
  })

  it("enforces active run and task snapshot limits", () => {
    const registry = new CodexRunRegistry({ maxRuns: 1, maxTasksPerRun: 1, maxTotalTasks: 1 })
    expect(registry.apply({ type: "run.started", sessionId: "s", turnId: "t1", observedAt: 1, backend: "HOOK_OBSERVER" })).not.toBeNull()
    expect(registry.apply({ type: "run.started", sessionId: "s", turnId: "t2", observedAt: 1, backend: "HOOK_OBSERVER" })).toBeNull()
    expect(registry.apply({ type: "task.started", sessionId: "s", turnId: "t1", taskId: "a", category: "other", label: "A", observedAt: 2 })).not.toBeNull()
    expect(registry.apply({ type: "task.started", sessionId: "s", turnId: "t1", taskId: "b", category: "other", label: "B", observedAt: 3 })).toBeNull()
    expect(registry.getSnapshot()).toHaveLength(1)
    expect(registry.getSnapshot()[0].tasks).toHaveLength(1)
  })
})
