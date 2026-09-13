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
  ["SOURCE_REFERENCE", "Source"], ["RAW_PSD_COMPOSITE", "Raw PSD"], ["CLEANED_PSD_COMPOSITE", "Cleaned PSD"],
  ["RIG_NEUTRAL", "Rig Neutral"], ["RIG_ANIMATED", "Rig Animated"],
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
        <div><span className="eyebrow">LIVE DIAGNOSTICS</span><h2>Rig inspector</h2></div>
        <button className={`icon-button ${overlayVisible ? "is-on" : ""}`} type="button" onClick={onToggleOverlay}>Hit areas</button>
      </header>

      {dialogue && <DialogueDebugPanel controller={dialogue} behavior={behavior} />}
      <BehaviorDebugPanel controller={behavior} source={taskSource} diagnostics={behaviorDiagnostics} />
      <ProtocolDebugPanel controller={behavior} directSource={taskSource} connectSource={onSourceChange} onApiChange={onProtocolApiChange} />

      <details open>
        <summary>Model & quality</summary>
        <div className="quality-controls">
          <label className="select-label"><span>Model</span><select value={selectedModel} onChange={(event) => onSelectModel(event.target.value)}>{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
          <div className="mode-grid">{QUALITY_MODES.map(([mode, label]) => <button key={mode} className={`button button-quiet ${diagnostics.qualityMode === mode ? "is-on" : ""}`} type="button" aria-pressed={diagnostics.qualityMode === mode} onClick={() => runtime.setQualityMode(mode)} disabled={mode === "SOURCE_REFERENCE" && !diagnostics.sourceReferenceUrl}>{label}</button>)}</div>
          <div className="button-row"><button className="button button-quiet" type="button" onClick={onCapture}>Capture PNG</button><button className="button button-quiet" type="button" onClick={() => void copyDiagnostics()}>Copy JSON</button><button className="button button-quiet" type="button" onClick={downloadDiagnostics}>Download JSON</button></div>
        </div>
      </details>

      <details open>
        <summary>Blink test</summary>
        <div className="quality-controls">
          <dl className="metrics-grid">
            <Metric label="Phase" value={diagnostics.blink.phase} />
            <Metric label="Next blink" value={`${Math.round(diagnostics.blink.nextBlinkInMs)} ms`} />
            <Metric label="Cycle" value={`${Math.round(diagnostics.blink.currentCycleDurationMs)} ms`} />
            <Metric label="Baseline L / R" value={`${diagnostics.blink.baselineEyeOpenL.toFixed(2)} / ${diagnostics.blink.baselineEyeOpenR.toFixed(2)}`} />
            <Metric label="Forced" value={diagnostics.blink.forcedBlinkCount} />
          </dl>
          <div className="mode-grid blink-grid">
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(1, 1)}>Both open</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(.5, .5)}>Half close</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(0, 0)}>Both close</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(0, 1)}>Left close</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.setBlinkTest(1, 0)}>Right close</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.clearBlinkTest()}>Clear test</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.forceBlink()}>Force blink</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.resetBlink()}>Reset blink</button>
          </div>
          <label className="check-label"><input type="checkbox" checked={diagnostics.autoBlink} onChange={(event) => runtime.setAutoBlink(event.target.checked)} />Auto blink</label>
        </div>
      </details>

      <details open>
        <summary>Gaze orchestration</summary>
        <div className="quality-controls">
          <dl className="metrics-grid">
            <Metric label="Mode" value={diagnostics.gaze.mode} />
            <Metric label="Pointer" value={diagnostics.gaze.pointerActive ? "active" : "inactive"} />
            <Metric label="Idle target" value={`${diagnostics.gaze.idle.targetEyeX.toFixed(2)}, ${diagnostics.gaze.idle.targetEyeY.toFixed(2)}`} />
            <Metric label="Next target" value={`${Math.round(diagnostics.gaze.idle.nextTargetInMs)} ms`} />
            <Metric label="Eye output" value={`${diagnostics.gaze.idle.eyeX.toFixed(2)}, ${diagnostics.gaze.idle.eyeY.toFixed(2)}`} />
            <Metric label="Head output" value={`${diagnostics.gaze.idle.headX.toFixed(2)}, ${diagnostics.gaze.idle.headY.toFixed(2)}`} />
          </dl>
          <div className="button-row">
            <button className="button button-quiet" type="button" onClick={() => runtime.forceNewIdleGazeTarget()}>New idle target</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.resetIdleGaze()}>Reset idle gaze</button>
          </div>
          <label className="check-label"><input type="checkbox" checked={diagnostics.gaze.idle.enabled} onChange={(event) => runtime.setIdleGazeEnabled(event.target.checked)} />Idle gaze</label>
        </div>
      </details>

      <details>
        <summary>Motion sources</summary>
        <div className="quality-controls">
          <div className="warning"><b>Owner-aware leases</b>{diagnostics.motionSources.slice(-30).map((source) => <span key={`${source.slot}:${source.token}`}>{source.slot} · {source.ownerId} · #{source.token} · p{source.priority} · {source.activeParameterCount} params · {Object.entries(source.modeOverrides).map(([name, mode]) => `${name}:${mode}`).join(", ") || "default modes"} · {source.status}</span>)}</div>
          <button className="button button-quiet" type="button" onClick={() => downloadJson("motion-source-diagnostics.json", diagnostics.motionSources)}>Export sources</button>
        </div>
      </details>

      <details>
        <summary>Lifecycle trace</summary>
        <div className="quality-controls">
          <div className="warning"><b>Recent events</b>{diagnostics.lifecycle.slice(-30).map((entry) => <span key={entry.id}>{(entry.at / 1000).toFixed(3)} · {entry.event.type} · {"poseId" in entry.event ? entry.event.poseId ?? "—" : entry.event.interactionId}</span>)}</div>
          <button className="button button-quiet" type="button" onClick={() => downloadJson("lifecycle-trace.json", runtime.getLifecycleHistory())}>Export lifecycle</button>
        </div>
      </details>

      <details>
        <summary>Hair test</summary>
        <div className="quality-controls">
          <div className="mode-grid">
            {([['off', 'Physics OFF'], ['combined', 'Physics ON'], ['wind', 'Wind only'], ['inertia', 'Inertia only']] as const).map(([mode, label]) => <button key={mode} className={`button button-quiet ${diagnostics.hairTestMode === mode ? "is-on" : ""}`} type="button" onClick={() => runtime.setHairTestMode(mode)}>{label}</button>)}
            <button className="button button-quiet" type="button" onClick={() => runtime.impulseHair()}>Impulse</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.resetHairSprings()}>Reset springs</button>
          </div>
          {([['frontHair', 'Front'], ['backHair', 'Back']] as const).map(([group, label]) => {
            const physics = diagnostics.hairPhysics[group]
            const set = (key: keyof HairPhysicsTuning) => (value: number) => runtime.setHairPhysics(group, key, value)
            return <div className="hair-group" key={group}><b>{label} hair</b><div className="parameter-list">
              <HairRange label="amplitude" value={physics.amplitude} min={0} max={2} step={.01} onChange={set("amplitude")} />
              <HairRange label="stiffness" value={physics.stiffness} min={1} max={160} step={1} onChange={set("stiffness")} />
              <HairRange label="damping" value={physics.damping} min={.1} max={30} step={.1} onChange={set("damping")} />
              <HairRange label="wind" value={physics.wind} min={0} max={2} step={.01} onChange={set("wind")} />
              <HairRange label="inertia" value={physics.inertia} min={0} max={2} step={.01} onChange={set("inertia")} />
              <HairRange label="root lock" value={physics.rootLock} min={0} max={.9} step={.01} onChange={set("rootLock")} />
              <HairRange label="max offset" value={physics.maxOffset} min={0} max={60} step={1} onChange={set("maxOffset")} />
            </div></div>
          })}
          <div className="parameter-list"><HairRange label="front softness" value={diagnostics.parameters.fhSoft} min={0} max={1} step={.01} onChange={(value) => runtime.setParameter("fhSoft", value)} /><HairRange label="back softness" value={Math.min(1, diagnostics.parameters.soft)} min={0} max={1} step={.01} onChange={(value) => runtime.setParameter("soft", value)} /></div>
        </div>
      </details>

      <details open>
        <summary>Engine</summary>
        <dl>
          <Metric label="Renderer" value={diagnostics.renderer} />
          <Metric label="Rigger" value={diagnostics.rigger} />
          <Metric label="Commit" value={`${diagnostics.upstreamCommit.slice(0, 9)}…`} />
          <Metric label="Stencil" value={diagnostics.webglStencil ? "enabled" : "disabled"} tone={diagnostics.webglStencil ? "good" : "warn"} />
          <Metric label="FPS" value={diagnostics.fps || "—"} />
        </dl>
      </details>

      <details open>
        <summary>Rig</summary>
        <dl className="metrics-grid">
          <Metric label="PSD canvas" value={diagnostics.psdCanvas} />
          <Metric label="PSD layers" value={diagnostics.psdLayerCount} />
          <Metric label="Rig / meshes" value={`${diagnostics.rigLayerCount} / ${diagnostics.meshCount}`} />
          <Metric label="Textures" value={diagnostics.textureCount} />
          <Metric label="Head / body" value={`${diagnostics.headLayers} / ${diagnostics.bodyLayers}`} />
          <Metric label="Eye layers" value={diagnostics.eyeLayers} />
          <Metric label="Hair layers" value={diagnostics.hairLayers} />
          <Metric label="Hair strands" value={diagnostics.hairStrandCount} />
          <Metric label="Synth eye / mouth" value={`${diagnostics.syntheticEyeClose ? "yes" : "no"} / ${diagnostics.syntheticMouthClose ? "yes" : "no"}`} />
        </dl>
        {!!diagnostics.missingRequiredLayers.length && <div className="warning"><b>Missing</b>{diagnostics.missingRequiredLayers.join(", ")}</div>}
        {!!diagnostics.warnings.length && <div className="warning"><b>Rigger warnings</b>{diagnostics.warnings.map((warning, index) => <span key={`${index}:${warning}`}>{warning}</span>)}</div>}
        {!!diagnostics.qualityFindings.length && <div className="warning"><b>Quality findings</b>{diagnostics.qualityFindings.map((finding) => <span key={finding.code}>{finding.code}: {finding.message}</span>)}</div>}
      </details>

      <details>
        <summary>Anchors</summary>
        <dl>
          <Metric label="Face bounds" value={anchors ? `${anchors.face.x0.toFixed(0)},${anchors.face.y0.toFixed(0)} → ${anchors.face.x1.toFixed(0)},${anchors.face.y1.toFixed(0)}` : "—"} />
          <Metric label="Eye L" value={anchors?.eyeL ? `${anchors.eyeL.icx.toFixed(1)}, ${anchors.eyeL.icy.toFixed(1)}` : "—"} />
          <Metric label="Eye R" value={anchors?.eyeR ? `${anchors.eyeR.icx.toFixed(1)}, ${anchors.eyeR.icy.toFixed(1)}` : "—"} />
          <Metric label="Mouth" value={formatPoint(anchors?.mouth)} />
          <Metric label="Neck pivot" value={formatPoint(anchors?.neckPivot)} />
          <Metric label="Body pivot" value={formatPoint(anchors?.bodyPivot)} />
        </dl>
      </details>

      <details open>
        <summary>Input</summary>
        <dl>
          <Metric label="Pointer model" value={diagnostics.pointerModel ? `${diagnostics.pointerModel.x.toFixed(1)}, ${diagnostics.pointerModel.y.toFixed(1)}` : "—"} />
          <Metric label="Hit area" value={diagnostics.hitArea} />
          <Metric label="Gesture" value={diagnostics.gesture} />
          <Metric label="Interaction" value={diagnostics.interactionState} />
          <Metric label="Pose" value={diagnostics.poseState} />
        </dl>
        <div className="button-row">
          <button className="button button-quiet" type="button" onClick={() => runtime.triggerInteraction("HEAD_TAP")}>Head tap preview</button>
          <button className="button button-quiet" type="button" onClick={() => runtime.triggerInteraction("PET_LOOP")}>Pet preview</button>
          <button className="button button-quiet" type="button" onClick={() => runtime.triggerInteraction("HOLD_LOOP")}>Hold preview</button>
          <button className="button button-quiet" type="button" onClick={() => runtime.triggerInteraction("TORSO_TAP")}>Torso tap preview</button>
          <button className="button button-quiet" type="button" onClick={() => runtime.cancelInteraction("qa-cancel")}>Cancel preview</button>
        </div>
      </details>

      <details>
        <summary>Parameters</summary>
        <div className="parameter-list">
          {PARAMS.map((name) => <label key={name}><span>{name}</span><output>{diagnostics.parameters[name].toFixed(2)}</output><input type="range" min={name.startsWith("eyeOpen") || name === "mouthOpen" ? 0 : -1} max="1" step="0.01" value={diagnostics.parameters[name]} onChange={(event) => runtime.setParameter(name, Number(event.target.value))} /></label>)}
        </div>
        <button className="button button-quiet" type="button" onClick={() => runtime.clearManualParameters()}>Manual reset</button>
      </details>

      <details open>
        <summary>Layered pose</summary>
        <dl className="metrics-grid">
          <Metric label="Pose ID" value={diagnostics.pose.id ?? "—"} />
          <Metric label="Pose PSD" value={diagnostics.pose.psd ?? "—"} />
          <Metric label="Load" value={diagnostics.pose.loadStatus} tone={diagnostics.pose.loadStatus === "ready" ? "good" : diagnostics.pose.loadStatus === "rejected" || diagnostics.pose.loadStatus === "error" ? "warn" : undefined} />
          <Metric label="Registration" value={diagnostics.pose.registrationStatus} tone={diagnostics.pose.registrationStatus === "accepted" ? "good" : diagnostics.pose.registrationStatus === "rejected" ? "warn" : undefined} />
          <Metric label="State" value={diagnostics.pose.state} />
          <Metric label="Progress / mix" value={`${diagnostics.pose.progress.toFixed(3)} / ${diagnostics.pose.mix.toFixed(3)}`} />
          <Metric label="Active pose layers" value={diagnostics.pose.activeLayerCount} />
          <Metric label="Base / pose GPU" value={`${diagnostics.pose.baseGpuResources} / ${diagnostics.pose.poseGpuResources}`} />
          <Metric label="Motion layers" value={diagnostics.pose.motionLayerCount} />
        </dl>
        {diagnostics.pose.registration && <dl>
          <Metric label="Eye distance base / pose" value={`${diagnostics.pose.registration.baseEyeDistance.toFixed(2)} / ${diagnostics.pose.registration.poseEyeDistance.toFixed(2)}`} />
          <Metric label="Scale delta" value={diagnostics.pose.registration.scaleDelta.toFixed(4)} />
          <Metric label="Rotation" value={`${diagnostics.pose.registration.rotationDeg.toFixed(3)}°`} />
          <Metric label="Eye / neck residual" value={`${diagnostics.pose.registration.eyeResidualError.toFixed(2)} / ${diagnostics.pose.registration.neckResidualError.toFixed(2)} px`} />
        </dl>}
        {diagnostics.pose.error && <div className="warning"><b>Pose error</b>{diagnostics.pose.error}</div>}
        {!!diagnostics.pose.warnings.length && <div className="warning"><b>Pose warnings</b>{diagnostics.pose.warnings.map((warning, index) => <span key={`${index}:${warning}`}>{warning}</span>)}</div>}
        <div className="quality-controls">
          <label className="select-label"><span>Pose</span><select data-testid="pose-selector" value={selectedPoseId} onChange={(event) => onSelectPose(event.target.value)} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}><option value="">None / Base</option>{poses.map((pose) => <option key={pose.id} value={pose.id}>{pose.label}</option>)}</select></label>
          <div className="button-row">
            <button className="button button-quiet" type="button" onClick={onLoadPose} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>Load pose</button>
            <button className="button button-quiet" type="button" onClick={onEnterPose} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>Enter</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.exitPose()} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>Exit</button>
            <button className="button button-quiet" type="button" onClick={onTogglePose} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>Toggle</button>
            <button className="button button-quiet" type="button" onClick={() => runtime.resetPose()} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>Reset</button>
          </div>
          <div className="mode-grid">
            {[.25, .5, .75].map((progress) => <button key={progress} className="button button-quiet" type="button" onClick={() => runtime.pausePoseAt(progress)} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>Pause {progress * 100}%</button>)}
            <button className="button button-quiet" type="button" onClick={() => runtime.pausePoseExitAt(.5)} disabled={behaviorDiagnostics.controlMode !== "MANUAL_POSE"}>Pause exit 50%</button>
          </div>
          <div className="button-row">
            <button className="button button-quiet" type="button" onClick={() => downloadJson("current-rig-overrides.json", { physics: diagnostics.hairPhysics })}>Export current overrides</button>
            <button className="button button-quiet" type="button" disabled={!diagnostics.pose.registration} onClick={() => downloadJson("pose-registration.json", diagnostics.pose.registration)}>Export pose registration</button>
          </div>
          <div className="button-row">
            {[...diagnostics.pose.poseReplaceLayers, ...diagnostics.pose.poseAdditiveLayers].map((name) => <button key={name} className="button button-quiet" type="button" onClick={() => runtime.isolateLayer(`pose:${name}`, name)}>Isolate {name}</button>)}
            <button className="button button-quiet" type="button" onClick={() => runtime.clearLayerFilters()}>Clear isolation</button>
          </div>
        </div>
        <div className="warning"><b>Layer graph</b><span>Shared base: {diagnostics.pose.sharedBaseLayers.join(", ") || "—"}</span><span>Base replace: {diagnostics.pose.baseReplaceLayers.join(", ") || "—"}</span><span>Pose replace: {diagnostics.pose.poseReplaceLayers.join(", ") || "—"}</span><span>Pose additive: {diagnostics.pose.poseAdditiveLayers.join(", ") || "—"}</span></div>
      </details>

      <details>
        <summary>PSD input order</summary>
        <ol className="layer-list">{diagnostics.layerNames.map((name, index) => <li key={`${name}-${index}`}><span>{index + 1}</span>{name}</li>)}</ol>
      </details>

      <details>
        <summary>Layer order</summary>
        <ol className="layer-list">{diagnostics.layerOrder.map((name, index) => <li key={`${name}-${index}`}><span>{index + 1}</span>{name}</li>)}</ol>
      </details>

      <details>
        <summary>Layer inspector</summary>
        <LayerInspector diagnostics={diagnostics} runtime={runtime} />
      </details>
    </aside>
  )
}
