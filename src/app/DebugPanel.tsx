import { useT } from "../i18n/useLanguage"
import type { TaskEventSource } from "../behavior/TaskEventSource"
import type { CharacterDialogueController } from "../dialogue/CharacterDialogueController"
import { DialogueDebugPanel } from "./DialogueDebugPanel"
import type { Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"
import type { Anime25DParameter, HairPhysicsTuning, QualityMode, RigDiagnostics } from "../engine/anime25d/types"
import { LayerInspector } from "./LayerInspector"
import type { PoseSummary } from "../pose/types"
import type { CharacterBehaviorController } from "../behavior/CharacterBehaviorController"
import type { MockTaskEventSource } from "../behavior/MockTaskEventSource"
import type { CharacterBehaviorDiagnostics } from "../behavior/types"
import { BehaviorDebugPanel } from "./BehaviorDebugPanel"
import { ProtocolDebugPanel, type ProtocolDebugApi } from "./ProtocolDebugPanel"

const PARAMS: Anime25DParameter[] = ["angleX", "angleY", "angleZ", "eyeX", "eyeY", "eyeOpenL", "eyeOpenR", "mouthOpen", "mouthForm", "body", "armY", "armPos"]

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" }) {
  return <div className="metric"><dt>{label}</dt><dd className={tone ? `tone-${tone}` : ""}>{value}</dd></div>
}

function formatPoint(point?: { cx: number; cy: number }) {
  return point ? `${point.cx.toFixed(1)}, ${point.cy.toFixed(1)}` : "—"
}

const QUALITY_MODES: Array<[QualityMode, string]> = [
  ["SOURCE_REFERENCE", "원본"], ["RAW_PSD_COMPOSITE", "원본 PSD"], ["CLEANED_PSD_COMPOSITE", "정리된 PSD"],
  ["RIG_NEUTRAL", "기본 리깅"], ["RIG_ANIMATED", "움직이는 리깅"],
]

function HairRange({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><output>{value.toFixed(2)}</output><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>
}

export function DebugPanel({ diagnostics, runtime, behavior, behaviorDiagnostics, taskSource, dialogue, onSourceChange, onProtocolApiChange, onToggleOverlay, overlayVisible, models, selectedModel, onSelectModel, onCapture, poses, selectedPoseId, onSelectPose, onLoadPose, onEnterPose, onTogglePose }: {
  diagnostics: RigDiagnostics
  runtime: Anime25DRuntime
  behavior: CharacterBehaviorController
  behaviorDiagnostics: CharacterBehaviorDiagnostics
  dialogue?: CharacterDialogueController
  onSourceChange?: (source: TaskEventSource) => void
  taskSource: MockTaskEventSource
  onProtocolApiChange?: (api: ProtocolDebugApi | null) => void
  onToggleOverlay: () => void
  overlayVisible: boolean
  models: Array<{ id: string; label: string }>
  selectedModel: string
  onSelectModel: (id: string) => void
  onCapture: () => void
  poses: PoseSummary[]
  selectedPoseId: string
  onSelectPose: (id: string) => void
  onLoadPose: () => void
  onEnterPose: () => void
  onTogglePose: () => void
}) {
  const t = useT()
  const anchors = diagnostics.anchors
  const copyDiagnostics = async () => {
    const report = runtime.getAssetDiagnostics()
    if (report) await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
  }
  const downloadDiagnostics = () => {
    const report = runtime.getAssetDiagnostics()
    if (!report) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${report.source.replace(/\.psd$/i, "")}-diagnostics.json`
    link.click()
    URL.revokeObjectURL(url)
  }
  const downloadJson = (name: string, value: unknown) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <aside className="debug-panel" data-testid="debug-panel">
      <header className="panel-header">
        <div><span className="eyebrow">{t("실시간 진단")}</span><h2>{t("리깅 검사")}</h2></div>
        <button className={`icon-button ${overlayVisible ? "is-on" : ""}`} type="button" onClick={onToggleOverlay}>{t("상호작용 영역")}</button>
      </header>

      {dialogue && <DialogueDebugPanel controller={dialogue} behavior={behavior} />}
      <BehaviorDebugPanel controller={behavior} source={taskSource} diagnostics={behaviorDiagnostics} />
      <ProtocolDebugPanel controller={behavior} directSource={taskSource} connectSource={onSourceChange} onApiChange={onProtocolApiChange} />

      <details open>
        <summary>{t("모델·품질")}</summary>
        <div className="quality-controls">
          <label className="select-label"><span>{t("모델")}</span><select value={selectedModel} onChange={(event) => onSelectModel(event.target.value)}>{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
          <div className="mode-grid">{QUALITY_MODES.map(([mode, label]) => <button key={mode} className={`button button-quiet ${diagnostics.qualityMode === mode ? "is-on" : ""}`} type="button" aria-pressed={diagnostics.qualityMode === mode} onClick={() => runtime.setQualityMode(mode)} disabled={mode === "SOURCE_REFERENCE" && !diagnostics.sourceReferenceUrl}>{t(label)}</button>)}</div>
          <div className="button-row"><button className="button button-quiet" type="button" onClick={onCapture}>{t("PNG 캡처")}</button><button className="button button-quiet" type="button" onClick={() => void copyDiagnostics()}>{t("JSON 복사")}</button><button className="button button-quiet" type="button" onClick={downloadDiagnostics}>{t("JSON 다운로드")}</button></div>
        </div>
      </details>

      <details open>
        <summary>{t("눈 깜박임 검사")}</summary>
        <div className="quality-controls">
          <dl className="metrics-grid">
            <Metric label={t("단계")} value={diagnostics.blink.phase} />
            <Metric label={t("다음 깜박임")} value={`${Math.round(diagnostics.blink.nextBlinkInMs)} ms`} />
            <Metric label={t("주기")} value={`${Math.round(diagnostics.blink.currentCycleDurationMs)} ms`} />
            <Metric label={t("기준 왼쪽 / 오른쪽")} value={`${diagnostics.blink.baselineEyeOpenL.toFixed(2)} / ${diagnostics.blink.baselineEyeOpenR.toFixed(2)}`} />
            <Metric label={t("강제 적용")} value={diagnostics.blink.forcedBlinkCount} />
          </dl>
          <div className="mode-grid blink-grid">
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(1, 1)}>{t("양쪽 뜨기")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(.5, .5)}>{t("반쯤 감기")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(0, 0)}>{t("양쪽 감기")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(0, 1)}>{t("왼쪽 감기")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(1, 0)}>{t("오른쪽 감기")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.clearBlinkTest()}>{t("검사 해제")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.forceBlink()}>{t("강제 깜박임")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.resetBlink()}>{t("깜박임 초기화")}</button>
          </div>
          <label className="check-label"><input type="checkbox" checked={diagnostics.autoBlink} onChange={(event) => runtime.setAutoBlink(event.target.checked)} />{t("자동 깜박임")}</label>
        </div>
      </details>

      <details open>
        <summary>{t("시선 제어")}</summary>
        <div className="quality-controls">
          <dl className="metrics-grid">
            <Metric label={t("모드")} value={diagnostics.gaze.mode} />
            <Metric label={t("포인터")} value={diagnostics.gaze.pointerActive ? "active" : "inactive"} />
            <Metric label={t("대기 시선 목표")} value={`${diagnostics.gaze.idle.targetEyeX.toFixed(2)}, ${diagnostics.gaze.idle.targetEyeY.toFixed(2)}`} />
            <Metric label={t("다음 목표")} value={`${Math.round(diagnostics.gaze.idle.nextTargetInMs)} ms`} />
            <Metric label={t("눈 출력")} value={`${diagnostics.gaze.idle.eyeX.toFixed(2)}, ${diagnostics.gaze.idle.eyeY.toFixed(2)}`} />
            <Metric label={t("머리 출력")} value={`${diagnostics.gaze.idle.headX.toFixed(2)}, ${diagnostics.gaze.idle.headY.toFixed(2)}`} />
          </dl>
          <div className="button-row">
            <button className="button button-quiet" type="button" onClick={() => runtime.forceNewIdleGazeTarget()}>{t("새 대기 시선 목표")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.resetIdleGaze()}>{t("대기 시선 초기화")}</button>
          </div>
          <label className="check-label"><input type="checkbox" checked={diagnostics.gaze.idle.enabled} onChange={(event) => runtime.setIdleGazeEnabled(event.target.checked)} />{t("대기 시선")}</label>
        </div>
      </details>

      <details>
        <summary>{t("모션 소스")}</summary>
        <div className="quality-controls">
          <div className="warning"><b>{t("소유자별 제어권")}</b>{diagnostics.motionSources.slice(-30).map((source) => <span key={`${source.slot}:${source.token}`}>{source.slot} · {source.ownerId} · #{source.token} · p{source.priority} · {source.activeParameterCount} params · {Object.entries(source.modeOverrides).map(([name, mode]) => `${name}:${mode}`).join(", ") || "default modes"} · {source.status}</span>)}</div>
          <button className="button button-quiet" type="button" onClick={() => downloadJson("motion-source-diagnostics.json", diagnostics.motionSources)}>{t("소스 내보내기")}</button>
        </div>
      </details>

      <details>
        <summary>{t("생명주기 추적")}</summary>
        <div className="quality-controls">
          <div className="warning"><b>{t("최근 이벤트 내역")}</b>{diagnostics.lifecycle.slice(-30).map((entry) => <span key={entry.id}>{(entry.at / 1000).toFixed(3)} · {entry.event.type} · {"poseId" in entry.event ? entry.event.poseId ?? "—" : entry.event.interactionId}</span>)}</div>
          <button className="button button-quiet" type="button" onClick={() => downloadJson("lifecycle-trace.json", runtime.getLifecycleHistory())}>{t("생명주기 내보내기")}</button>
        </div>
      </details>

      <details>
        <summary>{t("머리카락 검사")}</summary>
        <div className="quality-controls">
          <div className="mode-grid">
            {([['off', 'Physics OFF'], ['combined', 'Physics ON'], ['wind', 'Wind only'], ['inertia', 'Inertia only']] as const).map(([mode, label]) => <button key={mode} className={`button button-quiet ${diagnostics.hairTestMode === mode ? "is-on" : ""}`} type="button" onClick={() => runtime.setHairTestMode(mode)}>{t(label)}</button>)}
            <button className="button button-quiet" type="button" onClick={() => runtime.impulseHair()}>{t("충격")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.resetHairSprings()}>{t("스프링 초기화")}</button>
          </div>
          {([['frontHair', 'Front'], ['backHair', 'Back']] as const).map(([group, label]) => {
            const physics = diagnostics.hairPhysics[group]
            const set = (key: keyof HairPhysicsTuning) => (value: number) => runtime.setHairPhysics(group, key, value)
            return <div className="hair-group" key={group}><b>{label}  {t("머리카락")}</b><div className="parameter-list">
              <HairRange label={t("진폭")} value={physics.amplitude} min={0} max={2} step={.01} onChange={set("amplitude")} />
              <HairRange label={t("강성")} value={physics.stiffness} min={1} max={160} step={1} onChange={set("stiffness")} />
              <HairRange label={t("감쇠")} value={physics.damping} min={.1} max={30} step={.1} onChange={set("damping")} />
              <HairRange label={t("바람")} value={physics.wind} min={0} max={2} step={.01} onChange={set("wind")} />
              <HairRange label={t("관성")} value={physics.inertia} min={0} max={2} step={.01} onChange={set("inertia")} />
              <HairRange label={t("뿌리 고정")} value={physics.rootLock} min={0} max={.9} step={.01} onChange={set("rootLock")} />
              <HairRange label={t("최대 변위")} value={physics.maxOffset} min={0} max={60} step={1} onChange={set("maxOffset")} />
            </div></div>
          })}
          <div className="parameter-list"><HairRange label={t("앞머리 부드러움")} value={diagnostics.parameters.fhSoft} min={0} max={1} step={.01} onChange={(value) => runtime.setParameter("fhSoft", value)} /><HairRange label={t("뒷머리 부드러움")} value={Math.min(1, diagnostics.parameters.soft)} min={0} max={1} step={.01} onChange={(value) => runtime.setParameter("soft", value)} /></div>
        </div>
      </details>

      <details open>
        <summary>{t("엔진")}</summary>
        <dl>
          <Metric label={t("렌더러")} value={diagnostics.renderer} />
          <Metric label={t("리깅 도구")} value={diagnostics.rigger} />
          <Metric label={t("커밋")} value={`${diagnostics.upstreamCommit.slice(0, 9)}…`} />
          <Metric label={t("스텐실")} value={diagnostics.webglStencil ? "enabled" : "disabled"} tone={diagnostics.webglStencil ? "good" : "warn"} />
          <Metric label="FPS" value={diagnostics.fps || "—"} />
        </dl>
      </details>

      <details open>
        <summary>{t("리깅")}</summary>
        <dl className="metrics-grid">
          <Metric label={t("PSD 캔버스")} value={diagnostics.psdCanvas} />
          <Metric label={t("PSD 레이어")} value={diagnostics.psdLayerCount} />
          <Metric label={t("리깅 / 메시")} value={`${diagnostics.rigLayerCount} / ${diagnostics.meshCount}`} />
          <Metric label={t("텍스처")} value={diagnostics.textureCount} />
          <Metric label={t("머리 / 몸")} value={`${diagnostics.headLayers} / ${diagnostics.bodyLayers}`} />
          <Metric label={t("눈 레이어")} value={diagnostics.eyeLayers} />
          <Metric label={t("머리카락 레이어")} value={diagnostics.hairLayers} />
          <Metric label={t("머리카락 가닥")} value={diagnostics.hairStrandCount} />
          <Metric label={t("합성 눈 / 입")} value={`${diagnostics.syntheticEyeClose ? "yes" : "no"} / ${diagnostics.syntheticMouthClose ? "yes" : "no"}`} />
        </dl>
        {!!diagnostics.missingRequiredLayers.length && <div className="warning"><b>{t("누락")}</b>{diagnostics.missingRequiredLayers.join(", ")}</div>}
        {!!diagnostics.warnings.length && <div className="warning"><b>{t("리깅 경고")}</b>{diagnostics.warnings.map((warning, index) => <span key={`${index}:${warning}`}>{warning}</span>)}</div>}
        {!!diagnostics.qualityFindings.length && <div className="warning"><b>{t("품질 검사 결과")}</b>{diagnostics.qualityFindings.map((finding) => <span key={finding.code}>{finding.code}: {finding.message}</span>)}</div>}
      </details>

      <details>
        <summary>{t("기준점")}</summary>
        <dl>
          <Metric label={t("얼굴 경계")} value={anchors ? `${anchors.face.x0.toFixed(0)},${anchors.face.y0.toFixed(0)} → ${anchors.face.x1.toFixed(0)},${anchors.face.y1.toFixed(0)}` : "—"} />
          <Metric label={t("왼쪽 눈")} value={anchors?.eyeL ? `${anchors.eyeL.icx.toFixed(1)}, ${anchors.eyeL.icy.toFixed(1)}` : "—"} />
          <Metric label={t("오른쪽 눈")} value={anchors?.eyeR ? `${anchors.eyeR.icx.toFixed(1)}, ${anchors.eyeR.icy.toFixed(1)}` : "—"} />
          <Metric label={t("입")} value={formatPoint(anchors?.mouth)} />
          <Metric label={t("목 회전축")} value={formatPoint(anchors?.neckPivot)} />
          <Metric label={t("몸 회전축")} value={formatPoint(anchors?.bodyPivot)} />
        </dl>
      </details>

      <details open>
        <summary>{t("입력")}</summary>
        <dl>
          <Metric label={t("모델 내 포인터")} value={diagnostics.pointerModel ? `${diagnostics.pointerModel.x.toFixed(1)}, ${diagnostics.pointerModel.y.toFixed(1)}` : "—"} />
          <Metric label={t("상호작용 영역")} value={diagnostics.hitArea} />
          <Metric label={t("제스처")} value={diagnostics.gesture} />
          <Metric label={t("상호작용")} value={diagnostics.interactionState} />
          <Metric label={t("포즈")} value={diagnostics.poseState} />
        </dl>
        <div className="button-row">
          <button className="button button-quiet" type="button" onClick={() => runtime.triggerInteraction("HEAD_TAP")}>{t("머리 누르기 미리보기")}</button>
          <button className="button button-quiet" type="button" onClick={() => runtime.triggerInteraction("PET_LOOP")}>{t("쓰다듬기 미리보기")}</button>
          <button className="button button-quiet" type="button" onClick={() => runtime.triggerInteraction("HOLD_LOOP")}>{t("길게 누르기 미리보기")}</button>
          <button className="button button-quiet" type="button" onClick={() => runtime.triggerInteraction("TORSO_TAP")}>{t("몸통 누르기 미리보기")}</button>
          <button className="button button-quiet" type="button" onClick={() => runtime.cancelInteraction("qa-cancel")}>{t("미리보기 취소")}</button>
        </div>
      </details>

      <details>
        <summary>{t("매개변수")}</summary>
        <div className="parameter-list">
          {PARAMS.map((name) => <label key={name}><span>{name}</span><output>{diagnostics.parameters[name].toFixed(2)}</output><input type="range" min={name.startsWith("eyeOpen") || name === "mouthOpen" ? 0 : -1} max="1" step="0.01" value={diagnostics.parameters[name]} onChange={(event) => runtime.setParameter(name, Number(event.target.value))} /></label>)}
        </div>
        <button className="button button-quiet" type="button" onClick={() => runtime.clearManualParameters()}>{t("수동 값 초기화")}</button>
      </details>

      <details open>
        <summary>{t("레이어 포즈")}</summary>
        <dl className="metrics-grid">
          <Metric label={t("포즈 ID")} value={diagnostics.pose.id ?? "—"} />
          <Metric label={t("포즈 PSD")} value={diagnostics.pose.psd ?? "—"} />
          <Metric label={t("로드")} value={diagnostics.pose.loadStatus} tone={diagnostics.pose.loadStatus === "ready" ? "good" : diagnostics.pose.loadStatus === "rejected" || diagnostics.pose.loadStatus === "error" ? "warn" : undefined} />
          <Metric label={t("정합")} value={diagnostics.pose.registrationStatus} tone={diagnostics.pose.registrationStatus === "accepted" ? "good" : diagnostics.pose.registrationStatus === "rejected" ? "warn" : undefined} />
          <Metric label={t("상태")} value={diagnostics.pose.state} />
          <Metric label={t("진행 / 혼합")} value={`${diagnostics.pose.progress.toFixed(3)} / ${diagnostics.pose.mix.toFixed(3)}`} />
          <Metric label={t("활성 포즈 레이어")} value={diagnostics.pose.activeLayerCount} />
          <Metric label={t("기본 / 포즈 GPU")} value={`${diagnostics.pose.baseGpuResources} / ${diagnostics.pose.poseGpuResources}`} />
          <Metric label={t("모션 레이어")} value={diagnostics.pose.motionLayerCount} />
        </dl>
        {diagnostics.pose.registration && <dl>
          <Metric label={t("기본 / 포즈 눈 거리")} value={`${diagnostics.pose.registration.baseEyeDistance.toFixed(2)} / ${diagnostics.pose.registration.poseEyeDistance.toFixed(2)}`} />
          <Metric label={t("크기 차이")} value={diagnostics.pose.registration.scaleDelta.toFixed(4)} />
          <Metric label={t("회전")} value={`${diagnostics.pose.registration.rotationDeg.toFixed(3)}°`} />
          <Metric label={t("눈 / 목 오차")} value={`${diagnostics.pose.registration.eyeResidualError.toFixed(2)} / ${diagnostics.pose.registration.neckResidualError.toFixed(2)} px`} />
        </dl>}
        {diagnostics.pose.error && <div className="warning"><b>{t("포즈 오류")}</b>{diagnostics.pose.error}</div>}
        {!!diagnostics.pose.warnings.length && <div className="warning"><b>{t("포즈 경고")}</b>{diagnostics.pose.warnings.map((warning, index) => <span key={`${index}:${warning}`}>{warning}</span>)}</div>}
        <div className="quality-controls">
          <label className="select-label"><span>{t("포즈")}</span><select data-testid="pose-selector" value={selectedPoseId} onChange={(event) => onSelectPose(event.target.value)} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}><option value="">{t("없음 / 기본")}</option>{poses.map((pose) => <option key={pose.id} value={pose.id}>{pose.label}</option>)}</select></label>
          <div className="button-row">
            <button className="button button-quiet" type="button" onClick={onLoadPose} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>{t("포즈 로드")}</button>
            <button className="button button-quiet" type="button" onClick={onEnterPose} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>{t("진입")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.exitPose()} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>{t("이탈")}</button>
            <button className="button button-quiet" type="button" onClick={onTogglePose} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>{t("전환")}</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.resetPose()} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>{t("초기화")}</button>
          </div>
          <div className="mode-grid">
            {[.25, .5, .75].map((progress) => <button key={progress} className="button button-quiet" type="button" onClick={() => runtime.pausePoseAt(progress)} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>{t("일시 중지")} {progress * 100}%</button>)}
            <button className="button button-quiet" type="button" onClick={() => runtime.pausePoseExitAt(.5)} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>{t("50% 이탈에서 일시 중지")}</button>
          </div>
          <div className="button-row">
            <button className="button button-quiet" type="button" onClick={() => downloadJson("current-rig-overrides.json", { physics: diagnostics.hairPhysics })}>{t("현재 덮어쓰기 값 내보내기")}</button>
            <button className="button button-quiet" type="button" disabled={!diagnostics.pose.registration} onClick={() => downloadJson("pose-registration.json", diagnostics.pose.registration)}>{t("포즈 정합 내보내기")}</button>
          </div>
          <div className="button-row">
            {[...diagnostics.pose.poseReplaceLayers, ...diagnostics.pose.poseAdditiveLayers].map((name) => <button key={name} className="button button-quiet" type="button" onClick={() => runtime.isolateLayer(`pose:${name}`, name)}>{t("격리")} {name}</button>)}
            <button className="button button-quiet" type="button" onClick={() => runtime.clearLayerFilters()}>{t("격리 해제")}</button>
          </div>
        </div>
        <div className="warning"><b>{t("레이어 그래프")}</b><span>{t("공유 기본:")} {diagnostics.pose.sharedBaseLayers.join(", ") || "—"}</span><span>{t("기본 교체:")} {diagnostics.pose.baseReplaceLayers.join(", ") || "—"}</span><span>{t("포즈 교체:")} {diagnostics.pose.poseReplaceLayers.join(", ") || "—"}</span><span>{t("포즈 추가:")} {diagnostics.pose.poseAdditiveLayers.join(", ") || "—"}</span></div>
      </details>

      <details>
        <summary>{t("PSD 입력 순서")}</summary>
        <ol className="layer-list">{diagnostics.layerNames.map((name, index) => <li key={`${name}-${index}`}><span>{index + 1}</span>{name}</li>)}</ol>
      </details>

      <details>
        <summary>{t("레이어 순서")}</summary>
        <ol className="layer-list">{diagnostics.layerOrder.map((name, index) => <li key={`${name}-${index}`}><span>{index + 1}</span>{name}</li>)}</ol>
      </details>

      <details>
        <summary>{t("레이어 검사")}</summary>
        <LayerInspector diagnostics={diagnostics} runtime={runtime} />
      </details>
    </aside>
  )
}
