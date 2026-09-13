import { validSpeechOutline, type SpeechOutline } from "./speech-outline"

/** Only local geometry, presentation state and authored dialogue cross this bridge. */
export type BubbleAnchor = { x0: number; y0: number; x1: number; y1: number }
export type SpeechBubbleContent = { text: string; width: number; height: number; fadeMs: number; outline?: SpeechOutline }
export type SpeechBubbleFrame = { content: SpeechBubbleContent; phase: "shown" | "exiting" }
export type PetBubblePresentation = {
  epoch: number
  sequence: number
  available: boolean
  phase: "hidden" | "preparing" | "shown" | "exiting"
  anchor: BubbleAnchor | null
  speech?: SpeechBubbleContent
}
export type BubblePermit = { epoch: number; sequence: number; granted: boolean }
export type BubblePresentationApi = {
  begin(): Promise<number>
  report(value: PetBubblePresentation): Promise<BubblePermit>
}
export const BUBBLE_IPC = { begin: "bubble:begin", report: "bubble:report", interaction: "bubble:interaction", pointer: "bubble:pointer", height: "bubble:height", speech: "bubble:speech" } as const
// Allow the renderer's hidden frame to commit without a perceptible empty gap.
export const BUBBLE_RETURN_DELAY_MS = 32

export function validatePetBubblePresentation(v: unknown): PetBubblePresentation | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (Object.keys(r).filter(key => key !== "speech").sort().join() !== "anchor,available,epoch,phase,sequence" || !Number.isSafeInteger(r.epoch) || (r.epoch as number) < 1 || !Number.isSafeInteger(r.sequence) || (r.sequence as number) < 1 || typeof r.available !== "boolean" || typeof r.phase !== "string" || !["hidden", "preparing", "shown", "exiting"].includes(r.phase)) return null
  if ("speech" in r) {
    const s = r.speech as SpeechBubbleContent | null
    if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).filter(key => key !== "outline").sort().join() !== "fadeMs,height,text,width"
      || typeof s.text !== "string" || !s.text.trim() || [...s.text].length > 36
      || !Number.isInteger(s.width) || s.width < 24 || s.width > 240
      || !Number.isInteger(s.height) || s.height < 24 || s.height > 240
      || !Number.isFinite(s.fadeMs) || s.fadeMs < 0 || s.fadeMs > 300) return null
    if ("outline" in s && !validSpeechOutline(s.outline)) return null
  }
  if (r.anchor !== null) {
    if (!r.anchor || typeof r.anchor !== "object" || Array.isArray(r.anchor)) return null
    const a = r.anchor as BubbleAnchor
    if (Object.keys(a).sort().join() !== "x0,x1,y0,y1" || !Object.values(a).every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) || a.x1 <= a.x0 || a.y1 <= a.y0) return null
  }
  return r as PetBubblePresentation
}
