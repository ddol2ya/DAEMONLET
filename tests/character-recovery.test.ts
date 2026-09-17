import { afterEach, describe, expect, it, vi } from "vitest"
import { AppController } from "../electron/main/AppController"
import { CharacterTransitions } from "../electron/main/CharacterTransitions"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
import { setApplicationInputLocked } from "../electron/main/updates/OperationGate"

vi.mock("electron", () => ({ app: {}, ipcMain: {}, net: {}, session: {}, shell: {}, screen: { removeListener: vi.fn() }, dialog: {}, powerMonitor: { removeListener: vi.fn() }, BrowserWindow: class {}, Menu: {}, Tray: class {}, nativeImage: {} }))
vi.mock("../electron/main/updates/OfficialUpdater", () => ({ createOfficialUpdateEngine: vi.fn(), detectUpdatePlatform: vi.fn() }))

const owned: CharacterTransitions[] = []
afterEach(() => { for (const t of owned.splice(0)) t.retire(); setApplicationInputLocked(false) })
function fixture() {
  // Exercise the real Main recovery method without creating native windows.
  const controller = Object.create(AppController.prototype) as any
  const entries = new Map(["style-a", "style-b", "gpichan"].map(id => [id, { id, revision: id + "-old", source: id === "gpichan" ? "builtin" : "external" }]))
  const chat = new SideChatService(() => { throw Error("No model calls") })
  const transitions = new CharacterTransitions({ begin: t => { chat.beginCharacterApply(t.requestId) }, failed: t => chat.characterFailed(t.requestId), timeout: t => { void controller.characterLoadFailed(t) } })
  owned.push(transitions)
  Object.assign(controller, {
    transitions, lastReady: entries.get("style-b"), settings: { characterId: "style-a" },
    characters: { get: (id: string) => entries.get(id), isAvailable: (id: string) => entries.has(id), rollback: vi.fn(async () => {}) },
    traceCharacter: vi.fn(), warn: vi.fn(),
    updateSettings: vi.fn(({ characterId }: { characterId: string }) => { controller.settings.characterId = characterId; transitions.begin(entries.get(characterId)!) }),
  })
  return { controller, transitions, entries, chat }
}
describe("Main character failure recovery", () => {
  it("retires readiness and waits for pack cleanup before destroying chat, windows or registry", async () => {
    const f = fixture(), c = f.controller
    f.transitions.begin(f.entries.get("style-a")!)
    const disposedChat = vi.fn(async () => {}), disposedRegistry = vi.fn(async () => {})
    let finishPack!: () => void
    for (const name of ["sideChatIpc", "activityIpc", "bubbleIpc", "taskControlIpc", "settingsIpc", "updateIpc", "packUpdateIpc", "characterIpc", "activityTitles", "protocol"]) c[name] = { dispose: vi.fn() }
    for (const name of ["settingsWindow", "activityWindow", "pet", "lab", "tray"]) c[name] = { destroy: vi.fn() }
    Object.assign(c, { sideChat: { dispose: disposedChat }, petDrag: { cancel: vi.fn() }, chatEntry: { cancel: vi.fn() },
      activityBubble: { cancelPlacement: vi.fn(), destroy: vi.fn() }, updates: { dispose: vi.fn() }, subscriptions: [],
      activity: { dispose: vi.fn(async () => {}) }, integration: { dispose: vi.fn(async () => {}) },
      adapter: { stop: vi.fn(async () => {}) }, store: { save: vi.fn(async () => {}) }, characterTrace: { flush: vi.fn(async () => {}) },
      packUpdates: { dispose: vi.fn(() => new Promise<void>(resolve => { finishPack = resolve })) },
    })
    c.characters.dispose = disposedRegistry
    const exiting = c.cleanupForExit()
    await vi.waitFor(() => expect(finishPack).toBeTypeOf("function"))
    expect(f.transitions.busy).toBe(false)
    expect(disposedChat).not.toHaveBeenCalled()
    expect(disposedRegistry).not.toHaveBeenCalled()
    expect(c.settingsWindow.destroy).not.toHaveBeenCalled()
    finishPack(); await exiting
    expect(disposedChat).toHaveBeenCalledOnce()
    expect(disposedRegistry).toHaveBeenCalledOnce()
  })
  it("stops after the last-ready model and built-in fallback both fail instead of alternating forever", async () => {
    const f = fixture()
    for (const id of ["style-a", "style-b", "gpichan"]) {
      expect(f.controller.settings.characterId).toBe(id)
      const t = f.transitions.begin(f.entries.get(id)!).ticket
      await f.controller.characterLoadFailed(t)
    }
    expect(f.controller.settings.characterId).toBe("gpichan")
    expect(f.controller.lastReady).toBeNull()
    expect(f.transitions.busy).toBe(false)
    expect(f.chat.snapshot().applying).toBe(false)
    // A user retry is a fresh owned operation, not a permanently disabled UI.
    const retry = f.transitions.begin(f.entries.get("style-a")!)
    expect(f.transitions.busy).toBe(true)
    expect(f.transitions.ready(retry.ticket)).toBe(true)
  })
  it("does not retire readiness on a stale failure from another attempt", async () => {
    const f = fixture(), stale = f.transitions.begin(f.entries.get("style-b")!).ticket
    const current = f.transitions.begin(f.entries.get("style-a")!).ticket
    await f.controller.characterLoadFailed(stale)
    expect(f.controller.lastReady).toEqual(f.entries.get("style-b"))
    expect(f.transitions.matches(current)).toBe(true)
    expect(f.transitions.busy).toBe(true)
    expect(f.controller.updateSettings).not.toHaveBeenCalled()
  })
  it("preserves the previous working revision when only its replacement fails", async () => {
    const f = fixture(), prior = f.entries.get("style-b")!
    f.entries.set("style-b", { ...prior, revision: "style-b-new", previousVersion: "1.0.0" } as any)
    f.controller.settings.characterId = "style-b"
    const t = f.transitions.begin(f.entries.get("style-b")!).ticket
    await f.controller.characterLoadFailed(t)
    expect(f.controller.characters.rollback).toHaveBeenCalledWith(t)
    expect(f.controller.lastReady).toEqual(prior)
  })
})
