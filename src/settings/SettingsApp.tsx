import { useEffect, useState, type KeyboardEvent } from "react"
import type { PublicSetupStatus, SettingsDesktopApi } from "../../electron/shared/codex-integration-contract"
import type { DesktopSettingsV1 } from "../../electron/shared/desktop-settings"
import { ConnectionPage } from "./ConnectionPage"
import { AppearancePage } from "./AppearancePage"
import { DiagnosticsPage } from "./DiagnosticsPage"
import { reasonText } from "./labels"

export type SettingsPageProps = { api: SettingsDesktopApi; status: PublicSetupStatus; run: <T>(label: string, task: () => Promise<T>) => Promise<T | undefined>; busy: string | null }
const tabs = [{ id: "connection", label: "Codex 연결", glyph: "◎" }, { id: "appearance", label: "캐릭터·표시", glyph: "◇" }, { id: "diagnostics", label: "진단", glyph: "≡" }] as const

export function SettingsApp() {
  const api = window.settingsDesktop
  const [tab, setTab] = useState<typeof tabs[number]["id"]>("connection")
  const [status, setStatus] = useState<PublicSetupStatus | null>(null)
  const [settings, setSettings] = useState<DesktopSettingsV1 | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { window.scrollTo(0, 0) }, [tab])

  useEffect(() => {
    if (!api) return
    let active = true
    const receiveStatus = (value: PublicSetupStatus) => { if (active) setStatus((previous) => !previous || value.checkedAt >= previous.checkedAt ? value : previous) }
    const receiveSettings = (value: DesktopSettingsV1) => { if (active) setSettings(value) }
    const unsubscribeStatus = api.onStatusChanged(receiveStatus)
    const unsubscribeSettings = api.onSettingsChanged(receiveSettings)
    void Promise.all([api.getStatus().then(receiveStatus), api.getSettings().then(receiveSettings)]).catch(() => { if (active) setError("설정 상태를 불러오지 못했습니다. 창을 닫았다 다시 열어 주세요.") })
    return () => { active = false; unsubscribeStatus(); unsubscribeSettings() }
  }, [api])

  const run = async <T,>(label: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined
    setError(null)
    setBusy(label)
    try { return await task() }
    catch (reason) { if (!(reason instanceof Error && reason.message === "PACK_CANCELLED")) setError(reasonText(reason instanceof Error ? reason.message : "")); return undefined }
    finally { setBusy(null) }
  }
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length
    if (event.key === "Home") next = 0
    if (event.key === "End") next = tabs.length - 1
    if (next !== null) { event.preventDefault(); setTab(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus() }
  }

  return <div className="settings-shell">
    <aside className="settings-sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">D</span><span>Daemonlet</span></div>
      <nav className="settings-nav" role="tablist" aria-label="설정" aria-orientation="vertical">
        {tabs.map((item, index) => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-label={item.label} aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onKeyDown={(event) => moveTab(event, index)} onClick={() => setTab(item.id)}><span aria-hidden="true">{item.glyph}</span>{item.label}</button>)}
      </nav>
      <div className="sidebar-bottom"><span className="status-dot positive" />Pet 실행 중<small>{status?.app.version ? `버전 ${status.app.version}` : "설정 불러오는 중"}</small></div>
    </aside>
    <main className="settings-content" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
      {status?.onboarding === "shown" && api && <div className="onboarding-banner"><strong>연결 준비를 눌러 시작하세요.</strong><div className="banner-actions"><button className="text-button" disabled={Boolean(busy)} onClick={() => void run("안내 닫기", () => api.dismissOnboarding("acknowledged"))}>닫기</button><button className="text-button" disabled={Boolean(busy)} onClick={() => void run("나중에 설정", () => api.dismissOnboarding("skipped"))}>나중에</button></div></div>}
      {error && <div className="notice error" role="alert"><span>{error}</span><button className="text-button" aria-label="오류 닫기" onClick={() => setError(null)}>닫기</button></div>}
      {!api ? <div className="empty-state"><h1>Daemonlet 앱에서 열어 주세요</h1><p>설정은 앱의 메뉴 막대 → Settings에서 사용할 수 있습니다.</p></div>
        : !status || !settings ? <div className="empty-state" role="status">설정 불러오는 중…</div>
        : tab === "connection" ? <ConnectionPage api={api} status={status} run={run} busy={busy} />
        : tab === "appearance" ? <AppearancePage api={api} status={status} run={run} busy={busy} settings={settings} />
        : <DiagnosticsPage api={api} status={status} run={run} busy={busy} />}
      <div className="operation-status" role="status" aria-live="polite">{busy ? `${busy}…` : ""}</div>
    </main>
  </div>
}
