import { beforeEach, expect, it, vi } from "vitest"
import { access } from "node:fs/promises"
import { connectOfficialSameHome } from "../electron/main/side-chat/OfficialSameHomeConnection"
const mocks = vi.hoisted(() => ({ startup: vi.fn(), launch: vi.fn(), policy: vi.fn(), auth: vi.fn() }))
vi.mock("../electron/main/side-chat/OfficialSameHomeLaunchProfile", () => ({ launchOfficialSameHomeProcess: mocks.launch }))
vi.mock("../electron/main/side-chat/SideChatPermissionPolicy", () => ({ inspectOfficialStartup: mocks.startup, assertOfficialConfiguration: mocks.policy }))
vi.mock("../electron/main/side-chat/SideChatAuth", () => ({ readOfficialAccountBinding: mocks.auth }))
const identity = (usageAllowed = true) => ({ email: "fixture@example.invalid", accountId: "fixture", source: "protocol", usageAllowed })
const client = { initialize: vi.fn(), request: vi.fn() }, stop = vi.fn()
let temporaryRoot = ""
beforeEach(() => {
  vi.resetAllMocks()
  mocks.startup.mockResolvedValue({ disabledMcpServers: [], assertUnchanged: vi.fn() })
  mocks.launch.mockImplementation(async ({ root }) => { temporaryRoot = root; return { client, stop } })
  mocks.auth.mockResolvedValue(identity())
  client.request.mockImplementation(async method => method === "config/read" ? { config: { cli_auth_credentials_store: "file" } } : method === "model/list" ? { data: [{ model: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] } : { requirements: null })
})
it("preserves initial usage limits and cleans up before any model lookup or turn", async () => {
  mocks.auth.mockResolvedValue(identity(false))
  await expect(connectOfficialSameHome("/fixture/codex", "/fixture/home")).rejects.toMatchObject({ message: "USAGE_LIMIT", stage: "authentication" })
  expect(stop).toHaveBeenCalledTimes(1); await expect(access(temporaryRoot)).rejects.toThrow()
  expect(client.request.mock.calls.map(([method]) => method)).toEqual(["configRequirements/read", "config/read"])
})
it("reports the same usage limit before a later turn", async () => {
  const connection = await connectOfficialSameHome("/fixture/codex", "/fixture/home")
  try { mocks.auth.mockResolvedValue(identity(false)); await expect(connection.beforeTurn!()).rejects.toThrow("USAGE_LIMIT") }
  finally { await connection.stop() }
  await expect(access(temporaryRoot)).rejects.toThrow()
  expect(client.request.mock.calls.some(([method]) => method.startsWith("turn/") || method.startsWith("thread/"))).toBe(false)
})
it.each(["CHAT_AUTH_REQUIRED", "CHAT_AUTH_UNAVAILABLE", "CHAT_ACCOUNT_CHANGED"])("retains safe authentication code %s", async code => {
  mocks.auth.mockRejectedValue(Error(code))
  await expect(connectOfficialSameHome("/fixture/codex", "/fixture/home")).rejects.toThrow(code)
  expect(stop).toHaveBeenCalledTimes(1); await expect(access(temporaryRoot)).rejects.toThrow()
})
it("distinguishes unavailable models from execution policy", async () => {
  client.request.mockImplementation(async method => method === "config/read" ? { config: {} } : method === "model/list" ? { data: [] } : { requirements: null })
  await expect(connectOfficialSameHome("/fixture/codex", "/fixture/home")).rejects.toThrow("CHAT_MODEL_UNAVAILABLE")
  expect(stop).toHaveBeenCalledTimes(1)
})
it("retains an actual policy refusal", async () => {
  mocks.policy.mockImplementation(() => { throw Error("CHAT_EXECUTION_POLICY") })
  await expect(connectOfficialSameHome("/fixture/codex", "/fixture/home")).rejects.toThrow("CHAT_EXECUTION_POLICY")
  expect(mocks.auth).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1)
})
it.each(["private native response /secret/token", "CHAT_private_native_response"])("redacts unknown communication failures including an unrecognized CHAT prefix: %s", async message => {
  client.initialize.mockRejectedValue(Error(message))
  await expect(connectOfficialSameHome("/fixture/codex", "/fixture/home")).rejects.toMatchObject({ message: "SESSION_LOST", stage: "initialize" })
  expect(stop).toHaveBeenCalledTimes(1); await expect(access(temporaryRoot)).rejects.toThrow()
})
