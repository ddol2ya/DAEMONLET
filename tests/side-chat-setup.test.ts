import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SideChatSetupController } from "../electron/main/side-chat/SideChatSetupController"
import { SideChatPreferences } from "../electron/main/side-chat/SideChatPreferences"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
const mocks = vi.hoisted(() => ({ prompt: vi.fn(), pick: vi.fn(), connect: vi.fn(), inspect: vi.fn(), stop: vi.fn() }))
vi.mock("electron", () => ({ dialog: { showMessageBox: mocks.prompt, showOpenDialog: mocks.pick }, shell: { openExternal: vi.fn() } }))
vi.mock("../electron/main/side-chat/SideChatPolicy", () => ({ connectVerifiedSideChat: mocks.connect, inspectSideChatRuntime: mocks.inspect }))
const roots: string[] = []
beforeEach(() => { vi.resetAllMocks(); mocks.inspect.mockResolvedValue({ executable: "/official", runtime: { version: "0.154.0" } }); mocks.connect.mockResolvedValue({ stop: mocks.stop }) })
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function fixture(enabled = true) {
  const dir = await mkdtemp(join(tmpdir(), "chat-setup-")); roots.push(dir)
  const backend = vi.fn(), service = new SideChatService(backend)
  service.configure(enabled, "ko")
  const preferences = new SideChatPreferences(dir), shared = { codexHome: "/chosen-home", executablePath: "/old-selection" }
  const setup = new SideChatSetupController(service, preferences, () => shared, () => null, () => service.configure(true, "ko"))
  await setup.load()
  service.setCandidates([{ threadId: "p", title: "Selected", cwd: dir }]); service.chooseParent(service.snapshot().candidates[0].handle)
  service.setDraft("keep this draft", 1)
  const request = () => ({ handle: service.snapshot().handle, epoch: service.snapshot().epoch, requestId: crypto.randomUUID(), text: "keep this draft", draftRevision: 1 })
  return { setup, service, preferences, backend, shared, request }
}
it("readiness opens and closes a metadata connection without creating a backend or child", async () => {
  const f = await fixture(); await f.setup.check()
  expect(f.backend).not.toHaveBeenCalled(); expect(mocks.stop).toHaveBeenCalledTimes(1)
  expect(f.service.snapshot()).toMatchObject({ draft: "keep this draft", readiness: { phase: "ready" }, consentRequired: true })
})
it("blocked preparation keeps activation and typed input; explicit retry works", async () => {
  const f = await fixture(); mocks.connect.mockRejectedValueOnce(Error("CHAT_MODEL_UNAVAILABLE"))
  await f.setup.check()
  expect(f.service.snapshot()).toMatchObject({ enabled: true, draft: "keep this draft", readiness: { phase: "blocked", code: "CHAT_MODEL_UNAVAILABLE" } })
  await f.setup.check(); expect(f.service.snapshot().readiness?.phase).toBe("ready")
})
it("cancel leaves consent, draft and attachments unconsumed; acceptance persists separately", async () => {
  const f = await fixture(); mocks.prompt.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
  expect(await f.setup.confirmSend(f.request())).toBe(false)
  expect(f.preferences.get().consentVersion).toBe(0); expect(f.service.snapshot().draft).toBe("keep this draft")
  expect(await f.setup.confirmSend(f.request())).toBe(true)
  expect(f.preferences.get().consentVersion).toBe(1)
  expect(await f.setup.confirmSend(f.request())).toBe(true); expect(mocks.prompt).toHaveBeenCalledTimes(2)
  expect(f.backend).not.toHaveBeenCalled()
})
it("a parent change while consent is open cannot authorize the stale submission", async () => {
  const f = await fixture(); let resolve!: (v: unknown) => void
  mocks.prompt.mockImplementation(() => new Promise(done => { resolve = done }))
  const result = f.setup.confirmSend(f.request()); f.service.reset(); resolve({ response: 1 })
  await expect(result).rejects.toThrow("STALE_REQUEST"); expect(f.preferences.get().consentVersion).toBe(0)
})
it("a side-chat CLI choice leaves shared task-control selection untouched", async () => {
  const f = await fixture(); await f.setup.pickCli(true)
  expect(f.preferences.get().executable).toBe("/official"); expect(f.shared.executablePath).toBe("/old-selection")
  expect(f.service.snapshot().draft).toBe("keep this draft")
})
it("preserves OFF without starting any readiness process", async () => {
  const f = await fixture(); f.service.configure(false, "ko"); await f.setup.check()
  expect(mocks.connect).not.toHaveBeenCalled(); expect(f.service.snapshot()).toMatchObject({ enabled: false, offNotice: true })
  await f.setup.dismissNotice(); expect(f.service.snapshot().offNotice).toBe(false)
})

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const connection = (stop = vi.fn(async () => {})) => ({ stop })
function selectedRuntime() { mocks.inspect.mockImplementation(async (executable?: string | null) => ({ executable: executable ?? "/B", runtime: { version: "0.154.0" } })) }

it("coalesces concurrent checks only for the same generation and selection", async () => {
  const f = await fixture(), gate = deferred<ReturnType<typeof connection>>()
  mocks.connect.mockReturnValueOnce(gate.promise)
  const first = f.setup.check(), second = f.setup.check()
  expect(first).toBe(second)
  await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
  const c = connection(); gate.resolve(c); await first
  expect(c.stop).toHaveBeenCalledTimes(1); expect(f.service.snapshot().readiness?.phase).toBe("ready")
})
it.each([false, true])("finishes a new CLI selection while the old metadata check is pending (discover=%s)", async discover => {
  const f = await fixture(), gate = deferred<ReturnType<typeof connection>>()
  selectedRuntime(); mocks.pick.mockResolvedValue({ canceled: false, filePaths: ["/B"] }); mocks.connect.mockReturnValueOnce(gate.promise)
  const first = f.setup.check(); await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
  const selection = f.setup.pickCli(discover)
  await vi.waitFor(() => expect(f.preferences.get().executable).toBe("/B"))
  gate.resolve(connection()); await Promise.all([first, selection])
  expect(mocks.connect.mock.calls.map(([o]) => o.executable)).toEqual(["/old-selection", "/B"])
  expect(f.service.snapshot()).toMatchObject({ draft: "keep this draft", readiness: { phase: "ready" } })
  expect(f.shared.executablePath).toBe("/old-selection")
})
it("queues only the last shared selection after A → B → C", async () => {
  const f = await fixture(), gate = deferred<ReturnType<typeof connection>>()
  selectedRuntime(); mocks.connect.mockReturnValueOnce(gate.promise)
  const a = f.setup.check(); await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
  f.shared.executablePath = "/B"; f.setup.invalidate(); const b = f.setup.check()
  f.shared.executablePath = "/C"; f.shared.codexHome = "/new-home"; f.setup.invalidate(); const c = f.setup.check()
  gate.resolve(connection()); await Promise.all([a, b, c])
  expect(mocks.connect.mock.calls.map(([o]) => [o.executable, o.codexHome])).toEqual([["/old-selection", "/chosen-home"], ["/C", "/new-home"]])
  expect(f.service.snapshot().readiness?.phase).toBe("ready")
})
it("does not publish an old failure over the latest selection", async () => {
  const f = await fixture(), gate = deferred<ReturnType<typeof connection>>()
  selectedRuntime(); mocks.connect.mockReturnValueOnce(gate.promise)
  const first = f.setup.check(); await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
  f.shared.executablePath = "/B"; f.setup.invalidate(); const next = f.setup.check()
  gate.reject(Error("CHAT_AUTH_REQUIRED")); await Promise.all([first, next])
  expect(mocks.connect.mock.calls.at(-1)?.[0].executable).toBe("/B")
  expect(f.service.snapshot().readiness).toMatchObject({ phase: "ready", code: null })
})
it("keeps a new pending check through late cleanup and deduplicates its retry", async () => {
  const f = await fixture(), cleanup = deferred<void>(), stop = vi.fn(() => cleanup.promise)
  selectedRuntime(); mocks.connect.mockResolvedValueOnce(connection(stop))
  const first = f.setup.check(); await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  f.shared.executablePath = "/B"; f.setup.invalidate(); const next = f.setup.check()
  expect(f.setup.check()).toBe(next); expect(mocks.connect).toHaveBeenCalledTimes(1)
  cleanup.resolve(); await Promise.all([first, next])
  expect(mocks.connect.mock.calls.map(([o]) => o.executable)).toEqual(["/old-selection", "/B"])
  expect(f.service.snapshot().readiness?.phase).toBe("ready")
})
it("does not revive disabled readiness and checks again on explicit enable", async () => {
  const f = await fixture(), gate = deferred<ReturnType<typeof connection>>()
  selectedRuntime(); mocks.connect.mockReturnValueOnce(gate.promise)
  const first = f.setup.check(); await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
  f.service.configure(false, "ko"); f.setup.invalidate(); await f.setup.check()
  expect(mocks.connect).toHaveBeenCalledTimes(1)
  const enabled = f.setup.enable(); gate.resolve(connection()); await Promise.all([first, enabled])
  expect(mocks.connect).toHaveBeenCalledTimes(2); expect(f.service.snapshot()).toMatchObject({ enabled: true, readiness: { phase: "ready" } })
})
it("retries the latest selected CLI explicitly after its own failure", async () => {
  const f = await fixture(); selectedRuntime(); mocks.connect.mockRejectedValueOnce(Error("CHAT_AUTH_REQUIRED"))
  await f.setup.pickCli(true)
  expect(f.service.snapshot().readiness).toMatchObject({ phase: "blocked", code: "CHAT_AUTH_REQUIRED" })
  await f.setup.check()
  expect(mocks.connect.mock.calls.map(([o]) => o.executable)).toEqual(["/B", "/B"])
  expect(f.service.snapshot().readiness?.phase).toBe("ready")
})
