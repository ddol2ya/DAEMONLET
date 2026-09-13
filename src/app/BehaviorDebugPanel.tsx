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
    <summary>Character behavior</summary>
    <div className="quality-controls behavior-controls">
      <div className="mode-grid">
        <button className={`button button-quiet ${diagnostics.controlMode === "AUTO_BEHAVIOR" ? "is-on" : ""}`} type="button" onClick={() => controller.setControlMode("AUTO_BEHAVIOR")}>Auto behavior</button>
        <button className={`button button-quiet ${diagnostics.controlMode === "MANUAL_POSE" ? "is-on" : ""}`} type="button" onClick={() => controller.setControlMode("MANUAL_POSE")}>Manual pose</button>
      </div>
      <dl className="metrics-grid">
        <Metric label="Control mode" value={diagnostics.controlMode} />
        <Metric label="Semantic state" value={semantic.state} tone={semantic.state === "BUSY" ? "warn" : "good"} />
        <Metric label="Previous state" value={semantic.previousState ?? "—"} />
        <Metric label="State since" value={`${Math.round(semantic.stateSince)} ms`} />
        <Metric label="Idle elapsed" value={`${Math.round(diagnostics.idleElapsedMs)} ms`} />
        <Metric label="Active task IDs" value={semantic.activeTaskIds.join(", ") || "—"} />
        <Metric label="Waiting task IDs" value={semantic.waitingTaskIds.join(", ") || "—"} />
        <Metric label="Connection" value={diagnostics.connected ? "Connected" : "Disconnected"} />
        <Metric label="Short reaction" value={diagnostics.currentReaction ?? "—"} />
        <Metric label="Last outcome" value={semantic.lastOutcome?.kind ?? "—"} />
        <Metric label="Completion confidence" value={semantic.lastOutcome?.kind === "completed" ? semantic.lastOutcome.confidence ?? "unspecified" : "—"} />
        <Metric label="Last event" value={eventLabel(semantic.lastEvent)} />
        <Metric label="Last stale event" value={eventLabel(semantic.lastStaleEvent)} />
        <Metric label="Stale events" value={semantic.staleEventCount} />
        <Metric label="Transition" value={semantic.transitionReason} />
        <Metric label="Bored action" value={diagnostics.currentBoredAction ?? "—"} />
        <Metric label="Desired pose" value={diagnostics.desiredPoseId ?? "Base"} />
        <Metric label="Loaded / active" value={`${diagnostics.loadedPoseId ?? "—"} / ${diagnostics.activePoseId ?? "—"}`} />
        <Metric label="Pose load" value={diagnostics.poseLoadStatus} tone={diagnostics.poseLoadStatus === "fallback" ? "warn" : undefined} />
      </dl>
      <label className="select-label"><span>Mock task ID</span><input value={taskId} onChange={(event) => setTaskId(event.target.value)} /></label>
      <label className="behavior-progress"><span>Progress</span><output>{Math.round(progress * 100)}%</output><input type="range" min="0" max="1" step="0.05" value={progress} onChange={(event) => setProgress(Number(event.target.value))} /></label>
      <div className="button-row behavior-buttons">
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_STARTED")}>Task Start</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_PROGRESS")}>Task Progress</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_WAITING")}>Task Waiting</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_RESUMED")}>Task Resume</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_COMPLETED")}>Task Complete</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_FAILED")}>Task Fail</button>
        <button className="button button-quiet" type="button" onClick={() => sendTask("TASK_CANCELLED")}>Task Cancel</button>
        <button className="button button-quiet" type="button" onClick={() => source.dispatch({ type: "USER_ACTIVITY", source: "debug" })}>User Activity</button>
        <button className="button button-quiet" type="button" onClick={() => controller.simulateIdleThreshold()}>Simulate Idle Threshold</button>
        <button className="button button-quiet" type="button" onClick={() => source.dispatch({ type: "RESET" })}>Reset</button>
        <button className="button button-quiet" type="button" onClick={() => source.dispatch({ type: "CONNECTION_CHANGED", connected: false })}>Simulate Disconnect</button>
        <button className="button button-quiet" type="button" onClick={() => source.dispatch({ type: "CONNECTION_CHANGED", connected: true })}>Simulate Reconnect</button>
        <button className="button button-quiet" type="button" onClick={download}>Download behavior JSON</button>
      </div>
      {diagnostics.warning && <div className="warning"><b>Behavior fallback</b>{diagnostics.warning}</div>}
      {!!diagnostics.manifestWarnings.length && <div className="warning"><b>Behavior warnings</b>{diagnostics.manifestWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
    </div>
  </details>
}
