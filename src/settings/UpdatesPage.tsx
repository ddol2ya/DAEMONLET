import { useEffect, useState } from "react"
import { useT } from "../i18n/useLanguage"
import type { SettingsPageProps } from "./SettingsApp"
import type { DesktopSettingsV1 } from "../../electron/shared/desktop-settings"
import type { UpdateAction, UpdateSnapshot } from "../../electron/shared/update-contract"
const labels = { idle: "새 버전이 있는지 확인할 수 있어요.", checking: "업데이트 확인 중…", upToDate: "최신 버전입니다.", available: "새 버전을 다운로드할 수 있어요.", manualOnly: "이 설치본은 수동 업데이트가 필요합니다.", blocked: "이 실행 환경에서는 앱 내 업데이트를 사용할 수 없습니다.", downloading: "업데이트 다운로드 중…", downloaded: "다운로드가 완료되었습니다. 재시작할 때 적용할 수 있어요.", preparing: "업데이트 적용을 준비하고 있어요…", handoff: "업데이트 설치기로 전환합니다…", error: "업데이트를 완료하지 못했습니다. 다시 확인하거나 배포 페이지에서 설치해 주세요." }
const reasons: Record<string, string> = { UNVERIFIED_PUBLISHER: "발행자 미검증 경로입니다. 출처와 파일 무결성은 확인하지만 발행자 서명은 확인하지 않습니다.", RATE_LIMITED: "업데이트 서버의 요청 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.", NETWORK: "인터넷 연결을 확인한 뒤 다시 시도해 주세요.", MAC_INSTALL_OR_TRUST: "서명·공증된 앱을 응용 프로그램 폴더에 설치해 주세요.", WINDOWS_PUBLISHER_REQUIRED: "검증 가능한 발행자 서명이 없어 자동 설치가 차단되었습니다.", PORTABLE_MANUAL: "Windows 압축본을 내려받아 앱을 종료한 후 수동으로 교체해 주세요. 앱 폴더 안에 데이터를 보관했다면 먼저 백업해 주세요.", DEVELOPMENT_BUILD: "개발 실행에서는 공개 배포본을 설치하지 않습니다.", PACK_BUSY: "캐릭터팩 작업을 마친 뒤 다시 시도해 주세요.", DISK_FULL: "저장 공간을 확보한 뒤 다시 시도해 주세요.", UNSUPPORTED_OS: "새 버전이 요구하는 운영체제를 확인해 주세요.", OS_SHUTDOWN: "시스템 종료 중에는 업데이트를 시작하지 않습니다." }
export function UpdatesPage({ api, status, settings, run, busy }: SettingsPageProps & { settings: DesktopSettingsV1 }) {
  const t = useT(), updates = window.updateDesktop
  const [state, setState] = useState<UpdateSnapshot | null>(null)
  useEffect(() => { if (!updates) return; let active = true; const receive = (value: UpdateSnapshot) => { if (active) setState(value) }; const off = updates.onChanged(receive); void updates.snapshot().then(receive); return () => { active = false; off() } }, [updates])
  const act = (value: UpdateAction) => { if (updates) void run("업데이트", () => updates.act(value).then(setState)) }
  const locked = Boolean(busy) || !state || ["checking", "downloading", "preparing", "handoff"].includes(state.phase)
  return <section><header className="page-header"><h1>{t("업데이트")}</h1><p>{t("Daemonlet을 최신 버전으로 유지하세요.")}</p></header>
    <section className="section-card"><h2>Daemonlet for Codex {state?.currentVersion}</h2><p role="status" aria-live="polite">{state ? t(labels[state.phase]) : t("설정 불러오는 중…")}</p>
      {state?.version && <p>{t("새 버전")}: {state.version}</p>}
      {state?.reason && reasons[state.reason] && <p>{t(reasons[state.reason])}</p>}
      {state?.phase === "downloading" && <progress className="update-progress" max={100} value={state.progress ?? 0} aria-label={t("업데이트 다운로드")} />}
      <div className="button-row">
        <button className="button secondary" disabled={locked || state?.phase === "downloaded"} onClick={() => act({ action: "check" })}>{t("업데이트 확인")}</button>
        {state?.phase === "available" && state.candidateId && <button disabled={Boolean(busy)} className="button primary" onClick={() => act({ action: "download", candidateId: state.candidateId! })}>{t("다운로드")}</button>}
        {state?.phase === "downloading" && <button className="button secondary" onClick={() => void updates?.act({ action: "cancelDownload" })}>{t("다운로드 취소")}</button>}
        {state?.phase === "downloaded" && state.candidateId && <button disabled={Boolean(busy)} className="primary" onClick={() => act({ action: "installAndRestart", candidateId: state.candidateId! })}>{t("업데이트 및 재시작…")}</button>}
        <button className="button secondary" disabled={state?.phase === "preparing" || state?.phase === "handoff"} onClick={() => act({ action: "openRelease" })}>{t("배포 페이지 열기")}</button>
      </div>
    </section>
    <section className="section-card"><label className="preference-row"><span><strong>{t("하루에 한 번 새 버전 확인")}</strong><span className="preference-description">{t("자동으로 다운로드하거나 재시작하지 않습니다.")}</span></span><input className="switch" type="checkbox" role="switch" checked={settings.updateAutoCheck} disabled={locked} onChange={event => void run("업데이트 설정 저장", () => api.updateSettings({ updateAutoCheck: event.target.checked }))} /></label></section>
    {status.app.platform === "win32" && <section className="section-card"><label className="preference-row"><span><strong>{t("서명 없는 Windows 업데이트 허용")}</strong><span className="preference-description">{t("이 기기에서만 적용됩니다. 켤 때 위험 안내와 명시적 동의가 필요합니다.")}</span></span><input className="switch" type="checkbox" role="switch" checked={settings.allowUnsignedWindowsUpdates} disabled={locked} onChange={event => act({ action: "setUnsignedWindowsPolicy", enabled: event.target.checked })} /></label></section>}
  </section>
}
