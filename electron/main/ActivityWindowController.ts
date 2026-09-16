import { appText, bindWindowLanguage, languageArguments } from "./AppLanguage"
import { BrowserWindow } from "electron"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"

export class ActivityWindowController {
  window: BrowserWindow | null = null
  constructor(private readonly preloadPath: string, private readonly devServerUrl?: string) {}

  open(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.show(); this.window.focus(); return this.window
    }
    const win = new BrowserWindow({
      width: 850, height: 800, minWidth: 640, minHeight: 560,
      title: appText("Daemonlet 작업 목록"), show: false, skipTaskbar: true, backgroundColor: "#f7f8fa",
      webPreferences: { additionalArguments: languageArguments(), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, preload: this.preloadPath },
    })
    bindWindowLanguage(win, "Daemonlet 작업 목록"); this.window = win
    secureWebContents(win.webContents, "activity", this.devServerUrl)
    win.once("ready-to-show", () => { if (!win.isDestroyed()) win.show() })
    win.once("closed", () => { if (this.window === win) this.window = null })
    void win.loadURL(expectedRendererUrl("activity", this.devServerUrl)).catch(() => {})
    return win
  }

  send(channel: string, value: unknown): void { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value) }
  destroy(): void { this.window?.destroy(); this.window = null }
}
