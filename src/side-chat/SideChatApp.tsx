import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ChatSubmission, ChatAction, ChatError, SideChatApi, SideChatSnapshot } from "../../electron/shared/side-chat-contract"
import { validChatInput } from "../../electron/shared/side-chat-contract"
import { requiresPanel, isComposing } from "./presentation"

declare global { interface Window { daemonletSideChat: SideChatApi } }
const labels = {
  ko: { chat: "사이드 대화", parent: "연결할 대화", empty: "대화를 하나 선택해 주세요.", input: "캐릭터에게 말하기 — 메인 작업에는 보내지 않음", send: "보내기", stop: "응답 중지", reset: "새 대화", expand: "전체 답변 보기", compact: "접기", close: "숨기기", answering: "답변 중", preparing: "대화 준비 중", ready: "무엇을 이야기할까요?", full: "긴 답변이 도착했습니다. 전체 답변을 확인해 주세요.", context: "맥락 기준", checked: "작업 상태 확인", none: "첫 전송 시 확인", copy: "복사", applying: "캐릭터 적용 중", notice: "새 대화로 전환되었습니다. 작성 중인 입력은 보존했습니다.", policy: "검증된 대화 전용 Codex 런타임이 필요합니다. 현재 런타임에서는 전송이 차단됩니다.", privacy: "부모 대화 맥락을 Codex에 전달하며 사용량이 발생합니다. 대화는 앱 메모리에만 보관합니다.", connection: "연결된 대화", limit: "입력은 4,000자 / 16,000바이트까지 가능합니다." },
  en: { chat: "Side conversation", parent: "Connect a conversation", empty: "Choose a conversation.", input: "Talk to the character — never sent to the main task", send: "Send", stop: "Stop response", reset: "New conversation", expand: "View full answer", compact: "Collapse", close: "Hide", answering: "Answering", preparing: "Preparing conversation", ready: "What would you like to talk about?", full: "A longer answer is ready. Open it to read the full response.", context: "Context as of", checked: "Task status checked", none: "Checked on first send", copy: "Copy", applying: "Applying character", notice: "Switched to a new conversation. Your draft was kept.", policy: "A verified chat-only Codex runtime is required. Sending is blocked on this runtime.", privacy: "Parent context is sent to Codex and uses your allowance. Chat is kept only in app memory.", connection: "Connected conversation", limit: "Input is limited to 4,000 characters / 16,000 bytes." },
}
const errors: Record<ChatError, [string, string]> = {
  CHAT_DISABLED: ["설정에서 실험 기능을 켜 주세요.", "Enable the experiment in Settings."], CHAT_POLICY_UNENFORCEABLE: [labels.ko.policy, labels.en.policy], NO_PARENT: [labels.ko.empty, labels.en.empty], BUSY: ["현재 응답이나 캐릭터 적용이 끝난 뒤 전송해 주세요.", "Wait for the response or character change."], STALE_REQUEST: ["대화가 변경되었습니다. 현재 내용을 확인해 주세요.", "The conversation changed. Review it before sending."], INVALID_REQUEST: ["요청 형식이 올바르지 않습니다.", "Invalid request."], INPUT_LIMIT: [labels.ko.limit, labels.en.limit], HISTORY_LIMIT: ["대화 보관 한도입니다. 새 대화를 시작해 주세요.", "History limit reached. Start a new conversation."], RESPONSE_INVALID: ["응답 형식을 확인할 수 없습니다. 자동으로 다시 요청하지 않았습니다.", "Invalid response format. No automatic retry was made."], REFUSED: ["이 요청에 대한 응답이 거절되었습니다.", "The request was refused."], STOPPED: ["응답을 중지했습니다.", "Response stopped."], SESSION_LOST: ["세션을 잃었습니다. 새 대화를 시작해 주세요.", "Session lost. Start a new conversation."], OUTCOME_UNKNOWN: ["전송 결과를 확인할 수 없습니다. 다시 보내면 중복될 수 있습니다. 새 대화에서 확인 후 전송해 주세요.", "Delivery outcome is unknown. Sending again may duplicate the request. Review before starting a new conversation."], PACK_PERSONA: ["캐릭터 페르소나를 검증할 수 없습니다.", "The character persona could not be validated."], REQUEST_LIMITED: ["잠시 뒤 다시 시도해 주세요.", "Please wait before trying again."],
}
/** Deliberately small Markdown subset. Every text node is React-escaped; no HTML,
 * remote media, links, or automatic navigation. The exact source remains copyable. */
export function Answer({ text }: { text: string }) {
  const chunks = text.split(/(^\s*(?:```|~~~)[^\n]*\n[\s\S]*?^\s*(?:```|~~~)\s*$)/m)
  return <>{chunks.map((chunk, i) => /^\s*(```|~~~)/.test(chunk)
    ? <pre key={i}><code>{chunk.replace(/^\s*(?:```|~~~)[^\n]*\n/, "").replace(/\n\s*(?:```|~~~)\s*$/, "")}</code></pre>
    : /(^|\n)\s*\|.*\|/.test(chunk) ? <pre key={i} className="table-source">{chunk}</pre> : <div key={i} className="answer-text">{chunk}</div>)}</>
}
export function SideChatApp({ api }: { api: SideChatApi }) {
  const [snapshot, setSnapshot] = useState<SideChatSnapshot | null>(null), [draft, setDraft] = useState(""), [error, setError] = useState<ChatError | null>(null)
  const stateRef = useRef(snapshot), draftRef = useRef(draft), revision = useRef(0), submitted = useRef<(ChatSubmission & { epoch: number; text: string }) | null>(null), composing = useRef(false)
  const history = useRef<HTMLDivElement>(null), atBottom = useRef(true), measurement = useRef<HTMLDivElement>(null), previewMeasure = useRef<HTMLDivElement>(null)
  const previousMode = useRef<SideChatSnapshot["mode"]>("hidden")
  const [long, setLong] = useState(false), [previewFits, setPreviewFits] = useState(true)
  const editDraft = (text: string) => { revision.current++; draftRef.current = text; setDraft(text) }
  const receive = useCallback((next: SideChatSnapshot) => {
    const previous = stateRef.current
    if (previous && next.handle === previous.handle && next.epoch < previous.epoch) return
    if (!previous) { revision.current = next.draftRevision; draftRef.current = next.draft; setDraft(next.draft) }
    stateRef.current = next; setSnapshot(next)
    if (!next.enabled) {
      revision.current = Math.max(revision.current, next.draftRevision) + 1
      draftRef.current = ""; setDraft(""); submitted.current = null
    }
    const pending = submitted.current, receipt = next.acceptedSubmission
    if (pending && pending.epoch !== next.epoch) submitted.current = null
    else if (pending && receipt?.requestId === pending.requestId && receipt.draftRevision === pending.draftRevision) {
      // Acceptance is explicit and survives a fast final response. New edits, including
      // editing away and back to the same text, never belong to the earlier submission.
      if (revision.current === pending.draftRevision && draftRef.current === pending.text) {
        revision.current++; draftRef.current = ""; setDraft("")
      }
      submitted.current = null
    }
  }, [])
  useEffect(() => {
    const unsubscribe = api.onChanged(receive)
    void api.get().then(result => { if (result.ok) receive(result.value); else setError(result.code) })
    return unsubscribe
  }, [api, receive])
  const action = async (name: ChatAction, text?: string, submission?: ChatSubmission) => {
    const current = stateRef.current; if (!current) return
    const result = await api.action(name, { handle: current.handle, epoch: current.epoch, requestId: submission?.requestId ?? crypto.randomUUID(), ...(text === undefined ? {} : { text }), ...(["send", "draft"].includes(name) ? { draftRevision: submission?.draftRevision ?? revision.current } : {}) })
    if (stateRef.current?.epoch !== current.epoch) return
    if (!result.ok) setError(result.code)
    else { setError(null); receive(result.value) }
  }
  useEffect(() => {
    const draftRevision = revision.current
    const timer = setTimeout(() => { if (stateRef.current?.enabled && validChatInput(draft, true)) void action("draft", draft, { requestId: crypto.randomUUID(), draftRevision }) }, 200)
    return () => clearTimeout(timer)
  }, [draft, snapshot?.epoch, snapshot?.enabled])
  useEffect(() => { if (snapshot) document.documentElement.lang = snapshot.language }, [snapshot?.language])
  const latest = snapshot?.messages.filter(m => m.role === "assistant").at(-1)
  useLayoutEffect(() => {
    const check = () => {
      const element = measurement.current; if (!element) return
      if (history.current && element.parentElement) element.parentElement.style.width = `${Math.max(1, history.current.clientWidth - 26)}px`
      setLong(requiresPanel(latest?.text ?? "", element.scrollHeight, parseFloat(getComputedStyle(element).lineHeight)))
      const preview = previewMeasure.current
      if (preview) setPreviewFits(preview.scrollHeight <= parseFloat(getComputedStyle(preview).lineHeight) * 3 + 1)
    }
    check(); const observer = new ResizeObserver(check); if (measurement.current) observer.observe(measurement.current); if (history.current) observer.observe(history.current)
    void document.fonts.ready.then(check)
    return () => observer.disconnect()
  }, [latest?.text, latest?.preview, snapshot?.mode])
  useLayoutEffect(() => {
    const element = history.current, mode = snapshot?.mode
    if (element) {
      if (mode === "compact") element.scrollTop = 0
      else if (mode === "panel" && previousMode.current === "compact") {
        const last = element.lastElementChild as HTMLElement | null
        element.scrollTop = last ? last.offsetTop - element.offsetTop : 0
      } else if (atBottom.current) element.scrollTop = element.scrollHeight
    }
    if (mode) previousMode.current = mode
  }, [snapshot?.messages.length, snapshot?.mode, long])
  if (!snapshot) return <main className="loading">Daemonlet…</main>
  const t = labels[snapshot.language], busy = snapshot.applying || ["answering", "preparing"].includes(snapshot.phase), panel = snapshot.mode === "panel", issue = error ?? snapshot.error
  const time = (value: number | null) => value ? new Date(value).toLocaleString(snapshot.language) : t.none
  const send = () => {
    if (composing.current || busy || submitted.current) return
    const text = draftRef.current
    if (!validChatInput(text)) { setError("INPUT_LIMIT"); return }
    const pending = { requestId: crypto.randomUUID(), draftRevision: revision.current, epoch: snapshot.epoch, text }
    submitted.current = pending
    void action("send", text, pending).finally(() => { if (submitted.current === pending) submitted.current = null })
  }
  return <main className={panel ? "chat panel" : "chat compact"} onKeyDown={event => { if (event.key === "Escape" && !composing.current && !isComposing(event.nativeEvent)) { event.preventDefault(); void action("draft", draft).then(() => action("hide")) } }}>
    <header><div><strong>{snapshot.character.label}</strong><span className="eyebrow">{t.chat}</span></div><div className="header-actions"><button onClick={() => void action(panel ? "compact" : "panel")} aria-label={panel ? t.compact : t.expand}>{panel ? "↙" : "↗"}</button><button onClick={() => void action("draft", draft).then(() => action("hide"))} aria-label={t.close}>×</button></div></header>
    <section className="context"><label>{t.connection}<select aria-label={t.parent} value={snapshot.parent?.handle ?? ""} disabled={busy} onChange={event => void action("parent", event.target.value)}><option value="" disabled>{t.empty}</option>{snapshot.parent && !snapshot.candidates.some(c => c.handle === snapshot.parent?.handle) && <option value={snapshot.parent.handle}>{snapshot.parent.title}</option>}{snapshot.candidates.map(parent => <option key={parent.handle} value={parent.handle}>{parent.title}</option>)}</select></label><details><summary>{t.context}: {time(snapshot.parent?.contextAt ?? null)}</summary><p>{t.checked}: {time(snapshot.task.checkedAt)}</p><p>{t.privacy}</p></details><span className="task-status">{({ ko: { idle: "대기", running: "작업 중", waiting: "승인·입력 필요", failed: "실패", unknown: "상태 미확인" }, en: { idle: "Idle", running: "Working", waiting: "Approval or input needed", failed: "Failed", unknown: "Status unknown" } }[snapshot.language] as Record<string, string>)[snapshot.task.state] ?? snapshot.task.state}</span></section>
    {snapshot.notice && <p className="notice">{t.notice}</p>}
    <div className="history" ref={history} onScroll={() => { if (!panel) return; const e = history.current!; atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 36 }} aria-label={t.chat}>
      {panel ? snapshot.messages.map(message => <article key={message.id} className={`message ${message.role}`}><Answer text={message.text} /><button className="copy" onClick={() => void action("copy", message.id)}>{t.copy}</button></article>) : latest ? <article className="message assistant"><div className="answer-text">{long ? latest.preview && previewFits ? latest.preview : t.full : latest.text}</div>{long && <button className="expand" onClick={() => void action("panel")}>{t.expand} ↗</button>}</article> : <p className="empty">{t.ready}</p>}
    </div>
    <div role="status" className="response-status">{snapshot.applying ? t.applying : snapshot.phase === "answering" ? t.answering : snapshot.phase === "preparing" ? t.preparing : ""}</div>
    {issue && <p className="error" role="alert">{errors[issue]?.[snapshot.language === "ko" ? 0 : 1] ?? issue}</p>}
    <footer><label htmlFor="chat-input">{t.input}</label><textarea id="chat-input" rows={2} value={draft} onChange={e => { if (validChatInput(e.target.value, true)) editDraft(e.target.value); else setError("INPUT_LIMIT") }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !isComposing(event.nativeEvent)) { event.preventDefault(); send() } }} /><div className="composer-actions"><button className="quiet" onClick={() => void action("reset")} disabled={snapshot.applying}>{t.reset}</button><span className="count">{Array.from(draft).length}/4000</span>{busy ? <button onClick={() => void action("stop")} disabled={snapshot.applying}>{t.stop}</button> : <button className="send" disabled={!draft.trim() || !snapshot.parent} onClick={send}>{t.send}</button>}</div></footer>
    <div className="measure" aria-hidden="true"><div className="answer-text" ref={measurement}>{latest?.text}</div><div className="answer-text" ref={previewMeasure}>{latest?.preview}</div></div>
  </main>
}
