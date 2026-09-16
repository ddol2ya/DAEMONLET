import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

class Window extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { id: 1, mainFrame: { url: "", processId: 1, routingId: 1 }, setWindowOpenHandler: vi.fn(), send: vi.fn() })
  minimized = false
  constructor(readonly options: Record<string, unknown>) { super() }
  setTitle = vi.fn()
  show = vi.fn()
  focus = vi.fn()
  showInactive = vi.fn()
  setSkipTaskbar = vi.fn()
  isDestroyed() { return false }
  isMinimized() { return this.minimized }
  restore = vi.fn(() => { this.minimized = false })
  async loadURL(url: string) { this.webContents.mainFrame.url = url }
  destroy() { this.emit("closed") }
}
vi.mock("electron", () => ({ BrowserWindow: Window }))
describe("resident application windows", () => {
  it("keeps settings, task list, lab and startup off the taskbar", async () => {
    const { SettingsWindowController } = await import("../electron/main/SettingsWindowController")
    const { ActivityWindowController } = await import("../electron/main/ActivityWindowController")
    const { LabWindowController } = await import("../electron/main/LabWindowController")
    const { StartupWindow } = await import("../electron/main/StartupWindow")
    const settings = new SettingsWindowController({ preloadPath: "/preload", onOpened: vi.fn(), onClosed: vi.fn() })
    const activity = new ActivityWindowController("/preload"), lab = new LabWindowController("/preload")
    for (const controller of [settings, activity, lab]) {
      const win = controller.open() as unknown as Window
      expect(win.options.skipTaskbar).toBe(true)
      win.emit("ready-to-show"); expect(win.show).toHaveBeenCalled()
      controller.destroy()
    }
    const startup = new StartupWindow(); await startup.open()
    expect((startup as unknown as { window: Window }).window.options.skipTaskbar).toBe(true)
    startup.close()
  })
  it("restores a minimized settings window and retains a taskbar route when the tray failed", async () => {
    const { SettingsWindowController } = await import("../electron/main/SettingsWindowController")
    let fallback = false
    const settings = new SettingsWindowController({ preloadPath: "/preload", onOpened: vi.fn(), onClosed: vi.fn(), taskbarVisible: () => fallback })
    const window = settings.open() as unknown as Window
    window.minimized = true; fallback = true
    expect(settings.open()).toBe(window)
    expect(window.restore).toHaveBeenCalledOnce(); expect(window.setSkipTaskbar).toHaveBeenLastCalledWith(false)
    settings.destroy()
    const reopened = settings.open() as unknown as Window
    expect(reopened.options.skipTaskbar).toBe(false)
    settings.destroy()
  })
})
