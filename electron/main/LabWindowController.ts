import { appText, bindWindowLanguage, languageArguments } from "./AppLanguage"
import { BrowserWindow } from "electron"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"

export class LabWindowController {
  window: BrowserWindow | null = null

  constructor(
    private readonly preloadPath: string,
    private readonly devServerUrl?: string,
    private readonly onWarning?: (message: string) => void,
  ) {}

  open(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return this.window }
    const win = new BrowserWindow({
      width: 1280,
      title: appText("모션 실험실"),
      height: 820,
      show: false,
      frame: true,
      transparent: false,
      backgroundColor: "#08090d",
      skipTaskbar: false,
      alwaysOnTop: false,
      webPreferences: { additionalArguments: languageArguments(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        devTools: !process.env.ELECTRON_IS_PACKAGED,
        preload: this.preloadPath,
      },
    })
    bindWindowLanguage(win, "모션 실험실"); this.window = win
    secureWebContents(win.webContents, "lab", this.devServerUrl)
    if ((typeof __APP_QA__ === "undefined" || __APP_QA__) && process.env.ELECTRON_SMOKE_TEST === "1") {
      win.webContents.on("console-message", (details) => {
        process.stderr.write(`[lab:${details.level}] ${details.message}\n`)
        if (details.level === "error") this.onWarning?.(`Motion Lab console: ${details.message}`)
      })
    }
    win.once("ready-to-show", () => win.show())
    win.once("closed", () => { this.window = null })
    void win.loadURL(expectedRendererUrl("lab", this.devServerUrl))
    return win
  }

  destroy(): void { this.window?.destroy(); this.window = null }
}
