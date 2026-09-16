import { useEffect, useRef } from "react"
import { useT } from "../i18n/useLanguage"
import { ModifierDragController } from "../pet/ModifierDragController"
import type { BubblePlacementApi, PlacementSnapshot } from "../../electron/shared/bubble-placement"

declare global { interface Window { bubblePlacementDesktop?: BubblePlacementApi } }
export function BubblePlacementPreview({ state }: { state: PlacementSnapshot }) {
  const t = useT(), handle = useRef<HTMLButtonElement>(null)
  const action = (action: "apply" | "cancel") => { void window.bubblePlacementDesktop?.action({ action, revision: state.revision }) }
  useEffect(() => {
    const element = handle.current, api = window.bubblePlacementDesktop
    if (!state.editing || !element || !api) return
    const cancel = () => { void api.action({ action: "cancel", revision: state.revision }) }
    const drag = new ModifierDragController(element, {
      platform: "", allowed: () => true, hit: () => true, gesture: e => e.button === 0 && e.pointerType === "mouse",
      request: async value => { const reply = await api.action({ action: "drag", revision: state.revision, drag: value }); return reply.ok && reply.drag ? reply.drag : { id: null } },
      lock: active => { element.style.cursor = active ? "grabbing" : "grab" }, onEscape: cancel,
    })
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); cancel() } }
    window.addEventListener("keydown", key)
    element.focus({ preventScroll: true })
    return () => { drag.dispose(); window.removeEventListener("keydown", key) }
  }, [state.editing, state.revision])
  return <section className="bubble-shell placement-preview" hidden={!state.editing} aria-label={t("말풍선 위치 조절")}>
    <button ref={handle} className="placement-handle" aria-label={t("말풍선 이동 손잡이")}>⠿ <span>{t("드래그하여 이동")}</span></button>
    <div className="placement-sample"><strong>{t("이 위치에 말풍선이 나타나요.")}</strong><p>{t("캐릭터를 움직이면 함께 따라갑니다.")}</p></div>
    <footer><button onClick={() => action("cancel")}>{t("취소")}</button><button className="placement-apply" onClick={() => action("apply")}>{t("적용")}</button></footer>
  </section>
}
