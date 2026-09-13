import { afterEach, describe, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron"
import { ActivityIpcController } from "../electron/main/ActivityIpcController"
import type { ActivityBubbleWindowController } from "../electron/main/ActivityBubbleWindowController"
import type { ActivityWindowController } from "../electron/main/ActivityWindowController"
import type { CodexAppLauncher } from "../electron/main/activity/CodexAppLauncher"
import { ActivityService } from "../electron/main/activity/ActivityService"
import { ActivityStore } from "../electron/main/activity/ActivityStore"
import { ACTIVITY_IPC, validateActivityAck } from "../electron/shared/activity-contract"

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>() }))
vi.mock("electron", () => ({ ipcMain: { handle: (c: string, f: (...args: any[]) => Promise<any>) => mocks.handlers.set(c, f), removeHandler: (c: string) => mocks.handlers.delete(c) } }))
const controllers: ActivityIpcController[] = []
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); mocks.handlers.clear() })

function fixture() {
  let now = 10_000
  const frame = { url: "pet://app/activity.html", processId: 1, routingId: 2 }
  const contents = { id: 7, mainFrame: frame } as unknown as WebContents
  const window = { window: { isDestroyed: () => false, webContents: contents } as BrowserWindow, send: vi.fn(), open: vi.fn() } as unknown as ActivityWindowController
  const store = new ActivityStore(() => now)
  const event = (runId: string) => store.accept({ protocolVersion: 1, source: "codex-adapter", sourceInstanceId: "one", sessionId: "wire", messageId: "test", sequence: 1, sentAt: now, frameType: "event", payload: { type: "run.completed", runId } })
  event("A")
  const service = { snapshot: () => store.view(), conversationKey: (target: { activityId: string; revision: number }) => store.navigationKey(target), acknowledge: vi.fn((request) => { store.acknowledge(request); return store.view() }), setNavigation: vi.fn(), subscribe: vi.fn(() => vi.fn()) }
  const launcher = { open: vi.fn(async () => "opened") }
  const bubbleFrame = { url: "pet://app/activity-bubble.html", processId: 10, routingId: 20 }
  const bubbleContents = { id: 9, mainFrame: bubbleFrame } as unknown as WebContents
  const bubble = { window: { isDestroyed: () => false, webContents: bubbleContents } as BrowserWindow, send: vi.fn(), setCollapsed: vi.fn(value => value) } as unknown as ActivityBubbleWindowController
  const bubbleSender = { sender: bubbleContents, senderFrame: bubbleFrame } as IpcMainInvokeEvent
  const openConversation = vi.fn(async (_key: string) => {})
  const controller = new ActivityIpcController(window, service as unknown as ActivityService, launcher as unknown as CodexAppLauncher, undefined, () => now, bubble, openConversation)
  controller.register(); controllers.push(controller)
  const sender = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  const invoke = (channel: string, args: unknown[] = [], event = sender) => mocks.handlers.get(channel)!(event, ...args)
  return { controller, launcher, openConversation, service, window, bubble, bubbleSender, frame, contents, event, invoke, sender, advance: () => { now += 2100 } }
}

describe("narrow activity IPC", () => {
  it("opens the selected result before acknowledging only that revision and blocks repeated clicks", async () => {
    const f = fixture(); f.event("B")
    const entry = f.service.snapshot().entries.find(e => e.activityId === "activity-1")!
    const target = { activityId: entry.activityId, revision: entry.revision }
    let finish!: () => void
    f.openConversation.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const opening = f.invoke(ACTIVITY_IPC.openResult, [target], f.bubbleSender)
    await vi.waitFor(() => expect(f.openConversation).toHaveBeenCalledOnce())
    expect(f.service.acknowledge).not.toHaveBeenCalled()
    f.advance()
    expect(await f.invoke(ACTIVITY_IPC.openResult, [target])).toEqual({ ok: false, code: "REQUEST_LIMITED" })
    f.event("C")
    finish()
    expect(await opening).toMatchObject({ ok: true, value: { counts: { completed: 2 } } })
    expect(f.service.acknowledge).toHaveBeenCalledExactlyOnceWith({ targets: [target] })
    expect(f.launcher.open).not.toHaveBeenCalled()
    expect(await f.invoke(ACTIVITY_IPC.openResult, [target])).toEqual({ ok: false, code: "STALE_TARGET" })
    expect(f.openConversation).toHaveBeenCalledOnce()
  })
  it("preserves unread results when a session is missing or launch fails, and rejects forged targets", async () => {
    const f = fixture(), entry = f.service.snapshot().entries[0]
    const target = { activityId: entry.activityId, revision: entry.revision }
    for (const value of [null, { ...target, url: "codex://threads/evil" }, { ...target, activityId: "--args" }]) expect(await f.invoke(ACTIVITY_IPC.openResult, [value])).toEqual({ ok: false, code: "INVALID_REQUEST" })
    expect(await f.invoke(ACTIVITY_IPC.openResult, [{ ...target, revision: target.revision + 1 }])).toEqual({ ok: false, code: "STALE_TARGET" })
    vi.spyOn(f.service, "conversationKey").mockReturnValueOnce(null)
    expect(await f.invoke(ACTIVITY_IPC.openResult, [target])).toEqual({ ok: false, code: "UNAVAILABLE" })
    f.openConversation.mockRejectedValueOnce(new Error("PRIVATE_PATH"))
    expect(await f.invoke(ACTIVITY_IPC.openResult, [target])).toEqual({ ok: false, code: "OPEN_FAILED" })
    expect(f.service.snapshot().counts.completed).toBe(1)
    expect(f.service.acknowledge).not.toHaveBeenCalled()
  })
  it("acknowledges only an unmapped A after open fails while mapped B stays unread", async () => {
    const f = fixture(); f.event("B")
    const a = f.service.snapshot().entries.find(e => e.activityId === "activity-1")!
    const target = { activityId: a.activityId, revision: a.revision }
    const lookup = f.service.conversationKey
    vi.spyOn(f.service, "conversationKey").mockImplementation(t => t.activityId === a.activityId ? null : lookup(t))
    expect(await f.invoke(ACTIVITY_IPC.openConversation, [target])).toEqual({ ok: false, code: "UNAVAILABLE" })
    expect(await f.invoke(ACTIVITY_IPC.acknowledge, [{ targets: [target] }], f.bubbleSender)).toMatchObject({ ok: true })
    expect(f.service.snapshot().entries.filter(e => e.unread).map(e => e.activityId)).toEqual(["activity-2"])
    expect(f.openConversation).not.toHaveBeenCalled()
  })
  it("opens only the selected activity's current private mapping and never marks the result read", async () => {
    const f = fixture(); f.event("B")
    const first = f.service.snapshot().entries.find(e => e.activityId === "activity-1")!
    const target = { activityId: first.activityId, revision: first.revision }
    expect(await f.invoke(ACTIVITY_IPC.openConversation, [target], f.bubbleSender)).toEqual({ ok: true, value: null })
    expect(f.openConversation).toHaveBeenCalledWith(f.service.conversationKey(target))
    expect(f.launcher.open).not.toHaveBeenCalled(); expect(f.service.acknowledge).not.toHaveBeenCalled()
    expect(f.service.snapshot().counts.completed).toBe(2)
    expect(await f.invoke(ACTIVITY_IPC.openConversation, [target])).toEqual({ ok: false, code: "REQUEST_LIMITED" })
    f.advance()
    for (const bad of [{ ...target, url: "codex://threads/anything" }, { ...target, activityId: "private-thread-id" }]) expect(await f.invoke(ACTIVITY_IPC.openConversation, [bad])).toEqual({ ok: false, code: "INVALID_REQUEST" })
    expect(await f.invoke(ACTIVITY_IPC.openConversation, [{ ...target, revision: target.revision + 1 }])).toEqual({ ok: false, code: "UNAVAILABLE" })
    expect(f.openConversation).toHaveBeenCalledOnce()
  })
  it("shares safe reads/ack but reserves sizing and list opening for the companion", async () => {
    const f = fixture()
    expect(await f.invoke(ACTIVITY_IPC.get, [], f.bubbleSender)).toMatchObject({ ok: true })
    expect(await f.invoke(ACTIVITY_IPC.setCollapsed, [true])).toEqual({ ok: false, code: "UNTRUSTED_SENDER" })
    expect(await f.invoke(ACTIVITY_IPC.openList)).toEqual({ ok: false, code: "UNTRUSTED_SENDER" })
    expect(await f.invoke(ACTIVITY_IPC.setCollapsed, [{ width: 2000 }], f.bubbleSender)).toEqual({ ok: false, code: "INVALID_REQUEST" })
    expect(await f.invoke(ACTIVITY_IPC.setCollapsed, [true], f.bubbleSender)).toEqual({ ok: true, value: true })
    expect(await f.invoke(ACTIVITY_IPC.openList, [], f.bubbleSender)).toEqual({ ok: true, value: null })
    expect(f.window.open).toHaveBeenCalledOnce()
    expect(f.service.acknowledge).not.toHaveBeenCalled()
    const { activityId, revision } = f.service.snapshot().entries[0]
    expect(await f.invoke(ACTIVITY_IPC.acknowledge, [{ targets: [{ activityId, revision }] }], f.bubbleSender)).toMatchObject({ ok: true, value: { counts: { completed: 0 } } })
  })
  it("keeps per-window rate limits when senders alternate", async () => {
    const f = fixture()
    for (let i = 0; i < 24; i++) {
      expect(await f.invoke(ACTIVITY_IPC.get)).toMatchObject({ ok: true })
      expect(await f.invoke(ACTIVITY_IPC.get, [], f.bubbleSender)).toMatchObject({ ok: true })
    }
    for (const sender of [f.sender, f.bubbleSender]) expect(await f.invoke(ACTIVITY_IPC.get, [], sender)).toEqual({ ok: false, code: "REQUEST_LIMITED" })
  })

  it("rejects other windows, same-URL subframes, missing frames and modified URLs", async () => {
    const f = fixture()
    for (const sender of [
      { sender: f.contents, senderFrame: { ...f.frame } },
      { sender: { id: 8 }, senderFrame: f.frame },
      { sender: f.contents, senderFrame: null },
    ]) for (const channel of mocks.handlers.keys()) expect(await f.invoke(channel, [], sender as IpcMainInvokeEvent)).toEqual({ ok: false, code: "UNTRUSTED_SENDER" })
    for (const url of ["pet://app/pet.html", "pet://app/settings.html", "pet://app/index.html", "pet://app/activity.html?url=evil"]) {
      f.frame.url = url
      expect(await f.invoke(ACTIVITY_IPC.openCodex)).toEqual({ ok: false, code: "UNTRUSTED_SENDER" })
    }
    expect(f.launcher.open).not.toHaveBeenCalled()
  })

  it("accepts click-time IDs/revisions only and rejects commands, URLs, long IDs and extra arguments", async () => {
    const f = fixture()
    const { activityId, revision } = f.service.snapshot().entries[0]
    for (const args of [["https://evil.example"], [{ path: "/tmp/evil", command: "execute" }]]) expect(await f.invoke(ACTIVITY_IPC.openCodex, args)).toEqual({ ok: false, code: "INVALID_REQUEST" })
    for (const value of [null, { targets: [], command: "execute" }, { targets: [{ activityId: "a".repeat(500), revision: 1 }] }, { targets: [{ activityId, revision, runId: "private" }] }, { targets: [{ activityId, revision: NaN }] }]) {
      expect(await f.invoke(ACTIVITY_IPC.acknowledge, [value])).toEqual({ ok: false, code: "INVALID_REQUEST" })
    }
    expect(f.launcher.open).not.toHaveBeenCalled()
    f.event("new-result")
    expect(await f.invoke(ACTIVITY_IPC.acknowledge, [{ targets: [{ activityId, revision }] }])).toMatchObject({ ok: true, value: { counts: { completed: 1 } } })
    expect(validateActivityAck({ targets: Array.from({ length: 101 }, (_, i) => ({ activityId: `activity-${i + 1}`, revision: 1 })) })).toBeNull()
  })

  it("opening/querying never acknowledges and app launch failure is a fixed code", async () => {
    const f = fixture()
    expect(await f.invoke(ACTIVITY_IPC.get)).toMatchObject({ value: { counts: { completed: 1 } } })
    expect(await f.invoke(ACTIVITY_IPC.openCodex)).toEqual({ ok: true, value: null })
    expect(f.service.snapshot().counts.completed).toBe(1)
    expect(await f.invoke(ACTIVITY_IPC.openCodex)).toEqual({ ok: false, code: "REQUEST_LIMITED" })
    f.advance(); f.launcher.open.mockRejectedValueOnce(new Error("PRIVATE_PATH"))
    expect(await f.invoke(ACTIVITY_IPC.openCodex)).toEqual({ ok: false, code: "UNAVAILABLE" })
    expect(f.service.acknowledge).not.toHaveBeenCalled()
  })

  it("rate limits and removes a single subscription and all handlers", async () => {
    const f = fixture()
    for (let i = 0; i < 24; i++) expect(await f.invoke(ACTIVITY_IPC.get)).toMatchObject({ ok: true })
    expect(await f.invoke(ACTIVITY_IPC.get)).toEqual({ ok: false, code: "REQUEST_LIMITED" })
    f.controller.register()
    expect(f.service.subscribe).toHaveBeenCalledOnce()
    const unsubscribe = f.service.subscribe.mock.results[0].value
    f.controller.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(mocks.handlers.size).toBe(0)
  })
})
