import { useState } from "react"
import { HOOK_EVENTS, type HookApplySummary, type HookPlanAction, type HookPlanSummary, type ObservationSurface, type SetupConfigurationStatus } from "../../electron/shared/codex-integration-contract"
import type { SettingsPageProps } from "./SettingsApp"
import { HookPlanPreview } from "./HookPlanPreview"
import { configurationLabels, reasonText, supportLabels } from "./labels"

const needsInstall = (state: SetupConfigurationStatus) => ["not-installed", "installed-legacy", "partially-installed", "repair-needed"].includes(state)
const time = (value: number) => new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })

export function ConnectionPage({ api, status, busy, run }: SettingsPageProps) {
  const [plan, setPlan] = useState<HookPlanSummary | null>(null)
  const [applied, setApplied] = useState<HookApplySummary | null>(null)
  const [surface, setSurface] = useState<ObservationSurface>("desktop")
  const discovery = status.discovery
  const disabled = Boolean(busy)
  const installed = status.configurationStatus === "installed-current"
  const receiving = status.reception.status === "receiving"
  const found = discovery?.executable.probeStatus === "verified"
  const reviewDone = status.hookReviewStatus === "user-reported-reviewed"
  const prepare = async () => {
    setApplied(null)
    await run("연결 준비", async () => {
      const next = await api.prepareConnection()
      if (needsInstall(next.configurationStatus)) setPlan(await api.planHooks(next.configurationStatus === "not-installed" ? "install" : "repair"))
    })
  }
  const preview = async (action: HookPlanAction) => {
    setApplied(null)
    const value = await run("변경 확인", () => api.planHooks(action))
    if (value) setPlan(value)
  }
  const closePreview = () => { setPlan(null); void api.discardHookPlan().catch(() => {}) }
  const apply = async () => {
    if (!plan) return
    const value = await run("Hook 설정 저장", () => api.applyHookPlan(plan.planId))
    if (value) setApplied(value)
    setPlan(null)
  }
  const warnings = status.configurationWarnings.filter(code => !["PACKAGED_TIMEOUT_2_SECONDS", "COMMITTED_RECEIPT_RECOVERED", "PREPARED_CHANGE_NOT_COMMITTED"].includes(code))

  if (status.app.platform === "win32") {
    const connected = status.adapter.state === "READY" && status.adapter.codexAvailable === true
    return <>
      <header className="page-header"><h1>Codex 연결</h1><button className="button secondary small" disabled={disabled} onClick={() => void run("상태 확인", () => api.refreshStatus())}>새로 확인</button></header>
      <section className="section-card connection-summary" aria-label="Codex 연결 상태">
        <div className="connection-heading"><span className={`connection-indicator ${connected ? "connected" : ""}`} aria-hidden="true">{connected ? "✓" : "◎"}</span><div><h2>{connected ? "데스크톱 자동 연결됨" : "데스크톱 연결 대기"}</h2><p>{connected ? "Codex의 작업 상태를 자동으로 수신하고 있습니다." : "같은 Windows 계정에서 Codex 앱을 실행해 주세요."}</p></div></div>
        <dl className="connection-checks"><div><dt>Codex Desktop</dt><dd>{connected ? "연결됨" : "연결 대기"}</dd></div><div><dt>진행 중인 작업</dt><dd>{status.adapter.activeRunCount}개</dd></div><div><dt>연결 서비스</dt><dd>{status.adapter.state}</dd></div></dl>
        <p>Windows에서는 Hook 설치 없이 자동 연결됩니다. 트레이의 Codex 제어에서 대화를 선택할 수 있습니다.</p>
        {status.adapter.state !== "READY" && <button className="button secondary" disabled={disabled || status.adapter.ownership === "EXTERNAL_PROCESS"} onClick={() => void run("연결 재시작", async () => { await api.restartAdapter(); return api.refreshStatus() })}>연결 다시 시작</button>}
      </section>
    </>
  }

  return <>
    <header className="page-header"><h1>Codex 연결</h1><button className="button secondary small" disabled={disabled} onClick={() => void run("상태 확인", () => api.refreshStatus())}>새로 확인</button></header>
    <section className="section-card connection-summary" aria-label="Codex 연결 상태">
      <div className="connection-heading"><span className={`connection-indicator ${receiving ? "connected" : ""}`} aria-hidden="true">{receiving ? "✓" : "◎"}</span><div><h2>{receiving ? "연결됨" : installed ? "신호 대기 중" : "연결 준비"}</h2><p>{receiving ? `최근 수신 ${time(status.reception.lastReceivedAt!)}` : installed ? "Codex를 사용하면 연결 상태가 자동으로 갱신됩니다." : "Codex 위치와 실행 환경을 자동으로 확인합니다."}</p></div></div>
      <dl className="connection-checks"><div><dt>Codex</dt><dd>{found ? discovery.executable.version?.replace("codex-cli ", "v") : discovery?.executable.path ? "확인 필요" : discovery ? "찾지 못함" : "찾는 중…"}</dd></div><div><dt>Hook</dt><dd>{installed ? "설정됨" : configurationLabels[status.configurationStatus]}</dd></div><div><dt>이벤트 수신</dt><dd>{receiving ? "확인됨" : status.reception.status === "waiting" ? "자동 확인 중" : "연결 대기"}</dd></div></dl>
      <div className="button-row"><button className="button primary" disabled={disabled} onClick={() => void prepare()}>{installed ? "연결 확인" : "연결 준비"}</button>{discovery && !discovery.executable.path && <button className="button secondary" disabled={disabled} onClick={() => void run("Codex 선택", () => api.chooseCodexExecutable())}>Codex 앱 선택</button>}</div>
    </section>
    {status.issue && <div className="notice warning" role="alert">{reasonText(status.issue)}</div>}
    {applied && applied.status !== "no-change" && (applied.status !== "applied" || !receiving) && <div className={`notice ${applied.status === "applied" ? "success" : "warning"}`} role="status">{applied.status === "applied-with-receipt-warning" ? "Hook 설정은 저장됐지만 설치 기록을 저장하지 못했습니다. 진단에서 확인해 주세요." : applied.status === "committed-conflict" ? "설정 저장 후 다른 변경이 발견됐습니다. 진단에서 확인해 주세요." : "Hook 설정을 저장했습니다. Codex에서 변경 내용을 검토해 주세요."}</div>}
    {discovery?.manualFeatureInstruction && <section className="section-card"><h2>Hook 기능 켜기</h2><p><code>config.toml</code>에 아래 설정을 추가한 뒤 Codex를 다시 실행해 주세요.</p><pre>{discovery.manualFeatureInstruction}</pre></section>}
    {(installed || applied) && !receiving && <section className="section-card hook-review"><div><h2>Codex에서 Hook 검토</h2><p>{reviewDone ? "검토 완료로 표시했습니다. 다음 작업부터 수신을 자동 확인합니다." : <>Codex의 Hook 설정에서 이 앱의 실행을 허용해 주세요. CLI에서는 <code>/hooks</code>를 사용합니다.</>}</p></div>{!reviewDone && <button className="button secondary small" disabled={disabled} onClick={() => void run("검토 상태 저장", () => api.reportHookReview())}>Codex에서 검토했어요</button>}</section>}
    {warnings.length > 0 && <div className="notice warning"><ul className="connection-warnings">{warnings.map(code => <li key={code}>{reasonText(code)}</li>)}</ul></div>}
    <details className="section-card setup-advanced"><summary>고급 설정</summary><div className="advanced-content">
      <h2>연결 위치</h2>
      <div className="path-row"><div><span className="label">Codex 실행 파일 <span className="source-label">{discovery?.executable.source === "selected" ? "직접 선택" : "자동 탐색"}</span></span><code>{discovery?.executable.path ?? "찾지 못함"}</code></div><button className="button secondary small" disabled={disabled} onClick={() => void run("Codex 선택", () => api.chooseCodexExecutable())}>변경</button></div>
      <div className="path-row"><div><span className="label">Codex 데이터 폴더</span><code>{discovery?.home.path ?? "확인 중…"}</code></div><button className="button secondary small" disabled={disabled} onClick={() => void run("Codex 폴더 선택", () => api.chooseCodexHome())}>폴더 변경</button></div>
      <div className="self-test-row"><div><strong>Hook 실행 검사</strong><p>{status.hostSelfTest.status === "passed" ? `검사 통과 · ${status.hostSelfTest.coldStartMs}ms` : status.hostSelfTest.status === "failed" ? "검사 실패" : "연결 준비 시 자동으로 실행합니다."}</p></div><button className="button secondary small" disabled={disabled || !status.host.available} onClick={() => void run("Hook 실행 검사", () => api.runHostSelfTest())}>다시 검사</button></div>
      <div className="button-row"><button className="button secondary small" disabled={disabled || !discovery} onClick={() => void preview("install")}>설치 미리보기</button><button className="button secondary small" disabled={disabled || !discovery} onClick={() => void preview("repair")}>수리 미리보기</button><button className="button quiet small" disabled={disabled || !status.hasRevert} onClick={() => void preview("revert-owned-change")}>마지막 변경 되돌리기</button><button className="button quiet small destructive-text" disabled={disabled || !discovery} onClick={() => void preview("uninstall")}>연동 제거</button></div>
      <p className="fine-print">앱 위치가 바뀌면 수리가 필요할 수 있습니다.</p>
    </div></details>
    <details className="section-card setup-advanced"><summary>이벤트 수신 내역</summary><div className="advanced-content">
      <table className="event-table"><thead><tr><th scope="col">이벤트</th><th scope="col">지원</th><th scope="col">수신</th></tr></thead><tbody>{HOOK_EVENTS.map(event => {
        const receipt = status.reception.events.find(item => item.event === event)
        return <tr key={event}><th scope="row"><code>{event}</code></th><td>{supportLabels[discovery?.capability.events[event] ?? "unknown"]}</td><td>{receipt?.count ? `${receipt.count}회` : "—"}</td></tr>
      })}</tbody></table>
      <details className="manual-observation"><summary>특정 작업 진단</summary><p>문제 재현이 필요할 때만 사용합니다. 일반 연결에는 필요하지 않습니다.</p><div className="observation-controls"><label htmlFor="observation-surface">실행 환경<select id="observation-surface" value={surface} disabled={disabled || status.live.active} onChange={event => setSurface(event.target.value as ObservationSurface)}><option value="desktop">Codex Desktop</option><option value="cli">Codex CLI</option></select></label><button className="button secondary small" disabled={disabled || status.adapter.state !== "READY" || status.adapter.ownership !== "OWNED_UTILITY"} onClick={() => void run("진단", () => status.live.active ? api.stopLiveObservation() : api.startLiveObservation(surface))}>{status.live.active ? "진단 종료" : "진단 시작"}</button></div><p>{status.live.status === "observed" ? "진단 중 시작·완료 수신" : status.live.status === "partial" ? "진단 중 일부 이벤트 수신" : "진단 중 수신 없음"}</p>{status.live.active && status.live.surface === "desktop" && <button className="button secondary small" disabled={disabled} onClick={() => void run("중단 검사 기록", () => api.reportDesktopStopAttempt())}>Desktop 중단 버튼을 눌렀어요</button>}<p className="fine-print">실행 환경과 중단 버튼 사용 여부는 직접 기재한 정보입니다.</p></details>
    </div></details>
    {plan && <HookPlanPreview plan={plan} busy={disabled} onClose={closePreview} onApply={() => void apply()} />}
  </>
}
