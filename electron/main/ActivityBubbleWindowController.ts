import { NativeDragStart } from "./NativeDragStart"
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
import { WindowDragController } from "./WindowDragController"
import { PLACEMENT_IPC, bubblePlacementReference, positionRelativeBubble, relativeBubblePlacement, type BubblePlacement, type PlacementSnapshot, type PlacementAction } from "../shared/bubble-placement"
import { validWindowDragRequest } from "../shared/window-drag"
import { SIDE_CHAT_IPC, type SideChatSnapshot } from "../shared/side-chat-contract"

/** One task surface for activity, explicit controls and the owned-child conversation. */
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
  private chat: SideChatSnapshot | null = null
  private focusChat = false
  private placementDraft: BubblePlacement | null = null
  private placementRevision = 0
  private focusPlacement = false
  private readonly placementStart = new NativeDragStart()
  private readonly placementDrag = new WindowDragController({
    window: () => this.window, cursor: () => screen.getCursorScreenPoint(), startCursor: () => this.placementStart.take(),
    workArea: point => screen.getDisplayNearestPoint(point).workArea, allowed: () => Boolean(this.placementDraft),
    lock: active => { if (active) this.window?.setIgnoreMouseEvents(false) },
    finish: (bounds, committed) => { if (committed && this.placementDraft && this.pet && !this.pet.isDestroyed()) this.placementDraft = relativeBubblePlacement(this.pet.getBounds(), bounds); this.sync() },
  })
  readonly presentation = new BubblePresentationCoordinator(() => this.sync())
  readonly speech: SpeechBubbleWindowController
  get petWindow(): BrowserWindow | null { return this.pet }
  focusConversation(): void { if (this.chat && this.chat.mode !== "hidden") { this.focusChat = true; this.sync() } }
  constructor(private readonly preloadPath: string, private readonly devServerUrl?: string, private readonly onHidden: () => void = () => {}, private readonly hideChat: () => void = () => {}, private readonly savePlacement: (value: BubblePlacement) => void = () => {}) {
    this.speech = new SpeechBubbleWindowController(join(dirname(preloadPath), "speech-preload.cjs"), devServerUrl)
  }

  placementSnapshot(): PlacementSnapshot { return { editing: this.placementDraft !== null, revision: this.placementRevision } }
  beginPlacement(): void {
    if (!this.pet || this.pet.isDestroyed() || !this.settings) return
    if (!this.placementDraft) {
      const bounds = this.pet.getBounds(), area = screen.getDisplayMatching(bounds).workArea
      this.placementDraft = this.settings.bubblePlacement.mode === "relative" ? { ...this.settings.bubblePlacement }
        : relativeBubblePlacement(bounds, positionActivityBubble(bounds, area, false, false, { width: 360, height: 210 }))
      this.placementRevision++
    }
    this.onHidden(); this.focusPlacement = true; this.presentation.setPlacementEditing(true)
    this.send(PLACEMENT_IPC.changed, this.placementSnapshot())
  }
  cancelPlacement(): void {
    if (!this.placementDraft) return
    this.placementDrag.cancel(); this.placementDraft = null; this.placementRevision++; this.focusPlacement = false
    this.presentation.setPlacementEditing(false); this.send(PLACEMENT_IPC.changed, this.placementSnapshot())
  }
  placementAction(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false } as const
    const request = value as PlacementAction
    if (!this.placementDraft || request.revision !== this.placementRevision) return { ok: false } as const
    if (request.action === "drag" && Object.keys(request).sort().join() === "action,drag,revision" && validWindowDragRequest(request.drag))
      return { ok: true, value: this.placementSnapshot(), drag: this.placementDrag.request(request.drag) } as const
    if (Object.keys(request).sort().join() !== "action,revision" || !["apply", "cancel"].includes(request.action)) return { ok: false } as const
    this.placementDrag.cancel()
    const placement = this.placementDraft
    if (request.action === "apply") this.savePlacement(placement)
    this.cancelPlacement()
    return { ok: true, value: this.placementSnapshot() } as const
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
  updateChat(snapshot: SideChatSnapshot): void {
    const wasOpen = this.chat !== null && this.chat.mode !== "hidden"
    this.chat = snapshot
    const open = snapshot.mode !== "hidden"
    if (!open) this.focusChat = false
    if (open && !wasOpen) {
      this.onHidden(); this.view = "activity"; this.collapsed = false; this.focusChat = true
      this.send(TASK_CONTROL_IPC.viewChanged, this.getView())
    }
    this.presentation.setSideChatVisible(open)
    this.send(SIDE_CHAT_IPC.changed, snapshot)
  }
  setInteractionLocked(locked: boolean, pressed = false): void {
    const wasLocked = this.presentation.interactionLocked
    const wasPressed = this.pressed
    this.pressed = pressed
    this.presentation.setInteractionLocked(locked)
    // Native hide may synchronously report release before visibility settles.
    // Only a changed press needs another sync when the lock is unchanged.
    if (wasLocked === locked && wasPressed !== pressed) this.sync()
  }
  setLayoutMode(value: boolean): void { this.inLayout = value; this.sync() }
  setContentHeight(height: number): void { if (this.contentHeight !== height && !this.presentation.sideChatVisible) { this.contentHeight = height; this.sync() } }
  setPointerInteractive(interactive: boolean): void { this.window?.setIgnoreMouseEvents(!interactive && !this.placementDraft && !this.presentation.sideChatVisible, { forward: true }) }
  send(channel: string, value: unknown): void { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value) }
  setCollapsed(value: boolean): boolean { this.collapsed = value; if (value && this.presentation.sideChatVisible) this.hideChat(); this.sync(); return this.collapsed }
  getView(): { view: "activity" | "control"; collapsed: boolean } { return { view: this.view, collapsed: this.collapsed } }
  setView(view: "activity" | "control", collapsed: boolean): void {
    if (view === "control" && this.presentation.sideChatVisible) this.hideChat()
    this.onHidden(); this.view = view; this.collapsed = collapsed; this.sync()
    this.send(TASK_CONTROL_IPC.viewChanged, this.getView())
  }

  sync = (): void => {
    if (this.disposed) return
    this.syncActivity()
    this.speech.sync(this.pet, this.settings, this.presentation.anchor, this.presentation.sideChatVisible || this.placementDraft ? null : this.presentation.speech, this.inLayout, this.view === "control" ? this.window : null)
  }

  private syncActivity(): void {
    if (this.window?.isDestroyed()) { this.window = null; this.ready = false }
    const pet = this.pet
    const editing = this.placementDraft !== null
    const chatting = this.presentation.sideChatVisible && this.view === "activity"
    const empty = !this.snapshot || !activityBubbleEntries(this.snapshot).length
    const retainInput = this.presentation.interactionLocked && this.window?.isVisible()
    if (!this.settings || !chatting && !editing && !this.settings.taskBubblesEnabled || !this.settings.visible || !pet || pet.isDestroyed() || !pet.isVisible() || pet.isMinimized() || this.view === "activity" && !chatting && !editing && (this.inLayout || !this.presentation.canShowActivity || empty && !retainInput)) {
      if (this.view === "control" && this.window?.isVisible()) this.onHidden()
      if (this.window?.isVisible()) this.window.hide()
      return
    }
    if (!this.window || this.window.isDestroyed()) this.create()
    const win = this.window!
    if (this.view === "activity" && !chatting && !editing && this.pressed && win.isVisible()) return
    const bounds = pet.getBounds()
    const placement = this.placementDraft ?? this.settings!.bubblePlacement
    const area = screen.getDisplayMatching(bubblePlacementReference(bounds, placement)).workArea
    // Explicit controls keep their own adjacent slot and are not automatically hidden.
    const automatic = editing ? positionActivityBubble(bounds, area, false, false, { width: 360, height: 210 }) : chatting ? positionActivityBubble(bounds, area, false, false, this.chat?.mode === "panel" ? { width: 480, height: 640 } : { width: 360, height: 340 }) : this.view === "activity" && this.presentation.anchor
      ? positionAnchoredActivityBubble(bounds, area, this.presentation.anchor, this.collapsed, this.contentHeight)
      : positionActivityBubble(bounds, area, this.collapsed, this.view === "control")
    const next = placement.mode === "relative" ? positionRelativeBubble(bounds, area, automatic, placement) : automatic
    const current = win.getBounds()
    if (!this.placementDrag.active && Object.keys(next).some(key => next[key as keyof typeof next] !== current[key as keyof typeof next])) win.setBounds(next, false)
    if (this.ready && (this.focusPlacement && editing || this.focusChat && chatting && !editing)) { this.focusChat = false; this.focusPlacement = false; win.setIgnoreMouseEvents(false); win.show(); win.focus() }
    else if (this.ready && !win.isVisible()) win.showInactive()
  }

  private create(): void {
    const win = new BrowserWindow({
      width: 276, height: 100, title: appText("Daemonlet 작업 말풍선"), show: false,
      transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, acceptFirstMouse: true, hasShadow: false, backgroundColor: "#00000000",
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
    win.webContents.on("before-mouse-event", (_event, input) => { if (input.type === "mouseDown") { this.placementStart.record(win.getBounds(), input, input.button === "left" && Boolean(this.placementDraft)); beforeDispatch() } })
    win.webContents.on("before-input-event", (_event, input) => { if (input.type === "keyDown" && ["Enter", " "].includes(input.key)) beforeDispatch() })
    win.on("hide", release)
    win.webContents.on("render-process-gone", release)
    win.webContents.on("did-start-navigation", release)
    win.on("hide", this.onHidden)
    win.webContents.on("did-start-navigation", this.onHidden)
    this.applyWindowSettings()
    secureWebContents(win.webContents, "activity-bubble", this.devServerUrl)
    win.once("ready-to-show", () => { this.ready = true; this.sync() })
    win.once("closed", () => { if (this.window === win) { this.window = null; this.ready = false; this.focusChat = false; if (this.view === "control") this.view = "activity" } if (this.placementDraft) this.cancelPlacement(); else this.hideChat(); this.onHidden(); release() })
    win.webContents.on("did-finish-load", () => {
      if (this.snapshot) this.send(ACTIVITY_IPC.changed, this.snapshot)
      if (this.chat) this.send(SIDE_CHAT_IPC.changed, this.chat)
      this.send(PLACEMENT_IPC.changed, this.placementSnapshot())
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
  destroy(): void { this.disposed = true; this.cancelPlacement(); this.onHidden(); this.detach?.(); this.detach = null; this.pet = null; this.presentation.dispose(); this.speech.destroy(); this.window?.destroy(); this.window = null }
}
