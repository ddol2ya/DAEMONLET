import { appText, bindWindowLanguage, languageArguments } from "./AppLanguage"
import { BrowserWindow, screen } from "electron"
import { BUBBLE_IPC, type BubbleAnchor, type SpeechBubbleContent, type SpeechBubbleFrame } from "../shared/bubble-presentation"
import type { BubbleRect } from "../shared/bubble-position"
import type { DesktopSettingsV1 } from "../shared/desktop-settings"
import { positionDesktopSpeechBubble } from "../shared/speech-bubble"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"

/** A non-interactive companion: scaling Pet never resizes its text area. */
export class SpeechBubbleWindowController {
  window: BrowserWindow | null = null
  private ready = false
  private frame: SpeechBubbleFrame | null = null
  private appearanceKey = ""
  private placement: { text: string; anchor: BubbleAnchor; content: SpeechBubbleContent; environment: string; bounds: BubbleRect | null } | null = null
  constructor(private readonly preloadPath: string, private readonly devServerUrl?: string) {}

  sync(pet: BrowserWindow | null, settings: DesktopSettingsV1 | null, anchor: BubbleAnchor | null, frame: SpeechBubbleFrame | null, inLayout: boolean, controls?: BrowserWindow | null): void {
    if (this.window?.isDestroyed()) { this.window = null; this.ready = false; this.placement = null }
    if (!pet || pet.isDestroyed() || !pet.isVisible() || pet.isMinimized() || !settings?.visible || !settings.speechBubblesEnabled || inLayout || !anchor || !frame) {
      this.frame = null
      this.placement = null
      this.window?.webContents.send(BUBBLE_IPC.speech, null)
      this.window?.hide()
      return
    }
    this.frame = frame
    if (!this.window) this.create()
    const win = this.window!, bounds = pet.getBounds()
    const appearanceKey = `${settings.alwaysOnTop}:${settings.showOnAllWorkspaces}:${settings.showOverFullScreen}`
    if (appearanceKey !== this.appearanceKey) {
      win.setAlwaysOnTop(settings.alwaysOnTop, "floating")
      if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(settings.showOnAllWorkspaces, { visibleOnFullScreen: settings.showOverFullScreen })
      this.appearanceKey = appearanceKey
    }
    const avoid = controls && !controls.isDestroyed() && controls.isVisible() ? controls.getBounds() : undefined
    const area = screen.getDisplayMatching(bounds).workArea
    if (!this.placement || this.placement.text !== frame.content.text) {
      this.placement = {
        text: frame.content.text, anchor: { ...anchor },
        content: { ...frame.content, outline: frame.content.outline?.slice() },
        environment: "", bounds: null,
      }
    }
    // Pin one line to its opening pose. Animation reports cannot move a box
    // the user is reading; real window moves/resizes still reposition it.
    const placement = this.placement
    const environment = JSON.stringify([bounds, area, avoid, frame.content.width, frame.content.height])
    if (!placement.bounds || placement.environment !== environment) {
      placement.bounds = positionDesktopSpeechBubble(bounds, area, placement.anchor, { ...placement.content, width: frame.content.width, height: frame.content.height }, avoid)
      placement.environment = environment
    }
    const next = placement.bounds
    const current = win.getBounds()
    if (Object.keys(next).some(k => next[k as keyof typeof next] !== current[k as keyof typeof next])) win.setBounds(next, false)
    if (this.ready) {
      win.webContents.send(BUBBLE_IPC.speech, frame)
      if (!win.isVisible()) win.showInactive()
    }
  }

  private create(): void {
    const win = new BrowserWindow({
      width: 252, height: 100, title: appText("Daemonlet 대사"), show: false,
      transparent: true, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, backgroundColor: "#00000000",
      webPreferences: { additionalArguments: languageArguments(), preload: this.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: false },
    })
    bindWindowLanguage(win, "Daemonlet 대사"); this.window = win; this.ready = false; this.appearanceKey = ""
    win.setIgnoreMouseEvents(true, { forward: true })
    secureWebContents(win.webContents, "speech-bubble", this.devServerUrl)
    win.webContents.on("did-finish-load", () => {
      this.ready = true
      win.webContents.send(BUBBLE_IPC.speech, this.frame)
      if (this.frame) win.showInactive()
    })
    win.webContents.on("render-process-gone", () => { this.ready = false; win.hide(); win.webContents.reload() })
    win.once("closed", () => { if (this.window === win) { this.window = null; this.ready = false } })
    void win.loadURL(expectedRendererUrl("speech-bubble", this.devServerUrl)).catch(() => { this.frame = null; win.hide() })
  }

  destroy(): void { this.frame = null; this.placement = null; this.window?.destroy(); this.window = null; this.ready = false }
}
