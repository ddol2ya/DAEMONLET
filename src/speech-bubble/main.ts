import type { SpeechBubbleFrame } from "../../electron/shared/bubble-presentation"
import { SPEECH_WINDOW_PADDING } from "../../electron/shared/speech-bubble"
import "../pet/speech-bubble.css"
import "./speech-bubble.css"

declare global {
  interface Window { petSpeech: { subscribe(listener: (frame: SpeechBubbleFrame | null) => void): () => void } }
}
const bubble = document.querySelector<HTMLElement>(".speech-bubble")!
bubble.style.left = `${SPEECH_WINDOW_PADDING}px`
bubble.style.top = `${SPEECH_WINDOW_PADDING}px`
window.petSpeech.subscribe(frame => {
  const phase = frame?.phase ?? "hidden"
  if (bubble.dataset.phase !== phase) bubble.dataset.phase = phase
  bubble.setAttribute("aria-hidden", String(!frame || frame.phase === "exiting"))
  if (!frame) return
  const text = bubble.querySelector("span")!
  if (text.textContent !== frame.content.text) text.textContent = frame.content.text
  bubble.style.width = `${frame.content.width}px`
  bubble.style.setProperty("--bubble-fade", `${frame.content.fadeMs}ms`)
})
