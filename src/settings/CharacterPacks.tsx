import { PackUpdateCard } from "./PackUpdateCard"
import type { PackUpdateState } from "../../electron/shared/pack-update-contract"
import { useT } from "../i18n/useLanguage"
import { useEffect, useRef, useState } from "react"
import { PACK_ERRORS, type CharacterEntry, type CharacterSnapshot, type ImportPreview, type PackProgress } from "../../electron/shared/character-pack-contract"
import type { SettingsPageProps } from "./SettingsApp"

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
export function CharacterPacks({ api, run, busy, selected }: Pick<SettingsPageProps, "api" | "run" | "busy"> & { selected: string }) {
  const t = useT()
  const [updates, setUpdates] = useState<PackUpdateState[]>([])
  const [checkingAll, setCheckingAll] = useState(false)
  useEffect(() => {
    let live = true
    const receive = (value: PackUpdateState[]) => { if (live) setUpdates(value) }
    const off = api.packUpdates.onChanged(receive)
    void api.packUpdates.list().then(receive).catch(() => {})
    return () => { live = false; off() }
  }, [api])
  const checkAll = async () => {
    setCheckingAll(true)
    try { for (const state of updates) await api.packUpdates.act({ action: "check", packId: state.packId }).catch(() => {}) }
    finally { setCheckingAll(false) }
  }
  const [snapshot, setSnapshot] = useState<CharacterSnapshot | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [installed, setInstalled] = useState<CharacterEntry | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [progress, setProgress] = useState<PackProgress | null>(null)
  const loadingDialog = useRef<HTMLDialogElement>(null)
  const loading = choosing && progress !== null || busy === "캐릭터 적용" || busy === "이전 버전 복원"
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let active = true
    const receive = (s: CharacterSnapshot) => { if (active) setSnapshot(previous => !previous || s.generation >= previous.generation ? s : previous) }
    const unsubscribe = api.characters.onChanged(receive)
    const unsubscribeProgress = api.characters.onProgress(value => { if (active) setProgress(value) })
    void run("캐릭터 목록 확인", () => api.characters.list().then(receive))
    return () => { active = false; unsubscribe(); unsubscribeProgress(); void api.characters.cancelImport().catch(() => {}) }
  }, [api])
  useEffect(() => {
    if (preview && !dialog.current?.open) dialog.current?.showModal()
    if (!preview && dialog.current?.open) { dialog.current.close(); trigger.current?.focus() }
  }, [preview])
  useEffect(() => {
    if (loading && !loadingDialog.current?.open) loadingDialog.current?.showModal()
    if (!loading && loadingDialog.current?.open) { loadingDialog.current.close(); trigger.current?.focus() }
  }, [loading])
  const choose = async () => {
    setProgress(null); setChoosing(true); setInstalled(null)
    try { const result = await run("캐릭터 팩 검증", () => api.characters.chooseImport()); if (result) setPreview(result) }
    finally { setChoosing(false) }
  }
  const cancel = async () => { await api.characters.cancelImport(); setPreview(null) }
  const apply = (entry: CharacterEntry) => { setProgress(null); return void run("캐릭터 적용", () => api.characters.select({ id: entry.id, revision: entry.revision })) }
  const commit = async () => {
    if (!preview) return
    const result = await run("캐릭터 팩 설치", () => api.characters.commitImport(preview.token))
    if (result) { setInstalled(result); setPreview(null) }
  }
  return <div className="character-packs">
    <div className="pack-toolbar"><h2>{t("캐릭터")}</h2><button ref={trigger} className="button secondary small" disabled={Boolean(busy)} onClick={() => void choose()}>{t("＋ 캐릭터 추가")}</button></div>
    {updates.length > 0 && <button className="text-button" disabled={checkingAll} onClick={() => void checkAll()}>{t(checkingAll ? "업데이트 확인 중…" : "표시된 HF 출처에서 모든 팩 확인")}</button>}
    {snapshot?.warning && <div className="notice warning" role="status">{t(snapshot.warning)}</div>}
    {installed && <div className="notice success pack-progress" role="status"><span>{t`${installed.name} ${installed.version} 버전이 준비됐어요.`}</span><button className="button primary small" disabled={Boolean(busy)} onClick={() => apply(installed)}>{t("지금 적용")}</button></div>}
    <div className="pack-list" role="radiogroup" aria-label={t("캐릭터 선택")}>{snapshot?.entries.map(entry => <article className={`pack-card${selected === entry.id ? " selected" : ""}`} key={entry.id}>
      <label className="pack-choice"><input type="radio" name="character" value={entry.id} checked={selected === entry.id} disabled={Boolean(busy) || entry.status === "disabled"} onChange={() => apply(entry)} aria-label={entry.name} />
        {entry.thumbnailUrl ? <img className="pack-thumbnail" src={entry.thumbnailUrl} alt="" width="48" height="56" /> : <span className={`pack-thumbnail pack-initial character-${entry.id}`} aria-hidden="true">{Array.from(entry.name)[0]}</span>}
        <span className="pack-title"><strong>{entry.name}</strong><small>{entry.source === "builtin" ? t("기본 제공") : t`v${entry.version} · ${entry.poseCount}포즈`}</small></span><span className="selection-mark" aria-hidden="true">{selected === entry.id ? "✓" : "○"}</span>
      </label>
      {entry.source === "external" && <div className="pack-details"><small className="pack-id">{entry.id} · {size(entry.bytes)}</small>{entry.status === "disabled" && <p className="pack-error">{t(PACK_ERRORS[entry.error ?? ""] ?? "사용할 수 없는 팩입니다.")}</p>}{entry.profile === "trial" && <p>{t`시험용 ${entry.poseCount}포즈`}{entry.unsupportedReactions?.length ? t` · 미지원: ${entry.unsupportedReactions.join(", ")}` : ""}</p>}<div className="pack-actions">
        <button className="text-button" disabled={Boolean(busy)} onClick={() => void choose()}>{t("수정본 가져오기")}</button>
        {entry.previousVersion && <button className="text-button" disabled={Boolean(busy)} onClick={() => void run("이전 버전 복원", () => api.characters.rollback({ id: entry.id, revision: entry.revision }))}>{t("이전 버전 복원")}</button>}
        <button className="text-button danger-text" disabled={Boolean(busy)} onClick={() => void run("캐릭터 제거", () => api.characters.remove({ id: entry.id, revision: entry.revision }))}>{t("제거")}</button>
      </div>{entry.update ? <PackUpdateCard entry={entry} state={updates.find(u => u.packId === entry.id)} api={api.packUpdates} selected={selected === entry.id} /> : <p className="fine-print">{t("온라인 업데이트를 사용하려면 출처가 포함된 같은 외형의 팩을 한 번 가져오세요.")}</p>}</div>}
    </article>)}</div>
    {!snapshot && <p role="status">{t("캐릭터 목록 불러오는 중…")}</p>}
    {snapshot && <p className="pack-storage">{t("외부 캐릭터 저장량 ")}<strong>{size(snapshot.storageBytes)}</strong> / {size(snapshot.storageLimitBytes)}</p>}
    <dialog ref={loadingDialog} className="plan-dialog loading-dialog" aria-labelledby="pack-loading-title" aria-busy={loading} onCancel={event => { event.preventDefault(); if (choosing) void cancel() }}>
      <span className="loading-spinner" aria-hidden="true" />
      <h2 id="pack-loading-title">{choosing ? t("캐릭터 가져오는 중") : t("캐릭터 준비 중")}</h2>
      <p role="status" aria-live="polite">{!progress ? choosing ? t("파일을 선택하면 검사를 시작합니다.") : t("캐릭터를 화면에 준비하고 있어요.") : progress.phase === "extract" ? t("압축을 풀고 있어요.") : progress.phase === "files" ? t("캐릭터 파일을 확인하고 있어요.") : t`캐릭터 동작 확인 중 · ${progress.completed} / ${progress.total}`}</p>
      {progress && progress.total > 0 && <progress max={progress.total} value={progress.completed} aria-label={progress.phase === "rig" ? t("동작 검사 진행") : t("파일 검사 진행")} />}
      <p className="fine-print">{t("포즈가 많은 캐릭터는 시간이 더 걸릴 수 있어요.")}</p>
      {choosing && <button className="button secondary" onClick={() => void cancel()}>{t("가져오기 취소")}</button>}
    </dialog>
    <dialog ref={dialog} className="plan-dialog pack-dialog" aria-labelledby="pack-preview-title" onCancel={event => { event.preventDefault(); if (!busy) void cancel() }}>
      {preview && <><div className="dialog-heading"><div><span className="eyebrow">{t("캐릭터 팩")}</span><h2 id="pack-preview-title">{preview.kind === "installed" ? t("이미 설치된 캐릭터") : preview.kind === "update" ? t("캐릭터 업데이트") : t("새 캐릭터 추가")}</h2></div></div>
        <div className="dialog-body"><h3>{preview.entry.name}</h3><dl className="diagnostic-list">
          <div><dt>{t("제작자 (직접 기재)")}</dt><dd>{preview.entry.author ?? t("기재되지 않음")}</dd></div>
          <div><dt>{t("버전")}</dt><dd>{preview.previousVersion && preview.kind === "update" ? `${preview.previousVersion} → ` : ""}{preview.entry.version}</dd></div>
          <div><dt>{t("포즈")}</dt><dd>{preview.entry.poseCount}{preview.entry.profile === "trial" ? t(" · 시험용") : ""}</dd></div>
          <div><dt>{t("설치 크기")}</dt><dd>{size(preview.entry.bytes)}</dd></div>
          <div><dt>{t("호환성")}</dt><dd>{t("현재 앱에서 사용 가능")}</dd></div>
        </dl>{preview.entry.unsupportedReactions?.length ? <p className="fine-print">{t("미지원 반응: ")}{preview.entry.unsupportedReactions.join(", ")}</p> : null}
        <p className="fine-print">{preview.kind === "update" ? t("선택 중인 캐릭터는 새 버전으로 바뀝니다. 이전 정상 버전으로 복원할 수 있어요.") : t("설치 후 ‘지금 적용’을 누르면 캐릭터가 바뀝니다.")}</p></div>
        <div className="dialog-actions"><span /><button className="button secondary" autoFocus disabled={Boolean(busy)} onClick={() => void cancel()}>{t("취소")}</button><button className="button primary" disabled={Boolean(busy)} onClick={() => void commit()}>{busy ? t("설치 중…") : preview.kind === "installed" ? t("확인") : preview.kind === "update" ? t("업데이트 설치") : t("설치")}</button></div></>}
    </dialog>
  </div>
}
