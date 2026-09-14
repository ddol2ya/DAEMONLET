import { useT } from "../i18n/useLanguage"
import { useEffect, useState } from "react"
import type { CharacterDialogueController } from "../dialogue/CharacterDialogueController"
import type { CharacterBehaviorController } from "../behavior/CharacterBehaviorController"
import { DIALOGUE_TRIGGER_IDS, type DialogueTriggerId } from "../dialogue/types"

const labels: Record<DialogueTriggerId, string> = {
  "run.started": "Run 시작", "run.completed.observed": "관찰된 Run 완료", "run.completed.authoritative": "확정된 Run 완료",
  "run.failed": "Run 실패", "run.cancelled.user": "사용자 중단",
  "task.started.command": "명령", "task.started.file-change": "파일 변경", "task.started.tool": "도구", "task.started.web-search": "웹 검색", "task.started.subtask": "하위 작업", "task.started.review": "검토", "task.started.other": "기타 작업",
  "state.bored": "심심함", "behavior.bored-look-away": "심심해서 시선 돌리기", "behavior.bored-sigh": "심심해서 한숨",
  "interaction.head-tap": "머리 누르기", "interaction.face-hold": "얼굴 길게 누르기", "interaction.pet": "쓰다듬기", "interaction.torso-tap": "몸통 누르기",
  "state.normal": "일반", "state.waiting": "대기", "state.disconnected": "연결 끊김",
}

export function DialogueDebugPanel({ controller, behavior }: { controller: CharacterDialogueController; behavior: CharacterBehaviorController }) {
  const t = useT()
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
    <summary>{t("대사")}</summary>
    <div className="quality-controls">
      <dl className="metrics-grid">
        {Object.entries({ "캐릭터": snapshot.characterId ?? "—", "활성화": String(snapshot.enabled), "트리거": snapshot.triggerId ?? "—", "문장": snapshot.text ?? "—", "우선순위": snapshot.priority ?? "—", "숨김까지": snapshot.hideAt === null ? "—" : `${Math.max(0, Math.round(snapshot.hideAt - performance.now()))} ms`, "대기열": snapshot.queueLength, "억제됨": snapshot.suppressedCount, "결정": snapshot.lastDecision ?? "—" }).map(([label, value]) => <div className="metric" key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}
      </dl>
      <div className="button-row behavior-buttons">
        {DIALOGUE_TRIGGER_IDS.map((trigger) => <button key={trigger} className="button button-quiet" type="button" onClick={() => controller.triggerDebug(trigger)}>{t(labels[trigger])}</button>)}
        <button className="button button-quiet" type="button" onClick={internalCancel}>{t("내부 복구 취소")}</button>
        <button className="button button-quiet" type="button" onClick={() => controller.clear()}>{t("대사 지우기")}</button>
      </div>
      {!!snapshot.warnings.length && <div className="warning">{snapshot.warnings.join(" ")}</div>}
      <details><summary>{t("최근 대사 선택 내역")}</summary><ol className="dialogue-history">{snapshot.history.slice(-12).reverse().map((entry, index) => <li key={index}>{entry.triggerId ?? "—"} · {entry.decision}{entry.text ? ` · ${entry.text}` : ""}</li>)}</ol></details>
    </div>
  </details>
}
