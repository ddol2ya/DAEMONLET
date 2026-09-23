import {playChatGesture} from './ChatGesture'
import {resolveChatPose, neutralMeaning, type ChatPhase, type ChatMeaning} from '../../electron/shared/character-chat-semantics'
import type {LocalChatPresentation} from '../../electron/shared/character-chat-contract'
import type {CharacterSession} from '../runtime/CharacterSession'

export const CHAT_PREPARATION_DELAY_MS = 800
export const CHAT_PREPARATION_HOLD_MS = 900

export class ChatPresentationController {
  private controller: AbortController | null = null
  private preparationTimer: ReturnType<typeof setTimeout> | null = null
  private replyTimer: ReturnType<typeof setTimeout> | null = null
  private preparationReady: Promise<boolean> | null = null
  private preparationVisibleAt: number | null = null
  private preparationRequested = false
  private streamed = false
  private replyApplied = false
  private key = ''
  private previous: string | null = null
  private active = false
  private epoch = -1
  private generation = 0

  constructor(private session: CharacterSession) {}

  update(p: LocalChatPresentation, currentId: string | null, currentRevision: string | null) {
    if (p.epoch < this.epoch) return
    if (p.epoch !== this.epoch) {
      this.cancelPending()
      this.epoch = p.epoch
      this.replyApplied = false
      this.preparationRequested = false
      this.streamed = false
      this.key = ''
    }
    if (!p.active || p.characterId !== currentId || p.revision !== currentRevision) {
      this.reset()
      return
    }
    if (!this.active) {
      this.active = true
      this.session.behavior.setControlMode('MANUAL_POSE')
      this.session.behavior.setPresentationSuspended(true)
      this.session.setInteractionEnabled(false)
      this.session.dialogue.setEnabled(false)
      this.session.dialogue.clear()
      this.session.runtime.setChatMotionPolicy('chat-safe')
    }

    // Completed metadata remains authoritative, including input focus/blur.
    if (p.meaning) {
      this.clearPreparationTimer()
      if (this.replyApplied) return
      this.replyApplied = true
      const epoch = this.epoch
      const generation = this.generation
      const applyReply = () => {
        if (!this.active || epoch !== this.epoch || generation !== this.generation || !this.replyApplied) return
        const remaining = this.preparationVisibleAt === null ? 0
          : Math.max(0, CHAT_PREPARATION_HOLD_MS - (Date.now() - this.preparationVisibleAt))
        const apply = () => {
          this.replyTimer = null
          if (this.active && epoch === this.epoch && generation === this.generation && this.replyApplied) void this.applyPose(p, 'replying', p.meaning!)
        }
        if (remaining > 0) this.replyTimer = setTimeout(apply, remaining)
        else apply()
      }
      // Finish an already-started pose transition before its minimum hold.
      // The independent dialogue stream is never delayed by this timer.
      if (this.preparationReady) void this.preparationReady.then(applyReply)
      else applyReply()
      return
    }

    if (p.phase === 'replying') {
      this.streamed = true
      this.clearPreparationTimer()
      // No intermediate default pose between preparation and the validated reply.
      return
    }
    if (p.phase === 'generating') {
      if (this.preparationRequested || this.streamed) return
      this.preparationRequested = true
      const epoch = this.epoch
      const generation = this.generation
      this.preparationTimer = setTimeout(() => {
        this.preparationTimer = null
        if (!this.active || epoch !== this.epoch || generation !== this.generation || this.streamed) return
        this.preparationReady = this.applyPose(p, 'generating', neutralMeaning()).then(changed => {
          if (changed && this.active && epoch === this.epoch && generation === this.generation) this.preparationVisibleAt = Date.now()
          return changed
        })
      }, CHAT_PREPARATION_DELAY_MS)
      return
    }

    // Explicit cancellation, errors and mode changes bypass the minimum hold.
    const key = p.epoch + ':' + p.phase
    if (this.key === key) return
    this.key = key
    this.cancelPending()
    this.replyApplied = false
    void this.applyPose(p, p.phase, neutralMeaning())
  }

  private async applyPose(p: LocalChatPresentation, phase: ChatPhase, meaning: ChatMeaning): Promise<boolean> {
    this.controller?.abort()
    const ac = this.controller = new AbortController()
    const selected = resolveChatPose(p.definition, phase, meaning, this.previous)
    this.session.runtime.setChatMotionPolicy(selected.motionPolicy)
    const unchanged = selected.poseId === this.previous && this.session.runtime.getPoseDiagnostics().id === selected.poseId
    this.previous = selected.poseId
    try {
      if (!unchanged) {
        if (selected.poseId) await this.session.runtime.transitionToPose(selected.poseId, {signal: ac.signal})
        else await this.session.runtime.exitPose({signal: ac.signal})
      }
      if (ac.signal.aborted) return false
      if (p.meaning) playChatGesture(this.session.runtime, meaning, ac.signal)
      return !unchanged && selected.poseId !== null
    } catch {
      if (!ac.signal.aborted) {
        this.previous = null
        this.session.runtime.resetPose('chat visual fallback')
      }
      return false
    }
  }

  private clearPreparationTimer() {
    if (this.preparationTimer !== null) clearTimeout(this.preparationTimer)
    this.preparationTimer = null
  }

  private cancelPending() {
    ++this.generation
    this.clearPreparationTimer()
    if (this.replyTimer !== null) clearTimeout(this.replyTimer)
    this.replyTimer = null
    this.controller?.abort()
    this.preparationReady = null
    this.preparationVisibleAt = null
  }

  reset() {
    this.cancelPending()
    this.key = ''
    this.previous = null
    this.replyApplied = false
    this.preparationRequested = false
    this.streamed = false
    if (this.active) {
      this.active = false
      this.session.runtime.setChatMotionPolicy(null)
      this.session.behavior.setPresentationSuspended(false)
      this.session.behavior.setControlMode('AUTO_BEHAVIOR')
      this.session.setInteractionEnabled(true)
    }
  }

  dispose() { this.reset() }
}
