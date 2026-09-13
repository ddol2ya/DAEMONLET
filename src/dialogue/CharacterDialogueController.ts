import type { BehaviorLifecycleEvent } from "../behavior/BehaviorLifecycleEvent"
import type { CharacterStateSnapshot, Clock } from "../behavior/types"
import type { CharacterLifecycleEvent } from "../lifecycle/CharacterLifecycleEvent"
import type { MotionLifecycleEvent } from "../motion/orchestration/MotionLifecycleBus"
import { createDefaultDialogueProfile } from "./DefaultDialogueProfile"
import { parseDialogueManifest } from "./DialogueManifest"
import { mapBehaviorTrigger, mapLifecycleTrigger, mapMotionTrigger } from "./DialogueTriggerMapper"
import { isDialogueTriggerId, type DialogueDecision, type DialogueEntry, type DialogueHistoryEntry, type DialogueProfile, type DialogueSnapshot, type DialogueTriggerId } from "./types"

// Correlation stays inside the controller; snapshots/history deliberately project it out.
type RunOwner = { epoch: number; active: boolean; lastTaskTrigger: DialogueTriggerId | null }
type GestureOwner = { gestureId: number; interactionId: string; poseKey: string | null; active: boolean; consumed: boolean }
type DialogueScope =
  | { kind: "ambient" }
  | { kind: "preview"; epoch: number }
  | { kind: "pose"; key: string; revision: number }
  | { kind: "gesture"; gesture: GestureOwner }
  | { kind: "run" | "outcome"; owner: RunOwner }
  | { kind: "task"; owner: RunOwner; taskId: string; active: boolean }
type Presentation = { triggerId: DialogueTriggerId; text: string; priority: number; shownAt: number; hideAt: number; phase: "shown" | "exiting"; scope: DialogueScope }
type QueuedTrigger = { triggerId: DialogueTriggerId; at: number; scope: DialogueScope }
export const MAX_DIALOGUE_QUEUE_AGE_MS = 5000
const terminal = (id: DialogueTriggerId) => id === "run.failed" || id === "run.cancelled.user" || id.startsWith("run.completed.")

export class CharacterDialogueController {
  private profile = createDefaultDialogueProfile()
  private characterId: string | null = null
  private enabled = true
  private available = true
  private presentationPausedAt: number | null = null
  private disposed = false
  private current: Presentation | null = null
  private queue: QueuedTrigger[] = []
  private readonly cooldowns = new Map<DialogueTriggerId, number>()
  private recentLines: string[] = []
  private lastTaskTrigger: DialogueTriggerId | null = null
  private workEpoch = 0
  private poseKey: string | null = null
  private poseRevision = 0
  private interactionReturnPose: string | null = null
  private continuousOwner: GestureOwner | null = null
  private managedContinuousTriggers = new Set<DialogueTriggerId>()
  private readonly runOwners = new Map<string, RunOwner>()
  private nextAllowedAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerRevision = 0
  private history: DialogueHistoryEntry[] = []
  private suppressedCount = 0
  private lastDecision: DialogueDecision | null = null
  private readonly listeners = new Set<() => void>()
  private readonly clock: Clock
  private readonly random: () => number

  constructor(options: { clock?: Clock; random?: () => number } = {}) {
    this.clock = options.clock ?? { now: () => performance.now() }
    this.random = options.random ?? (() => Math.random())
  }

  configure(profile: DialogueProfile, characterId: string | null, managedContinuousTriggers: DialogueTriggerId[] = []): void {
    if (this.disposed) return
    this.clearPresentation()
    this.resetOwners()
    this.cooldowns.clear()
    this.recentLines = []
    this.history = []
    this.lastTaskTrigger = null
    this.continuousOwner = null
    this.managedContinuousTriggers = new Set(managedContinuousTriggers)
    this.poseKey = null
    this.interactionReturnPose = null
    this.poseRevision++
    this.suppressedCount = 0
    this.lastDecision = null
    this.characterId = characterId
    // Defend the one text ingress even when a caller constructs a profile directly.
    try {
      this.profile = profile.manifest ? { manifest: parseDialogueManifest(profile.manifest), warnings: [] } : createDefaultDialogueProfile()
    } catch {
      this.profile = createDefaultDialogueProfile()
    }
    this.emit()
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) this.clearPresentation()
    this.emit()
  }

  /** Hidden, loading, layout and error surfaces drop signals without replay on return. */
  setAvailable(available: boolean): void {
    if (this.disposed || this.available === available) return
    this.available = available
    if (!available) this.clearPresentation()
    this.emit()
  }

  /** Pauses only the current visual lifetime while another surface finishes input.
   * Trigger generation and owner invalidation continue normally. */
  setPresentationPaused(paused: boolean): void {
    if (this.disposed || paused === (this.presentationPausedAt !== null)) return
    if (paused) {
      this.presentationPausedAt = this.clock.now()
      if (this.current) this.cancelTimer()
    } else {
      const delay = this.clock.now() - this.presentationPausedAt!
      this.presentationPausedAt = null
      if (this.current) {
        const current = this.current
        current.hideAt += delay
        if (current.phase === "shown") this.schedule(current.hideAt, () => this.beginExit(current))
        else this.schedule(this.clock.now() + (this.profile.manifest?.settings.fadeMs ?? 0), () => this.finishExit(current))
      }
    }
  }

  handleLifecycle(event: CharacterLifecycleEvent, semantic: CharacterStateSnapshot): void {
    if (this.disposed) return
    // Pose-bound characters speak when the matching artwork is visible. This
    // avoids duplicate lifecycle cues and stale task text during a transition.
    if (this.profile.manifest?.poseTriggers) return
    if (event.type === "snapshot.applied") {
      this.resetOwners()
      this.syncOwners(semantic.activeTaskIds)
      this.clear("snapshot")
      return
    }
    let scope: DialogueScope
    if (event.type === "run.started") {
      if (!semantic.lastEventAccepted || !semantic.activeTaskIds.includes(event.runId) || this.runOwners.has(event.runId)) return
      if (!this.runOwners.size || semantic.activeTaskIds.length === 1) this.beginWorkPeriod()
      this.syncOwners(semantic.activeTaskIds)
      scope = { kind: "run", owner: this.runOwners.get(event.runId)! }
    } else if ("taskId" in event) {
      if (!semantic.activeTaskIds.includes(event.runId)) return
      this.syncOwners(semantic.activeTaskIds)
      const owner = this.runOwners.get(event.runId)!
      if (event.type !== "task.started") {
        for (const item of [...(this.current ? [this.current] : []), ...this.queue]) {
          if (item.scope.kind === "task" && item.scope.owner === owner && item.scope.taskId === event.taskId) item.scope.active = false
        }
        this.invalidatePresentation()
        return
      }
      scope = { kind: "task", owner, taskId: event.taskId, active: true }
    } else {
      const expected = event.type === "run.completed" ? "TASK_COMPLETED" : event.type === "run.failed" ? "TASK_FAILED" : "TASK_CANCELLED"
      // Recognize non-final terminals too, while rejecting late/unknown cancellation cleanup.
      const last = semantic.lastEvent
      if (!semantic.lastEventAccepted || last?.type !== expected || !("taskId" in last) || last.taskId !== event.runId) return
      const owner = this.runOwners.get(event.runId) ?? { epoch: this.workEpoch, active: true, lastTaskTrigger: null }
      owner.active = false
      this.runOwners.delete(event.runId)
      this.syncOwners(semantic.activeTaskIds)
      scope = { kind: "outcome", owner }
    }
    // Lifetime invalidation precedes cooldown, probability and priority selection.
    this.invalidatePresentation()
    const id = mapLifecycleTrigger(event, semantic)
    if (event.type === "run.cancelled" && event.reason !== "user-interrupted" && event.reason !== "interrupted") {
      this.decide(null, "internal-cancel")
      return
    }
    if (id) {
      this.trigger(id, scope)
    }
  }

  handleBehavior(event: BehaviorLifecycleEvent): void {
    if (this.disposed) return
    if (event.type === "continuous.changed") {
      const id = event.interactionId === "PET" ? "interaction.pet" : "interaction.face-hold"
      if (!this.managedContinuousTriggers.has(id)) return
      const matches = this.continuousOwner?.gestureId === event.gestureId && this.continuousOwner.interactionId === event.interactionId
      if (event.phase === "ended") {
        if (matches) {
          this.continuousOwner!.active = false
          this.continuousOwner = null
          this.invalidatePresentation()
        }
        return
      }
      // Only an accepted gesture can activate; a late ready signal cannot
      // resurrect one that already ended or belongs to a previous model.
      if (event.phase === "active" && !matches) return
      if (!matches) {
        if (this.continuousOwner) this.continuousOwner.active = false
        this.continuousOwner = { gestureId: event.gestureId, interactionId: event.interactionId, poseKey: event.poseId, active: true, consumed: false }
        this.invalidatePresentation()
      }
      if (event.phase === "active" && !this.continuousOwner!.consumed) {
        this.continuousOwner!.consumed = true
        this.nextAllowedAt = 0
        this.trigger(id, { kind: "gesture", gesture: this.continuousOwner! })
      }
      return
    }
    if (this.profile.manifest?.poseTriggers) return
    const id = mapBehaviorTrigger(event)
    if (id) this.trigger(id)
  }

  handleMotion(event: MotionLifecycleEvent): void {
    const id = mapMotionTrigger(event)
    if (!id || this.managedContinuousTriggers.has(id)) return
    const poses = this.profile.manifest?.poseTriggers
    if (poses && Object.values(poses).includes(id)) {
      if (this.poseKey && poses[this.poseKey] === id) this.trigger(id, { kind: "pose", key: this.poseKey, revision: this.poseRevision })
      return
    }
    this.trigger(id)
  }

  /** Called only for a settled visible pose, including direct pose switches. */
  setPoseContext(poseId: string | null): void {
    if (this.disposed || !this.profile.manifest?.poseTriggers) return
    const key = poseId ?? "base"
    if (this.poseKey === key) return
    const poses = this.profile.manifest.poseTriggers
    const isInteraction = (pose: string | null) => pose !== null && poses[pose]?.startsWith("interaction.")
    if (isInteraction(key) && !isInteraction(this.poseKey)) this.interactionReturnPose = this.poseKey
    const returning = !isInteraction(key) && key === this.interactionReturnPose
    if (!isInteraction(key)) this.interactionReturnPose = null
    this.poseKey = key
    this.poseRevision++
    this.invalidatePresentation()
    this.nextAllowedAt = 0
    const id = this.profile.manifest.poseTriggers[key]
    if (id && !returning && !this.managedContinuousTriggers.has(id)) this.trigger(id, { kind: "pose", key, revision: this.poseRevision })
  }

  triggerDebug(triggerId: DialogueTriggerId): void {
    this.trigger(triggerId, triggerId.startsWith("run.") || triggerId.startsWith("task.") ? { kind: "preview", epoch: this.workEpoch } : { kind: "ambient" })
  }

  clear(decision: "cleared" | "snapshot" = "cleared"): void {
    if (this.disposed) return
    this.clearPresentation()
    this.decide(null, decision)
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): DialogueSnapshot {
    return {
      enabled: this.isEnabled(), characterId: this.characterId,
      visible: this.current !== null, phase: this.current?.phase ?? "hidden",
      text: this.current?.text ?? null, triggerId: this.current?.triggerId ?? null, priority: this.current?.priority ?? null,
      shownAt: this.current?.shownAt ?? null, hideAt: this.current?.hideAt ?? null,
      fadeMs: this.profile.manifest?.settings.fadeMs ?? 0, queueLength: this.queue.length,
      suppressedCount: this.suppressedCount, lastDecision: this.lastDecision,
      history: this.history.map((entry) => ({ ...entry })), warnings: [...this.profile.warnings],
    }
  }

  /** Exporting the controller is equivalent to exporting its public diagnostics. */
  toJSON(): DialogueSnapshot { return this.getSnapshot() }

  dispose(): void {
    if (this.disposed) return
    this.clearPresentation()
    this.resetOwners()
    if (this.continuousOwner) this.continuousOwner.active = false
    this.continuousOwner = null
    this.managedContinuousTriggers.clear()
    this.disposed = true
    this.listeners.clear()
    this.cooldowns.clear()
    this.history = []
    this.recentLines = []
  }

  private isEnabled(): boolean { return !this.disposed && this.enabled && this.available && this.profile.manifest !== null }

  private trigger(id: DialogueTriggerId, scope: DialogueScope = { kind: "ambient" }): void {
    if (this.disposed) return
    // Runtime allowlist prevents diagnostics from accepting arbitrary IDs/text.
    if (!isDialogueTriggerId(id)) { this.decide(null, "unmapped"); return }
    if (!this.isEnabled()) { this.decide(id, "disabled"); return }
    if (!this.isScopeValid(scope)) return
    const entry = this.profile.manifest!.triggers[id]
    if (!entry) { this.decide(id, "missing-trigger"); return }
    const now = this.clock.now()
    if (now - (this.cooldowns.get(id) ?? -Infinity) < entry.cooldownMs) { this.decide(id, "cooldown"); return }
    const lastTaskTrigger = "owner" in scope ? scope.owner.lastTaskTrigger : this.lastTaskTrigger
    if (this.queue.some((item) => item.triggerId === id && this.sameOwner(item.scope, scope)) || id.startsWith("task.started.") && id === lastTaskTrigger) { this.decide(id, "duplicate"); return }
    if (entry.probability <= 0 || entry.probability < 1 && this.sampleRandom() >= entry.probability) { this.decide(id, "probability"); return }
    if (this.current) {
      if (entry.mode === "replace-lower" && entry.priority > this.current.priority) { this.show(id, entry, now, scope); return }
      if (entry.mode === "queue") { this.enqueue(id, now, scope); return }
      this.decide(id, "lower-priority")
      return
    }
    // Terminal outcomes need immediate feedback even in the global quiet gap.
    if (now < this.nextAllowedAt && !terminal(id)) {
      if (entry.mode !== "drop-if-busy") this.enqueue(id, now, scope)
      else this.decide(id, "global-gap")
      return
    }
    this.show(id, entry, now, scope)
  }

  private show(id: DialogueTriggerId, entry: DialogueEntry, now: number, scope: DialogueScope): void {
    this.cancelTimer()
    const manifest = this.profile.manifest!
    const pose = scope.kind === "pose" ? scope.key : scope.kind === "gesture" ? scope.gesture.poseKey : null
    const lines = pose && manifest.poseTriggers?.[pose] === id ? manifest.poseLines?.[pose] ?? entry.lines : entry.lines
    let candidates = lines.filter((line) => !this.recentLines.includes(line))
    if (!candidates.length) candidates = lines.filter((line) => line !== this.recentLines.at(-1))
    if (!candidates.length) candidates = lines
    const text = candidates[Math.floor(this.sampleRandom() * candidates.length)]
    const presentation: Presentation = { triggerId: id, text, priority: entry.priority, shownAt: now, hideAt: now + (entry.displayMs ?? this.profile.manifest!.settings.defaultDisplayMs), phase: "shown", scope }
    this.current = presentation
    this.cooldowns.set(id, now)
    // Always remember the last line, including when repeatMemory is zero.
    this.recentLines.push(text)
    this.recentLines = this.recentLines.slice(-Math.max(1, this.profile.manifest!.settings.repeatMemory))
    if (id.startsWith("task.started.")) {
      if ("owner" in scope) scope.owner.lastTaskTrigger = id
      else this.lastTaskTrigger = id
    }
    if (this.presentationPausedAt === null) this.schedule(presentation.hideAt, () => this.beginExit(presentation))
    else this.presentationPausedAt = now
    this.decide(id, "shown", text)
  }

  private enqueue(id: DialogueTriggerId, now: number, scope: DialogueScope): void {
    this.pruneQueue(now)
    if (this.queue.length >= this.profile.manifest!.settings.maxQueueSize) { this.decide(id, "queue-full"); return }
    this.queue.push({ triggerId: id, at: now, scope })
    if (!this.current) this.schedule(this.nextAllowedAt, () => this.drain())
    this.decide(id, "queued")
  }

  private beginExit(presentation: Presentation): void {
    if (this.current !== presentation || !this.isEnabled()) return
    presentation.phase = "exiting"
    this.schedule(this.clock.now() + this.profile.manifest!.settings.fadeMs, () => this.finishExit(presentation))
    this.emit()
  }

  private finishExit(presentation: Presentation): void {
    if (this.current !== presentation) return
    this.current = null
    this.nextAllowedAt = this.clock.now() + this.profile.manifest!.settings.minGapMs
    if (this.queue.length) this.schedule(this.nextAllowedAt, () => this.drain())
    this.emit()
  }

  private drain(): void {
    if (!this.isEnabled() || this.current) return
    const now = this.clock.now()
    this.pruneQueue(now)
    while (this.queue.length) {
      const item = this.queue.shift()!
      const entry = this.profile.manifest!.triggers[item.triggerId]
      if (!entry || !this.isScopeValid(item.scope)) continue
      if (now - (this.cooldowns.get(item.triggerId) ?? -Infinity) < entry.cooldownMs) { this.decide(item.triggerId, "cooldown"); continue }
      this.show(item.triggerId, entry, now, item.scope)
      return
    }
    this.emit()
  }

  private pruneQueue(now: number): void {
    const stale = this.queue.filter((item) => now - item.at >= MAX_DIALOGUE_QUEUE_AGE_MS)
    this.queue = this.queue.filter((item) => this.isScopeValid(item.scope) && now - item.at < MAX_DIALOGUE_QUEUE_AGE_MS)
    for (const item of stale) this.decide(item.triggerId, "expired")
  }

  private clearPresentation(): void {
    this.cancelTimer()
    this.current = null
    this.queue = []
    this.nextAllowedAt = 0
  }

  private cancelTimer(): void {
    this.timerRevision++
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(at: number, callback: () => void): void {
    this.cancelTimer()
    const revision = this.timerRevision
    this.timer = setTimeout(() => {
      if (this.disposed || revision !== this.timerRevision) return
      this.timer = null
      callback()
    }, Math.max(0, at - this.clock.now()))
  }

  private beginWorkPeriod(): void {
    this.workEpoch++
    this.lastTaskTrigger = null
    this.nextAllowedAt = 0
    // Start/progress/interaction cooldowns remain global; outcomes belong to one work period.
    for (const id of this.cooldowns.keys()) if (terminal(id)) this.cooldowns.delete(id)
  }

  private resetOwners(): void {
    for (const owner of this.runOwners.values()) owner.active = false
    this.runOwners.clear()
    this.beginWorkPeriod()
  }

  private syncOwners(activeRunIds: string[]): void {
    const active = new Set(activeRunIds)
    for (const [id, owner] of this.runOwners) {
      if (!active.has(id)) { owner.active = false; this.runOwners.delete(id) }
    }
    for (const id of active) {
      if (!this.runOwners.has(id)) this.runOwners.set(id, { epoch: this.workEpoch, active: true, lastTaskTrigger: null })
    }
  }

  private isScopeValid(scope: DialogueScope): boolean {
    if (scope.kind === "ambient") return true
    if (scope.kind === "preview") return scope.epoch === this.workEpoch
    if (scope.kind === "gesture") return scope.gesture.active && scope.gesture === this.continuousOwner
    if (scope.kind === "pose") return scope.key === this.poseKey && scope.revision === this.poseRevision
    return scope.owner.epoch === this.workEpoch && (scope.kind === "outcome" || scope.owner.active) && (scope.kind !== "task" || scope.active)
  }

  private sameOwner(left: DialogueScope, right: DialogueScope): boolean {
    if (left.kind === "gesture" && right.kind === "gesture") return left.gesture === right.gesture
    if ("owner" in left && "owner" in right) return left.owner === right.owner
    return left.kind === right.kind && !("owner" in left) && !("owner" in right)
  }

  private invalidatePresentation(): void {
    const oldLength = this.queue.length
    this.queue = this.queue.filter(item => this.isScopeValid(item.scope))
    const current = this.current
    const removed = current && !this.isScopeValid(current.scope)
    if (removed) {
      this.cancelTimer()
      this.current = null
      // Preserve the remaining Run's original queue deadline within the same period.
      const epoch = "owner" in current.scope ? current.scope.owner.epoch : current.scope.kind === "preview" ? current.scope.epoch : this.workEpoch
      if (epoch === this.workEpoch) this.nextAllowedAt = Math.max(this.nextAllowedAt, current.hideAt + (this.profile.manifest?.settings.fadeMs ?? 0) + (this.profile.manifest?.settings.minGapMs ?? 0))
    }
    if (!this.current) {
      if (this.queue.length) this.schedule(this.nextAllowedAt, () => this.drain())
      else this.cancelTimer()
    }
    if (removed || this.queue.length !== oldLength) this.decide(null, "cleared")
  }

  private sampleRandom(): number {
    const value = this.random()
    return Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0
  }

  private decide(triggerId: DialogueTriggerId | null, decision: DialogueDecision, text: string | null = null): void {
    this.lastDecision = decision
    if (!["shown", "queued", "cleared", "snapshot"].includes(decision)) this.suppressedCount++
    this.history.push({ at: this.clock.now(), triggerId, decision, text })
    if (this.history.length > 64) this.history.shift()
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* Rendering failure cannot change behavior or protocol state. */ }
    }
  }
}
