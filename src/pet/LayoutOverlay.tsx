import { SCALE_PRESETS, type DesktopSettingsV1 } from "../../electron/shared/desktop-settings"

export function LayoutOverlay({ settings, onScale, onDone }: {
  settings: DesktopSettingsV1
  onScale: (scale: number) => void
  onDone: () => void
}) {
  return <div className="layout-overlay" role="dialog" aria-label="Move and resize character">
    <div className="layout-drag-handle">Drag to move</div>
    <div className="layout-controls">
      {SCALE_PRESETS.map((scale) => <button key={scale} className={Math.abs(settings.scale - scale) < 0.001 ? "active" : ""} onClick={() => onScale(scale)}>{Math.round(scale * 100)}%</button>)}
      <button className="done" onClick={onDone}>Done</button>
    </div>
  </div>
}
