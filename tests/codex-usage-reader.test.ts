import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { access } from "node:fs/promises"
import { createCodexUsageReader } from "../electron/main/codex-usage/CodexUsageReader"
import { AppServerRpcError } from "../adapter/codex/app-server/AppServerJsonlClient"
const m = vi.hoisted(() => ({ inspect: vi.fn(), resolve: vi.fn(), launch: vi.fn(), startup: vi.fn(), assert: vi.fn() }))
vi.mock("../electron/main/side-chat/SideChatDiscovery", () => ({ inspectSideChatRuntime: m.inspect, resolveNativeCandidate: m.resolve }))
vi.mock("../electron/main/side-chat/OfficialSameHomeLaunchProfile", () => ({ launchOfficialSameHomeProcess: m.launch }))
vi.mock("../electron/main/side-chat/SideChatPermissionPolicy", () => ({ inspectOfficialStartup: m.startup, assertOfficialConfiguration: m.assert }))
const provider = { executablePath: process.execPath, codexHome: "/fixture/home" }
let account: unknown, quota: unknown, pendingReject: ((e: Error) => void) | null
let onRequest: ((r: { id: number }) => void) | null
const client = { initialize: vi.fn(), request: vi.fn(), onServerRequest: vi.fn(), rejectServerRequest: vi.fn(async () => {}) }
const stop = vi.fn(async () => { pendingReject?.(Error("closed")) }), off = vi.fn()
beforeEach(() => {
  vi.clearAllMocks(); pendingReject = null; onRequest = null
  account = { account: { type: "chatgpt", email: "fixture-user" } }
  quota = { accountId: "fixture-workspace", ordinaryUsageAllowed: false, rateLimits: { primary: { windowDurationMins: 300, usedPercent: 24, resetsAt: null }, secondary: null } }
  m.resolve.mockResolvedValue(process.execPath); m.inspect.mockResolvedValue({ executable: process.execPath }); m.startup.mockResolvedValue({ disabledMcpServers: [], assertUnchanged: async () => {} }); m.assert.mockReturnValue(undefined)
  m.launch.mockResolvedValue({ client, stop }); client.initialize.mockResolvedValue({})
  client.onServerRequest.mockImplementation(listener => { onRequest = listener; return off })
  client.request.mockImplementation(async method => method === "account/read" ? account : method === "account/rateLimits/read" ? quota : {})
})
afterEach(() => vi.useRealTimers())
const read = () => createCodexUsageReader()(provider, new AbortController().signal)
describe("short-lived metadata reader", () => {
  it("reads exhausted quota without models, side-chat enablement or account mutation and cleans up", async () => {
    const reader = createCodexUsageReader(), result = await reader(provider, new AbortController().signal)
    expect(result).toMatchObject({ value: { fiveHour: { usedPercent: 24 }, ordinaryUsageAllowed: false } })
    expect(client.request.mock.calls.map(c => c[0])).toEqual(["configRequirements/read", "config/read", "account/read", "account/rateLimits/read"])
    expect(client.request).toHaveBeenCalledWith("account/read", { refreshToken: false }, 10000)
    expect(client.request).toHaveBeenCalledWith("account/rateLimits/read", { supportsLunaReserve: false, excludeResetCreditDetails: true }, 10000)
    expect(client.initialize).toHaveBeenCalledWith(expect.any(Object), "side-chat", 10000)
    expect(stop).toHaveBeenCalledTimes(1); expect(off).toHaveBeenCalledTimes(1)
    await expect(access(m.launch.mock.calls[0][0].root)).rejects.toThrow()
    expect(JSON.stringify(result)).not.toMatch(/fixture-user|fixture-workspace/)
    await reader(provider, new AbortController().signal); expect(m.inspect).toHaveBeenCalledTimes(1)
    expect(m.resolve).toHaveBeenCalledTimes(2)
  })
  it.each([[{ account: null }, "not-signed-in"], [{ account: { type: "apiKey" } }, "api-key-account"], [{ account: { type: "unknown" } }, "unsupported-account"], [{}, "invalid-response"]])("classifies account states and skips quota", async (raw, reason) => {
    account = raw; expect(await read()).toEqual({ reason }); expect(client.request.mock.calls.some(c => c[0] === "account/rateLimits/read")).toBe(false); expect(stop).toHaveBeenCalledOnce()
  })
  it.each([-32601, -32602, -32000])("does not retry unverified compatibility or auth errors (%s)", async code => {
    client.request.mockImplementation(async method => { if (method === "account/rateLimits/read") throw new AppServerRpcError(code); return method === "account/read" ? account : {} })
    expect(await read()).toEqual({ reason: code === -32000 ? "query-failed" : "cli-unsupported" })
    expect(client.request.mock.calls.filter(c => c[0] === "account/rateLimits/read")).toHaveLength(1)
  })
  it("closes a pending stream at the total deadline and rejects server tools", async () => {
    vi.useFakeTimers()
    client.request.mockImplementation(method => method === "account/read" ? new Promise((_r, reject) => { pendingReject = reject }) : Promise.resolve({}))
    const job = read()
    await vi.waitFor(() => expect(pendingReject).not.toBeNull())
    onRequest!({ id: 7 }); expect(client.rejectServerRequest).toHaveBeenCalledWith(7)
    await vi.advanceTimersByTimeAsync(25000); expect(await job).toEqual({ reason: "query-failed" }); expect(stop).toHaveBeenCalled(); expect(off).toHaveBeenCalledOnce()
    await expect(access(m.launch.mock.calls[0][0].root)).rejects.toThrow()
  })
  it("cancels owned readers and never launches if already aborted", async () => {
    const abort = new AbortController(); abort.abort()
    expect(await createCodexUsageReader()(provider, abort.signal)).toEqual({ reason: "query-failed" }); expect(m.launch).not.toHaveBeenCalled()
  })
  it.each(["CHAT_RUNTIME_UNSUPPORTED", "CHAT_PLATFORM_UNVERIFIED", "CHAT_RUNTIME_MISSING"])("enforces runtime admission %s", async error => {
    m.inspect.mockRejectedValueOnce(Error(error)); expect(await read()).toEqual({ reason: error.endsWith("MISSING") ? "cli-missing" : "cli-unsupported" }); expect(m.launch).not.toHaveBeenCalled()
  })
})
