import { SPEECH_OUTLINE_SIZE, speechOutlineFromPixels, type SpeechOutline } from "../../electron/shared/speech-outline"

/** Capture the opening silhouette once per line, refreshing only on resize. */
export class SpeechOutlineSampler {
  private readonly canvas = document.createElement("canvas")
  private readonly context: CanvasRenderingContext2D | null
  private sampledAt = -Infinity
  private sourceSize = ""
  private capturedSize = ""
  private outline: SpeechOutline | null = null

  constructor(private readonly source: HTMLCanvasElement) {
    this.canvas.width = this.canvas.height = SPEECH_OUTLINE_SIZE
    this.context = this.canvas.getContext("2d", { willReadFrequently: true })
  }

  read(): SpeechOutline | null {
    if (!this.context) return null
    const now = performance.now(), size = `${this.source.width}:${this.source.height}`
    if (size === this.capturedSize && this.outline) return this.outline
    if (size === this.sourceSize && now - this.sampledAt < 100) return this.outline
    this.sampledAt = now; this.sourceSize = size
    const n = SPEECH_OUTLINE_SIZE
    this.context.clearRect(0, 0, n, n)
    this.context.drawImage(this.source, 0, 0, n, n)
    const next = speechOutlineFromPixels(this.context.getImageData(0, 0, n, n).data)
    // A WebGL resize briefly clears the buffer; retain the previous normalized
    // outline until the next painted frame rather than moving the bubble away.
    if (next) {
      this.capturedSize = size
      if (!this.outline || next.some((value, i) => value !== this.outline![i])) this.outline = next
    }
    return this.outline
  }
}
