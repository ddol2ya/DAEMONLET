import TaskControlPanel from "./TaskControlPanel"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ActivityApi, ActivityResponse, ActivitySnapshot } from "../../electron/shared/activity-contract"
import { activityBubbleEntries } from "../../electron/shared/activity-bubble"

declare global { interface Window { activityDesktop?: ActivityApi } }
const labels = { waiting: "입력 필요", running: "작업 중", completed: "작업 종료", failed: "작업 실패", cancelled: "작업 중단", unknown: "상태 확인 불가" }
const categories = { command: "명령 실행", "file-change": "파일 변경", tool: "도구 사용", "web-search": "웹 검색", subtask: "하위 작업", review: "검토", other: "작업 진행" }

export default function ActivityBubbleApp() {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null)
  const [attention, setAttention] = useState({ waiting: 0, unread: 0 })
  const [selected, setSelected] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [view, setView] = useState<"activity" | "control">("activity")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const main = useRef<HTMLElement>(null)
  const latest = useRef<ActivitySnapshot | null>(null)
  const holds = useRef(new Set<string>())
  const actionPending = useRef(false)
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blockedClick = useRef(false)
  const menu = useRef<HTMLDetailsElement>(null)
  const focusAfterToggle = useRef(false)
  const closeMenu = () => { setMenuOpen(false); hold("menu", false) }
  const receive = (value: ActivitySnapshot) => {
    if (latest.current && latest.current.revision > value.revision) return
    latest.current = value
    setAttention({ waiting: value.counts.waiting, unread: value.entries.filter(r => r.unread).length })
    if (!holds.current.size) setSnapshot(value)
  }
  const hold = (reason: string, value: boolean) => {
    const pressed = () => ["pointer", "keyboard", "native"].some(reason => holds.current.has(reason))
    const before = holds.current.size > 0, beforePressed = pressed()
    if (value) holds.current.add(reason); else holds.current.delete(reason)
    const after = holds.current.size > 0
    if (before !== after || beforePressed !== pressed()) window.activityDesktop?.setInteractionLocked(after, pressed())
    if (!after && latest.current) setSnapshot(latest.current)
  }
  useEffect(() => {
    const api = window.activityDesktop
    if (!api) { setError("앱에서 다시 열어 주세요."); return }
    let alive = true
    const uninput = api.onInteractionStarted(() => hold("native", true))
    const unsubscribe = api.onChanged(value => { if (alive) receive(value) })
    void api.getSnapshot().then(result => { if (alive) { if (result.ok) receive(result.value); else setError("불러오지 못했어요. 다시 열어 주세요.") } }).catch(() => { if (alive) setError("연결하지 못했어요.") })
    const control = window.taskControlDesktop
    let viewChanged = false
    const applyView = (v: {view: "activity" | "control"; collapsed: boolean}) => { if (alive) { setView(v.view); setCollapsed(v.collapsed) } }
    const unview = control?.onViewChanged(v => { viewChanged = true; applyView(v) })
    void control?.getView().then(result => { if (result.ok && !viewChanged) applyView(result.value) }).catch(() => {})
    let interactive = false
    const pointer = (event: MouseEvent) => {
      const next = event.target instanceof Element && Boolean(event.target.closest("button, input, textarea, select, summary, a"))
      if (interactive !== next) { interactive = next; api.setPointerInteractive(next) }
    }
    // Focus can move while a captured mouse press is still active (for
    // example while settings apply). Only up/cancel/lost capture ends it.
    const blur = () => { hold("keyboard", false); hold("focus", false); closeMenu() }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target)) closeMenu() }
    const visibility = () => { if (document.hidden) { hold("pointer", false); hold("native", false); blur() } }
    const releases = new Map<string, ReturnType<typeof setTimeout>>()
    const releaseInput = (reason: string) => {
      const old = releases.get(reason); if (old) clearTimeout(old)
      releases.set(reason, setTimeout(() => { releases.delete(reason); hold(reason, false); hold("native", false); if (!holds.current.size) api.setInteractionLocked(false) }, 0))
    }
    const up = () => releaseInput("pointer"), keyup = () => releaseInput("keyboard")
    window.addEventListener("pointerup", up); window.addEventListener("keyup", keyup)
    document.addEventListener("mousemove", pointer)
    document.addEventListener("pointerdown", outside, true)
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", visibility)
    return () => { alive = false; unsubscribe(); uninput(); unview?.(); document.removeEventListener("mousemove", pointer); document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pointerup", up); window.removeEventListener("keyup", keyup); for (const timer of releases.values()) clearTimeout(timer); if (releaseTimer.current) clearTimeout(releaseTimer.current); api.setInteractionLocked(false) }
  }, [])
  useLayoutEffect(() => {
    const element = main.current
    if (!element || view !== "activity") return
    let frame: number | null = null
    const measure = () => {
      frame = null
      const bounds = element.getBoundingClientRect(), panel = menu.current?.open ? menu.current.querySelector(".bubble-menu-panel")?.getBoundingClientRect() : null
      window.activityDesktop?.reportHeight(Math.max(44, Math.min(480, Math.ceil(Math.max(bounds.bottom, panel?.bottom ?? 0) + 3))))
    }
    const observer = new ResizeObserver(() => { if (frame === null) frame = requestAnimationFrame(measure) })
    observer.observe(element); measure()
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame) }
  }, [view, collapsed, menuOpen])
  useLayoutEffect(() => {
    if (!focusAfterToggle.current || view !== "activity") return
    focusAfterToggle.current = false
    main.current?.querySelector<HTMLElement>(collapsed ? ".mini-task-chip" : ".bubble-menu summary")?.focus({ preventScroll: true })
  }, [collapsed, view])
  const entries = snapshot ? activityBubbleEntries(snapshot) : []
  const index = Math.max(0, entries.findIndex(r => r.activityId === selected))
  const entry = entries[index]
  useEffect(() => { if (selected !== (entry?.activityId ?? null)) setSelected(entry?.activityId ?? null) }, [entry?.activityId, selected])
  const stale = snapshot?.connection !== "READY" || entry?.freshness === "rechecking"
  const perform = async <T,>(action: () => Promise<ActivityResponse<T>>, after?: (value: T) => void) => {
    if (actionPending.current) return
    actionPending.current = true; hold("pending", true); setPending(true); setError("")
    try { const result = await action(); if (result.ok) { after?.(result.value); hold("focus", false) } else setError(result.code === "REQUEST_LIMITED" ? "잠시 후 다시 눌러 주세요." : result.code === "UNAVAILABLE" ? "이 작업의 대화 연결을 찾지 못했어요. 확인은 따로 할 수 있어요." : result.code === "OPEN_FAILED" ? "대화를 열지 못했어요. 확인은 따로 할 수 있어요." : result.code === "STALE_TARGET" ? "이미 확인했거나 상태가 바뀐 작업이에요." : "처리하지 못했어요. 다시 시도해 주세요.") }
    catch { setError("연결하지 못했어요. 다시 시도해 주세요.") } finally { actionPending.current = false; setPending(false); hold("pending", false) }
  }
  const api = window.activityDesktop
  const toggle = () => { closeMenu(); focusAfterToggle.current = document.activeElement?.matches(":focus-visible") ?? false; if (api) void perform(() => api.setCollapsed(!collapsed), setCollapsed) }
  const cycle = (delta: number) => { if (entries.length) { setSelected(entries[(index + delta + entries.length) % entries.length].activityId); setError("") } }
  const release = (reason: string) => { if (releaseTimer.current) clearTimeout(releaseTimer.current); releaseTimer.current = setTimeout(() => { releaseTimer.current = null; hold(reason, false) }, 0) }
  const target = entry && { activityId: entry.activityId, revision: entry.revision }
  return <><div className="activity-view" hidden={view !== "activity"}><main ref={main} className={`bubble-shell task-bubble ${collapsed ? "compact" : ""}`} data-state={entry?.state ?? "unknown"} data-activity-id={entry?.activityId} aria-label="작업 말풍선"
    onPointerDownCapture={event => {
      if (!(event.target instanceof Element)) return
      const button = event.target.closest("button, summary")
      if (button instanceof HTMLElement) { blockedClick.current = false; hold("pointer", true); hold("native", false); button.setPointerCapture(event.pointerId) }
    }}
    onPointerUpCapture={event => {
      if (event.target instanceof Element) { const r = event.target.getBoundingClientRect(); blockedClick.current = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom }
      release("pointer")
    }}
    onPointerCancel={() => { hold("pointer", false); hold("native", false) }}
    onLostPointerCapture={() => release("pointer")}
    onClickCapture={event => { if (blockedClick.current) { event.preventDefault(); event.stopPropagation(); blockedClick.current = false } }}
    onFocusCapture={event => { if (event.target.matches(":focus-visible")) hold("focus", true) }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) hold("focus", false) }}
    onKeyDown={event => { if (["Enter", " "].includes(event.key)) { hold("keyboard", true); hold("native", false) } if (event.key === "Escape") { if (menuOpen) { event.preventDefault(); closeMenu(); menu.current?.querySelector("summary")?.focus() } else if (!collapsed) toggle() } }}
    onKeyUp={() => release("keyboard")}>
    {collapsed ? <button className="mini-task-chip" aria-label="작업 알림 펼치기" aria-expanded="false" title={`${entry?.name ?? "작업 알림"} · ${entry ? labels[entry.state] : ""} · 입력 필요 ${attention.waiting} · 미확인 ${attention.unread}`} disabled={pending || !api} onClick={toggle}>
      <span className="mini-task-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h6"/></svg><span className={`task-dot ${stale ? "stale" : ""}`} /></span>
      {attention.waiting + attention.unread > 0 && <span className="mini-task-count" aria-hidden="true">{Math.min(99, attention.waiting + attention.unread)}{attention.waiting + attention.unread > 99 ? "+" : ""}</span>}
      <span className="sr-label" role="status" aria-live="polite">입력 필요 {attention.waiting} · 미확인 {attention.unread}</span>
    </button> : <><div className="bubble-top">
      <span className={`task-dot ${stale ? "stale" : ""}`} aria-hidden="true" />
      <div className="task-heading"><strong>{stale ? "작업 재확인 중" : entry ? labels[entry.state] : "작업 알림"}</strong>{!collapsed && entry && (entry.unread || entry.category || entry.state === "waiting" || stale) && <span>· {entry.unread ? "미확인" : entry.state === "running" && entry.category ? categories[entry.category] : entry.state === "waiting" ? "대화에서 응답" : "마지막 관찰"}</span>}</div>
      <button className="text-button" aria-label="작업 목록 열기" disabled={pending || !api} onClick={() => api && void perform(() => api.openList())}>목록</button>
      <details ref={menu} className="bubble-menu" open={menuOpen} onToggle={event => { setMenuOpen(event.currentTarget.open); hold("menu", event.currentTarget.open) }}><summary aria-label="작업 말풍선 메뉴" onClick={event => hold("menu", !(event.currentTarget.parentElement as HTMLDetailsElement).open)}>···</summary><div className="bubble-menu-panel">
        {window.taskControlDesktop && <button disabled={pending} onClick={() => { closeMenu(); void window.taskControlDesktop!.setView("control", false) }}>Codex 제어</button>}
        <button disabled={pending || !api} onClick={toggle}>{collapsed ? "펼치기" : "접기"}</button>
        {entry?.unread && entry.canOpenConversation && <button disabled={pending || !api} onClick={() => { closeMenu(); if (api && target) void perform(() => api.openResult(target), receive) }}>열고 확인</button>}
      </div></details>
    </div>
    <div className="bubble-bottom"><span className="task-name" title={entry?.name}>{entry?.name ?? "새 작업을 기다려요"}</span><div className="task-links">
      {entry?.canOpenConversation && <button className="text-button" disabled={pending || !api} onClick={() => api && target && void perform(() => api.openConversation(target))}>대화 열기 <span aria-hidden="true">↗</span></button>}
      {entry?.unread && <button className="text-button confirm" disabled={pending || !api} onClick={() => api && target && void perform(() => api.acknowledge({ targets: [target] }), receive)}>확인</button>}
    </div></div>
    <div className="bubble-summary"><span role="status" aria-live="polite" aria-atomic="true">{attention.waiting ? `입력 필요 ${attention.waiting}` : ""}{attention.waiting && attention.unread ? " · " : ""}{attention.unread ? `미확인 ${attention.unread}` : ""}</span>
      {entries.length > 1 && <div className="task-pager" aria-label="작업 선택"><button className="text-button" aria-label="이전 작업" disabled={pending} onClick={() => cycle(-1)}>‹</button><span>{index + 1}/{entries.length}</span><button className="text-button" aria-label="다음 작업" disabled={pending} onClick={() => cycle(1)}>›</button></div>}
    </div>
    {(error || snapshot?.storage === "error") && <p className="task-error" role="alert">{error || "이력 저장 실패 · 작업 목록에서 확인해 주세요."}</p>}</>}
  </main></div><TaskControlPanel hidden={view !== "control"} collapsed={collapsed} /></>
}
