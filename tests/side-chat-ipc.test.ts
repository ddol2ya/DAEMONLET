import { afterEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import type { SideChatWindowController } from "../electron/main/SideChatWindowController"
import { SideChatIpcController } from "../electron/main/SideChatIpcController"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
import { SIDE_CHAT_IPC } from "../electron/shared/side-chat-contract"
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), copy: vi.fn(), dialog: vi.fn() }))
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, fn: any) => mocks.handlers.set(channel, fn), removeHandler: (channel: string) => mocks.handlers.delete(channel) }, clipboard: { writeText: mocks.copy }, dialog: { showMessageBox: mocks.dialog } }))
afterEach(() => { mocks.handlers.clear(); vi.clearAllMocks() })
function fixture() {
  const frame = { url: "pet://app/side-chat.html" }, contents = { id: 1, mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents }
  const service = new SideChatService(() => { throw Error("must not start") }), controller = new SideChatIpcController(service, { window } as unknown as SideChatWindowController)
  controller.register(); service.configure(true, "ko")
  const event = { sender: contents, senderFrame: frame }
  const invoke = (name: string, request: unknown, e: unknown = event, ...extra: unknown[]) => mocks.handlers.get(SIDE_CHAT_IPC.action)!(e, name, request, ...extra)
  const request = (text?: string) => ({ handle: service.snapshot().handle, epoch: service.snapshot().epoch, requestId: randomUUID(), ...(text === undefined ? {} : { text, draftRevision: service.snapshot().draftRevision + 1 }) })
  return { service, controller, event, invoke, request }
}
describe("side chat IPC authority", () => {
  it("restricts main frame/window even for same URL and does not expose raw profiles", async () => {
    const f = fixture(), get = mocks.handlers.get(SIDE_CHAT_IPC.get)!
    expect(get(f.event).ok).toBe(true)
    expect(get({ ...f.event, senderFrame: { url: f.event.senderFrame.url } }).ok).toBe(false)
    expect(get({ ...f.event, sender: { id: 2 } }).ok).toBe(false)
    expect(JSON.stringify(get(f.event))).not.toMatch(/developerInstructions|profileInput|threadId|cwd/)
    expect((await f.invoke("draft", f.request("draft"), { ...f.event, senderFrame: null })).ok).toBe(false)
    expect(f.service.snapshot().draft).toBe("")
  })
  it("validates arity and input before mutation, bounds rate and rejects duplicate IDs", async () => {
    const f = fixture(), r = f.request("draft")
    expect((await f.invoke("draft", r)).ok).toBe(true)
    expect(await f.invoke("draft", r)).toMatchObject({ ok: false, code: "STALE_REQUEST" })
    expect((await f.invoke("draft", f.request("bad"), f.event, "extra")).ok).toBe(false)
    expect((await f.invoke("draft", { ...f.request("bad"), path: "/secret" })).ok).toBe(false)
    expect((await f.invoke("send", { ...f.request("bad"), draftRevision: -1 })).ok).toBe(false)
    expect((await f.invoke("draft", { ...f.request("bad"), draftRevision: undefined })).ok).toBe(false)
    expect(f.service.snapshot().draft).toBe("draft")
    let limited = false
    for (let n = 0; n < 25; n++) if ((await f.invoke("draft", f.request("a"))).code === "REQUEST_LIMITED") limited = true
    expect(limited).toBe(true)
  })
})
