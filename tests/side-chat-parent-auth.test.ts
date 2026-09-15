import { inspectParent } from "../scripts/side-chat/parent-inspection"
import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { readChatParentContext } from "../electron/main/side-chat/SideChatParent"
import { readChatAuthTokens } from "../electron/main/side-chat/SideChatAuth"
import { inspectSideChatExecutable } from "../electron/main/side-chat/SideChatPolicy"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const root = async () => { const value = await mkdtemp(join(tmpdir(), "side-chat-guard-")); roots.push(value); return value }
async function parentFixture(meta: Record<string, unknown> = {}) {
  const home = await root(), id = randomUUID(), turn = randomUUID(), current = randomUUID()
  await mkdir(join(home, "sessions"))
  const path = join(home, "sessions", `rollout-2026-09-16T00-00-00-${id}.jsonl`)
  const lines = [{ type: "session_meta", payload: { id, history_mode: "legacy", ...meta } }, { type: "event_msg", timestamp: "2026-09-16T00:00:00Z", payload: { type: "task_complete", turn_id: turn } }, { type: "event_msg", timestamp: "2026-09-16T00:00:01Z", payload: { type: "task_started", turn_id: current } }]
  const bytes = lines.map(line => JSON.stringify(line) + "\n").join("") + '{"unfinished"'
  await writeFile(path, bytes, { mode: 0o600 })
  return { home, path, turn, bytes, parent: { threadId: id, title: "Synthetic", cwd: home, path } }
}
describe("controlled parent history", () => {
  it("selects the last durable terminal boundary without copying history or mutating an active parent", async () => {
    const f = await parentFixture()
    expect(await readChatParentContext(f.home, f.parent)).toMatchObject({ lastTurnId: f.turn, contextAt: Date.parse("2026-09-16T00:00:00Z") })
    expect(await readFile(f.path, "utf8")).toBe(f.bytes)
  })
  it("blocks inherited dynamic capabilities, paginated history and mismatched identity before fork", async () => {
    for (const [meta, code] of [[{ dynamic_tools: [{ name: "arbitrary" }] }, "PARENT_CAPABILITIES"], [{ history_mode: "paginated" }, "PARENT_UNSUPPORTED"], [{ id: randomUUID() }, "PARENT_UNSUPPORTED"]] as const) {
      const f = await parentFixture(meta)
      await expect(readChatParentContext(f.home, f.parent)).rejects.toThrow(code)
    }
  })
  it("rejects another home and oversized records", async () => {
    const f = await parentFixture()
    await expect(readChatParentContext(await root(), f.parent)).rejects.toThrow("PARENT_UNSUPPORTED")
    await writeFile(f.path, f.bytes.split("\n")[0] + "\n" + "x".repeat(1024 * 1024 + 1))
    await expect(readChatParentContext(f.home, f.parent)).rejects.toThrow("PARENT_UNSUPPORTED")
  })
  it.skipIf(process.platform === "win32")("does not follow redirected parent files", async () => {
    const f = await parentFixture(), copy = join(f.home, "copy.jsonl")
    await writeFile(copy, f.bytes); await rm(f.path); await symlink(copy, f.path)
    await expect(readChatParentContext(f.home, f.parent)).rejects.toThrow("PARENT_UNSUPPORTED")
  })
})
describe("read-only existing Codex auth broker", () => {
  const token = (seconds: number) => "fixture." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "pro" } })).toString("base64url") + ".not-a-real-signature"
  it("loads only unexpired ChatGPT access tokens and leaves the original file unchanged", async () => {
    const home = await root(), accessToken = token(3600), original = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: accessToken, refresh_token: "never-used-fixture-refresh" } })
    await writeFile(join(home, "auth.json"), original, { mode: 0o600 })
    expect(await readChatAuthTokens(home)).toEqual({ accessToken, chatgptAccountId: "fixture-account", chatgptPlanType: "pro" })
    expect(await readFile(join(home, "auth.json"), "utf8")).toBe(original)
  })
  it("requires normal login for expired, missing and non-ChatGPT credentials", async () => {
    const home = await root()
    await expect(readChatAuthTokens(home)).rejects.toThrow("CHAT_AUTH_REQUIRED")
    for (const auth of [{ auth_mode: "chatgpt", tokens: { access_token: token(-1) } }, { auth_mode: "apikey", OPENAI_API_KEY: "fixture-only" }, {}]) {
      await writeFile(join(home, "auth.json"), JSON.stringify(auth), { mode: 0o600 })
      await expect(readChatAuthTokens(home)).rejects.toThrow("CHAT_AUTH_REQUIRED")
    }
  })
  it.skipIf(process.platform === "win32")("rejects credential files readable by other users", async () => {
    const home = await root(), path = join(home, "auth.json")
    await writeFile(path, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token(3600) } }), { mode: 0o600 }); await chmod(path, 0o644)
    await expect(readChatAuthTokens(home)).rejects.toThrow("CHAT_AUTH_REQUIRED")
  })
  it("does not execute unrecognized launch candidates", async () => {
    const home = await root(), path = join(home, "unverified-codex")
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    await expect(inspectSideChatExecutable(path)).rejects.toThrow(/CHAT_RUNTIME_/)
  })
})

describe("model-free parent suitability report", () => {
  it("reports production-validated legacy boundaries without identifiers, titles or content", async () => {
    const f = await parentFixture({ private_marker: "DO_NOT_REPORT_TRANSCRIPT" })
    const report = await inspectParent(f.home, f.parent)
    expect(report).toEqual({ sourceHome: "MATCH", access: "READABLE", format: "legacy", dynamicTools: "NONE", terminalBoundary: "CONFIRMED", status: "ELIGIBLE_PARENT_ONLY", reason: "AUTH_AND_RUNTIME_NOT_CHECKED" })
    for (const secret of [f.path, f.turn, f.parent.threadId, "DO_NOT_REPORT_TRANSCRIPT"]) expect(JSON.stringify(report)).not.toContain(secret)
    expect(await readFile(f.path, "utf8")).toBe(f.bytes)
  })
  it("distinguishes blocked formats, inherited tools and absent boundaries without converting parents", async () => {
    const paginated = await parentFixture({ history_mode: "paginated" }), dynamic = await parentFixture({ dynamic_tools: [{ name: "private-tool" }] }), empty = await parentFixture()
    expect(await inspectParent(paginated.home, paginated.parent)).toMatchObject({ format: "paginated", dynamicTools: "NONE", terminalBoundary: "NOT_INSPECTED_UNSUPPORTED_FORMAT", status: "BLOCKED_UPSTREAM" })
    expect(await inspectParent(dynamic.home, dynamic.parent)).toMatchObject({ format: "legacy", dynamicTools: "PRESENT", reason: "PARENT_CAPABILITIES" })
    await writeFile(empty.path, empty.bytes.split("\n")[0] + "\n")
    expect(await inspectParent(empty.home, empty.parent)).toMatchObject({ terminalBoundary: "ABSENT", reason: "NO_COMPLETED_BOUNDARY" })
    expect(await inspectParent(await root(), empty.parent)).toMatchObject({ sourceHome: "OUTSIDE", access: "NOT_CHECKED" })
    expect(await readFile(paginated.path, "utf8")).toBe(paginated.bytes)
    expect(await readFile(dynamic.path, "utf8")).toBe(dynamic.bytes)
  })
})
