import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"

class FakeWebContents extends EventEmitter {
  id = 41
  readonly setWindowOpenHandler = vi.fn()
  readonly reload = vi.fn()
  readonly send = vi.fn()
  url = ""
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  readonly hide = vi.fn(() => { this.visible = false })
  readonly showInactive = vi.fn(() => { this.visible = true })
  readonly moveTop = vi.fn()
  readonly setAlwaysOnTop = vi.fn()
  readonly setVisibleOnAllWorkspaces = vi.fn()
  readonly setIgnoreMouseEvents = vi.fn()
  readonly setFocusable = vi.fn()
  readonly setBounds = vi.fn()
  readonly destroy = vi.fn()
  visible = false
  isDestroyed() { return false }
  isVisible() { return this.visible }
  getBounds() { return { x: 0, y: 0, width: 460, height: 460 } }
  async loadURL(url: string) { this.webContents.url = url }
}

const cursor = vi.hoisted(() => ({ x: 200, y: 200 }))
vi.mock("electron", () => ({ BrowserWindow: FakeBrowserWindow, screen: { getCursorScreenPoint: () => cursor } }))

describe("PetWindowController visibility", () => {
  it.runIf(process.platform === "win32")("releases gaze outside the native window when DOM leave is missing, preserving drags and cleaning up", async () => {
    vi.useFakeTimers()
    const { PetWindowController } = await import("../electron/main/PetWindowController")
    const controller = new PetWindowController({ preloadPath: "/preload.cjs", onBoundsChanged: vi.fn(), onWarning: vi.fn(), onCloseRequested: vi.fn() })
    const window = controller.create(defaultDesktopSettings()) as unknown as FakeBrowserWindow
    try {
      controller.reportReady()
      Object.assign(cursor, { x: 200, y: 200 })
      vi.advanceTimersByTime(100)
      expect(window.webContents.send).not.toHaveBeenCalled()
      for (const point of [{ x: -1, y: 200 }, { x: 460, y: 200 }, { x: 200, y: -1 }, { x: 200, y: 460 }]) {
        Object.assign(cursor, point)
        vi.advanceTimersByTime(100)
        expect(window.webContents.send).toHaveBeenLastCalledWith("desktop.pointer.outside", true)
      }
      window.webContents.send.mockClear()
      controller.setInteractionLocked(true)
      vi.advanceTimersByTime(300)
      expect(window.webContents.send).not.toHaveBeenCalled()
      controller.setInteractionLocked(false)
      vi.advanceTimersByTime(100)
      expect(window.webContents.send).toHaveBeenCalledOnce()
      window.webContents.send.mockClear()
      controller.hide()
      vi.advanceTimersByTime(100)
      expect(window.webContents.send).not.toHaveBeenCalled()
      controller.show()
      controller.destroy()
      vi.advanceTimersByTime(300)
      expect(window.webContents.send).not.toHaveBeenCalled()
    } finally { controller.destroy(); vi.useRealTimers() }
  })
  it("routes a close request through the persisted visible setting", async () => {
    const { PetWindowController } = await import("../electron/main/PetWindowController")
    let settings = defaultDesktopSettings()
    let controller!: InstanceType<typeof PetWindowController>
    const onCloseRequested = vi.fn(() => {
      settings = { ...settings, visible: false }
      controller.applySettings(settings)
    })
    const onContextMenu = vi.fn()
    controller = new PetWindowController({
      preloadPath: "/preload.cjs",
      onBoundsChanged: vi.fn(),
      onWarning: vi.fn(),
      onCloseRequested,
      onContextMenu,
    })
    const window = controller.create(settings) as unknown as FakeBrowserWindow
    controller.reportReady()
    const event = { preventDefault: vi.fn() }
    window.emit("close", event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(onCloseRequested).toHaveBeenCalledOnce()
    expect(settings.visible).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    window.webContents.emit("context-menu")
    expect(onContextMenu).toHaveBeenCalledWith(window)
    controller.destroy()
  })
})
