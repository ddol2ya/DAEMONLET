import type { App, BrowserWindow } from "electron"

/** Geometry failure may expose a temporary recovery window, not a permanent Dock app. */
export class DockResidencyController {
  private fallback = false
  private disposed = false
  private policy: "regular" | "accessory" | null = null
  private readonly listeners = new Map<BrowserWindow, () => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly options: {
    app: Pick<App, "on" | "removeListener" | "setActivationPolicy">
    windows(): BrowserWindow[]
    utilityWindows(): Array<BrowserWindow | null>
    dockVisible(): boolean
    trayCreated(): boolean
    trayVisible(): boolean
    recovered(): void
  }) {}
  start() {
    this.options.app.on("browser-window-created", this.created)
    for (const win of this.options.windows()) this.watch(win)
    this.timer = setInterval(this.sync, 2000); this.timer.unref()
    this.sync()
  }
  requestFallback() { this.fallback = true; this.sync() }
  private created = (_event: unknown, win: BrowserWindow) => this.watch(win)
  private watch(win: BrowserWindow) {
    if (this.listeners.has(win)) return
    const changed = () => queueMicrotask(this.sync)
    this.listeners.set(win, changed)
    win.on("show", changed); win.on("hide", changed); win.on("closed", changed)
    win.on("minimize", changed); win.on("restore", changed)
  }
  sync = () => {
    if (this.disposed) return
    if (this.fallback && this.options.trayCreated() && this.options.trayVisible()) {
      this.fallback = false; this.options.recovered()
    }
    // Real Tray creation failure retains a reachable Dock entry even with no windows.
    // A placed-but-overflowed menu item only needs Dock access while utility UI is open.
    const utilityOpen = this.options.utilityWindows().some(win => win && !win.isDestroyed() && (win.isVisible() || win.isMinimized()))
    const policy = this.fallback && (!this.options.trayCreated() || utilityOpen) ? "regular" : "accessory"
    if (policy !== this.policy || this.options.dockVisible() !== (policy === "regular")) { this.policy = policy; this.options.app.setActivationPolicy(policy) }
    for (const [win, changed] of this.listeners) if (win.isDestroyed()) this.unwatch(win, changed)
  }
  private unwatch(win: BrowserWindow, changed: () => void) {
    win.removeListener("show", changed); win.removeListener("hide", changed); win.removeListener("closed", changed)
    win.removeListener("minimize", changed); win.removeListener("restore", changed)
    this.listeners.delete(win)
  }
  dispose() {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.options.app.removeListener("browser-window-created", this.created)
    for (const [win, changed] of this.listeners) this.unwatch(win, changed)
  }
}
