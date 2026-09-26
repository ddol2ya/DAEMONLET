import { describe, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron"
import { CodexUsageIpcController } from "../electron/main/CodexUsageIpcController"
import { CodexUsageService } from "../electron/main/codex-usage/CodexUsageService"
import type { ActivityBubbleWindowController } from "../electron/main/ActivityBubbleWindowController"
import { CODEX_USAGE_IPC as IPC } from "../electron/shared/codex-usage-contract"
const m = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>() }))
vi.mock("electron", () => ({ ipcMain: { handle: (c: string, f: (...args: any[]) => Promise<any>) => m.handlers.set(c, f), removeHandler: (c: string) => m.handlers.delete(c) } }))
describe("usage IPC capability", () => {
  it("allows only the bubble main frame, no arguments, bounded reads and cleans registration", async () => {
    const frame = { url: "pet://app/activity-bubble.html", processId: 1, routingId: 2 }, contents = { id: 7, mainFrame: frame } as unknown as WebContents
    const bubble = { window: { isDestroyed: () => false, webContents: contents } as BrowserWindow, send: vi.fn() } as unknown as ActivityBubbleWindowController
    const sender = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
    const read = vi.fn(), service = new CodexUsageService(read), controller = new CodexUsageIpcController(service, bubble)
    controller.register(); controller.register(); expect(m.handlers.size).toBe(2)
    const invoke = (channel: string, event = sender, ...args: unknown[]) => m.handlers.get(channel)!(event, ...args)
    expect(await invoke(IPC.get)).toMatchObject({ ok: true }); expect(read).not.toHaveBeenCalled()
    for (const event of [{ ...sender, senderFrame: { ...frame, url: "pet://app/settings.html" } }, { ...sender, senderFrame: { ...frame, routingId: 3 } }, { ...sender, sender: { ...contents, id: 99 } }]) expect(await invoke(IPC.refresh, event as IpcMainInvokeEvent)).toEqual({ ok: false, code: "UNTRUSTED_SENDER" })
    for (const arg of [null, {}, "/private", { method: "turn/start" }]) expect(await invoke(IPC.refresh, sender, arg)).toEqual({ ok: false, code: "INVALID_REQUEST" })
    for (let i = 0; i < 11; i++) expect(await invoke(IPC.get)).toMatchObject({ ok: true })
    expect(await invoke(IPC.refresh)).toEqual({ ok: false, code: "REQUEST_LIMITED" })
    controller.dispose(); expect(m.handlers.size).toBe(0); await service.dispose()
  })
})
