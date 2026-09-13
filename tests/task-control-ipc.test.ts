import { afterEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { TaskControlIpcController } from "../electron/main/TaskControlIpcController"
import { TASK_CONTROL_IPC } from "../electron/shared/task-control-contract"
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>() }))
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, fn: (...args: any[]) => Promise<any>) => mocks.handlers.set(channel, fn), removeHandler: (channel: string) => mocks.handlers.delete(channel) } }))
afterEach(() => mocks.handlers.clear())
function fixture() {
  const frame = { url: "pet://app/activity-bubble.html", processId: 1, routingId: 2 }
  const contents = { id: 10, mainFrame: frame }
  const window = { window: { webContents: contents, isDestroyed: () => false, isVisible: () => true } as BrowserWindow, getView: () => ({ view: "control", collapsed: false }), setView: vi.fn(), send: vi.fn() }
  const service = { snapshot: vi.fn(() => ({ revision: 1 })), connect: vi.fn(), disconnect: vi.fn(), refresh: vi.fn(), select: vi.fn(), send: vi.fn(), stop: vi.fn(), navigationTarget: vi.fn(), subscribe: () => vi.fn(), dispose: vi.fn() }
  const dictation = { start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), subscribe: () => vi.fn(), dispose: vi.fn() }
  const controller = new TaskControlIpcController(window as never, service as never, dictation as never)
  controller.register()
  const sender = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, args: unknown[] = [], event = sender) => mocks.handlers.get(channel)!(event, ...args)
  return { controller, service, dictation, invoke, sender, frame, window }
}
describe("task-control IPC capability boundary", () => {
  it("denies every command from the list, Pet, wrong URLs and identical-looking subframes", async () => {
    const f = fixture()
    for (const event of [{ ...f.sender, sender: { id: 1 } }, { ...f.sender, senderFrame: { ...f.frame } }, { ...f.sender, senderFrame: null }]) {
      for (const channel of mocks.handlers.keys()) expect(await f.invoke(channel, [], event as IpcMainInvokeEvent)).toEqual({ ok: false, code: "UNTRUSTED_SENDER" })
    }
    f.frame.url = "pet://app/activity.html"
    expect(await f.invoke(TASK_CONTROL_IPC.send, [{ text: "bad" }])).toMatchObject({ code: "UNTRUSTED_SENDER" })
    expect(f.service.send).not.toHaveBeenCalled(); expect(f.dictation.start).not.toHaveBeenCalled()
    f.controller.dispose()
  })
  it("accepts only validated opaque target requests and never accepts raw thread IDs, methods or execution options", async () => {
    const f = fixture(), target = { key: randomUUID(), revision: 1, actionId: randomUUID() }
    for (const request of [{ ...target, threadId: "injected" }, { ...target, command: "rm" }, { ...target, method: "turn/interrupt" }]) expect(await f.invoke(TASK_CONTROL_IPC.stop, [request])).toMatchObject({ code: "INVALID_REQUEST" })
    expect(await f.invoke(TASK_CONTROL_IPC.send, [{ ...target, text: "메시지", sandbox: "danger-full-access" }])).toMatchObject({ code: "INVALID_REQUEST" })
    expect(await f.invoke(TASK_CONTROL_IPC.send, [{ ...target, text: "메시지" }])).toMatchObject({ ok: true })
    expect(f.service.send).toHaveBeenCalledExactlyOnceWith({ ...target, text: "메시지" })
    f.controller.dispose()
  })
  it("restricts microphone start to a visible expanded control panel and cancels on target/view changes", async () => {
    const f = fixture(), id = randomUUID()
    expect(await f.invoke(TASK_CONTROL_IPC.dictationStart, [id])).toMatchObject({ ok: true })
    expect(f.dictation.start).toHaveBeenCalledWith(id)
    f.window.getView = () => ({ view: "control", collapsed: true })
    expect(await f.invoke(TASK_CONTROL_IPC.dictationStart, [id])).toMatchObject({ code: "UNAVAILABLE" })
    await f.invoke(TASK_CONTROL_IPC.select, [id]); await f.invoke(TASK_CONTROL_IPC.view, ["activity", false])
    expect(f.dictation.cancel).toHaveBeenCalledTimes(2)
    expect(await f.invoke(TASK_CONTROL_IPC.view, ["control", { width: 900 }])).toMatchObject({ code: "INVALID_REQUEST" })
    f.controller.dispose(); expect(f.dictation.dispose).toHaveBeenCalledOnce()
  })
  it("limits request bursts and removes all handlers", async () => {
    const f = fixture()
    for (let i = 0; i < 20; i++) expect(await f.invoke(TASK_CONTROL_IPC.get)).toMatchObject({ ok: true })
    expect(await f.invoke(TASK_CONTROL_IPC.get)).toMatchObject({ code: "REQUEST_LIMITED" })
    f.controller.dispose(); expect(mocks.handlers.size).toBe(0)
  })
})
