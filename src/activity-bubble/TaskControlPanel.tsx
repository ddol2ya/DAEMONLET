import { useEffect, useRef, useState } from "react"
import type { ControlledThread, DictationSnapshot, TaskControlApi, TaskControlError, TaskControlResponse, TaskControlSnapshot } from "../../electron/shared/task-control-contract"

declare global { interface Window { taskControlDesktop?: TaskControlApi } }
const labels = { idle: "후속 질문을 보낼 수 있어요", running: "실행 중 · 추가 지시를 보낼 수 있어요", waiting: "입력 또는 승인을 기다리고 있어요", failed: "실패한 작업 · 후속 질문을 보낼 수 있어요", unknown: "실행 상태를 다시 확인해 주세요" }
const errors: Record<TaskControlError, string> = {
  OPEN_FAILED: "ChatGPT 앱에서 대화를 열지 못했어요.", UNTRUSTED_SENDER: "앱에서 다시 열어 주세요.", INVALID_REQUEST: "입력 내용을 확인해 주세요.", REQUEST_LIMITED: "잠시 후 다시 시도해 주세요.", UNAVAILABLE: "연결을 확인해 주세요.", UNSAFE_SOCKET: "현재 사용자의 Codex 연결 경로를 확인해 주세요.", CONNECT_FAILED: "공유 서버를 시작했는지, 소켓 경로가 맞는지 확인해 주세요.", PROTOCOL_UNSUPPORTED: "연결한 앱이 필요한 기능을 지원하지 않거나 응답하지 않아요.", STALE_TARGET: "작업 상태가 바뀌었어요. 현재 대상을 확인한 뒤 다시 눌러 주세요.", ACTION_FAILED: "요청이 처리되지 않았어요. 원래 대화를 확인해 주세요.", OUTCOME_UNKNOWN: "전송 결과를 확인하지 못했어요. 원래 대화를 먼저 확인해 주세요.", OPERATION_PENDING: "앞선 요청을 처리하고 있어요.",
}
const voiceErrors = { UNAVAILABLE: "이 기기에서는 받아쓰기를 사용할 수 없어요.", PERMISSION_DENIED: "시스템 설정에서 마이크·음성 인식 접근을 허용해 주세요.", ON_DEVICE_UNAVAILABLE: "한국어 기기 내 음성 인식을 사용할 수 없어요.", AUDIO_UNAVAILABLE: "사용 가능한 마이크를 확인해 주세요.", RECOGNITION_FAILED: "음성을 인식하지 못했어요. 다시 시도해 주세요." }
function Mic({ stop = false }: { stop?: boolean }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">{stop ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /> : <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>}</svg>
}

export default function TaskControlPanel({ hidden, collapsed }: { hidden: boolean; collapsed: boolean }) {
  const api = window.taskControlDesktop
  const [snapshot, setSnapshot] = useState<TaskControlSnapshot | null>(null)
  const [path, setPath] = useState("")
  const [manual, setManual] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [composing, setComposing] = useState(false)
  const pressedTarget = useRef<ControlledThread | null | undefined>(undefined)
  const clearPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [notice, setNotice] = useState("")
  const [isError, setIsError] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [voice, setVoice] = useState<DictationSnapshot | null>(null)
  const recording = useRef<{ id: string; key: string; base: string } | null>(null)
  const sendAttempt = useRef<{ key: string; text: string; id: string } | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const selected = snapshot?.threads.find(r => r.key === snapshot.selectedKey)
  const draftKey = selected?.key ?? "unbound"
  const draft = drafts[draftKey] ?? ""
  const voiceActive = Boolean(voice && ["starting", "listening", "stopping"].includes(voice.state))
  const pending = busy || snapshot?.pending
  const receive = (value: TaskControlSnapshot) => setSnapshot(old => old && old.revision > value.revision ? old : value)
  useEffect(() => {
    if (!api) return
    let alive = true
    const unsubscribe = api.onChanged(value => { if (alive) receive(value) })
    void api.getSnapshot().then(result => { if (alive && result.ok) { receive(result.value); setPath(result.value.socketPath); setManual(result.value.source === "shared" && !result.value.autoConnect) } }).catch(() => {})
    const unvoice = api.onDictation(value => {
      if (!alive) return
      const session = recording.current
      if (value.sessionId === null) { recording.current = null; setVoice(null); return }
      if (!session || value.sessionId !== session.id) return
      setVoice(value)
      setDrafts(old => ({ ...old, [session.key]: `${session.base}${session.base && value.text ? " " : ""}${value.text}`.slice(0, 4000) }))
      if (value.error) { setNotice(voiceErrors[value.error]); setIsError(true) }
      if (value.state === "idle" || value.state === "error") { recording.current = null; textarea.current?.focus() }
    })
    return () => { alive = false; unsubscribe(); unvoice(); if (clearPressTimer.current) clearTimeout(clearPressTimer.current); if (recording.current) void api.stopDictation(recording.current.id); recording.current = null }
  }, [api])
  useEffect(() => { if (hidden || collapsed) { setComposing(false); pressedTarget.current = undefined } }, [hidden, collapsed])
  const perform = async <T,>(action: () => Promise<TaskControlResponse<T>>, after?: (value: T) => void, failed?: (code: TaskControlError) => void) => {
    if (busyRef.current || snapshot?.pending) return false
    busyRef.current = true; setBusy(true); setNotice(""); setIsError(false)
    try { const result = await action(); if (result.ok) { after?.(result.value); return true } else { setNotice(errors[result.code]); setIsError(true); failed?.(result.code); return false } }
    catch { setNotice("연결 결과를 확인하지 못했어요. 원래 대화를 확인해 주세요."); setIsError(true); failed?.("OUTCOME_UNKNOWN"); return false }
    finally { busyRef.current = false; setBusy(false) }
  }
  const toggleVoice = () => {
    if (!api) return
    if (recording.current) { void perform(() => api.stopDictation(recording.current!.id)); return }
    const id = crypto.randomUUID()
    recording.current = { id, key: draftKey, base: draft }
    void perform(() => api.startDictation(id)).then(ok => { if (!ok && recording.current?.id === id) { recording.current = null; setVoice(null) } })
  }
  const takeTarget = () => { const target = pressedTarget.current === undefined ? selected : pressedTarget.current; pressedTarget.current = undefined; return target }
  const captureTarget = (node: EventTarget) => { if (node instanceof Element && node.closest('[data-control-action]')) pressedTarget.current = selected ? { ...selected } : null }
  const releaseTarget = () => { if (clearPressTimer.current) clearTimeout(clearPressTimer.current); clearPressTimer.current = setTimeout(() => { pressedTarget.current = undefined; clearPressTimer.current = null }, 0) }
  const stop = () => { const target = takeTarget(); if (api && target?.canStop) void perform(() => api.stop({ key: target.key, revision: target.revision, actionId: crypto.randomUUID() }), value => { receive(value); setNotice("중지를 요청했어요. 실행 상태를 확인하고 있어요.") }) }
  const send = () => {
    const target = takeTarget()
    if (!api || !target?.canSend || target.key !== draftKey || !draft.trim() || voiceActive || composing) return
    if (!sendAttempt.current || sendAttempt.current.key !== draftKey || sendAttempt.current.text !== draft) sendAttempt.current = { key: draftKey, text: draft, id: crypto.randomUUID() }
    const attempt = sendAttempt.current
    void perform(() => api.send({ key: target.key, revision: target.revision, actionId: attempt.id, text: draft }), value => {
      receive(value); setDrafts(old => old[attempt.key] === attempt.text ? { ...old, [attempt.key]: "" } : old)
      sendAttempt.current = null; setNotice("선택한 대화에 전송했어요.")
    }, code => { if (!["OUTCOME_UNKNOWN", "UNAVAILABLE"].includes(code)) sendAttempt.current = null })
  }
  const desktop = snapshot?.source === "desktop"
  const awaitingDesktop = Boolean(desktop && snapshot?.autoConnect && snapshot.connection !== "ready" && (!snapshot.issue || snapshot.issue === "CONNECT_FAILED"))
  const feedback = notice || (voiceActive ? "Apple 음성 인식으로 받아쓰는 중 · 전송 전 수정할 수 있어요." : snapshot?.needsClient ? "승인·질문은 원래 Codex 대화에서 확인해 주세요." : awaitingDesktop ? "Codex 데스크톱이 열리면 자동으로 연결해요." : snapshot?.issue ? errors[snapshot.issue] : desktop && selected && !selected.canSend && selected.canStop ? "실행 중 추가 지시는 원래 대화에서 보내 주세요. 종료 후 후속 질문을 보낼 수 있어요." : selected ? labels[selected.state] : snapshot?.connection === "ready" ? desktop ? "데스크톱의 대화를 선택해 주세요." : "공유 서버의 대화를 선택해 주세요." : "데스크톱 자동 연결을 켜거나 공유 서버에 연결해 주세요.")
  return <main hidden={hidden} className={`task-bubble control-panel ${collapsed ? "compact" : ""}`} aria-label="Codex 작업 제어" onPointerDownCapture={event => captureTarget(event.target)} onPointerUpCapture={releaseTarget} onPointerCancel={releaseTarget} onKeyDownCapture={event => { if (["Enter", " "].includes(event.key)) captureTarget(event.target) }} onKeyUpCapture={releaseTarget} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) releaseTarget() }}>
    <div className="bubble-top">
      <span className={`task-dot ${snapshot?.connection !== "ready" ? "stale" : ""}`} aria-hidden="true" />
      <div className="task-heading"><strong title={collapsed && selected ? selected.title : undefined}>{collapsed && selected ? selected.title : "Codex 제어"}</strong>{!collapsed && <span>{desktop ? snapshot?.connection === "ready" ? "데스크톱 자동 연결됨" : snapshot?.autoConnect ? "데스크톱 연결 대기" : "데스크톱 연결 일시 중지" : snapshot?.connection === "ready" ? "공유 서버 연결됨" : "Codex 연결"}</span>}</div>
      {!collapsed && <button className="icon-button" aria-label="선택한 대화 열기" title="선택한 대화를 ChatGPT에서 열기" disabled={!selected?.canOpenConversation || pending || snapshot?.connection !== "ready"} onClick={() => api && selected && void perform(() => api.openConversation(selected.key), () => setNotice("ChatGPT에 해당 대화 열기를 요청했어요."))}>↗</button>}
      {!collapsed && <button className="icon-button" title="작업 알림으로 돌아가기" aria-label="작업 알림으로 돌아가기" disabled={busy} onClick={() => api && void perform(() => api.setView("activity", false))}>←</button>}
      <button className="icon-button" title={collapsed ? "Codex 제어 펼치기" : "Codex 제어 접기"} aria-label={collapsed ? "Codex 제어 펼치기" : "Codex 제어 접기"} aria-expanded={!collapsed} disabled={busy} onClick={() => api && void perform(() => api.setView("control", !collapsed))}>{collapsed ? "⌄" : "⌃"}</button>
    </div>
    {!collapsed && <>
      {snapshot?.connection !== "ready" ? <div className="control-connect">
        <div className="control-auto-row"><span>Codex 데스크톱</span><button className="control-small" aria-label={snapshot?.autoConnect ? "데스크톱 자동 연결 중지" : "데스크톱 자동 연결"} disabled={busy || !api} onClick={() => api && void perform(() => snapshot?.autoConnect ? api.disconnect() : api.connectDesktop(), receive)}>{snapshot?.autoConnect ? "연결 중지" : "자동 연결"}</button></div>
        <details className="control-manual" open={manual} onToggle={event => setManual(event.currentTarget.open)}><summary>공유 서버 직접 연결</summary>
          <label className="control-label sr-label" htmlFor="control-socket">공유 서버 소켓</label>
          <div className="control-connect-row"><input id="control-socket" value={path} onChange={e => setPath(e.target.value)} placeholder="/tmp/codex-control/server.sock" spellCheck={false} disabled={busy} /><button className="control-small" disabled={busy || !path || !api} onClick={() => api && void perform(() => api.connect(path), receive)}>{busy ? "연결 중" : "연결"}</button></div>
        </details>
      </div> : <div className="control-select-row">
        <label className="control-label sr-label" htmlFor="control-thread">제어할 대화</label>
        <select id="control-thread" aria-label="제어할 대화" value={snapshot.selectedKey ?? ""} disabled={pending || voiceActive} onChange={e => { const key = e.target.value; if (key && api) void perform(() => api.select(key), value => { receive(value); if (!selected && drafts.unbound) setDrafts(old => ({ ...old, [key]: old[key] || old.unbound, unbound: "" })) }) }}>
          <option value="" disabled>{snapshot.threads.length ? "제어할 대화 선택" : "제어할 수 있는 대화가 없어요"}</option>
          {snapshot.threads.map(t => <option key={t.key} value={t.key}>{t.title}{t.project ? ` · ${t.project}` : ""}</option>)}
        </select>
        <button className="icon-button" aria-label="작업 새로고침" title="새로고침" disabled={pending} onClick={() => api && void perform(() => api.refresh(), receive)}>↻</button>
        <button className="icon-button" aria-label="Codex 연결 해제" title="연결 해제 · 자동 연결 일시 중지" disabled={pending} onClick={() => api && void perform(() => api.disconnect(), receive)}>×</button>
      </div>}
      <p className={`control-feedback ${isError || snapshot?.issue && !awaitingDesktop ? "task-error" : ""}`} role={isError ? "alert" : "status"} title={feedback}>{feedback}</p>
      <textarea ref={textarea} aria-label="후속 질문" placeholder="후속 질문을 입력하거나 마이크를 눌러 말해 보세요" value={draft} maxLength={4000} disabled={voiceActive || pending} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onChange={e => { setDrafts(old => ({ ...old, [draftKey]: e.target.value })); sendAttempt.current = null }} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
      <div className="control-actions">
        <button className={`voice-button ${voiceActive ? "recording" : ""}`} aria-label={voiceActive ? "받아쓰기 중지" : "음성 받아쓰기"} title={voiceActive ? "받아쓰기 중지" : "음성 받아쓰기"} aria-pressed={voiceActive} disabled={busy || !api || voice?.state === "stopping"} onClick={toggleVoice}><Mic stop={voiceActive} /><span>{voice?.state === "starting" ? "준비 중" : voice?.state === "stopping" ? "정리 중" : voiceActive ? "듣는 중" : "받아쓰기"}</span></button>
        <div className="control-send-actions"><button className="control-stop" aria-label="선택한 작업 실행 중지" title="선택한 작업 실행 중지" disabled={!selected?.canStop || pending} data-control-action="stop" onClick={stop}><Mic stop /></button><button className="task-action" data-control-action="send" disabled={composing || !selected?.canSend || !draft.trim() || voiceActive || pending} onClick={send}>전송 <span aria-hidden="true">↑</span></button></div>
      </div>
    </>}
  </main>
}
