// Two horizontal edges per row on a normalized 128 × 128 canvas. No image
// content crosses IPC; -1/-1 marks a transparent row, x1 is exclusive.
export const SPEECH_OUTLINE_SIZE = 128
export type SpeechOutline = number[]

export function speechOutlineFromPixels(rgba: Uint8ClampedArray): SpeechOutline | null {
  const n = SPEECH_OUTLINE_SIZE, outline: number[] = []
  let visible = false
  for (let y = 0; y < n; y++) {
    let left = -1, right = -1
    for (let x = 0; x < n; x++) if (rgba[(y * n + x) * 4 + 3] >= 8) {
      if (left === -1) left = x
      right = x + 1; visible = true
    }
    outline.push(left, right)
  }
  return visible ? outline : null
}

export function validSpeechOutline(value: unknown): value is SpeechOutline {
  if (!Array.isArray(value) || value.length !== SPEECH_OUTLINE_SIZE * 2) return false
  for (let i = 0; i < value.length; i += 2) {
    const left = value[i], right = value[i + 1]
    if (left === -1 && right === -1) continue
    if (!Number.isInteger(left) || !Number.isInteger(right) || left < 0 || right > SPEECH_OUTLINE_SIZE || right <= left) return false
  }
  return true
}
