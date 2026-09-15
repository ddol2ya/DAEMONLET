import { createTranslator } from "../shared/translations"
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
  openSideChat?(): void
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
  const t = createTranslator(settings.language)
  const adapterLabel = adapter.state === "READY" ? "READY (Owned)" : adapter.state
  return [
    { label: settings.visible ? t("캐릭터 숨기기") : t("캐릭터 표시"), click: actions.toggleVisible },
    ...(actions.openActivity ? [
      { label: t("작업 목록"), click: actions.openActivity },
      ...(actions.activity ? [{ label: activitySummary(actions.activity(), settings.language), enabled: false }] : []),
    ] : []),
    ...(actions.openSideChat ? [{ label: t("캐릭터와 대화"), enabled: settings.sideChatEnabled, click: actions.openSideChat }] : []),
    { type: "separator" },
    { label: t("캐릭터 이동·크기 조절"), click: () => actions.setLayout(true) },
    { label: t("위치 초기화"), click: actions.resetPosition },
    {
      label: t("캐릭터"),
      submenu: [
        ...(actions.characters?.() ?? CHARACTER_IDS.map(id => ({ id, name: CHARACTER_NAMES[id], status: "ready" }))).map(entry => ({ label: entry.name, enabled: entry.status !== "disabled", type: "radio" as const, checked: settings.characterId === entry.id, click: () => actions.updateSettings({ characterId: entry.id }) })),
      ],
    },
    {
      label: t("크기"),
      submenu: SCALE_PRESETS.map((scale) => ({
        label: `${Math.round(scale * 100)}%`,
        type: "radio" as const,
        checked: Math.abs(settings.scale - scale) < 0.001,
        click: () => actions.updateSettings({ scale }),
      })),
    },
    { type: "separator" },
    ...(actions.openTaskControl ? [{ label: t("Codex 제어 · 음성 입력"), click: actions.openTaskControl }] : []),
    { label: t("항상 위에 표시"), type: "checkbox", checked: settings.alwaysOnTop, click: () => actions.updateSettings({ alwaysOnTop: !settings.alwaysOnTop }) },
    { label: t("캐릭터 대사 표시"), type: "checkbox", checked: settings.speechBubblesEnabled, click: () => actions.updateSettings({ speechBubblesEnabled: !settings.speechBubblesEnabled }) },
    { label: t("작업 말풍선 표시"), type: "checkbox", checked: settings.taskBubblesEnabled, click: () => actions.updateSettings({ taskBubblesEnabled: !settings.taskBubblesEnabled }) },
    { label: t("모든 데스크톱에서 표시"), type: "checkbox", checked: settings.showOnAllWorkspaces, visible: process.platform === "darwin", click: () => actions.updateSettings({ showOnAllWorkspaces: !settings.showOnAllWorkspaces }) },
    { label: t("전체 화면 앱 위에 표시"), type: "checkbox", checked: settings.showOverFullScreen, visible: process.platform === "darwin", click: () => actions.updateSettings({ showOverFullScreen: !settings.showOverFullScreen }) },
    {
      label: t("투명한 영역의 클릭 통과"),
      submenu: [
        { label: t("자동"), type: "radio", checked: settings.clickThrough, click: () => actions.updateSettings({ clickThrough: true }) },
        { label: t("사용 안 함"), type: "radio", checked: !settings.clickThrough, click: () => actions.updateSettings({ clickThrough: false }) },
      ],
    },
    { type: "separator" },
    {
      label: t("Codex Adapter"),
      submenu: [
        { label: t`상태: ${adapterLabel}`, enabled: false },
        { label: t("재시작"), click: actions.restartAdapter },
        { label: t("진단 열기"), click: () => {
          const value = actions.diagnostics()
          void dialog.showMessageBox({ type: value.state === "ERROR" ? "error" : "info", title: t("Codex Adapter 진단"), message: value.state, detail: JSON.stringify(value, null, 2) })
        } },
      ],
    },
    { label: "언어 / Language", submenu: [
      { label: "한국어", type: "radio", checked: settings.language === "ko", click: () => actions.updateSettings({ language: "ko" }) },
      { label: "English", type: "radio", checked: settings.language === "en", click: () => actions.updateSettings({ language: "en" }) },
    ] },
    { label: t("설정…"), click: actions.openSettings },
    { label: t("모션 실험실 열기"), click: actions.openMotionLab },
    { label: t("캐릭터 새로고침"), click: actions.reloadPet },
    { type: "separator" },
    { label: t("종료"), role: "quit", click: actions.quit },
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
      this.tray?.setToolTip(`${APP_NAME}\n${activitySummary(activity, settings.language)}${activity.storage === "error" ? `\n${createTranslator(settings.language)("이력 저장 실패")}` : ""}`)
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
