import { useT } from "../i18n/useLanguage"
import { CharacterPacks } from "./CharacterPacks"
import { SCALE_PRESETS, type DesktopSettingsPatch, type DesktopSettingsV1 } from "../../electron/shared/desktop-settings"
import type { SettingsPageProps } from "./SettingsApp"

const toggles = [
  { key: "sideChatEnabled", label: "캐릭터 사이드 대화 (실험)", description: "검증된 Codex 런타임에서만 전송할 수 있습니다. 사용량이 발생하며 부모 대화 맥락이 전달될 수 있습니다." },
  { key: "visible", label: "캐릭터 표시", description: null },
  { key: "alwaysOnTop", label: "항상 위에 표시", description: null },
  { key: "speechBubblesEnabled", label: "캐릭터 대사 표시", description: null },
  { key: "taskBubblesEnabled", label: "작업 말풍선 표시", description: null },
  { key: "clickThrough", label: "투명한 영역의 클릭 통과", description: "캐릭터가 없는 부분에서 뒤의 앱을 클릭합니다." },
  { key: "showOnAllWorkspaces", label: "모든 데스크톱에서 표시", description: null, macOnly: true },
  { key: "showOverFullScreen", label: "전체 화면 앱 위에 표시", description: null, macOnly: true },
] as const

export function AppearancePage({ api, status, settings, run, busy }: SettingsPageProps & { settings: DesktopSettingsV1 }) {
  const t = useT()
  const update = (patch: DesktopSettingsPatch) => void run("표시 설정 저장", () => api.updateSettings(patch))
  return <>
    <header className="page-header"><h1>{t("캐릭터·표시")}</h1></header>
    <section className="section-card"><CharacterPacks api={api} run={run} busy={busy} selected={settings.characterId} />
      <div className="preference-row"><div><strong>{t("캐릭터 크기")}</strong><p>{t`현재 ${Math.round(settings.scale * 100)}%`}</p></div><label className="visually-hidden" htmlFor="character-scale">{t("캐릭터 크기")}</label><select id="character-scale" value={settings.scale} disabled={Boolean(busy)} onChange={(event) => update({ scale: Number(event.target.value) })}>{!SCALE_PRESETS.some((value) => Math.abs(value - settings.scale) < 0.001) && <option value={settings.scale}>{t`${Math.round(settings.scale * 100)}% (현재)`}</option>}{SCALE_PRESETS.map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select></div>
    </section>
    <section className="section-card"><h2>{t("데스크톱 표시")}</h2>{toggles.filter((item) => !("macOnly" in item) || status.app.platform === "darwin").map((item) => <label className="preference-row" key={item.key}><span><strong>{t(item.label)}</strong>{item.description && <span className="preference-description">{t(item.description)}</span>}</span><input className="switch" type="checkbox" role="switch" checked={settings[item.key]} disabled={Boolean(busy)} onChange={(event) => update({ [item.key]: event.target.checked })} /></label>)}<div className="preference-row"><strong>{t("캐릭터 위치 초기화")}</strong><button className="button secondary small" disabled={Boolean(busy)} onClick={() => void run("위치 초기화", () => api.resetPetPosition())}>{t("위치 초기화")}</button></div></section>
    <section className="section-card"><h2>{t("앱 시작 동작")}</h2><label className="preference-row"><span><strong>{t("Codex 연결 자동 시작")}</strong><span className="preference-description">{t("다음 앱 실행부터 적용")}</span></span><input className="switch" type="checkbox" role="switch" checked={settings.adapterAutoStart} disabled={Boolean(busy)} onChange={(event) => update({ adapterAutoStart: event.target.checked })} /></label></section>
  </>
}
