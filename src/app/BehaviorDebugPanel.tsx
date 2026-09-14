import { useT } from "../i18n/useLanguage"
import { useState } from "react"
import type { CharacterBehaviorController } from "../behavior/CharacterBehaviorController"
import type { MockTaskEventSource } from "../behavior/MockTaskEventSource"
import type { CharacterBehaviorDiagnostics, CharacterTaskEvent } from "../behavior/types"

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" }) {
  return <div className="metric"><dt>{label}</dt><dd className={tone ? `tone-${tone}` : ""}>{value}</dd></div>
}

function eventLabel(event: CharacterTaskEvent | null) {
  if (!event) return "—"
  if ("taskId" in event) return `${event.type} · ${event.taskId}`
  if (event.type === "TASK_SNAPSHOT") return `${event.type} · ${event.tasks.length} runs`
  if (event.type === "USER_ACTIVITY") return `${event.type} · ${event.source}`
  return event.type
}

export function BehaviorDebugPanel({ controller, source, diagnostics }: {
  controller: CharacterBehaviorController
  source: MockTaskEventSource
  diagnostics: CharacterBehaviorDiagnostics
}) {
  const t = useT()
  const [taskId, setTaskId] = useState("mock-task-001")
  const [progress, setProgress] = useState(0.5)
  const sendTask = (type: "TASK_STARTED" | "TASK_PROGRESS" | "TASK_COMPLETED" | "TASK_FAILED" | "TASK_CANCELLED" | "TASK_WAITING" | "TASK_RESUMED") => {
    const id = taskId.trim()
    if (!id) return
    source.dispatch(type === "TASK_PROGRESS" ? { type, taskId: id, progress }
      : type === "TASK_CANCELLED" ? { type, taskId: id, reason: "user-interrupted" }
      : { type, taskId: id })
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(controller.getDiagnostics(), null, 2)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "behavior-diagnostics.json"
    link.click()
    URL.revokeObjectURL(url)
  }
  const semantic = diagnostics.semantic
  return <details open data-testid="behavior-debug-panel">
    <summary>{t("캐릭터 동작")}</summary>
    <div className="quality-controls behavior-controls">
      <div className="mode-grid">
        <button className={`button button-quiet ${diagnostics.controlMode === "AUTO_BEHAVIOR" ? "is-on" : ""}`} type="button" onClick={() => controller.setControlMode("AUTO_BEHAVIOR")}>{t("자동 동작")}</button>
        <button className={`button button-quiet ${diagnostics.controlMode === "MANUAL_POSE" ? "is-on" : ""}`} type="button" data-testid="behavior-manual" onClick={() => controller.setControlMode("MANUAL_POSE")}>{t("수동 포즈")}</button>
      </div>
      <dl className="metrics-grid">
        <Metric label={t("제어 모드")} value={diagnostics.controlMode} />
        <Metric label={t("의미 상태")} value={semantic.state} tone={semantic.state === "BUSY" ? "warn" : "good"} />
        <Metric label={t("이전 상태")} value={semantic.previousState ?? "—"} />
        <Metric label={t("상태 시작")} value={`${Math.round(semantic.stateSince)} ms`} />
        <Metric label={t("대기 경과")} value={`${Math.round(diagnostics.idleElapsedMs)} ms`} />
        <Metric label={t("진행 중 작업 ID")} value={semantic.activeTaskIds.join(", ") || "—"} />
        <Metric label={t("대기 중 작업 ID")} value={semantic.waitingTaskIds.join(", ") || "—"} />
        <Metric label={t("연결 상태")} value={diagnostics.connected ? "Connected" : "Disconnected"} />
        <Metric label={t("짧은 반응")} value={diagnostics.currentReaction ?? "—"} />
        <Metric label={t("최근 결과")} value={semantic.lastOutcome?.kind ?? "—"} />
        <Metric label={t("완료 신뢰도")} value={semantic.lastOutcome?.kind === "completed" ? semantic.lastOutcome.confidence ?? "unspecified" : "—"} />
        <Metric label={t("최근 이벤트")} value={eventLabel(semantic.lastEvent)} />
        <Metric label={t("최근 오래된 이벤트")} value={eventLabel(semantic.lastStaleEvent)} />
        <Metric label={t("오래된 이벤트")} value={semantic.staleEventCount} />
        <Metric label={t("전환")} value={semantic.transitionReason} />
        <Metric label={t("심심 동작")} value={diagnostics.currentBoredAction ?? "—"} />
        <Metric label={t("목표 포즈")} value={diagnostics.desiredPoseId ?? "Base"} />
        <Metric label={t("로드됨 / 활성")} value={`${diagnostics.loadedPoseId ?? "—"} / ${diagnostics.activePoseId ?? "—"}`} />
        <Metric label={t("포즈 로딩")} value={diagnostics.poseLoadStatus} tone={diagnostics.poseLoadStatus === "fallback" ? "warn" : undefined} />
      </dl>
      <label className="select-label"><span>{t("모의 작업 ID")}</span><input value={taskId} onChange={(event) => setTaskId(event.target.value)} /></label>
      <label className="behavior-progress"><span>{t("진행률")}</span><output>{Math.round(progress * 100)}%</output><input type="range" min="0" max="1" step="0.05" value={progress} onChange={(event) => setProgress(Number(event.target.value))} /></label>
      <div className="button-row behavior-buttons">
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_STARTED")}>{t("작업 시작")}</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_PROGRESS")}>{t("작업 진행")}</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_WAITING")}>{t("작업 대기")}</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_RESUMED")}>{t("작업 재개")}</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_COMPLETED")}>{t("작업 완료")}</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_FAILED")}>{t("작업 실패")}</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_CANCELLED")}>{t("작업 취소")}</button>
        <button className="button button-quiet" type="button" onClick={() => source.dispatch({ type: "USER_ACTIVITY", source: "debug" })}>{t("사용자 활동")}</button>
        <button className="button button-quiet" type="button" onClick={() => controller.simulateIdleThreshold()}>{t("대기 임계값 모의 실행")}</button>
        <button className="button button-quiet" type="button" onClick={() => source.dispatch({ type: "RESET" })}>{t("초기화")}</button>
        <button className="button button-quiet" type="button" onClick={() => source.dispatch({ type: "CONNECTION_CHANGED", connected: false })}>{t("연결 끊김 모의 실행")}</button>
        <button className="button button-quiet" type="button" onClick={() => source.dispatch({ type: "CONNECTION_CHANGED", connected: true })}>{t("재연결 모의 실행")}</button>
        <button className="button button-quiet" type="button" onClick={download}>{t("동작 JSON 다운로드")}</button>
      </div>
      {diagnostics.warning && <div className="warning"><b>{t("동작 대체")}</b>{diagnostics.warning}</div>}
      {!!diagnostics.manifestWarnings.length && <div className="warning"><b>{t("동작 경고")}</b>{diagnostics.manifestWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
    </div>
  </details>
}
