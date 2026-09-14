import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { CharacterIpcController } from "../electron/main/CharacterIpcController"
import type { CharacterRegistry } from "../electron/main/CharacterRegistry"
import type { SettingsWindowController } from "../electron/main/SettingsWindowController"
import { CHARACTER_IPC } from "../electron/shared/character-pack-contract"

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), picker: vi.fn(), confirm: vi.fn() }))
vi.mock("electron", () => ({ ipcMain: { handle: (c: string, fn: (...args: any[]) => Promise<any>) => mocks.handlers.set(c, fn), removeHandler: (c: string) => mocks.handlers.delete(c) }, dialog: { showOpenDialog: mocks.picker, showMessageBox: mocks.confirm } }))
const controllers: CharacterIpcController[] = []
beforeEach(() => { mocks.handlers.clear(); mocks.picker.mockReset(); mocks.confirm.mockReset() })
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()) })
function fixture() {
  const win = (id: number, page: string) => ({ isDestroyed: () => false, webContents: { id, mainFrame: { url: `pet://app/${page}.html` } } }) as unknown as BrowserWindow
  const settings = win(1, "settings"), pet = win(2, "pet"), lab = win(3, "index")
  const entry = { id: "fresh", name: "Fresh", source: "external", status: "ready", version: "2.0.0", previousVersion: "1.0.0", revision: "a".repeat(64) }
  const registry = { snapshot: vi.fn(() => ({ generation: 1, entries: [entry] })), get: vi.fn(() => entry), prepareImport: vi.fn(async () => ({})), commitImport: vi.fn(async () => entry), cancelImport: vi.fn(async () => {}), rollback: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  const select = vi.fn(async () => {})
  const window = { window: settings, currentOwner: () => "owner-1", send: vi.fn() } as unknown as SettingsWindowController
  const controller = new CharacterIpcController({ registry: registry as unknown as CharacterRegistry, settings: window, pet: () => pet, lab: () => lab, select, selected: () => "fresh" })
  controllers.push(controller); controller.register()
  const event = (w = settings) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame }) as IpcMainInvokeEvent
  const invoke = (channel: string, args: unknown[] = [], e = event()) => mocks.handlers.get(channel)!(e, ...args)
  return { entry, registry, settings, pet, lab, window, select, event, invoke }
}
describe("character IPC authority", () => {
  it("allows Pet/Lab read and select, while only Settings can mutate packs", async () => {
    const f = fixture()
    for (const w of [f.pet, f.lab]) {
      expect(await f.invoke(CHARACTER_IPC.list, [], f.event(w))).toMatchObject({ ok: true })
      expect(await f.invoke(CHARACTER_IPC.select, [{ id: "fresh", revision: f.entry.revision }], f.event(w))).toMatchObject({ ok: true })
      for (const channel of [CHARACTER_IPC.choose, CHARACTER_IPC.commit, CHARACTER_IPC.cancel, CHARACTER_IPC.remove, CHARACTER_IPC.rollback]) expect(await f.invoke(channel, [], f.event(w))).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" })
    }
    expect(mocks.picker).not.toHaveBeenCalled()
  })
  it("rejects same-URL iframes, forged senders, extra arguments, paths and malformed selections", async () => {
    const f = fixture()
    expect(await f.invoke(CHARACTER_IPC.list, [], { ...f.event(), senderFrame: { url: "pet://app/settings.html" } } as IpcMainInvokeEvent)).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" })
    expect(await f.invoke(CHARACTER_IPC.choose, ["/arbitrary/path.petchar"])).toMatchObject({ ok: false })
    expect(await f.invoke(CHARACTER_IPC.commit, [{ token: "fake", verified: true, path: "/secret" }])).toMatchObject({ ok: false })
    expect(await f.invoke(CHARACTER_IPC.select, [{ id: "fresh", revision: f.entry.revision, path: "/secret" }])).toMatchObject({ ok: false })
    expect(f.registry.prepareImport).not.toHaveBeenCalled(); expect(f.select).not.toHaveBeenCalled()
  })
  it("uses the native picker result and binds the preview to its current owner", async () => {
    const f = fixture()
    mocks.picker.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await f.invoke(CHARACTER_IPC.choose)).toEqual({ ok: true, value: null })
    mocks.picker.mockResolvedValueOnce({ canceled: false, filePaths: ["/native/selected.petchar"] })
    await f.invoke(CHARACTER_IPC.choose)
    expect(f.registry.prepareImport).toHaveBeenCalledExactlyOnceWith("/native/selected.petchar", "owner-1", expect.any(Function))
  })
  it("sends progress only to the window that owns the import", async () => {
    const f = fixture()
    mocks.picker.mockResolvedValueOnce({ canceled: false, filePaths: ["/native/selected.petchar"] })
    await f.invoke(CHARACTER_IPC.choose)
    const progress = (f.registry.prepareImport.mock.calls[0] as unknown as [string, string, (value: unknown) => void])[2]
    progress({ phase: "rig", completed: 1, total: 3 })
    expect(f.window.send).toHaveBeenCalledExactlyOnceWith(CHARACTER_IPC.progress, { phase: "rig", completed: 1, total: 3 })
    f.window.currentOwner = () => "different-window"
    progress({ phase: "rig", completed: 2, total: 3 })
    expect(f.window.send).toHaveBeenCalledTimes(1)
  })
  it("waits for the fallback to be ready before removing the selected pack", async () => {
    const f = fixture(); let ready!: () => void
    f.select.mockImplementation(() => new Promise(resolve => { ready = resolve }))
    mocks.confirm.mockResolvedValueOnce({ response: 1 })
    const request = f.invoke(CHARACTER_IPC.remove, [{ id: "fresh", revision: f.entry.revision }])
    await vi.waitFor(() => expect(f.select).toHaveBeenCalledWith({ id: "gpichan", revision: "builtin" }))
    expect(f.registry.remove).not.toHaveBeenCalled()
    ready(); expect(await request).toMatchObject({ ok: true, value: true })
    expect(f.registry.remove).toHaveBeenCalledOnce()
  })
  it("keeps the pack if fallback loading fails or confirmation is cancelled", async () => {
    const f = fixture(), target = { id: "fresh", revision: f.entry.revision }
    mocks.confirm.mockResolvedValueOnce({ response: 0 })
    expect(await f.invoke(CHARACTER_IPC.remove, [target])).toMatchObject({ ok: true, value: false })
    mocks.confirm.mockResolvedValueOnce({ response: 1 }); f.select.mockRejectedValueOnce(new Error("PACK_LOAD"))
    expect(await f.invoke(CHARACTER_IPC.remove, [target])).toMatchObject({ ok: false, code: "PACK_LOAD" })
    expect(f.registry.remove).not.toHaveBeenCalled()
  })
})
