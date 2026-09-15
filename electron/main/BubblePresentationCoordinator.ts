import { BUBBLE_RETURN_DELAY_MS, type BubbleAnchor, type BubblePermit, type PetBubblePresentation, type SpeechBubbleFrame } from "../shared/bubble-presentation"

type Clock = { setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(timer: ReturnType<typeof setTimeout>): void }

/** Display arbitration only: never mutates activity, selection, dialogue or dictation. */
export class BubblePresentationCoordinator {
  private chatVisible = false
  get sideChatVisible() { return this.chatVisible }
  setSideChatVisible(value: boolean) { this.chatVisible = value; if (value) this.rejectPending(); this.changed() }
  private epoch = 0
  private sequence = 0
  private available = false
  private occupied = false
  private locked = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: { report: PetBubblePresentation; resolve: (value: BubblePermit) => void } | null = null
  anchor: BubbleAnchor | null = null
  speech: SpeechBubbleFrame | null = null
  constructor(private readonly changed: () => void, private readonly clock: Clock = { setTimeout, clearTimeout }) {}

  get canShowActivity(): boolean { return !this.chatVisible && this.available && !this.occupied }
  get interactionLocked(): boolean { return this.locked }
  begin(): number {
    this.cancelReturn(); this.rejectPending(); this.epoch++; this.sequence = 0
    this.available = false; this.occupied = false; this.anchor = null; this.speech = null
    this.changed(); return this.epoch
  }
  report(report: PetBubblePresentation): Promise<BubblePermit> {
    const permit = (granted: boolean): BubblePermit => ({ epoch: report.epoch, sequence: report.sequence, granted })
    if (this.chatVisible) return Promise.resolve(permit(false))
    if (report.epoch !== this.epoch || report.sequence <= this.sequence) return Promise.resolve(permit(false))
    this.sequence = report.sequence; this.rejectPending()
    this.available = report.available && report.anchor !== null; this.anchor = report.anchor
    this.speech = report.speech && this.available && (report.phase === "shown" || report.phase === "exiting")
      ? { content: report.speech, phase: report.phase } : null
    if (!this.available) {
      this.cancelReturn(); this.occupied = false; this.changed(); return Promise.resolve(permit(false))
    }
    if (report.phase === "hidden") {
      if (this.occupied && this.timer === null) this.timer = this.clock.setTimeout(() => { this.timer = null; this.occupied = false; this.changed() }, BUBBLE_RETURN_DELAY_MS)
      this.changed(); return Promise.resolve(permit(false))
    }
    this.cancelReturn()
    if (report.phase === "preparing" && this.locked && !this.occupied) {
      this.changed()
      return new Promise(resolve => { this.pending = { report, resolve } })
    }
    this.occupied = true
    // The callback synchronously hides the native activity window before the
    // invoking renderer receives permission to paint its dialogue.
    this.changed()
    return Promise.resolve(permit(true))
  }
  setInteractionLocked(locked: boolean): void {
    if (this.locked === locked) return
    this.locked = locked
    if (!locked && this.pending) {
      const { report, resolve } = this.pending; this.pending = null
      this.occupied = true; this.cancelReturn(); this.changed()
      resolve({ epoch: report.epoch, sequence: report.sequence, granted: true })
    } else this.changed()
  }
  private rejectPending(): void {
    if (!this.pending) return
    const { report, resolve } = this.pending; this.pending = null
    resolve({ epoch: report.epoch, sequence: report.sequence, granted: false })
  }
  private cancelReturn(): void { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null }
  dispose(): void { this.begin(); this.locked = false }
}
