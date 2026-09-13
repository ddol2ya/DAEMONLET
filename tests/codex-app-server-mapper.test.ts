import { describe, expect, it } from "vitest"
import { validateAppServerNotification } from "../adapter/codex/app-server/AppServerEventValidator.ts"
import { mapAppServerNotification } from "../adapter/codex/app-server/AppServerEventMapper.ts"

const map = (method: string, params: unknown) => {
  const validated = validateAppServerNotification(method, params, 5)
  if (!validated.ok || !validated.value) return validated
  return mapAppServerNotification(validated.value)
}

describe("App Server event validation and mapping", () => {
  it.each([
    ["completed", "run.completed"],
    ["failed", "run.failed"],
    ["interrupted", "run.cancelled"],
  ])("maps authoritative turn status %s", (status, expected) => {
    expect(map("turn/completed", { threadId: "thread", turn: { id: "turn", status, error: status === "failed" ? { message: "failed at /Users/example-user/secret sk-abcdefghijk" } : null } })).toMatchObject({ type: expected })
  })

  it.each([
    ["commandExecution", "command", "Command"],
    ["fileChange", "file-change", "File change"],
    ["mcpToolCall", "mcp-tool", "safe_tool"],
    ["dynamicToolCall", "dynamic-tool", "safe_tool"],
    ["webSearch", "web-search", "Web search"],
  ])("maps safe task metadata for %s", (type, category, label) => {
    const event = map("item/started", { threadId: "thread", turnId: "turn", item: { type, id: "item", status: "inProgress", tool: "safe_tool", command: "private command", arguments: { token: "private" }, aggregatedOutput: "private output", diff: "private diff" } })
    expect(event).toMatchObject({ type: "task.started", category, label })
    expect(JSON.stringify(event)).not.toMatch(/private|aggregatedOutput|diff|arguments/)
  })

  it("ignores messages and tolerates unknown methods while rejecting required-field loss", () => {
    expect(map("item/started", { threadId: "t", turnId: "u", item: { type: "agentMessage", id: "i", text: "private" } })).toBeNull()
    expect(validateAppServerNotification("future/notification", { additive: true })).toMatchObject({ ok: true, value: null })
    expect(validateAppServerNotification("turn/started", { threadId: "t", turn: { status: "inProgress" } })).toMatchObject({ ok: false })
  })
})
