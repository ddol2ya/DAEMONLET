import { beforeEach, afterEach, it, expect, vi } from "vitest"
import { UPDATE_IPC } from "../electron/shared/update-contract"
import { UpdateIpcController } from "../electron/main/updates/UpdateIpcController"
import { setApplicationInputLocked } from "../electron/main/updates/OperationGate"
const handlers = vi.hoisted(() => new Map<string, Function>())
vi.mock("electron", () => ({ ipcMain: { handle: (key: string, fn: Function) => handlers.set(key, fn), removeHandler: (key: string) => handlers.delete(key) } }))
let controller: UpdateIpcController
const frame = { url: "pet://app/settings.html" }, webContents = { id: 21, mainFrame: frame }, win = { isDestroyed: () => false, webContents }
const event = { sender: webContents, senderFrame: frame }
const service = { snapshot: vi.fn(() => ({ phase: "idle", currentVersion: "0.7.2" })), act: vi.fn(async () => ({ phase: "checking" })), subscribe: vi.fn(() => vi.fn()) }
beforeEach(() => { vi.clearAllMocks(); controller = new UpdateIpcController(service as any, { window: win, send: vi.fn() } as any); controller.register() })
afterEach(() => { controller.dispose(); setApplicationInputLocked(false) })
it("rejects other windows, same-URL subframes and extra URL/path arguments", () => {
  const action = handlers.get(UPDATE_IPC.action)!
  expect(() => action({ ...event, sender: { ...webContents, id: 22 } }, { action: "check" })).toThrow("UNTRUSTED")
  expect(() => action({ ...event, senderFrame: { ...frame } }, { action: "check" })).toThrow("UNTRUSTED")
  expect(() => action(event, { action: "download", candidateId: "d4664dd8-9f04-4919-8a7a-58013f81d6c6", path: "evil.exe" })).toThrow("INVALID")
  expect(() => action(event, { action: "check" }, "url")).toThrow("INVALID")
  expect(service.act).not.toHaveBeenCalled()
})
it("limits IPC flooding and permits status during the shutdown gate", () => {
  setApplicationInputLocked(true)
  const snapshot = handlers.get(UPDATE_IPC.snapshot)!
  expect(snapshot(event)).toMatchObject({ phase: "idle" })
  for (let n = 0; n < 11; n++) snapshot(event)
  expect(() => snapshot(event)).toThrow("REQUEST_LIMITED")
})
it("disposes only its own update handlers", () => { handlers.set("unrelated", () => {}); controller.dispose(); expect(handlers.has(UPDATE_IPC.action)).toBe(false); expect(handlers.has("unrelated")).toBe(true); handlers.delete("unrelated") })
