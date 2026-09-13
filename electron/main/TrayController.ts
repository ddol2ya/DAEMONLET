import { APP_NAME } from "../shared/app-identity.mjs"
import { Menu, Tray, dialog, nativeImage, type BrowserWindow, type MenuItemConstructorOptions, type NativeImage, type Rectangle } from "electron"
import type { DesktopSettingsV1 } from "../shared/desktop-settings"
import { CHARACTER_IDS, CHARACTER_NAMES, SCALE_PRESETS } from "../shared/desktop-settings"
import type { AdapterStatus, SanitizedAdapterDiagnostics } from "../shared/ipc-contract"
import type { CharacterEntry } from "../shared/character-pack-contract"
import { activitySummary, type ActivitySnapshot } from "../shared/activity-contract"
import { TRAY_TEMPLATE_PNG, TRAY_TEMPLATE_PNG_2X } from "./TrayIconData"


export function createTrayIcon() {
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_TEMPLATE_PNG, "base64"))
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(TRAY_TEMPLATE_PNG_2X, "base64") })
  if (process.platform === "darwin") image.setTemplateImage(true)
  return image
}

export function createNativeTray(image: NativeImage): Tray {
  return new Tray(image)
}

export function intersectsDisplay(bounds: Rectangle, displays: Rectangle[]): boolean {
  return displays.some((display) => (
    bounds.width > 0
    && bounds.height > 0
    && bounds.x < display.x + display.width
    && bounds.x + bounds.width > display.x
    && bounds.y < display.y + display.height
    && bounds.y + bounds.height > display.y
  ))
}

export type TrayActions = {
  activity?(): ActivitySnapshot
  openActivity?(): void
  openTaskControl?(): void
  characters?(): CharacterEntry[]
  toggleVisible(): void
  setLayout(enabled: boolean): void
  resetPosition(): void
  updateSettings(patch: Partial<DesktopSettingsV1>): void
  openMotionLab(): void
  openSettings(): void
  reloadPet(): void
  restartAdapter(): void
  diagnostics(): SanitizedAdapterDiagnostics
  quit(): void
}

export function buildTrayMenu(settings: DesktopSettingsV1, adapter: AdapterStatus, actions: TrayActions): MenuItemConstructorOptions[] {
  const adapterLabel = adapter.state === "READY" ? "READY (Owned)" : adapter.state
  return [
    { label: settings.visible ? "Hide Character" : "Show Character", click: actions.toggleVisible },
    ...(actions.openActivity ? [
      { label: "작업 목록", click: actions.openActivity },
      ...(actions.activity ? [{ label: activitySummary(actions.activity()), enabled: false }] : []),
    ] : []),
    { type: "separator" },
    { label: "Move / Resize Character", click: () => actions.setLayout(true) },
    { label: "Reset Position", click: actions.resetPosition },
    {
      label: "Character",
      submenu: [
        ...(actions.characters?.() ?? CHARACTER_IDS.map(id => ({ id, name: CHARACTER_NAMES[id], status: "ready" }))).map(entry => ({ label: entry.name, enabled: entry.status === "ready", type: "radio" as const, checked: settings.characterId === entry.id, click: () => actions.updateSettings({ characterId: entry.id }) })),
      ],
    },
    {
      label: "Scale",
      submenu: SCALE_PRESETS.map((scale) => ({
        label: `${Math.round(scale * 100)}%`,
        type: "radio" as const,
        checked: Math.abs(settings.scale - scale) < 0.001,
        click: () => actions.updateSettings({ scale }),
      })),
    },
    { type: "separator" },
    ...(actions.openTaskControl ? [{ label: "Codex 제어 · 음성 입력", click: actions.openTaskControl }] : []),
    { label: "Always on Top", type: "checkbox", checked: settings.alwaysOnTop, click: () => actions.updateSettings({ alwaysOnTop: !settings.alwaysOnTop }) },
    { label: "Show Speech Bubbles", type: "checkbox", checked: settings.speechBubblesEnabled, click: () => actions.updateSettings({ speechBubblesEnabled: !settings.speechBubblesEnabled }) },
    { label: "작업 말풍선 표시", type: "checkbox", checked: settings.taskBubblesEnabled, click: () => actions.updateSettings({ taskBubblesEnabled: !settings.taskBubblesEnabled }) },
    { label: "Show on All Workspaces", type: "checkbox", checked: settings.showOnAllWorkspaces, visible: process.platform === "darwin", click: () => actions.updateSettings({ showOnAllWorkspaces: !settings.showOnAllWorkspaces }) },
    { label: "Show over Fullscreen", type: "checkbox", checked: settings.showOverFullScreen, visible: process.platform === "darwin", click: () => actions.updateSettings({ showOverFullScreen: !settings.showOverFullScreen }) },
    {
      label: "Click-through",
      submenu: [
        { label: "Auto", type: "radio", checked: settings.clickThrough, click: () => actions.updateSettings({ clickThrough: true }) },
        { label: "Disabled", type: "radio", checked: !settings.clickThrough, click: () => actions.updateSettings({ clickThrough: false }) },
      ],
    },
    { type: "separator" },
    {
      label: "Codex Adapter",
      submenu: [
        { label: `Status: ${adapterLabel}`, enabled: false },
        { label: "Restart", click: actions.restartAdapter },
        { label: "Open Diagnostics", click: () => {
          const value = actions.diagnostics()
          void dialog.showMessageBox({ type: value.state === "ERROR" ? "error" : "info", title: "Codex Adapter Diagnostics", message: value.state, detail: JSON.stringify(value, null, 2) })
        } },
      ],
    },
    { label: "Settings…", click: actions.openSettings },
    { label: "Open Motion Lab", click: actions.openMotionLab },
    { label: "Reload Pet", click: actions.reloadPet },
    { type: "separator" },
    { label: "Quit", role: "quit", click: actions.quit },
  ]
}

export class TrayController {
  tray: Tray | null = null
  private menu: Menu | null = null

  create(settings: DesktopSettingsV1, adapter: AdapterStatus, actions: TrayActions): boolean {
    // The character's shared context menu remains available even if Tray creation fails.
    this.update(settings, adapter, actions)
    if (!this.tray) {
      const image = createTrayIcon()
      if (image.isEmpty()) return false
      try { this.tray = createNativeTray(image) } catch { return false }
      this.tray.setToolTip(APP_NAME)
      this.tray.on("click", actions.toggleVisible)
    }
    this.update(settings, adapter, actions)
    return true
  }

  update(settings: DesktopSettingsV1, adapter: AdapterStatus, actions: TrayActions): void {
    this.menu = Menu.buildFromTemplate(buildTrayMenu(settings, adapter, actions))
    this.tray?.setContextMenu(this.menu)
    const activity = actions.activity?.()
    if (activity) {
      this.tray?.setToolTip(`${APP_NAME}\n${activitySummary(activity)}${activity.storage === "error" ? "\n이력 저장 실패" : ""}`)
      if (process.platform === "darwin") this.tray?.setTitle(activity.counts.attention ? `${activity.connection === "READY" ? "" : "?"}${activity.counts.attention}` : "")
    }
  }

  popup(window: BrowserWindow): boolean {
    if (!this.menu) return false
    this.menu.popup({ window })
    return true
  }

  isVisibleOn(displays: Rectangle[]): boolean {
    return this.tray ? intersectsDisplay(this.tray.getBounds(), displays) : false
  }

  destroy(): void { this.tray?.destroy(); this.tray = null; this.menu = null }
}
