import { CharacterPacks } from "./CharacterPacks"
import { SCALE_PRESETS, type DesktopSettingsPatch, type DesktopSettingsV1 } from "../../electron/shared/desktop-settings"
import type { SettingsPageProps } from "./SettingsApp"

const toggles = [
  { key: "visible", label: "캐릭터 표시", description: null },
  { key: "alwaysOnTop", label: "항상 위에 표시", description: null },
  { key: "speechBubblesEnabled", label: "캐릭터 대사 표시", description: null },
  { key: "taskBubblesEnabled", label: "작업 말풍선 표시", description: null },
  { key: "clickThrough", label: "투명한 영역의 클릭 통과", description: "캐릭터가 없는 부분에서 뒤의 앱을 클릭합니다." },
  { key: "showOnAllWorkspaces", label: "모든 데스크톱에서 표시", description: null, macOnly: true },
  { key: "showOverFullScreen", label: "전체 화면 앱 위에 표시", description: null, macOnly: true },
] as const

export function AppearancePage({ api, status, settings, run, busy }: SettingsPageProps & { settings: DesktopSettingsV1 }) {
  const update = (patch: DesktopSettingsPatch) => void run("표시 설정 저장", () => api.updateSettings(patch))
  return <>
    <header className="page-header"><h1>캐릭터·표시</h1></header>
    <section className="section-card"><CharacterPacks api={api} run={run} busy={busy} selected={settings.characterId} />
      <div className="preference-row"><div><strong>캐릭터 크기</strong><p>현재 {Math.round(settings.scale * 100)}%</p></div><label className="visually-hidden" htmlFor="character-scale">캐릭터 크기</label><select id="character-scale" value={settings.scale} disabled={Boolean(busy)} onChange={(event) => update({ scale: Number(event.target.value) })}>{!SCALE_PRESETS.some((value) => Math.abs(value - settings.scale) < 0.001) && <option value={settings.scale}>{Math.round(settings.scale * 100)}% (현재)</option>}{SCALE_PRESETS.map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select></div>
    </section>
    <section className="section-card"><h2>데스크톱 표시</h2>{toggles.filter((item) => !("macOnly" in item) || status.app.platform === "darwin").map((item) => <label className="preference-row" key={item.key}><span><strong>{item.label}</strong>{item.description && <span className="preference-description">{item.description}</span>}</span><input className="switch" type="checkbox" role="switch" checked={settings[item.key]} disabled={Boolean(busy)} onChange={(event) => update({ [item.key]: event.target.checked })} /></label>)}<div className="preference-row"><strong>캐릭터 위치 초기화</strong><button className="button secondary small" disabled={Boolean(busy)} onClick={() => void run("위치 초기화", () => api.resetPetPosition())}>위치 초기화</button></div></section>
    <section className="section-card"><h2>앱 시작 동작</h2><label className="preference-row"><span><strong>Codex 연결 자동 시작</strong><span className="preference-description">다음 앱 실행부터 적용</span></span><input className="switch" type="checkbox" role="switch" checked={settings.adapterAutoStart} disabled={Boolean(busy)} onChange={(event) => update({ adapterAutoStart: event.target.checked })} /></label></section>
  </>
}
