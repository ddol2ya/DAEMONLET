import { appText, bindWindowLanguage, languageArguments } from "./AppLanguage"
import { BrowserWindow, screen } from "electron"
import type { EventEmitter } from "node:events"
import { ACTIVITY_IPC, type ActivitySnapshot } from "../shared/activity-contract"
import { activityBubbleEntries, positionActivityBubble, positionAnchoredActivityBubble } from "../shared/activity-bubble"
import type { DesktopSettingsV1 } from "../shared/desktop-settings"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"
import { TASK_CONTROL_IPC } from "../shared/task-control-contract"
import { BubblePresentationCoordinator } from "./BubblePresentationCoordinator"
import { BUBBLE_IPC } from "../shared/bubble-presentation"
import { SpeechBubbleWindowController } from "./SpeechBubbleWindowController"
import { dirname, join } from "node:path"

/** A display-only companion. It never connects to the adapter or touches Pet input. */
export class ActivityBubbleWindowController {
  window: BrowserWindow | null = null
  private pet: BrowserWindow | null = null
  private settings: DesktopSettingsV1 | null = null
  private snapshot: ActivitySnapshot | null = null
  private collapsed = false
  private view: "activity" | "control" = "activity"
  private ready = false
  private detach: (() => void) | null = null
  private contentHeight = 100
  private inLayout = false
  private pressed = false
  private disposed = false
  readonly presentation = new BubblePresentationCoordinator(() => this.sync())
  readonly speech: SpeechBubbleWindowController
  get petWindow(): BrowserWindow | null { return this.pet }
  constructor(private readonly preloadPath: string, private readonly devServerUrl?: string, private readonly onHidden: () => void = () => {}) {
    this.speech = new SpeechBubbleWindowController(join(dirname(preloadPath), "speech-preload.cjs"), devServerUrl)
  }

  attach(pet: BrowserWindow, settings: DesktopSettingsV1): void {
    this.detach?.(); this.pet = pet
    const sync = () => this.sync()
    const reset = () => { this.presentation.begin() }
    const closed = () => { this.pet = null; reset() }
    const events = ["move", "moved", "resize", "show", "hide", "minimize", "restore"] as const
    for (const event of events) (pet as EventEmitter).on(event, sync)
    pet.on("closed", closed)
    const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) reset() }
    pet.webContents.on("did-start-navigation", navigation)
    pet.webContents.on("render-process-gone", reset)
    this.detach = () => { for (const event of events) (pet as EventEmitter).removeListener(event, sync); pet.removeListener("closed", closed); pet.webContents.removeListener("did-start-navigation", navigation); pet.webContents.removeListener("render-process-gone", reset) }
    this.applySettings(settings)
  }

  applySettings(settings: DesktopSettingsV1): void {
    this.settings = { ...settings }
    this.applyWindowSettings(); this.sync()
  }
  update(snapshot: ActivitySnapshot): void { this.snapshot = snapshot; this.sync() }
  setInteractionLocked(locked: boolean, pressed = false): void {
    const wasLocked = this.presentation.interactionLocked
    this.pressed = pressed
    this.presentation.setInteractionLocked(locked)
    if (wasLocked === locked) this.sync()
  }
  setLayoutMode(value: boolean): void { this.inLayout = value; this.sync() }
  setContentHeight(height: number): void { if (this.contentHeight !== height) { this.contentHeight = height; this.sync() } }
  setPointerInteractive(interactive: boolean): void { this.window?.setIgnoreMouseEvents(!interactive, { forward: true }) }
  send(channel: string, value: unknown): void { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value) }
  setCollapsed(value: boolean): boolean { this.collapsed = value; this.sync(); return this.collapsed }
  getView(): { view: "activity" | "control"; collapsed: boolean } { return { view: this.view, collapsed: this.collapsed } }
  setView(view: "activity" | "control", collapsed: boolean): void {
    this.onHidden(); this.view = view; this.collapsed = collapsed; this.sync()
    this.send(TASK_CONTROL_IPC.viewChanged, this.getView())
  }

  sync = (): void => {
    if (this.disposed) return
    this.syncActivity()
    this.speech.sync(this.pet, this.settings, this.presentation.anchor, this.presentation.speech, this.inLayout, this.view === "control" ? this.window : null)
  }

  private syncActivity(): void {
    if (this.window?.isDestroyed()) { this.window = null; this.ready = false }
    const pet = this.pet
    const empty = !this.snapshot || !activityBubbleEntries(this.snapshot).length
    const retainInput = this.presentation.interactionLocked && this.window?.isVisible()
    if (!this.settings?.taskBubblesEnabled || !this.settings.visible || !pet || pet.isDestroyed() || !pet.isVisible() || pet.isMinimized() || this.view === "activity" && (this.inLayout || !this.presentation.canShowActivity || empty && !retainInput)) {
      if (this.view === "control" && this.window?.isVisible()) this.onHidden()
      this.window?.hide(); return
    }
    if (!this.window || this.window.isDestroyed()) this.create()
    const win = this.window!
    if (this.view === "activity" && this.pressed && win.isVisible()) return
    const bounds = pet.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    // Explicit controls keep their own adjacent slot and are not automatically hidden.
    const next = this.view === "activity" && this.presentation.anchor
      ? positionAnchoredActivityBubble(bounds, area, this.presentation.anchor, this.collapsed, this.contentHeight)
      : positionActivityBubble(bounds, area, this.collapsed, this.view === "control")
    const current = win.getBounds()
    if (Object.keys(next).some(key => next[key as keyof typeof next] !== current[key as keyof typeof next])) win.setBounds(next, false)
    if (this.ready && !win.isVisible()) win.showInactive()
  }

  private create(): void {
    const win = new BrowserWindow({
      width: 276, height: 100, title: appText("Daemonlet 작업 말풍선"), show: false,
      transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, hasShadow: false, backgroundColor: "#00000000",
      webPreferences: { additionalArguments: languageArguments(), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: false, preload: this.preloadPath },
    })
    bindWindowLanguage(win, "Daemonlet 작업 말풍선"); this.window = win; this.ready = false
    win.setIgnoreMouseEvents(true, { forward: true })
    const release = () => this.setInteractionLocked(false)
    // Lock before DOM dispatch, closing the cross-renderer race between a
    // physical down event and Pet's permission request. The renderer releases
    // after up/click and any resulting asynchronous action have settled.
    const beforeDispatch = () => {
      if (this.view !== "activity") return
      this.pressed = true
      this.presentation.setInteractionLocked(true)
      // Freeze the renderer before later snapshot IPC can replace its target,
      // even when the DOM down event has not been dispatched yet.
      this.send(BUBBLE_IPC.interaction, true)
    }
    win.webContents.on("before-mouse-event", (_event, input) => { if (input.type === "mouseDown") beforeDispatch() })
    win.webContents.on("before-input-event", (_event, input) => { if (input.type === "keyDown" && ["Enter", " "].includes(input.key)) beforeDispatch() })
    win.on("hide", release)
    win.webContents.on("render-process-gone", release)
    win.webContents.on("did-start-navigation", release)
    win.on("hide", this.onHidden)
    win.webContents.on("did-start-navigation", this.onHidden)
    this.applyWindowSettings()
    secureWebContents(win.webContents, "activity-bubble", this.devServerUrl)
    win.once("ready-to-show", () => { this.ready = true; this.sync() })
    win.once("closed", () => { if (this.window === win) { this.window = null; this.ready = false; if (this.view === "control") this.view = "activity" } this.onHidden(); release() })
    win.webContents.on("did-finish-load", () => {
      if (this.snapshot) this.send(ACTIVITY_IPC.changed, this.snapshot)
      this.send(TASK_CONTROL_IPC.viewChanged, this.getView())
      // An initially hidden transparent Windows window may finish loading
      // without emitting ready-to-show. Apply the existing visibility rules
      // after load as well, including dialogue arbitration and hidden Pet.
      this.ready = true
      this.sync()
    })
    void win.loadURL(expectedRendererUrl("activity-bubble", this.devServerUrl)).catch(() => {})
  }
  private applyWindowSettings(): void {
    if (!this.window || this.window.isDestroyed() || !this.settings) return
    this.window.setAlwaysOnTop(this.settings.alwaysOnTop, "floating")
    if (process.platform === "darwin") this.window.setVisibleOnAllWorkspaces(this.settings.showOnAllWorkspaces, { visibleOnFullScreen: this.settings.showOverFullScreen })
  }
  destroy(): void { this.disposed = true; this.onHidden(); this.detach?.(); this.detach = null; this.pet = null; this.presentation.dispose(); this.speech.destroy(); this.window?.destroy(); this.window = null }
}
