import { useT } from "../i18n/useLanguage"
import { SCALE_PRESETS, type DesktopSettingsV1 } from "../../electron/shared/desktop-settings"

export function LayoutOverlay({ settings, onScale, onDone }: {
  settings: DesktopSettingsV1
  onScale: (scale: number) => void
  onDone: () => void
}) {
  const t = useT()
  return <div className="layout-overlay" role="dialog" aria-label={t("캐릭터 이동·크기 조절")}>
    <div className="layout-drag-handle">{t("드래그하여 이동")}</div>
    <div className="layout-controls">
      {SCALE_PRESETS.map((scale) => <button key={scale} className={Math.abs(settings.scale - scale) < 0.001 ? "active" : ""} onClick={() => onScale(scale)}>{Math.round(scale * 100)}%</button>)}
      <button className="done" onClick={onDone}>{t("완료")}</button>
    </div>
  </div>
}
