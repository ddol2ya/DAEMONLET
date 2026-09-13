import { useEffect, useRef, useState } from "react"
import { ACTIVITY_HISTORY_DAYS, ACTIVITY_HISTORY_LIMIT, activitySummary, type ActivityAckTarget, type ActivityApi, type ActivityEntry, type ActivitySnapshot } from "../../electron/shared/activity-contract"

declare global { interface Window { activityDesktop?: ActivityApi } }
const stateText = { running: "실행 중", waiting: "입력 필요", completed: "작업 종료", failed: "작업 실패", cancelled: "사용자 중단", unknown: "상태 확인 불가" }
const connectionText = { READY: "연결됨", DISCONNECTED: "연결 끊김", CONNECTING: "연결 중", HANDSHAKING: "연결 확인 중", SYNCING: "동기화 중", DESYNCED: "다시 동기화 중", RECONNECTING: "재연결 중", ERROR: "연결 오류" }
const categoryText = { command: "명령 실행", "file-change": "파일 변경", tool: "도구 사용", "web-search": "웹 검색", subtask: "하위 작업", review: "검토", other: "기타 작업" }
const formatTime = (at: number) => new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(at)

export default function ActivityApp() {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const latest = useRef<ActivitySnapshot | null>(null)
  const pointerHeld = useRef(false)
  const pendingRef = useRef(false)
  const blockedClick = useRef(false)
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const receive = (value: ActivitySnapshot) => {
    if (latest.current && latest.current.revision > value.revision) return
    latest.current = value
    if (!pointerHeld.current && !pendingRef.current) setSnapshot(value)
  }
  const finish = () => { pendingRef.current = false; setPending(false); if (!pointerHeld.current && latest.current) setSnapshot(latest.current) }
  useEffect(() => {
    const api = window.activityDesktop
    if (!api) { setError("작업 목록에 연결할 수 없습니다. 앱에서 다시 열어 주세요."); return }
    let alive = true
    const unsubscribe = api.onChanged(value => { if (alive) receive(value) })
    void api.getSnapshot().then(result => { if (result.ok && alive) receive(result.value); else if (alive) setError("작업 목록을 불러오지 못했습니다. 창을 다시 열어 주세요.") }).catch(() => { if (alive) setError("작업 목록을 불러오지 못했습니다. 창을 다시 열어 주세요.") })
    const release = () => { pointerHeld.current = false; if (!pendingRef.current && latest.current) setSnapshot(latest.current) }
    window.addEventListener("blur", release)
    return () => { alive = false; unsubscribe(); window.removeEventListener("blur", release); if (releaseTimer.current) clearTimeout(releaseTimer.current) }
  }, [])

  const acknowledge = async (targets: ActivityAckTarget[]) => {
    if (!window.activityDesktop || pendingRef.current) return
    pendingRef.current = true; setPending(true); setError("")
    try {
      const result = await window.activityDesktop.acknowledge({ targets })
      if (!result.ok) { setError("확인 처리에 실패했습니다. 잠시 후 다시 시도해 주세요."); return }
      receive(result.value)
      setNotice("선택한 결과를 확인했습니다. 입력 대기 상태는 그대로 유지됩니다.")
      // The acknowledged row moves to history; retain an intentional keyboard focus location.
      titleRef.current?.focus()
    } catch { setError("확인 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.") }
    finally { finish() }
  }
  const openCodex = async (target?: ActivityAckTarget) => {
    if (!window.activityDesktop || pendingRef.current) return
    pendingRef.current = true; setPending(true); setError("")
    try {
      const result = await (target ? window.activityDesktop.openConversation(target) : window.activityDesktop.openCodex())
      if (!result.ok) setError(result.code === "UNAVAILABLE" ? "검증된 ChatGPT 앱을 찾지 못했습니다." : "ChatGPT 앱을 열지 못했습니다. 잠시 후 다시 시도해 주세요.")
      else setNotice(target ? "ChatGPT에 이 작업의 대화 열기를 요청했습니다." : "ChatGPT 앱에 열기를 요청했습니다. 결과 확인 표시는 유지됩니다.")
    } catch { setError("ChatGPT 앱을 열지 못했습니다.") } finally { finish() }
  }
  const openResult = async (target: ActivityAckTarget) => {
    if (!window.activityDesktop || pendingRef.current) return
    pendingRef.current = true; setPending(true); setError("")
    try {
      const result = await window.activityDesktop.openResult(target)
      if (!result.ok) {
        setError(result.code === "UNAVAILABLE" ? "이 작업의 대화 연결을 찾지 못했습니다. 미확인 상태를 유지합니다." : result.code === "STALE_TARGET" ? "이미 확인했거나 상태가 바뀐 작업입니다." : result.code === "REQUEST_LIMITED" ? "잠시 후 다시 눌러 주세요." : "대화를 열지 못했습니다. 미확인 상태를 유지합니다.")
        return
      }
      receive(result.value)
      setNotice("해당 대화 열기를 요청하고 결과를 확인 처리했습니다.")
    } catch { setError("대화를 열지 못했습니다. 미확인 상태를 유지합니다.") }
    finally { finish() }
  }
  const groups = snapshot ? [
    { title: "확인이 필요한 작업", id: "attention", items: snapshot.entries.filter(r => r.state === "waiting" || r.unread) },
    { title: "진행 중", id: "running", items: snapshot.entries.filter(r => r.state === "running") },
    { title: "최근 이력", id: "history", items: snapshot.entries.filter(r => r.state !== "waiting" && r.state !== "running" && !r.unread) },
  ] : []
  const targets = snapshot?.entries.filter(r => r.unread).map(({ activityId, revision }) => ({ activityId, revision })) ?? []
  return <main className="activity-app"
    onPointerDownCapture={event => { const target = event.target instanceof Element ? event.target.closest("button") : null; if (target) { blockedClick.current = false; pointerHeld.current = true; target.setPointerCapture(event.pointerId) } }}
    onPointerUpCapture={event => {
      if (event.target instanceof Element) { const r = event.target.getBoundingClientRect(); blockedClick.current = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom }
      if (releaseTimer.current) clearTimeout(releaseTimer.current)
      releaseTimer.current = setTimeout(() => { pointerHeld.current = false; if (!pendingRef.current && latest.current) setSnapshot(latest.current) }, 0)
    }}
    onPointerCancel={() => { pointerHeld.current = false; if (!pendingRef.current && latest.current) setSnapshot(latest.current) }}
    onClickCapture={event => { if (blockedClick.current) { event.preventDefault(); event.stopPropagation(); blockedClick.current = false } }}
    onKeyDownCapture={event => { if (["Enter", " "].includes(event.key)) pointerHeld.current = true }}
    onKeyUpCapture={() => { if (releaseTimer.current) clearTimeout(releaseTimer.current); releaseTimer.current = setTimeout(() => { pointerHeld.current = false; if (!pendingRef.current && latest.current) setSnapshot(latest.current) }, 0) }}
  >
    <header className="activity-header">
      <div className="heading-row"><h1 id="activity-title" ref={titleRef} tabIndex={-1}>작업 목록</h1>
        <span className={`connection ${snapshot?.connection === "READY" ? "connected" : ""}`}>{snapshot ? connectionText[snapshot.connection] : "불러오는 중"}</span>
      </div>
    </header>
    {error && <p role="alert" className="banner error">{error}</p>}
    {snapshot ? <>
      <div className="counts" aria-label="작업 상태 요약">
        {([ ["waiting", "입력 필요"], ["failed", "미확인 실패"], ["completed", "미확인 종료"], ["running", "실행 중"] ] as const).map(([key, label]) => <div className={`count ${key}`} key={key}><span>{label}</span><strong>{snapshot.counts[key]}</strong></div>)}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{activitySummary(snapshot)}</p>
      {snapshot.connection !== "READY" && <p className="banner">연결 확인 중 · 마지막 수신 {snapshot.lastObservedAt === null ? "없음" : formatTime(snapshot.lastObservedAt)}</p>}
      {snapshot.storage === "error" && <p className="banner error" role="alert">이력 저장 실패 · 현재 목록은 유지되지만 앱을 다시 시작하면 최근 변경이 사라질 수 있습니다.</p>}
      {snapshot.historyRecovered && <p className="banner">손상된 이력 파일을 격리했습니다. 이전 기록 일부를 복원하지 못했습니다.</p>}
      {snapshot.droppedUnread > 0 && <p className="banner">보관 한도로 미확인 결과 {snapshot.droppedUnread}건이 정리되었습니다.{snapshot.lastPrunedAt !== null && ` 최근 정리: ${formatTime(snapshot.lastPrunedAt)}.`}</p>}
      {snapshot.capacityLimited && <p className="banner">수집 또는 중복 방지 용량 한도에 도달한 적이 있습니다. 일부 기록이 누락되거나 다시 표시될 수 있습니다.</p>}
      <div className="toolbar">
        <button className="primary" disabled={pending || targets.length === 0} onClick={() => void acknowledge(targets)}>미확인 결과 모두 확인{targets.length ? ` (${targets.length})` : ""}</button>
        <button disabled={pending || snapshot.navigation === "none"} onClick={() => void openCodex()}>ChatGPT 앱 열기 <span aria-hidden="true">↗</span></button>
      </div>
      {snapshot.navigation === "none" && <p className="navigation-note">ChatGPT 앱을 찾지 못했습니다.</p>}
      {!snapshot.entries.length && <section className="empty"><span className="empty-symbol" aria-hidden="true">☷</span><h2>아직 작업이 없습니다</h2></section>}
      {groups.filter(g => g.items.length).map(group => <section className="activity-section" key={group.id} aria-labelledby={`section-${group.id}`}>
        <h2 id={`section-${group.id}`}>{group.title} <span>{group.items.length}</span></h2>
        <ul>{group.items.map(r => <li key={r.activityId}><ActivityRow entry={r} pending={pending} onOpen={() => void openCodex({ activityId: r.activityId, revision: r.revision })} onConfirm={() => void acknowledge([{ activityId: r.activityId, revision: r.revision }])} onOpenAndConfirm={() => void openResult({ activityId: r.activityId, revision: r.revision })} /></li>)}</ul>
      </section>)}
      <footer>
        <p>{snapshot.storage === "pending" ? "이력 저장 중…" : snapshot.storage === "saved" ? "로컬 이력 저장됨" : "이력 저장 실패"}</p>
        <details><summary>기록 보관 안내</summary><p>종료 이력은 최대 {ACTIVITY_HISTORY_LIMIT}건, {ACTIVITY_HISTORY_DAYS}일 보관합니다. 미확인 결과도 보관 한도에 따라 정리됩니다. 대화 제목과 본문은 저장하지 않습니다.</p></details>
      </footer>
    </> : !error && <p className="empty" role="status">작업 목록을 불러오고 있습니다…</p>}
    <p className="sr-only" role="status" aria-live="polite">{notice}</p>
  </main>
}

function ActivityRow({ entry: r, pending, onConfirm, onOpen, onOpenAndConfirm }: { entry: ActivityEntry; pending: boolean; onConfirm: () => void; onOpen: () => void; onOpenAndConfirm: () => void }) {
  return <article className={`activity-row ${r.state}`} aria-label={`${r.name}, ${stateText[r.state]}`}>
    <span className="state-dot" aria-hidden="true" />
    <div className="row-content">
      <div className="row-title"><h3>{r.name}</h3><span className="state-label">{stateText[r.state]}{r.freshness === "rechecking" ? " · 재확인 중" : ""}</span>{r.unread && <span className="unread">미확인</span>}</div>
      <p className="row-time">첫 수신 <time dateTime={new Date(r.firstObservedAt).toISOString()}>{formatTime(r.firstObservedAt)}</time> · {r.endedAt === null ? "최근 수신" : "종료"} {formatTime(r.endedAt ?? r.lastObservedAt)}</p>
      {r.state === "unknown" && <p className="row-note">종료 상태를 확인하지 못했습니다.</p>}
      {r.state === "waiting" && <p className="row-note">{r.freshness === "rechecking" ? "입력 대기 상태를 다시 확인하고 있습니다." : "Codex에서 응답해 주세요."}</p>}
      {r.state === "running" && r.category && <p className="row-note">{categoryText[r.category]}</p>}
      {r.acknowledgedAt !== null && <p className="row-note">{formatTime(r.acknowledgedAt)} 확인</p>}
    </div>
    <div className="row-actions">
      {r.canOpenConversation && <button disabled={pending} aria-label={`${r.name} 대화 열기`} onClick={onOpen}>대화 열기 ↗</button>}
      {r.unread && <button className="confirm" title="이 결과만 확인" disabled={pending} aria-label={`${r.name} 결과 확인`} onClick={onConfirm}>확인</button>}
      {r.unread && r.canOpenConversation && <button disabled={pending} onClick={onOpenAndConfirm}>열고 확인</button>}
    </div>
  </article>
}
