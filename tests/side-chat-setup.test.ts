import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SideChatSetupController } from "../electron/main/side-chat/SideChatSetupController"
import { SideChatPreferences } from "../electron/main/side-chat/SideChatPreferences"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
const mocks = vi.hoisted(() => ({ prompt: vi.fn(), connect: vi.fn(), inspect: vi.fn(), stop: vi.fn() }))
vi.mock("electron", () => ({ dialog: { showMessageBox: mocks.prompt }, shell: { openExternal: vi.fn() } }))
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
