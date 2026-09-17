import { useRef, useState } from "react"
import { useT } from "../i18n/useLanguage"
import { PACK_ERRORS, type CharacterEntry } from "../../electron/shared/character-pack-contract"
import { PACK_UPDATE_ERRORS, type PackUpdateAction, type PackUpdateApi, type PackUpdatePhase, type PackUpdateState } from "../../electron/shared/pack-update-contract"

const phases: Record<PackUpdatePhase, string> = {
  "source-required": "출처 확인 필요", idle: "업데이트 확인 가능", checking: "업데이트 확인 중…", latest: "최신 팩 버전", available: "새 팩 버전", skipped: "이번 버전 건너뜀", downloading: "팩 다운로드 중…", verifying: "팩 파일·리깅 검증 중…", ready: "검증 완료 · 적용 대기", applying: "캐릭터 업데이트 적용 중…", applied: "팩 업데이트 적용 완료", "app-required": "호환 앱 업데이트 필요", error: "팩 업데이트 실패",
}
export function PackUpdateCard({ entry, state, api, selected }: { entry: CharacterEntry; state?: PackUpdateState; api: PackUpdateApi; selected: boolean }) {
  const t = useT(), dialog = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false)
  if (!entry.update) return null
  const phase = state?.phase ?? "source-required", working = ["checking", "downloading", "verifying", "applying"].includes(phase)
  const act = async (value: PackUpdateAction) => {
    if (pending && value.action !== "cancel") return
    setError(undefined); setPending(true)
    try { await api.act(value) } catch (e) {
      const raw = e instanceof Error ? e.message : "", code = Object.keys({ ...PACK_ERRORS, ...PACK_UPDATE_ERRORS }).find(k => raw.includes(k))
      setError(code ?? "PACK_UPDATE_NETWORK")
    } finally { setPending(false) }
  }
  const issue = error ?? state?.error
  return <section className="pack-update" aria-label={t("캐릭터팩 업데이트")}>
    <p><strong>{t("팩 버전")}: {entry.version}{state?.version && state.version !== entry.version ? ` → ${state.version}` : ""}</strong></p>
    <p className="pack-update-source">Hugging Face · {entry.update.repoId}<br /><small>{entry.update.manifestPath}</small></p>
    <p role="status">{t(phases[phase])}{state?.bytes ? ` · ${(state.bytes / 1024 ** 2).toFixed(1)} MB` : ""}</p>
    {issue && <p className="pack-error" role="alert">{t(PACK_UPDATE_ERRORS[issue] ?? PACK_ERRORS[issue] ?? "업데이트 서버에 연결하지 못했습니다.")}</p>}
    {phase === "downloading" && <progress max={state?.bytes ?? 1} value={state?.received ?? 0} aria-label={t("팩 다운로드 진행")} />}
    {state?.notes && <details><summary>{t("변경사항")}</summary><p className="pack-update-notes">{state.notes}</p></details>}
    {phase === "source-required" && <p className="fine-print">{t("아래 출처 확인은 이 저장소에 한 번 요청합니다. 자동 확인은 기본으로 꺼져 있습니다.")}</p>}
    <div className="pack-actions">
      {!working && phase !== "ready" && <button className="text-button" disabled={pending} onClick={() => void act({ action: "check", packId: entry.id })}>{t(phase === "source-required" ? "이 출처에서 업데이트 확인" : "업데이트 확인")}</button>}
      {["available", "skipped"].includes(phase) && <button className="button secondary small" disabled={pending} onClick={() => void act({ action: "download", packId: entry.id })}>{t("팩 다운로드")}</button>}
      {phase === "available" && <button className="text-button" disabled={pending} onClick={() => void act({ action: "skip", packId: entry.id })}>{t("이번 버전 건너뛰기")}</button>}
      {phase === "ready" && state?.candidateId && <button className="button primary small" disabled={pending} onClick={() => dialog.current?.showModal()}>{t("업데이트 적용")}</button>}
      {["checking", "downloading", "verifying", "ready"].includes(phase) && <button className="text-button" onClick={() => void act({ action: "cancel", packId: entry.id })}>{t("취소")}</button>}
    </div>
    {phase !== "source-required" && <label className="pack-update-auto"><input type="checkbox" checked={state?.autoCheck ?? false} disabled={pending || phase === "applying"} onChange={event => void act({ action: "auto", packId: entry.id, enabled: event.target.checked })} />{t("이 팩 자동 확인 (다운로드·적용은 직접 선택)")}</label>}
    <dialog ref={dialog} className="plan-dialog pack-dialog" aria-label={t("업데이트 적용")}>
      <h2>{entry.name}</h2><p>{t("팩 버전")}: {entry.version} → {state?.version}</p>
      <p>{t("전체 파일과 동작 데이터 검증을 완료했습니다.")}</p>
      <p>{t(selected ? "선택 중인 외형을 업데이트합니다. 대화가 초기화될 수 있으며 입력 초안은 유지됩니다. 응답 중이면 적용을 보류합니다." : "이 외형팩의 저장 버전만 업데이트합니다. 현재 선택과 대화는 유지됩니다.")}</p>
      <p>{t("이전 정상 버전으로 복원할 수 있습니다.")}</p>
      <div className="dialog-actions"><button className="button secondary" onClick={() => dialog.current?.close()}>{t("취소")}</button><button className="button primary" onClick={() => { dialog.current?.close(); if (state?.candidateId) void act({ action: "apply", candidateId: state.candidateId }) }}>{t("업데이트 적용")}</button></div>
    </dialog>
  </section>
}
