import { appText, bindWindowLanguage, languageArguments } from "./AppLanguage"
import { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"

export class SettingsWindowController {
  window: BrowserWindow | null = null
  private owner: string | null = null
  private token = ""

  constructor(private readonly options: {
    preloadPath: string
    devServerUrl?: string
    onOpened: (owner: string) => void
    onClosed: (owner: string) => void
  }) {}

  currentOwner(): string | null {
    const win = this.window
    if (!win || win.isDestroyed()) return null
    const frame = win.webContents.mainFrame
    if (frame.url !== expectedRendererUrl("settings", this.options.devServerUrl)) return null
    const next = `${this.token}:${win.webContents.id}:${frame.processId}:${frame.routingId}`
    if (this.owner !== next) {
      if (this.owner) this.options.onClosed(this.owner)
      this.owner = next
      this.options.onOpened(next)
    }
    return next
  }

  open(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return this.window }
    const win = new BrowserWindow({
      width: 1060, height: 820, minWidth: 800, minHeight: 650,
      title: appText("Daemonlet 설정"), show: false, frame: true, transparent: false,
      backgroundColor: "#f7f7f4", alwaysOnTop: false, skipTaskbar: false,
      webPreferences: { additionalArguments: languageArguments(), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, preload: this.options.preloadPath, devTools: !process.env.ELECTRON_IS_PACKAGED },
    })
    bindWindowLanguage(win, "Daemonlet 설정"); this.window = win
    this.token = randomUUID()
    secureWebContents(win.webContents, "settings", this.options.devServerUrl)
    win.webContents.on("did-start-loading", () => { if (this.owner) this.options.onClosed(this.owner); this.owner = null })
    win.webContents.on("did-finish-load", () => { this.currentOwner() })
    win.webContents.on("render-process-gone", () => { if (this.owner) this.options.onClosed(this.owner); this.owner = null })
    win.once("ready-to-show", () => { if (!win.isDestroyed()) win.show() })
    win.once("closed", () => {
      if (this.owner) this.options.onClosed(this.owner)
      this.owner = null
      if (this.window === win) this.window = null
    })
    void win.loadURL(expectedRendererUrl("settings", this.options.devServerUrl)).catch(() => { /* failure is displayed by Chromium, never raw installer data */ })
    return win
  }

  send(channel: string, value: unknown): void { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value) }
  destroy(): void { this.window?.destroy(); this.window = null }
}
