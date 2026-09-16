import { NativeDragStart } from "./NativeDragStart"
import { bindWindowLanguage, languageArguments } from "./AppLanguage"
import { BrowserWindow, screen, type Rectangle } from "electron"
import { join } from "node:path"
import type { DesktopSettingsV1 } from "../shared/desktop-settings"
import { IPC, type AdapterStatus } from "../shared/ipc-contract"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"

type PetWindowOptions = {
  preloadPath: string
  devServerUrl?: string
  onBoundsChanged: (bounds: Rectangle) => void
  onWarning: (message: string) => void
  onCloseRequested: () => void
  onContextMenu?: (window: BrowserWindow) => void
}

export class PetWindowController {
  window: BrowserWindow | null = null
  private layoutMode = false
  private interactionLocked = false
  private requestedPassthrough = false
  private ready = false
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private pointerBoundaryTimer: ReturnType<typeof setInterval> | null = null
  private crashReloaded = false
  private clickThrough = true
  private desiredVisible = true
  private effectivePassthrough = false
  private dragging = false
  private dragStart = new NativeDragStart()
  private revealWaiters = new Set<(ready: boolean) => void>()

  constructor(private readonly options: PetWindowOptions) {}

  create(settings: DesktopSettingsV1): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    this.clickThrough = settings.clickThrough
    this.desiredVisible = settings.visible
    const win = new BrowserWindow({
      ...settings.bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: settings.alwaysOnTop,
      focusable: true,
      acceptFirstMouse: true,
      webPreferences: { additionalArguments: languageArguments(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        devTools: !process.env.ELECTRON_IS_PACKAGED,
        preload: this.options.preloadPath,
      },
    })
    bindWindowLanguage(win); this.window = win
    secureWebContents(win.webContents, "pet", this.options.devServerUrl)
    win.setAlwaysOnTop(settings.alwaysOnTop, "floating")
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(settings.showOnAllWorkspaces, { visibleOnFullScreen: settings.showOverFullScreen })
    win.on("move", () => this.options.onBoundsChanged(win.getBounds()))
    win.on("moved", () => this.options.onBoundsChanged(win.getBounds()))
    win.on("close", (event) => {
      if (!win.isDestroyed()) { event.preventDefault(); this.options.onCloseRequested() }
    })
    win.webContents.on("render-process-gone", (_event, details) => {
      this.failSafe(`Pet renderer exited: ${details.reason}`)
      if (!this.crashReloaded) { this.crashReloaded = true; win.webContents.reload() }
    })
    win.webContents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
      if (mainFrame) this.failSafe(`Pet load failed (${code} ${description}): ${url}`)
    })
    win.webContents.on("context-menu", () => this.options.onContextMenu?.(win))
    win.webContents.on("before-mouse-event", (_event, input) => {
      if (input.type !== "mouseDown") return
      const modifiers = input.modifiers ?? []
      this.dragStart.record(win.getBounds(), input, input.button === "left" && modifiers.includes("alt") && !modifiers.some(m => ["control", "ctrl", "meta", "command", "cmd", ...(process.platform === "win32" ? ["right", "altgr"] : [])].includes(m)))
    })
    if ((typeof __APP_QA__ === "undefined" || __APP_QA__) && process.env.ELECTRON_SMOKE_TEST === "1") {
      win.webContents.on("console-message", (details) => {
        process.stderr.write(`[pet:${details.level}] ${details.message}\n`)
        if (details.level === "error") this.options.onWarning(`Renderer console: ${details.message}`)
      })
    }
    win.on("unresponsive", () => this.failSafe("Pet renderer became unresponsive"))
    win.once("closed", () => { this.stopPointerBoundaryCheck(); this.window = null })
    // Windows click-through can stop DOM mouse delivery without pointerleave.
    // Check native coordinates without moving the cursor or taking focus.
    if (process.platform === "win32") {
      this.pointerBoundaryTimer = setInterval(() => {
        if (!this.ready || win.isDestroyed() || !win.isVisible() || this.interactionLocked || this.layoutMode) return
        const cursor = screen.getCursorScreenPoint(), bounds = win.getBounds()
        if (cursor.x < bounds.x || cursor.y < bounds.y || cursor.x >= bounds.x + bounds.width || cursor.y >= bounds.y + bounds.height) {
          this.send(IPC.pointerOutside, true)
        }
      }, 100)
      this.pointerBoundaryTimer.unref()
    }
    void win.loadURL(expectedRendererUrl("pet", this.options.devServerUrl)).catch((error) => this.failSafe(`Pet navigation failed: ${String(error)}`))
    this.readyTimer = setTimeout(() => {
      if (!this.ready && !win.isDestroyed()) {
        for (const finish of [...this.revealWaiters]) finish(false)
        this.options.onWarning("Pet renderer did not report ready within 15 seconds")
        if (this.desiredVisible) win.showInactive()
      }
    }, 15_000)
    return win
  }

  reportReady(): void {
    this.ready = true
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    if (this.desiredVisible && this.window && !this.window.isDestroyed()) this.window.showInactive()
    for (const finish of [...this.revealWaiters]) finish(true)
  }

  async reveal(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.desiredVisible || !this.window || this.window.isDestroyed()) return false
    if (!this.ready) {
      const ready = await new Promise<boolean>(resolve => {
        const abort = () => finish(false)
        const finish = (ready: boolean) => { this.revealWaiters.delete(finish); signal.removeEventListener("abort", abort); resolve(ready) }
        this.revealWaiters.add(finish); signal.addEventListener("abort", abort, { once: true })
      })
      if (!ready || signal.aborted || !this.desiredVisible) return false
    }
    this.show()
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible())
  }

  setMousePassthrough(ignore: boolean): void {
    this.requestedPassthrough = ignore
    this.applyMousePolicy()
  }

  setInteractionLocked(locked: boolean): void {
    this.interactionLocked = locked
    this.applyMousePolicy()
  }
  setDragging(value: boolean) {
    this.dragging = value
    this.applyMousePolicy()
    if (!value) this.send(IPC.dragCancelled, true)
  }
  takeDragStart() {
    const point = this.dragStart.take()
    return point && this.ready && !this.layoutMode && this.desiredVisible ? { x: point.x, y: point.y } : null
  }

  setLayoutMode(enabled: boolean): void {
    this.layoutMode = enabled
    this.applyMousePolicy()
    this.window?.setFocusable(true)
    this.send(IPC.layoutChanged, enabled)
    if (enabled) this.show()
  }

  applySettings(settings: DesktopSettingsV1): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    this.clickThrough = settings.clickThrough
    this.desiredVisible = settings.visible
    if (!settings.visible) for (const finish of [...this.revealWaiters]) finish(false)
    win.setAlwaysOnTop(settings.alwaysOnTop, "floating")
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(settings.showOnAllWorkspaces, { visibleOnFullScreen: settings.showOverFullScreen })
    if (win.isVisible() !== settings.visible) settings.visible ? win.showInactive() : win.hide()
    this.applyMousePolicy()
    this.send(IPC.settingsChanged, settings)
  }

  setBounds(bounds: Rectangle): void { this.window?.setBounds(bounds, false) }
  show(): void { if (this.window && !this.window.isDestroyed()) { if (this.window.isMinimized()) this.window.restore(); this.window.showInactive(); this.window.moveTop() } }
  hide(): void { this.window?.hide() }
  reload(): void { this.crashReloaded = false; this.failSafe("Pet reload requested"); this.window?.webContents.reload() }
  send(channel: string, value: unknown): void { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value) }
  getMousePolicy(): { requested: boolean; effective: boolean; interactionLocked: boolean; layoutMode: boolean } {
    return { requested: this.requestedPassthrough, effective: this.effectivePassthrough, interactionLocked: this.interactionLocked, layoutMode: this.layoutMode }
  }

  destroy(): void {
    for (const finish of [...this.revealWaiters]) finish(false)
    this.stopPointerBoundaryCheck()
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    const win = this.window
    this.window = null
    if (win && !win.isDestroyed()) { win.removeAllListeners("close"); win.destroy() }
  }

  private stopPointerBoundaryCheck(): void {
    if (this.pointerBoundaryTimer) clearInterval(this.pointerBoundaryTimer)
    this.pointerBoundaryTimer = null
  }

  private applyMousePolicy(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const ignore = this.ready && this.clickThrough && this.requestedPassthrough && !this.interactionLocked && !this.layoutMode && !this.dragging
    this.effectivePassthrough = ignore
    win.setIgnoreMouseEvents(ignore, { forward: true })
  }

  private failSafe(message: string): void {
    for (const finish of [...this.revealWaiters]) finish(false)
    this.ready = false
    this.requestedPassthrough = false
    this.effectivePassthrough = false
    this.window?.setIgnoreMouseEvents(false)
    this.options.onWarning(message)
  }
}
