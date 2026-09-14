import { useEffect, useRef, useState } from "react"
import { PACK_ERRORS, type CharacterEntry, type CharacterSnapshot, type ImportPreview, type PackProgress } from "../../electron/shared/character-pack-contract"
import type { SettingsPageProps } from "./SettingsApp"

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
export function CharacterPacks({ api, run, busy, selected }: Pick<SettingsPageProps, "api" | "run" | "busy"> & { selected: string }) {
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
    <div className="pack-toolbar"><h2>캐릭터</h2><button ref={trigger} className="button secondary small" disabled={Boolean(busy)} onClick={() => void choose()}>＋ 캐릭터 추가</button></div>
    {snapshot?.warning && <div className="notice warning" role="status">{snapshot.warning}</div>}
    {installed && <div className="notice success pack-progress" role="status"><span><strong>{installed.name}</strong> {installed.version} 버전이 준비됐어요.</span><button className="button primary small" disabled={Boolean(busy)} onClick={() => apply(installed)}>지금 적용</button></div>}
    <div className="pack-list" role="radiogroup" aria-label="캐릭터 선택">{snapshot?.entries.map(entry => <article className={`pack-card${selected === entry.id ? " selected" : ""}`} key={entry.id}>
      <label className="pack-choice"><input type="radio" name="character" value={entry.id} checked={selected === entry.id} disabled={Boolean(busy) || entry.status === "disabled"} onChange={() => apply(entry)} aria-label={entry.name} />
        {entry.thumbnailUrl ? <img className="pack-thumbnail" src={entry.thumbnailUrl} alt="" width="48" height="56" /> : <span className={`pack-thumbnail pack-initial character-${entry.id}`} aria-hidden="true">{Array.from(entry.name)[0]}</span>}
        <span className="pack-title"><strong>{entry.name}</strong><small>{entry.source === "builtin" ? "기본 제공" : `v${entry.version} · ${entry.poseCount}포즈`}</small></span><span className="selection-mark" aria-hidden="true">{selected === entry.id ? "✓" : "○"}</span>
      </label>
      {entry.source === "external" && <div className="pack-details"><small className="pack-id">{entry.id} · {size(entry.bytes)}</small>{entry.status === "disabled" && <p className="pack-error">{PACK_ERRORS[entry.error ?? ""] ?? "사용할 수 없는 팩입니다."}</p>}{entry.profile === "trial" && <p>시험용 {entry.poseCount}포즈{entry.unsupportedReactions?.length ? ` · 미지원: ${entry.unsupportedReactions.join(", ")}` : ""}</p>}<div className="pack-actions">
        <button className="text-button" disabled={Boolean(busy)} onClick={() => void choose()}>수정본 가져오기</button>
        {entry.previousVersion && <button className="text-button" disabled={Boolean(busy)} onClick={() => void run("이전 버전 복원", () => api.characters.rollback({ id: entry.id, revision: entry.revision }))}>이전 버전 복원</button>}
        <button className="text-button danger-text" disabled={Boolean(busy)} onClick={() => void run("캐릭터 제거", () => api.characters.remove({ id: entry.id, revision: entry.revision }))}>제거</button>
      </div></div>}
    </article>)}</div>
    {!snapshot && <p role="status">캐릭터 목록 불러오는 중…</p>}
    {snapshot && <p className="pack-storage">외부 캐릭터 저장량 <strong>{size(snapshot.storageBytes)}</strong> / {size(snapshot.storageLimitBytes)}</p>}
    <dialog ref={loadingDialog} className="plan-dialog loading-dialog" aria-labelledby="pack-loading-title" aria-busy={loading} onCancel={event => { event.preventDefault(); if (choosing) void cancel() }}>
      <span className="loading-spinner" aria-hidden="true" />
      <h2 id="pack-loading-title">{choosing ? "캐릭터 가져오는 중" : "캐릭터 준비 중"}</h2>
      <p role="status" aria-live="polite">{!progress ? choosing ? "파일을 선택하면 검사를 시작합니다." : "캐릭터를 화면에 준비하고 있어요." : progress.phase === "extract" ? "압축을 풀고 있어요." : progress.phase === "files" ? "캐릭터 파일을 확인하고 있어요." : `캐릭터 동작 확인 중 · ${progress.completed} / ${progress.total}`}</p>
      {progress && progress.total > 0 && <progress max={progress.total} value={progress.completed} aria-label={progress.phase === "rig" ? "동작 검사 진행" : "파일 검사 진행"} />}
      <p className="fine-print">포즈가 많은 캐릭터는 시간이 더 걸릴 수 있어요.</p>
      {choosing && <button className="button secondary" onClick={() => void cancel()}>가져오기 취소</button>}
    </dialog>
    <dialog ref={dialog} className="plan-dialog pack-dialog" aria-labelledby="pack-preview-title" onCancel={event => { event.preventDefault(); if (!busy) void cancel() }}>
      {preview && <><div className="dialog-heading"><div><span className="eyebrow">CHARACTER PACK</span><h2 id="pack-preview-title">{preview.kind === "installed" ? "이미 설치된 캐릭터" : preview.kind === "update" ? "캐릭터 업데이트" : "새 캐릭터 추가"}</h2></div></div>
        <div className="dialog-body"><h3>{preview.entry.name}</h3><dl className="diagnostic-list">
          <div><dt>제작자 (직접 기재)</dt><dd>{preview.entry.author ?? "기재되지 않음"}</dd></div>
          <div><dt>버전</dt><dd>{preview.previousVersion && preview.kind === "update" ? `${preview.previousVersion} → ` : ""}{preview.entry.version}</dd></div>
          <div><dt>포즈</dt><dd>{preview.entry.poseCount}개{preview.entry.profile === "trial" ? " · 시험용" : ""}</dd></div>
          <div><dt>설치 크기</dt><dd>{size(preview.entry.bytes)}</dd></div>
          <div><dt>호환성</dt><dd>현재 앱에서 사용 가능</dd></div>
        </dl>{preview.entry.unsupportedReactions?.length ? <p className="fine-print">미지원 반응: {preview.entry.unsupportedReactions.join(", ")}</p> : null}
        <p className="fine-print">{preview.kind === "update" ? "선택 중인 캐릭터는 새 버전으로 바뀝니다. 이전 정상 버전으로 복원할 수 있어요." : "설치 후 ‘지금 적용’을 누르면 캐릭터가 바뀝니다."}</p></div>
        <div className="dialog-actions"><span /><button className="button secondary" autoFocus disabled={Boolean(busy)} onClick={() => void cancel()}>취소</button><button className="button primary" disabled={Boolean(busy)} onClick={() => void commit()}>{busy ? "설치 중…" : preview.kind === "installed" ? "확인" : preview.kind === "update" ? "업데이트 설치" : "설치"}</button></div></>}
    </dialog>
  </div>
}
