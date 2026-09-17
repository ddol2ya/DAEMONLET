import { afterEach, describe, expect, it, vi } from "vitest"
import { PackUpdateIpcController } from "../electron/main/pack-updates/PackUpdateIpcController"
import { PACK_UPDATE_IPC } from "../electron/shared/pack-update-contract"
const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>() }))
vi.mock("electron", () => ({ ipcMain: { handle: (c: string, fn: (...a: any[]) => Promise<any>) => mock.handlers.set(c, fn), removeHandler: (c: string) => mock.handlers.delete(c) } }))
afterEach(() => mock.handlers.clear())
function fixture() {
  const frame = { url: "pet://app/settings.html" }, sender = { id: 2, mainFrame: frame }, win = { isDestroyed: () => false, webContents: sender }
  const service = Object.fromEntries(["snapshot", "check", "download", "apply", "cancel", "auto", "skip"].map(k => [k, vi.fn(async () => undefined)]))
  const controller = new PackUpdateIpcController(service as any, { window: win, currentOwner: () => "window-generation" } as any)
  controller.register()
  const invoke = (action: unknown, event = { sender, senderFrame: frame }, ...extra: unknown[]) => mock.handlers.get(PACK_UPDATE_IPC.act)!(event, action, ...extra)
  return { service, invoke, sender, frame }
}
describe("pack update IPC", () => {
  it("rejects pet, iframe and forged senders before doing work", async () => {
    const f = fixture()
    for (const event of [{ sender: { ...f.sender, id: 99 }, senderFrame: f.frame }, { sender: f.sender, senderFrame: { ...f.frame } }]) await expect(f.invoke({ action: "check", packId: "style-a" }, event)).rejects.toThrow("UNTRUSTED_SENDER")
    expect(f.service.check).not.toHaveBeenCalled()
  })
  it("exposes only IDs/actions, binds calls to the settings owner and rejects extra authority", async () => {
    const f = fixture()
    await f.invoke({ action: "check", packId: "style-a" })
    expect(f.service.check).toHaveBeenCalledWith("style-a", "window-generation")
    for (const action of [{ action: "download", packId: "style-a", url: "https://example.test" }, { action: "apply", candidateId: "fake", verified: true }, { action: "download", packId: "style-a", path: "/tmp/a.petchar" }, { action: "auto", packId: "style-a", enabled: "yes" }, { action: "apply", token: "0".repeat(36) }, { action: "publish", packId: "style-a" }]) await expect(f.invoke(action)).rejects.toThrow("PACK_TRANSACTION")
    expect(f.service.download).not.toHaveBeenCalled(); expect(f.service.apply).not.toHaveBeenCalled()
  })
})
