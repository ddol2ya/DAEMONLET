import { useT } from "../i18n/useLanguage"
import type { TaskEventSource } from "../behavior/TaskEventSource"
import { useEffect, useRef, useState } from "react"
import type { CharacterBehaviorController } from "../behavior/CharacterBehaviorController"
import type { MockTaskEventSource } from "../behavior/MockTaskEventSource"
import { CharacterEventProtocolClient } from "../protocol/CharacterEventProtocolClient"
import { ProtocolLoopbackSource } from "../protocol/ProtocolLoopbackSource"
import { ProtocolTaskEventSource } from "../protocol/ProtocolTaskEventSource"
import type { ProtocolDiagnostics, ProtocolFrame, ProtocolTraceExport } from "../protocol/types"
import { InMemoryProtocolTransport } from "../protocol/transports/InMemoryProtocolTransport"
import { ReplayProtocolTransport } from "../protocol/transports/ReplayProtocolTransport"
import { WebSocketProtocolTransport } from "../protocol/transports/WebSocketProtocolTransport"
import type { CharacterEventTransport } from "../protocol/transports/CharacterEventTransport"
import { ElectronIpcProtocolTransport } from "../pet/ElectronIpcProtocolTransport"

type SourceMode = "DIRECT_MOCK" | "PROTOCOL_LOOPBACK" | "PROTOCOL_WEBSOCKET" | "PROTOCOL_REPLAY" | "CODEX_ADAPTER"
type ProtocolRuntime = {
  client: CharacterEventProtocolClient
  source: ProtocolTaskEventSource
  transport: CharacterEventTransport
  loopback?: ProtocolLoopbackSource
}

export type ProtocolDebugApi = {
  connect(): Promise<void>
  disconnect(reason?: string): void
  inject(frame: string | ProtocolFrame | unknown): void
  requestSnapshot(): void
  getDiagnostics(): ProtocolDiagnostics
  exportTrace(): ProtocolTraceExport
}

const EMPTY_DIAGNOSTICS: ProtocolDiagnostics = {
  connectionState: "DISCONNECTED", connectionEpoch: 0, endpoint: null, protocolVersion: null, source: null, sourceInstanceId: null, sessionId: null,
  lastAppliedSequence: 0, bufferedFrameCount: 0, acceptedCount: 0, duplicateCount: 0, staleCount: 0, rejectedCount: 0,
  gapCount: 0, snapshotCount: 0, reconnectCount: 0, snapshotRequestPending: false, lastMessageAt: null, lastHeartbeatAt: null, heartbeatAgeMs: null,
  activeRuns: [], activeTaskCount: 0, lastError: null, lastRejectionReason: null,
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" }) {
  return <div className="metric"><dt>{label}</dt><dd className={tone ? `tone-${tone}` : ""}>{value}</dd></div>
}

const downloadJson = (name: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export function ProtocolDebugPanel({ controller, directSource, connectSource, onApiChange }: {
  controller: CharacterBehaviorController
  connectSource?: (source: TaskEventSource) => void
  directSource: MockTaskEventSource
  onApiChange?: (api: ProtocolDebugApi | null) => void
}) {
  const t = useT()
  const [mode, setMode] = useState<SourceMode>("DIRECT_MOCK")
  const [endpointDraft, setEndpointDraft] = useState("ws://127.0.0.1:4174/events")
  const [endpoint, setEndpoint] = useState(endpointDraft)
  const [diagnostics, setDiagnostics] = useState(EMPTY_DIAGNOSTICS)
  const [replayLoadError, setReplayLoadError] = useState<string | null>(null)
  const [runId, setRunId] = useState("protocol-run-001")
  const [taskId, setTaskId] = useState("child-test")
  const runtimeRef = useRef<ProtocolRuntime | null>(null)
  const diagnosticsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const electronProtocol = window.motionLabDesktop?.protocol

  useEffect(() => {
    const previous = runtimeRef.current
    runtimeRef.current = null
    previous?.source.dispose()
    previous?.loopback?.dispose()
    previous?.client.dispose()
    if (diagnosticsTimer.current) clearTimeout(diagnosticsTimer.current)
    diagnosticsTimer.current = null
    setDiagnostics(EMPTY_DIAGNOSTICS)
    setReplayLoadError(null)
    onApiChange?.(null)
    if (mode === "DIRECT_MOCK") {
      (connectSource ?? ((source) => controller.connect(source)))(directSource)
      controller.reset()
      return
    }

    let transport: CharacterEventTransport
    try {
      transport = mode === "PROTOCOL_LOOPBACK"
        ? new InMemoryProtocolTransport()
        : mode === "PROTOCOL_REPLAY"
          ? new ReplayProtocolTransport()
          : mode === "CODEX_ADAPTER" && electronProtocol
            ? new ElectronIpcProtocolTransport(electronProtocol)
            : new WebSocketProtocolTransport(mode === "CODEX_ADAPTER" ? "ws://127.0.0.1:4174/events" : endpoint)
    } catch (error) {
      setDiagnostics({
        ...EMPTY_DIAGNOSTICS,
        connectionState: "ERROR",
        endpoint,
        lastError: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const loopback = transport instanceof InMemoryProtocolTransport ? new ProtocolLoopbackSource(transport) : undefined
    const client = new CharacterEventProtocolClient(transport)
    const source = new ProtocolTaskEventSource(client)
    ;(connectSource ?? ((next) => controller.connect(next)))(source)
    const runtime: ProtocolRuntime = { transport, client, source, ...(loopback ? { loopback } : {}) }
    runtimeRef.current = runtime
    const refresh = () => {
      if (diagnosticsTimer.current) return
      diagnosticsTimer.current = setTimeout(() => {
        diagnosticsTimer.current = null
        if (runtimeRef.current === runtime) setDiagnostics(client.getDiagnostics())
      }, 120)
    }
    const unsubscribe = client.subscribeDiagnostics(refresh)
    const api: ProtocolDebugApi = {
      connect: () => client.connect(),
      disconnect: (reason) => client.disconnect(reason),
      inject: (frame) => { if (transport instanceof InMemoryProtocolTransport) transport.inject(frame) },
      requestSnapshot: () => client.requestSnapshot("manual"),
      getDiagnostics: () => client.getDiagnostics(),
      exportTrace: () => client.exportTrace(),
    }
    onApiChange?.(api)
    setDiagnostics(client.getDiagnostics())
    return () => {
      unsubscribe()
      if (diagnosticsTimer.current) clearTimeout(diagnosticsTimer.current)
      diagnosticsTimer.current = null
      if (runtimeRef.current === runtime) runtimeRef.current = null
      source.dispose()
      loopback?.dispose()
      client.dispose()
      onApiChange?.(null)
    }
  }, [controller, directSource, connectSource, electronProtocol, endpoint, mode, onApiChange])

  const runtime = () => runtimeRef.current
  const connect = () => void runtime()?.client.connect().catch(() => setDiagnostics(runtime()?.client.getDiagnostics() ?? EMPTY_DIAGNOSTICS))
  const loopback = () => runtime()?.loopback
  const replay = () => {
    const transport = runtime()?.transport
    return transport instanceof ReplayProtocolTransport ? transport : null
  }
  const loadReplay = async (file: File | undefined) => {
    if (!file) return
    const transport = replay()
    if (!transport) return
    try {
      const contents = await file.text()
      if (replay() !== transport) return
      transport.load(contents)
      setReplayLoadError(null)
      setDiagnostics(runtime()?.client.getDiagnostics() ?? EMPTY_DIAGNOSTICS)
    } catch (error) {
      if (replay() === transport) setReplayLoadError(error instanceof Error ? error.message : String(error))
    }
  }
  const resetReplay = () => {
    const current = runtime()
    const transport = replay()
    if (!current || !transport) return
    current.client.reset()
    transport.reset()
    void current.client.connect()
  }

  return <details open data-testid="protocol-debug-panel">
    <summary>{t("외부 이벤트 프로토콜 v1")}</summary>
    <div className="quality-controls protocol-controls">
      <label className="select-label"><span>{t("소스 모드")}</span><select value={mode} onChange={(event) => setMode(event.target.value as SourceMode)}>
        <option value="DIRECT_MOCK">{t("직접 모의 실행")}</option>
        <option value="PROTOCOL_LOOPBACK">{t("프로토콜 루프백")}</option>
        {!electronProtocol && <option value="PROTOCOL_WEBSOCKET">{t("프로토콜 WebSocket")}</option>}
        <option value="CODEX_ADAPTER">Codex Adapter</option>
        <option value="PROTOCOL_REPLAY">{t("프로토콜 재생")}</option>
      </select></label>
      {mode === "PROTOCOL_WEBSOCKET" && <div className="protocol-endpoint"><label className="select-label"><span>{t("엔드포인트")}</span><input value={endpointDraft} onChange={(event) => setEndpointDraft(event.target.value)} /></label><button className="button button-quiet" type="button" onClick={() => setEndpoint(endpointDraft.trim())}>{t("적용")}</button></div>}
      {mode === "CODEX_ADAPTER" && <div className="warning"><b>Codex Adapter</b><span>{t("예상 소스: codex-adapter ·")} {electronProtocol ? "secure Electron IPC transport" : "ws://127.0.0.1:4174/events"}</span>{!electronProtocol && <a href="http://127.0.0.1:4175/healthz" target="_blank" rel="noreferrer">{t("Hook 관찰 상태")}</a>}</div>}
      {electronProtocol && mode === "PROTOCOL_WEBSOCKET" && <div className="warning"><b>{t("사용 불가")}</b><span>{t("사용자 지정 WebSocket 엔드포인트는 브라우저 모션 실험실에서만 사용할 수 있습니다.")}</span></div>}
      <div className="button-row">
        <button className="button button-quiet" type="button" onClick={connect} disabled={mode === "DIRECT_MOCK"}>{t("연결")}</button>
        <button className="button button-quiet" type="button" onClick={() => runtime()?.client.disconnect()} disabled={mode === "DIRECT_MOCK"}>{t("연결 해제")}</button>
        <button className="button button-quiet" type="button" onClick={() => runtime()?.client.requestSnapshot("manual")} disabled={mode === "DIRECT_MOCK"}>{t("스냅샷 요청")}</button>
      </div>
      <dl className="metrics-grid">
        <Metric label={t("모드")} value={mode} />
        <Metric label={t("연결 상태")} value={diagnostics.connectionState} tone={diagnostics.connectionState === "READY" ? "good" : diagnostics.connectionState === "ERROR" || diagnostics.connectionState === "DESYNCED" ? "warn" : undefined} />
        <Metric label={t("연결 세대")} value={diagnostics.connectionEpoch} />
        <Metric label={t("엔드포인트")} value={diagnostics.endpoint ?? "—"} />
        <Metric label={t("프로토콜 / 소스")} value={`${diagnostics.protocolVersion ?? "—"} / ${diagnostics.source ?? "—"}`} />
        <Metric label={t("소스 인스턴스")} value={diagnostics.sourceInstanceId ?? "—"} />
        <Metric label={t("세션")} value={diagnostics.sessionId ?? "—"} />
        <Metric label={t("최근 순번")} value={diagnostics.lastAppliedSequence} />
        <Metric label={t("하트비트 경과")} value={diagnostics.heartbeatAgeMs === null ? "—" : `${Math.round(diagnostics.heartbeatAgeMs)} ms`} />
        <Metric label={t("수락 / 거부")} value={`${diagnostics.acceptedCount} / ${diagnostics.rejectedCount}`} />
        <Metric label={t("중복 / 오래됨")} value={`${diagnostics.duplicateCount} / ${diagnostics.staleCount}`} />
        <Metric label={t("누락 / 버퍼")} value={`${diagnostics.gapCount} / ${diagnostics.bufferedFrameCount}`} />
        <Metric label={t("스냅샷 / 재연결")} value={`${diagnostics.snapshotCount} / ${diagnostics.reconnectCount}`} />
        <Metric label={t("스냅샷 대기")} value={diagnostics.snapshotRequestPending ? "yes" : "no"} tone={diagnostics.snapshotRequestPending ? "warn" : undefined} />
      </dl>
      {replayLoadError && <div className="warning"><b>{t("재생 로드 실패")}</b><span>{replayLoadError}</span></div>}
      {(diagnostics.lastRejectionReason || diagnostics.lastError) && <div className="warning"><b>{t("프로토콜 진단")}</b>{diagnostics.lastRejectionReason && <span>{t("거부:")} {diagnostics.lastRejectionReason}</span>}{diagnostics.lastError && <span>{t("오류:")} {diagnostics.lastError}</span>}</div>}
      {mode === "CODEX_ADAPTER" && diagnostics.source && diagnostics.source !== "codex-adapter" && <div className="warning"><b>{t("예상하지 않은 소스")}</b><span>{t("수신값")} {diagnostics.source}{t("; 예상값 codex-adapter.")}</span></div>}
      {!!diagnostics.activeRuns.length && <div className="warning"><b>{t("진행 중 Run")}</b>{diagnostics.activeRuns.map((run) => <span key={run.runId}>{run.runId} · {run.progress === undefined ? "—" : `${Math.round(run.progress * 100)}%`}  {t("· 작업 [")}{run.runningTaskIds.join(", ") || "—"}{t("] · 실패 [")}{run.failedTaskIds.join(", ") || "—"}]</span>)}</div>}

      {mode === "PROTOCOL_LOOPBACK" && <>
        <label className="select-label"><span>{t("Run ID")}</span><input value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
        <label className="select-label"><span>{t("하위 작업 ID")}</span><input value={taskId} onChange={(event) => setTaskId(event.target.value)} /></label>
        <div className="button-row behavior-buttons">
          <button className="button button-quiet" type="button" onClick={() => loopback()?.startRun(runId)}>{t("정상 Run 시작")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.waitRun(runId)}>{t("정상 Run 대기")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.resumeRun(runId)}>{t("정상 Run 재개")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.completeRun(runId)}>{t("정상 Run 완료")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.failRun(runId)}>{t("정상 Run 실패")}</button>
          <button className="button button-quiet" type="button" onClick={() => { loopback()?.startTask(runId, taskId); loopback()?.failTask(runId, taskId) }}>{t("하위 작업 실패")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.duplicateLast()}>{t("마지막 프레임 중복")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendOutOfOrder()}>{t("순서가 뒤바뀐 프레임")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendGap()}>{t("순번 누락")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendSnapshot()}>{t("기준 스냅샷")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.restartSource()}>{t("소스 인스턴스 재시작")}</button>
          <button className="button button-quiet" type="button" onClick={() => (runtime()?.transport as InMemoryProtocolTransport | undefined)?.drop()}>{t("연결 끊기")}</button>
          <button className="button button-quiet" type="button" onClick={connect}>{t("재연결")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendMalformed()}>{t("잘못된 JSON")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendInvalidProgress()}>{t("잘못된 진행률")}</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendUnsupportedVersion()}>{t("지원하지 않는 버전")}</button>
        </div>
      </>}

      {mode === "PROTOCOL_REPLAY" && <>
        <label className="select-label"><span>{t("JSON / JSONL 재생")}</span><input type="file" accept=".json,.jsonl,application/json" onChange={(event) => {
          const input = event.currentTarget
          void loadReplay(input.files?.[0]).finally(() => { input.value = "" })
        }} /></label>
        <div className="button-row">
          <button className="button button-quiet" type="button" onClick={() => replay()?.play()}>{t("재생")}</button>
          <button className="button button-quiet" type="button" onClick={() => replay()?.pause()}>{t("일시 중지")}</button>
          <button className="button button-quiet" type="button" onClick={() => replay()?.step()}>{t("한 단계")}</button>
          <button className="button button-quiet" type="button" onClick={resetReplay}>{t("초기화")}</button>
          {([0.5, 1, 2] as const).map((speed) => <button key={speed} className="button button-quiet" type="button" onClick={() => replay()?.setSpeed(speed)}>{speed}x</button>)}
        </div>
      </>}

      <div className="button-row">
        <button className="button button-quiet" type="button" onClick={() => runtime() && downloadJson("protocol-trace.json", runtime()!.client.exportTrace())} disabled={mode === "DIRECT_MOCK"}>{t("프로토콜 추적 내보내기")}</button>
        <button className="button button-quiet" type="button" onClick={() => runtime() && downloadJson("protocol-snapshot.json", runtime()!.client.getRuntimeSnapshot())} disabled={mode === "DIRECT_MOCK"}>{t("현재 스냅샷 내보내기")}</button>
        <button className="button button-quiet" type="button" onClick={() => downloadJson("protocol-diagnostics.json", diagnostics)} disabled={mode === "DIRECT_MOCK"}>{t("진단 내보내기")}</button>
      </div>
    </div>
  </details>
}
