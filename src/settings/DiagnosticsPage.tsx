import { useState } from "react"
import type { SettingsPageProps } from "./SettingsApp"
import { configurationLabels } from "./labels"

export function DiagnosticsPage({ api, status, run, busy }: SettingsPageProps) {
  const [notice, setNotice] = useState("")
  return <>
    <header className="page-header"><h1>진단</h1><button className="button secondary" disabled={Boolean(busy)} onClick={async () => { const value = await run("진단 내보내기", () => api.exportDiagnostics()); if (value?.saved) setNotice("진단 파일을 저장했습니다.") }}>진단 내보내기</button></header>
    {notice && <div className="notice neutral" role="status">{notice}</div>}
    <section className="section-card"><h2>앱과 Adapter</h2><dl className="diagnostic-list"><div><dt>앱</dt><dd>v{status.app.version} · {status.app.packaged ? "패키지 실행" : "개발 실행"}</dd></div><div><dt>Adapter</dt><dd>{status.adapter.state} · {status.adapter.ownership === "OWNED_UTILITY" ? "이 앱이 실행함" : status.adapter.ownership === "EXTERNAL_PROCESS" ? "외부 프로세스" : "실행 소유권 없음"}</dd></div><div><dt>진행 중인 작업</dt><dd>{status.adapter.activeRunCount}개 Run / {status.adapter.activeTaskCount}개 task</dd></div><div><dt>Hook 설정</dt><dd>{configurationLabels[status.configurationStatus]}</dd></div><div><dt>동봉 실행 호스트</dt><dd>{status.host.available ? "접근 가능" : "확인 필요"} · RunAsNode {status.host.runAsNode}</dd></div><div><dt>자체 검사</dt><dd>{status.hostSelfTest.status === "passed" ? "동봉 Hook 실행·전송 검사 통과" : status.hostSelfTest.status === "not-tested" ? "아직 검사 안 함" : "검사 확인 필요"}</dd></div></dl>
      <div className="button-row"><button className="button secondary small" disabled={Boolean(busy) || status.adapter.ownership === "EXTERNAL_PROCESS"} onClick={async () => { const value = await run("Adapter 재시작", () => api.restartAdapter()); if (value) setNotice(value.restarted ? "Adapter를 재시작했습니다." : "재시작하지 않았습니다. 외부 프로세스 또는 작업 상태를 확인해 주세요.") }}>Adapter 재시작</button></div><p className="fine-print">진행 중인 Run이 있으면 재시작 영향을 확인합니다. 외부 Adapter는 종료하거나 교체하지 않습니다.</p>
    </section>
    <section className="section-card"><h2>현재 앱이 사용하는 위치</h2><p>아래 실제 경로는 이 창에서만 표시합니다. 내보내기에서는 역할 이름으로 바뀝니다.</p><dl className="diagnostic-list paths"><div><dt>앱 실행 파일</dt><dd><code>{status.host.executableDisplayPath}</code></dd></div><div><dt>동봉 forwarder</dt><dd><code>{status.host.resourceDisplayPath}</code></dd></div><div><dt>Adapter dataDir</dt><dd><code>{status.host.dataDisplayPath}</code></dd></div><div><dt>전송 주소</dt><dd><code>{status.host.endpoint}</code></dd></div><div><dt>앱 userData</dt><dd><code>{status.storage.userDataDisplayPath}</code></dd></div><div><dt>보호된 설치 기록·백업</dt><dd><code>{status.storage.receiptDirectoryDisplayPath}</code></dd></div></dl></section>
    <section className="section-card"><h2>검사의 범위</h2><p>선택한 Codex Home의 hooks.json·config.toml, 접근 가능한 알려진 system requirements 파일을 확인합니다. 프로젝트·플러그인·MDM·클라우드 policy 전체를 조사하지 않습니다.</p><p>진단 파일에는 단계별 상태와 이벤트 이름·횟수·시각만 포함합니다. 다른 Hook의 command, token, 대화 원문, transcript, Run/Session/Task ID, 원본 백업은 내보내지 않습니다.</p><p className="fine-print">Hook 검토는 사용자 보고입니다. 서명·공증과 실제 Desktop 중단 버튼 확인은 별도의 검증입니다.</p></section>
  </>
}
