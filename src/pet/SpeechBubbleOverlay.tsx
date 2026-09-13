import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react"
import type { DialogueSnapshot } from "../dialogue/types"
import type { Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"
import { modelToViewport } from "../engine/anime25d/coordinate"
import { positionSpeechBubble, type BubblePosition } from "./SpeechBubblePosition"
import "./speech-bubble.css"
import { useBubblePresentation } from "./useBubblePresentation"
import type { BubbleAnchor } from "../../electron/shared/bubble-presentation"
import type { CharacterDialogueController } from "../dialogue/CharacterDialogueController"
import { SpeechOutlineSampler } from "./SpeechOutlineSampler"
import type { SpeechOutline } from "../../electron/shared/speech-outline"
import { fitSpeechBubbleSize } from "./SpeechBubbleSize"

type Layout = BubblePosition & { fontSize: number; outline?: SpeechOutline; measuredText?: string | null }

export function SpeechBubbleOverlay({ snapshot, runtime, canvasRef, available = true, characterEpoch = 0, controller }: {
  available?: boolean
  characterEpoch?: number
  controller?: CharacterDialogueController
  snapshot: DialogueSnapshot
  runtime: Anime25DRuntime
  canvasRef: RefObject<HTMLCanvasElement | null>
}) {
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout | null>(null)
  const [anchor, setAnchor] = useState<BubbleAnchor | null>(null)
  const native = Boolean(controller && typeof window !== "undefined" && window.petDesktop)
  const granted = useBubblePresentation(snapshot, anchor, layout !== null, available, characterEpoch, controller, native && layout ? layout : undefined)
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const bubble = bubbleRef.current
    if (!canvas || !bubble) return
    const textMeasure = document.createElement("canvas").getContext("2d")
    const outlineSampler = native ? new SpeechOutlineSampler(canvas) : null
    let nativeSize: { width: number; height: number } | null = null
    const measure = () => {
      if (!available) { setLayout(null); setAnchor(null); return }
      const geometry = runtime.getBaseFaceGeometry()
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (!geometry || !width || !height) { setLayout(null); setAnchor(null); return }
      const start = modelToViewport(geometry.head.x0, geometry.head.y0, width, height, geometry.width, geometry.height)
      const end = modelToViewport(geometry.head.x1, geometry.head.y1, width, height, geometry.width, geometry.height)
      const head = { x0: Math.max(0, start.x - 4), y0: Math.max(0, start.y - 4), x1: Math.min(width, end.x + 4), y1: Math.min(height, end.y + 4) }
      const nextAnchor = { x0: head.x0 / width, y0: head.y0 / height, x1: head.x1 / width, y1: head.y1 / height }
      setAnchor(old => old && Object.keys(nextAnchor).every(k => old[k as keyof BubbleAnchor] === nextAnchor[k as keyof BubbleAnchor]) ? old : nextAnchor)
      if (!snapshot.visible || !available) { setLayout(null); return }
      // Measure from the CSS width limit each time so a small-window wrap
      // can expand again when the viewport or text changes.
      const previousMaxWidth = bubble.style.maxWidth
      const fontSize = 13
      bubble.style.setProperty("--bubble-font-size", `${fontSize}px`)
      bubble.style.maxWidth = ""
      const naturalWidth = Math.ceil(bubble.getBoundingClientRect().width)
      if (native) {
        const outline = outlineSampler?.read()
        if (!outline) { bubble.style.maxWidth = previousMaxWidth; return }
        // This element only measures authored text. The desktop companion owns
        // its display area, so neither wrapping nor font size follows Pet scale.
        nativeSize ??= fitSpeechBubbleSize(bubble, naturalWidth)
        const next: Layout = { x: 0, y: 0, ...nativeSize, side: "right", tailX: 14, tailY: 14, fontSize, outline, measuredText: snapshot.text }
        bubble.style.maxWidth = previousMaxWidth
        setLayout(old => old && Object.keys(next).every(key => old[key as keyof Layout] === next[key as keyof Layout]) ? old : next)
        return
      }
      const computed = getComputedStyle(bubble)
      if (textMeasure) textMeasure.font = `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`
      const longestWord = Math.max(0, ...(snapshot.text ?? "").split(/\s+/u).map(word => textMeasure?.measureText(word).width ?? 0))
      const minWidth = Math.ceil(longestWord + parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight) + parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth) + 2)
      let position = positionSpeechBubble({ width, height }, head, { width: naturalWidth, height: bubble.offsetHeight, minWidth })
      bubble.style.maxWidth = `${position.width}px`
      position = positionSpeechBubble({ width, height }, head, { width: naturalWidth, height: bubble.offsetHeight, minWidth })
      bubble.style.maxWidth = previousMaxWidth
      const next: Layout = { ...position, x: position.x + canvas.offsetLeft, y: position.y + canvas.offsetTop, fontSize }
      setLayout((old) => old && Object.keys(next).every((key) => old[key as keyof Layout] === next[key as keyof Layout]) ? old : next)
    }
    measure()
    // ResizeObserver callbacks must not resize the element they are observing
    // during delivery. Coalesce font/wrap/runtime updates into the next frame.
    let measurementFrame: number | null = null
    const scheduleMeasure = () => {
      if (measurementFrame !== null) return
      measurementFrame = requestAnimationFrame(() => { measurementFrame = null; measure() })
    }
    // Canvas size changes must update local layout before paint. The bubble is
    // absolute and is not observed, so measuring it cannot feed a resize loop.
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    const unsubscribe = runtime.subscribe(scheduleMeasure)
    const timer = window.setInterval(scheduleMeasure, 150)
    return () => { window.clearInterval(timer); observer.disconnect(); unsubscribe(); if (measurementFrame !== null) cancelAnimationFrame(measurementFrame) }
  }, [canvasRef, runtime, snapshot.visible, snapshot.text, available, characterEpoch, native])

  if (!controller && (!snapshot.visible || !snapshot.text)) return null
  const style = {
    left: layout?.x ?? 8, top: layout?.y ?? 8,
    maxWidth: layout?.width,
    visibility: !native && layout && granted ? "visible" : "hidden",
    "--bubble-fade": `${snapshot.fadeMs}ms`,
    "--bubble-font-size": `${layout?.fontSize ?? 13}px`,
    "--bubble-tail-x": `${layout?.tailX ?? 14}px`,
    "--bubble-tail-y": `${layout?.tailY ?? 14}px`,
  } as CSSProperties
  return <div ref={bubbleRef} className={`bubble-shell dialogue-bubble${snapshot.visible && snapshot.text ? " speech-bubble" : ""}`} role="status" aria-live="polite" aria-atomic="true" aria-hidden={native || !granted || snapshot.phase === "exiting"} data-native={native} data-granted={granted} data-phase={snapshot.phase} data-trigger={snapshot.triggerId} data-side={layout?.side ?? "top"} style={style}>
    <span>{snapshot.text}</span>
  </div>
}
