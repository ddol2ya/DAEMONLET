import { useT } from "../i18n/useLanguage"
import { useEffect, useRef, useState } from "react"
import type { HookPlanSummary } from "../../electron/shared/codex-integration-contract"
import { reasonText } from "./labels"

const titles = { install: "Hook 설치 미리보기", repair: "Hook 수리 미리보기", uninstall: "Codex 연동 제거 미리보기", "revert-owned-change": "마지막 앱 변경 되돌리기" }
export function HookPlanPreview({ plan, busy, onClose, onApply }: { plan: HookPlanSummary; busy: boolean; onClose: () => void; onApply: () => void }) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    dialog.current?.showModal()
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const expired = now >= plan.expiresAt
  return <dialog className="plan-dialog" ref={dialog} aria-labelledby="plan-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="dialog-heading"><div><span className="eyebrow">{t("변경 내용 확인")}</span><h2 id="plan-title">{t(titles[plan.action])}</h2></div><button className="icon-button" aria-label={t("미리보기 닫기")} disabled={busy} onClick={onClose}>×</button></div>
    <div className="dialog-body">
      <p>{t("아래 내용을 확인하고 적용해 주세요. 승인은 이 미리보기에만 유효합니다.")}</p>
      <div className="target-summary"><span className="label">{t("변경할 파일")}</span><code>{plan.targetDisplayPath}</code><span className="preservation-note"><strong>{t`다른 도구의 handler ${plan.foreignHandlersPreserved}개 보존`}</strong></span></div>
      {plan.conflicts.length > 0 && <div className="notice warning" role="alert"><strong>{t("지금은 적용할 수 없습니다")}</strong><ul>{plan.conflicts.map((code) => <li key={code}>{t(reasonText(code))}{code.startsWith("AMBIGUOUS_HANDLER:") && <small>{t`위치: ${code.split(":").slice(1).join(" / ")} (0부터 시작)`}</small>}</li>)}</ul></div>}
      {plan.changes.length ? <ul className="change-list">{plan.changes.map((item, index) => <li key={`${item.event}-${index}`}><span className={`change-symbol ${item.operation}`} aria-hidden="true">{item.operation === "remove" ? "−" : "+"}</span><code>{item.event}</code><span>{t(reasonText(item.reasonCode))}</span></li>)}</ul> : <div className="notice neutral">{t("변경할 항목이 없습니다. 파일과 백업을 만들지 않습니다.")}</div>}
      {plan.generatedCommand && <details className="command-disclosure"><summary>{t("이 앱이 생성한 command 확인")}</summary><pre>{plan.generatedCommand}</pre></details>}
      {plan.restoredCommands.length > 0 && <details className="command-disclosure"><summary>{t("복원될 앱 command 확인")}</summary>{plan.restoredCommands.map((command) => <pre key={command}>{command}</pre>)}</details>}
      {plan.warnings.length > 0 && <ul className="preview-notes">{plan.warnings.map((code) => <li key={code}>{t(reasonText(code))}</li>)}</ul>}
      {plan.changed && <p className="fine-print">{t("원본을 보호된 위치에 백업한 뒤 적용합니다. 되돌리기는 앱의 변경만 역적용하며, 이후 변경된 다른 Hook을 보존합니다.")}</p>}
      {expired && <p className="notice warning" role="alert">{t("미리보기가 만료되었습니다. 닫고 새 미리보기를 만들어 주세요.")}</p>}
    </div>
    <div className="dialog-actions"><span className="fine-print">{expired ? t("만료됨") : t`약 ${Math.max(1, Math.ceil((plan.expiresAt - now) / 60000))}분 동안 유효`}</span><button className="button secondary" disabled={busy} onClick={onClose}>{t("닫기")}</button><button className={`button ${plan.action === "uninstall" ? "danger" : "primary"}`} disabled={busy || expired || !plan.canApply || !plan.changed} onClick={onApply}>{busy ? t("적용 중…") : t("변경을 확인했으며 적용")}</button></div>
  </dialog>
}
