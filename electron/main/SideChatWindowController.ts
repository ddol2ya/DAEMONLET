import { installAppProtocol } from "./AppProtocol"
import { join } from "node:path"
import { app, BrowserWindow, screen } from "electron"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"
import { SIDE_CHAT_IPC, type SideChatSnapshot } from "../shared/side-chat-contract"

export function chatBounds(area: Electron.Rectangle, anchor: Electron.Rectangle, size: { width: number; height: number }): Electron.Rectangle {
  const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height)
  return { width, height, x: Math.round(Math.max(area.x, Math.min(anchor.x - width - 12, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(anchor.y, area.y + area.height - height))) }
}
export class SideChatWindowController {
  window: BrowserWindow | null = null
  private mode: SideChatSnapshot["mode"] = "hidden"
  private panelSize = { width: 420, height: 560 }
  private changingBounds = false
  private protocolInstalled = false
  constructor(private readonly options: { preload: string; distRoot?: string; devServerUrl?: string; pet: () => BrowserWindow | null; hidden: () => void; visibility: (visible: boolean) => void }) {}
  show(snapshot: SideChatSnapshot) {
    if (snapshot.mode === "hidden") { this.mode = "hidden"; this.window?.hide(); this.options.visibility(false); this.send(snapshot); return }
    const opening = !this.window?.isVisible(), previous = this.mode
    this.mode = snapshot.mode
    if (!this.window || this.window.isDestroyed()) {
      const win = new BrowserWindow({ width: 380, height: 480, minWidth: 280, minHeight: 280, show: false, title: "Daemonlet", backgroundColor: "#f7f8fa", alwaysOnTop: true,
        webPreferences: { preload: this.options.preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, partition: "daemonlet-side-chat" } })
      if (!this.protocolInstalled) { installAppProtocol(this.options.distRoot ?? join(app.getAppPath(), "dist"), win.webContents.session.protocol); this.protocolInstalled = true }
      this.window = win; secureWebContents(win.webContents, "side-chat", this.options.devServerUrl)
      win.webContents.session.setPermissionRequestHandler((_w, _p, callback) => callback(false))
      win.webContents.session.setPermissionCheckHandler(() => false)
      win.on("close", event => { event.preventDefault(); this.options.hidden() })
      win.on("resize", () => { if (this.mode === "panel" && !this.changingBounds) { const b = win.getBounds(); this.panelSize = { width: b.width, height: b.height } } })
      win.webContents.on("render-process-gone", () => { this.options.hidden(); win.destroy(); if (this.window === win) this.window = null })
      win.once("ready-to-show", () => { if (this.mode !== "hidden" && !win.isDestroyed()) win.show() })
      void win.loadURL(expectedRendererUrl("side-chat", this.options.devServerUrl)).catch(() => this.options.hidden())
    }
    const win = this.window
    win.setTitle(snapshot.language === "ko" ? "캐릭터와 대화" : "Chat with character")
    win.setResizable(this.mode === "panel")
    if (opening || previous !== this.mode) this.reposition()
    this.options.visibility(true)
    if (opening && !win.webContents.isLoading()) { win.show(); win.focus() }
    this.send(snapshot)
  }
  reposition = () => {
    const win = this.window
    if (!win || this.mode === "hidden") return
    const anchor = this.options.pet()?.getBounds() ?? screen.getPrimaryDisplay().workArea
    const area = screen.getDisplayMatching(anchor).workArea
    this.changingBounds = true
    win.setMinimumSize(Math.min(280, area.width), Math.min(280, area.height))
    win.setBounds(chatBounds(area, anchor, this.mode === "panel" ? this.panelSize : { width: 380, height: 480 }))
    this.changingBounds = false
  }
  send(snapshot: SideChatSnapshot) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(SIDE_CHAT_IPC.changed, snapshot) }
  destroy() { this.window?.destroy(); this.window = null; this.options.visibility(false) }
}
