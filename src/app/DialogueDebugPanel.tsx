import { useEffect, useState } from "react"
import type { CharacterDialogueController } from "../dialogue/CharacterDialogueController"
import type { CharacterBehaviorController } from "../behavior/CharacterBehaviorController"
import { DIALOGUE_TRIGGER_IDS, type DialogueTriggerId } from "../dialogue/types"

const labels: Record<DialogueTriggerId, string> = {
  "run.started": "Run started", "run.completed.observed": "Run completed observed", "run.completed.authoritative": "Run completed authoritative",
  "run.failed": "Run failed", "run.cancelled.user": "User interrupted",
  "task.started.command": "Command", "task.started.file-change": "File change", "task.started.tool": "Tool", "task.started.web-search": "Web search", "task.started.subtask": "Subtask", "task.started.review": "Review", "task.started.other": "Other task",
  "state.bored": "Bored", "behavior.bored-look-away": "Bored look-away", "behavior.bored-sigh": "Bored sigh",
  "interaction.head-tap": "Head tap", "interaction.face-hold": "Face hold", "interaction.pet": "Pet", "interaction.torso-tap": "Torso tap",
  "state.normal": "Normal", "state.waiting": "Waiting", "state.disconnected": "Disconnected",
}

export function DialogueDebugPanel({ controller, behavior }: { controller: CharacterDialogueController; behavior: CharacterBehaviorController }) {
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot())
  useEffect(() => {
    setSnapshot(controller.getSnapshot())
    return controller.subscribe(() => setSnapshot(controller.getSnapshot()))
  }, [controller])
  const internalCancel = () => {
    controller.clear()
    controller.handleLifecycle({ type: "run.cancelled", runId: "dialogue-debug", reason: "recovery-not-confirmed", at: performance.now() }, behavior.machine.getSnapshot())
  }
  return <details open data-testid="dialogue-debug-panel">
    <summary>Dialogue</summary>
    <div className="quality-controls">
      <dl className="metrics-grid">
        {Object.entries({ Character: snapshot.characterId ?? "—", Enabled: String(snapshot.enabled), Trigger: snapshot.triggerId ?? "—", Text: snapshot.text ?? "—", Priority: snapshot.priority ?? "—", "Hide in": snapshot.hideAt === null ? "—" : `${Math.max(0, Math.round(snapshot.hideAt - performance.now()))} ms`, Queue: snapshot.queueLength, Suppressed: snapshot.suppressedCount, Decision: snapshot.lastDecision ?? "—" }).map(([label, value]) => <div className="metric" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <div className="button-row behavior-buttons">
        {DIALOGUE_TRIGGER_IDS.map((trigger) => <button key={trigger} className="button button-quiet" type="button" onClick={() => controller.triggerDebug(trigger)}>{labels[trigger]}</button>)}
        <button className="button button-quiet" type="button" onClick={internalCancel}>Internal recovery cancel</button>
        <button className="button button-quiet" type="button" onClick={() => controller.clear()}>Clear dialogue</button>
      </div>
      {!!snapshot.warnings.length && <div className="warning">{snapshot.warnings.join(" ")}</div>}
      <details><summary>Recent dialogue decisions</summary><ol className="dialogue-history">{snapshot.history.slice(-12).reverse().map((entry, index) => <li key={index}>{entry.triggerId ?? "—"} · {entry.decision}{entry.text ? ` · ${entry.text}` : ""}</li>)}</ol></details>
    </div>
  </details>
}
