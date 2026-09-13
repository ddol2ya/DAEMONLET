import { useLayoutEffect, useRef, useState } from "react"
import type { BubbleAnchor } from "../../electron/shared/bubble-presentation"
import type { CharacterDialogueController } from "../dialogue/CharacterDialogueController"
import type { DialogueSnapshot } from "../dialogue/types"
import type { SpeechOutline } from "../../electron/shared/speech-outline"

/** Keep the surface lease while speech remains visible. Replacing a line must
 * not hide the same bubble while waiting for another cross-process round trip. */
export function useBubblePresentation(snapshot: DialogueSnapshot, anchor: BubbleAnchor | null, layoutReady: boolean, available: boolean, characterEpoch: number, controller?: CharacterDialogueController, size?: { width: number; height: number; outline?: SpeechOutline; measuredText?: string | null }) {
  const [epoch, setEpoch] = useState(0)
  const [reportedAnchor, setReportedAnchor] = useState<BubbleAnchor | null>(null)
  const lastAnchorAt = useRef(-Infinity)
  useLayoutEffect(() => {
    if (!available || !anchor) { setReportedAnchor(null); lastAnchorAt.current = -Infinity; return }
    const publish = () => { lastAnchorAt.current = performance.now(); setReportedAnchor(anchor) }
    const remaining = 100 - (performance.now() - lastAnchorAt.current)
    if (remaining <= 0) { publish(); return }
    const timer = setTimeout(publish, remaining)
    return () => clearTimeout(timer)
  }, [anchor, available])
  const [grantedKey, setGrantedKey] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const sequence = useRef(0)
  const key = `${characterEpoch}:${epoch}`
  const wanted = available && snapshot.enabled && snapshot.visible && layoutReady
  const granted = wanted && grantedKey === key
  useLayoutEffect(() => {
    let alive = true
    setEpoch(0); setGrantedKey(null)
    if (!controller) return
    void window.petDesktop?.bubble.begin().then(value => { if (alive) { sequence.current = 0; setEpoch(value) } }).catch(() => {})
    return () => { alive = false }
  }, [characterEpoch])
  useLayoutEffect(() => {
    controller?.setPresentationPaused(wanted && !granted)
    if (!wanted) setGrantedKey(null)
    if (!epoch || !window.petDesktop) return
    // Keep the current lease until a replacement line has its own fitted size.
    // Never briefly paint new text inside the previous line's wider box.
    if (wanted && size?.measuredText !== undefined && size.measuredText !== snapshot.text) return
    const seq = ++sequence.current
    const phase = wanted ? granted ? snapshot.phase : "preparing" : "hidden"
    let alive = true
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const retryReport = () => {
      if (alive && available) retryTimer = setTimeout(() => setRetry(value => value + 1), 180)
    }
    const speech = wanted && snapshot.text && size ? { text: snapshot.text, width: Math.ceil(size.width), height: Math.ceil(size.height), fadeMs: snapshot.fadeMs, ...(size.outline ? { outline: size.outline } : {}) } : undefined
    void window.petDesktop.bubble.report({ epoch, sequence: seq, available, phase, anchor: reportedAnchor, ...(speech ? { speech } : {}) }).then(permit => {
      if (alive && wanted && permit.granted && permit.epoch === epoch && permit.sequence === seq && sequence.current === seq) setGrantedKey(key)
      else if (permit.epoch !== epoch || permit.sequence !== seq || wanted && !granted) retryReport()
    }).catch(retryReport)
    return () => { alive = false; if (retryTimer !== null) clearTimeout(retryTimer) }
  }, [epoch, key, wanted, granted, snapshot.phase, snapshot.text, snapshot.fadeMs, size?.width, size?.height, size?.outline, size?.measuredText, available, reportedAnchor, controller, retry])
  useLayoutEffect(() => () => { controller?.setPresentationPaused(false) }, [controller])
  return controller ? granted : wanted
}
