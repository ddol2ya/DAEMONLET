import type { ContinuousInteractionId, PointerGestureSignal } from "../interaction/types"
import { sampleMotionEnvelope } from "../motion/MotionSampler"
import type { Anime25DParameterState } from "../engine/anime25d/types"
import type { PoseRuntimeDiagnostics } from "../pose/types"
import { blendBehaviorParameters, sampleBehaviorMotion } from "./BehaviorMotion"
import { CharacterStateMachine } from "./CharacterStateMachine"
import { isUserInterruption } from "../lifecycle/isUserInterruption"
import { IdleActionScheduler, type RandomSource } from "./IdleActionScheduler"
import { PoseVariantSelector } from "./PoseVariantSelector"
import type { TaskEventSource } from "./TaskEventSource"
import type {
  BehaviorAction,
  ContinuousReaction,
  BehaviorControlMode,
  BehaviorHistoryEntry,
  BehaviorPoseLoadStatus,
  BehaviorProfile,
  BehaviorStateDefinition,
  CharacterBehaviorDiagnostics,
  CharacterStateSnapshot,
  CharacterTaskEvent,
  Clock,
} from "./types"
import { behaviorStateDefinition, validateBehaviorPoseIds } from "./BehaviorManifest"
import type { BehaviorLifecycleEvent } from "./BehaviorLifecycleEvent"

export interface CharacterBehaviorRuntime {
  loadPoseById(id: string): Promise<unknown>
  transitionToPose?(id: string, options?: { waitUntil?: "STARTED" | "ACTIVE_LOOP"; signal?: AbortSignal; timeoutMs?: number; cancelOnAbort?: boolean; restartMotion?: boolean }): Promise<void>
  enterPose(id?: string, options?: { waitUntil?: "STARTED" | "ACTIVE_LOOP"; signal?: AbortSignal; timeoutMs?: number; restartMotion?: boolean }): Promise<void>
  exitPose(options?: { waitUntil?: "STARTED" | "BASE"; signal?: AbortSignal; timeoutMs?: number }): void | Promise<void>
  cancelPendingPoseLoad?(reason?: string): void
  getActivePoseId(): string | null
  getPoseDiagnostics(): Pick<PoseRuntimeDiagnostics, "id" | "loadStatus" | "state">
  setBehaviorGazeTakeover?(enabled: boolean): void
  setBehaviorSemanticState?(state: CharacterStateSnapshot["state"]): void
  setBehaviorStateParameters(values: Partial<Anime25DParameterState>, ownerId?: string, weight?: number): void
  setBehaviorActionParameters(values: Partial<Anime25DParameterState>, ownerId?: string, weight?: number): void
  clearBehaviorStateParameters(ownerId?: string): void
  clearBehaviorActionParameters(ownerId?: string): void
}

type ControllerOptions = {
  clock: Clock & { advance?(ms: number): void }
  random?: RandomSource
  availablePoseIds?: Iterable<string>
}

type RunningAction = {
  action: BehaviorAction; startedAt: number; kind: "bored" | "transient" | "continuous"; interactionId?: string; poseStartedAt?: number
  continuous?: { gestureId: number; interactionId: ContinuousInteractionId; definition: ContinuousReaction; scale: number; releasedAt?: number }
}
let nextBehaviorControllerId = 1

export class CharacterBehaviorController {
  private readonly ownerId = `behavior-controller:${nextBehaviorControllerId++}`
  private profile: BehaviorProfile
  private readonly clock: ControllerOptions["clock"]
  private readonly scheduler: IdleActionScheduler
  private readonly variants: PoseVariantSelector
  private availablePoseIds = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly lifecycleListeners = new Set<(event: BehaviorLifecycleEvent) => void>()
  private disconnectSource: (() => void) | null = null
  private controlMode: BehaviorControlMode = "AUTO_BEHAVIOR"
  private poseLoadStatus: BehaviorPoseLoadStatus = "idle"
  private visualWarning: string | null = null
  private visualRevision = 0
  private pendingPoseId: string | null = null
  private poseWaitController: AbortController | null = null
  private disposed = false
  private running = false
  private animationFrame = 0
  private lastEmitAt = Number.NEGATIVE_INFINITY
  private semantic: CharacterStateSnapshot
  private blendFrom: Partial<Anime25DParameterState> = {}
  private blendStartedAt = 0
  private stateParameters: Partial<Anime25DParameterState> = {}
  private actionParameters: Partial<Anime25DParameterState> = {}
  private runningAction: RunningAction | null = null
  private pendingTap: "HEAD_TAP" | "TORSO_TAP" | null = null
  private pointerGestureId: number | null = null
  private pointerGestureBlocked = false
  private connected = true
  private transitionHistory: BehaviorHistoryEntry[] = []
  private manifestWarnings: string[] = []
  private statePoseId: string | null = null
  private statePoseReadyAt: number | null = null

  constructor(
    private readonly runtime: CharacterBehaviorRuntime,
    readonly machine: CharacterStateMachine,
    profile: BehaviorProfile,
    options: ControllerOptions,
  ) {
    this.profile = profile
    this.runtime.setBehaviorGazeTakeover?.(profile.gazeTakeoverFromCurrent ?? false)
    this.clock = options.clock
    this.scheduler = new IdleActionScheduler(options.random)
    this.variants = new PoseVariantSelector(options.random)
    this.availablePoseIds = new Set(options.availablePoseIds ?? [])
    this.semantic = machine.getSnapshot()
    this.selectStatePose()
    this.runtime.setBehaviorSemanticState?.(this.semantic.state)
    this.blendStartedAt = this.clock.now()
    this.refreshManifestWarnings()
    this.recordTransition(this.semantic)
    this.reconcilePose(this.semantic)
  }

  connect(source: TaskEventSource): () => void {
    this.disconnectSource?.()
    this.setConnected(true)
    // Sources can use a different clock (including the Lab's debug offset).
    // Semantic durations always start at receipt on this controller's clock.
    this.disconnectSource = source.subscribe((event) => this.dispatch({ ...event, at: this.clock.now() }))
    return () => {
      this.disconnectSource?.()
      this.disconnectSource = null
    }
  }

  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.animationFrame = requestAnimationFrame(this.onFrame)
  }

  stop(): void {
    this.running = false
    if (this.animationFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.animationFrame)
    this.animationFrame = 0
  }

  dispatch(event: CharacterTaskEvent): CharacterStateSnapshot {
    if (this.disposed) return this.semantic
    if (event.type === "CONNECTION_CHANGED") this.setConnected(event.connected)
    const previousTasks = JSON.stringify([this.semantic.activeTaskIds, this.semantic.waitingTaskIds])
    const snapshot = this.machine.dispatch(event)
    const sameSemanticState = snapshot.state === this.semantic.state && snapshot.stateSince === this.semantic.stateSince
    const workChanged = snapshot.lastEventAccepted && ["TASK_STARTED", "TASK_WAITING", "TASK_RESUMED", "TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED", "RESET"].includes(event.type) || snapshot.lastEventAccepted && event.type === "TASK_SNAPSHOT" && previousTasks !== JSON.stringify([snapshot.activeTaskIds, snapshot.waitingTaskIds])
    if (workChanged) this.pendingTap = null
    const interrupted = workChanged && this.runningAction?.kind === "continuous"
    if (interrupted) this.clearAction()
    this.acceptSnapshot(snapshot)
    if (interrupted && sameSemanticState) this.reconcilePose(snapshot)
    this.updateVisuals(this.clock.now())
    this.emit()
    return snapshot
  }

  /** Returns true when this profile owns the continuous signal, even if blocked. */
  handlePointerGesture(signal: PointerGestureSignal): boolean {
    if (this.disposed) return false
    if (signal.type === "begin") {
      this.pendingTap = null
      this.cancelContinuousInteraction("new-press")
      this.pointerGestureId = signal.gestureId
      this.pointerGestureBlocked = false
      return false
    }
    if (signal.type === "end") {
      if (signal.gestureId === this.pointerGestureId) {
        this.finishContinuous(signal.reason === "released")
        this.pointerGestureId = null
        this.pointerGestureBlocked = false
      }
      return false
    }
    const definition = this.profile.continuousReactions?.[signal.interactionId]
    if (!definition) return false
    if (signal.gestureId !== this.pointerGestureId) return true
    if (signal.phase === "end") {
      if (this.runningAction?.continuous?.interactionId === signal.interactionId) this.finishContinuous(true)
      return true
    }
    if (signal.phase !== "start" || this.pointerGestureBlocked) return true
    if (!this.connected || this.controlMode !== "AUTO_BEHAVIOR" || this.semantic.state === "HAPPY"
      || this.runningAction?.kind === "transient" && !this.runningAction.interactionId) {
      this.pointerGestureBlocked = true
      return true
    }
    if (this.runningAction?.continuous?.gestureId === signal.gestureId && this.runningAction.continuous.releasedAt === undefined) return true
    const working = this.semantic.state === "BUSY" || this.semantic.state === "WAITING"
    const poseId = definition.poseId
    if (poseId && !this.availablePoseIds.has(poseId)) {
      this.pointerGestureBlocked = true
      this.visualWarning = `Continuous ${signal.interactionId} pose '${poseId}' is unavailable.`
      this.emit()
      return true
    }
    const replacedPoseId = this.runningAction?.action.poseId
    this.clearAction()
    const now = this.clock.now()
    this.startAction({
      kind: "continuous", startedAt: now,
      action: { id: `continuous-${signal.interactionId.toLowerCase()}`, durationMs: definition.motion.loopDurationMs, motion: definition.motion, ...(poseId ? { poseId } : {}) },
      ...(poseId ? {} : { poseStartedAt: now }),
      continuous: { gestureId: signal.gestureId, interactionId: signal.interactionId, definition, scale: working && !poseId ? definition.workScale : 1 },
    })
    this.emitContinuous("pending")
    if (!poseId) this.emitContinuous("active")
    // A facial-only reaction must release the previous action's pose or pending request.
    if (poseId || replacedPoseId) this.reconcilePose(this.semantic)
    this.updateVisuals(now)
    this.emit()
    return true
  }

  cancelContinuousInteraction(_reason: string): void {
    this.pointerGestureBlocked = true
    if (this.runningAction?.kind !== "continuous") return
    const controlledPose = Boolean(this.runningAction.action.poseId)
    this.clearAction()
    if (controlledPose) this.reconcilePose(this.semantic)
    this.emit()
  }

  getContinuousInteraction() {
    const running = this.runningAction
    if (!running?.continuous) return null
    return { gestureId: running.continuous.gestureId, interactionId: running.continuous.interactionId,
      phase: running.continuous.releasedAt !== undefined ? "releasing" : running.poseStartedAt === undefined ? "loading" : "active" }
  }

  private finishContinuous(smooth: boolean): void {
    const running = this.runningAction
    if (!running?.continuous || running.continuous.releasedAt !== undefined) return
    if (!smooth || running.poseStartedAt === undefined || running.continuous.definition.releaseMs === 0) {
      this.cancelContinuousInteraction("pointer-ended")
      return
    }
    running.continuous.releasedAt = this.clock.now()
    this.emitContinuous("ended")
    if (running.action.poseId) this.reconcilePose(this.semantic)
    this.updateVisuals(this.clock.now())
    this.emit()
  }

  private emitContinuous(phase: "pending" | "active" | "ended", running = this.runningAction): void {
    if (!running?.continuous) return
    this.emitLifecycle({ type: "continuous.changed", gestureId: running.continuous.gestureId,
      interactionId: running.continuous.interactionId, phase, poseId: running.action.poseId ?? null, at: this.clock.now() })
  }

  triggerInteraction(id: string): void {
    if (this.disposed || this.controlMode !== "AUTO_BEHAVIOR" || !this.connected) return
    if (id !== "HEAD_TAP" && id !== "TORSO_TAP") return
    const action = this.profile.interactionReactions?.[id]
    if (!action) return
    this.dispatch({ type: "USER_ACTIVITY", source: "pointer" })
    if (this.tapIsSettling(this.clock.now())) { this.pendingTap = id; return }
    this.clearAction()
    this.startAction({ action, startedAt: this.clock.now(), kind: "transient", interactionId: id }, `interaction:${id}`)
    this.reconcilePose(this.semantic)
    this.updateVisuals(this.clock.now())
    this.emit()
  }

  cancelInteractionReaction(): void {
    this.pendingTap = null
    if (this.runningAction?.kind !== "transient" || !this.runningAction.interactionId) return
    this.clearAction()
    this.reconcilePose(this.semantic)
    this.emit()
  }

  tick(now = this.clock.now()): CharacterStateSnapshot {
    if (this.disposed) return this.semantic
    this.acceptSnapshot(this.machine.tick(now))
    if (this.pendingTap && !this.tapIsSettling(now)) {
      const id = this.pendingTap
      this.pendingTap = null
      this.triggerInteraction(id)
    }
    this.updateVisuals(now)
    if (now - this.lastEmitAt >= 120) this.emit()
    return this.semantic
  }

  configure(profile: BehaviorProfile, availablePoseIds: Iterable<string>, reset = true): CharacterStateSnapshot {
    this.profile = profile
    this.variants.clear()
    this.runtime.setBehaviorGazeTakeover?.(profile.gazeTakeoverFromCurrent ?? false)
    this.availablePoseIds = new Set(availablePoseIds)
    this.visualRevision++
    this.abortPoseWait("behavior profile changed")
    this.pendingPoseId = null
    this.runtime.cancelPendingPoseLoad?.("behavior profile changed")
    this.scheduler.cancel()
    this.clearAction()
    this.blendFrom = { ...this.stateParameters }
    this.blendStartedAt = this.clock.now()
    this.visualWarning = null
    this.refreshManifestWarnings()
    const snapshot = this.machine.configure(profile.timing, reset)
    this.semantic = snapshot
    this.selectStatePose()
    this.runtime.setBehaviorSemanticState?.(snapshot.state)
    this.transitionHistory = []
    this.recordTransition(snapshot)
    if (reset && this.controlMode === "AUTO_BEHAVIOR") void this.runtime.exitPose()
    this.reconcilePose(snapshot)
    this.updateVisuals(this.clock.now())
    this.emit()
    return snapshot
  }

  prepareForModelChange(): void {
    if (this.disposed) return
    this.pointerGestureBlocked = true
    this.visualRevision++
    this.abortPoseWait("model change")
    this.pendingPoseId = null
    this.availablePoseIds.clear()
    this.variants.clear()
    this.runtime.cancelPendingPoseLoad?.("model change")
    void this.runtime.exitPose()
    this.scheduler.cancel()
    this.clearAction()
    this.visualWarning = null
    this.refreshManifestWarnings()
    this.acceptSnapshot(this.machine.getSnapshot(), true)
    this.updateVisuals(this.clock.now())
    this.emit()
  }

  setControlMode(mode: BehaviorControlMode): void {
    if (mode === this.controlMode || this.disposed) return
    this.controlMode = mode
    this.pointerGestureBlocked = true
    this.clearAction()
    this.visualRevision++
    this.abortPoseWait("behavior control mode changed")
    this.pendingPoseId = null
    this.runtime.cancelPendingPoseLoad?.("behavior control mode changed")
    this.poseLoadStatus = mode === "MANUAL_POSE" ? "manual" : "idle"
    this.visualWarning = null
    if (mode === "AUTO_BEHAVIOR") {
      this.selectStatePose()
      this.reconcilePose(this.semantic)
    }
    this.emit()
  }

  advance(ms: number): CharacterStateSnapshot {
    if (!this.clock.advance) throw new Error("This behavior clock does not support debug advancement")
    this.clock.advance(ms)
    return this.tick(this.clock.now())
  }

  simulateIdleThreshold(): CharacterStateSnapshot {
    const now = this.clock.now()
    const remaining = Math.max(1, this.profile.timing.boredAfterMs - (now - this.semantic.lastActivityAt) + 1)
    return this.advance(remaining)
  }

  reset(): CharacterStateSnapshot {
    return this.dispatch({ type: "RESET" })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getProfile(): BehaviorProfile {
    return this.profile
  }

  subscribeLifecycle(listener: (event: BehaviorLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  getDiagnostics(): CharacterBehaviorDiagnostics {
    const pose = this.runtime.getPoseDiagnostics()
    const scheduler = this.scheduler.getSnapshot()
    return {
      controlMode: this.controlMode,
      semantic: this.machine.getSnapshot(),
      idleElapsedMs: Math.max(0, this.clock.now() - this.semantic.lastActivityAt),
      currentBoredAction: this.runningAction?.kind === "bored" ? this.runningAction.action.id : null,
      currentReaction: this.runningAction && this.runningAction.kind !== "bored" ? this.runningAction.action.id : null,
      connected: this.connected,
      desiredPoseId: this.desiredPoseId(),
      loadedPoseId: pose.id,
      activePoseId: this.runtime.getActivePoseId(),
      poseLoadStatus: this.poseLoadStatus,
      warning: this.visualWarning,
      stateParameters: { ...this.stateParameters },
      actionParameters: { ...this.actionParameters },
      transitionHistory: this.transitionHistory.map((entry) => ({ ...entry, activeTaskIds: [...entry.activeTaskIds] })),
      boredActionHistory: scheduler.history,
      manifestWarnings: [...this.manifestWarnings],
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.disconnectSource?.()
    this.disconnectSource = null
    this.visualRevision++
    this.abortPoseWait("behavior controller disposed")
    this.pendingPoseId = null
    this.scheduler.cancel()
    this.variants.clear()
    this.runtime.cancelPendingPoseLoad?.("behavior controller disposed")
    this.runtime.clearBehaviorStateParameters(this.ownerId)
    this.clearAction()
    this.listeners.clear()
    this.lifecycleListeners.clear()
    this.runningAction = null
  }

  private readonly onFrame = () => {
    if (!this.running || this.disposed) return
    this.tick(this.clock.now())
    this.animationFrame = requestAnimationFrame(this.onFrame)
  }

  private acceptSnapshot(snapshot: CharacterStateSnapshot, force = false): void {
    const previous = this.semantic.state
    const transitioned = force || snapshot.state !== this.semantic.state || snapshot.stateSince !== this.semantic.stateSince
    this.semantic = snapshot
    this.runtime.setBehaviorSemanticState?.(snapshot.state)
    if (!transitioned) return
    if (this.controlMode === "AUTO_BEHAVIOR" && (this.connected || force)) this.selectStatePose(snapshot)
    const now = this.clock.now()
    this.blendFrom = { ...this.stateParameters }
    this.blendStartedAt = now
    const idleTransition = (previous === "NORMAL" || previous === "BORED") && (snapshot.state === "NORMAL" || snapshot.state === "BORED")
    const preserveContinuous = !force && this.runningAction?.kind === "continuous" && idleTransition
    if (!preserveContinuous) this.clearAction()
    if (snapshot.state === "BORED") {
      this.scheduler.start(this.profile.states.BORED.actions ?? [], this.profile.timing, now)
    } else {
      this.scheduler.cancel()
    }
    if (!force && snapshot.state !== previous) {
      this.emitLifecycle({ type: "semantic.changed", previous, current: snapshot.state, reason: snapshot.transitionReason, at: now })
    }
    if (!force && this.connected && snapshot.transitionReason === "last-task-failed" && this.profile.failureReaction) {
      this.startAction({ action: this.profile.failureReaction, startedAt: now, kind: "transient" }, "failure")
    }
    if (!force && this.connected && snapshot.transitionReason === "last-task-cancelled" && this.profile.cancellationReaction
      && snapshot.lastEventAccepted && snapshot.lastEvent?.type === "TASK_CANCELLED" && isUserInterruption(snapshot.lastEvent.reason)) {
      this.startAction({ action: this.profile.cancellationReaction, startedAt: now, kind: "transient" }, "cancellation")
    }
    this.recordTransition(snapshot)
    if (!preserveContinuous) this.reconcilePose(snapshot)
  }

  private updateVisuals(now: number): void {
    this.rotateStatePose(now)
    this.updateStateMotion(now)
    this.updateActionMotion(now)
  }

  private updateStateMotion(now: number): void {
    const definition = this.stateDefinition()
    const poseActive = this.runtime.getActivePoseId() !== null
    const motion = this.connected && this.runningAction?.action.poseId && !this.runningAction.continuous ? undefined
      : this.statePoseId && !poseActive ? definition.fallbackMotion ?? definition.motion : definition.motion
    const target = sampleBehaviorMotion(motion, now - this.semantic.stateSince)
    const blendMs = this.profile.timing.stateBlendMs
    const progress = blendMs === 0 ? 1 : Math.min(1, Math.max(0, (now - this.blendStartedAt) / blendMs))
    const values = progress < 1 ? blendBehaviorParameters(this.blendFrom, target, progress) : target
    this.stateParameters = values
    const weight = sampleMotionEnvelope(motion, now - this.semantic.stateSince)
    if (Object.keys(values).length && weight > 0) this.runtime.setBehaviorStateParameters(values, this.ownerId, weight)
    else this.runtime.clearBehaviorStateParameters(this.ownerId)
  }

  private updateActionMotion(now: number): void {
    if (this.connected && this.semantic.state === "BORED" && (!this.runningAction || this.runningAction.kind === "bored")) {
      const scheduled = this.scheduler.tick(now)
      if (scheduled.current && scheduled.currentStartedAt !== null) {
        if (!this.runningAction || this.runningAction.action.id !== scheduled.current.id || this.runningAction.startedAt !== scheduled.currentStartedAt) {
          this.completeAction(now)
          this.startAction({ action: scheduled.current, startedAt: scheduled.currentStartedAt, kind: "bored" }, `bored:${scheduled.current.id}`)
          if (this.runningAction?.action.poseId) this.reconcilePose(this.semantic)
        }
      } else if (this.runningAction?.kind === "bored") {
        this.completeAction(now)
      }
    }

    const running = this.runningAction
    if (!running) {
      this.actionParameters = {}
      this.runtime.clearBehaviorActionParameters(this.ownerId)
      return
    }
    if (running.continuous) {
      const continuous = running.continuous
      const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x) }
      const elapsed = now - (running.poseStartedAt ?? now)
      const entered = running.poseStartedAt === undefined ? 0 : continuous.definition.enterMs === 0 ? 1 : smooth(elapsed / continuous.definition.enterMs)
      const released = continuous.releasedAt === undefined ? 1 : 1 - smooth((now - continuous.releasedAt) / continuous.definition.releaseMs)
      if (released <= 0) { this.clearAction(false); return }
      this.actionParameters = sampleBehaviorMotion(running.action.motion, elapsed)
      const weight = entered * released * continuous.scale
      if (weight > 0) this.runtime.setBehaviorActionParameters(this.actionParameters, this.ownerId, weight)
      else this.runtime.clearBehaviorActionParameters(this.ownerId)
      return
    }
    // A pose reaction gets its full hold time after entry, even on a cold PSD load.
    const elapsed = running.action.poseId ? running.poseStartedAt === undefined ? 0 : now - running.poseStartedAt : now - running.startedAt
    if (running.kind === "transient" && elapsed >= running.action.durationMs) {
      this.completeAction(now)
      return
    }
    if (running.action.poseId && this.runtime.getActivePoseId() !== null) {
      // Authored pose parameters already own this expression; do not add twice.
      this.actionParameters = {}
      this.runtime.clearBehaviorActionParameters(this.ownerId)
      return
    }
    this.actionParameters = sampleBehaviorMotion(running.action.motion, elapsed)
    const weight = sampleMotionEnvelope(running.action.motion, elapsed)
    if (weight > 0) this.runtime.setBehaviorActionParameters(this.actionParameters, this.ownerId, weight)
    else this.runtime.clearBehaviorActionParameters(this.ownerId)
  }

  private tapIsSettling(now: number): boolean {
    const running = this.runningAction
    if (!running?.interactionId || running.kind !== "transient") return false
    // Count from the visible pose, not the request: cold loading must not
    // consume the minimum hold. Rapid input replaces one pending tap.
    const enteredAt = running.action.poseId ? running.poseStartedAt : running.startedAt
    return enteredAt === undefined || now - enteredAt < Math.min(850, running.action.durationMs)
  }

  private clearAction(emitCancellation = true): void {
    this.pendingTap = null
    const running = this.runningAction
    this.runningAction = null
    this.actionParameters = {}
    this.runtime.clearBehaviorActionParameters(this.ownerId)
    if (running?.continuous) {
      this.pointerGestureBlocked = true
      if (running.continuous.releasedAt === undefined) this.emitContinuous("ended", running)
    }
    if (running && emitCancellation) this.emitLifecycle({ type: "action.cancelled", actionId: running.action.id, kind: running.kind, at: this.clock.now() })
  }

  private reconcilePose(snapshot: CharacterStateSnapshot): void {
    const revision = ++this.visualRevision
    this.abortPoseWait("pose request superseded")
    this.pendingPoseId = null
    if (this.controlMode !== "AUTO_BEHAVIOR") {
      this.poseLoadStatus = "manual"
      return
    }
    const desired = this.desiredPoseId(snapshot)
    if (!desired) {
      this.runtime.cancelPendingPoseLoad?.("semantic state no longer needs a pose")
      this.poseLoadStatus = "idle"
      this.visualWarning = null
      void this.runtime.exitPose()
      return
    }
    if (!this.availablePoseIds.has(desired)) {
      if (this.runningAction?.continuous) {
        this.clearAction()
        this.reconcilePose(snapshot)
        this.visualWarning = `Continuous pose '${desired}' is unavailable.`
        return
      }
      this.runtime.cancelPendingPoseLoad?.("requested pose is unavailable")
      void this.runtime.exitPose()
      this.poseLoadStatus = "fallback"
      this.visualWarning = `Pose '${desired}' is unavailable; using ${snapshot.state} parameter fallback.`
      if (this.runningAction?.action.poseId === desired) this.runningAction.poseStartedAt ??= this.clock.now()
      return
    }
    this.poseLoadStatus = "loading"
    this.visualWarning = null
    this.pendingPoseId = desired
    void this.ensurePose(desired, revision)
  }

  private startAction(running: RunningAction, variantOwner = running.action.id): void {
    this.runningAction = running.action.poseVariants?.length ? {
      ...running,
      action: { ...running.action, poseId: this.choosePose(variantOwner, running.action) ?? undefined },
    } : running
    this.emitLifecycle({ type: "action.started", actionId: running.action.id, kind: running.kind, at: running.startedAt })
  }

  private completeAction(at: number): void {
    const running = this.runningAction
    this.clearAction(false)
    if (running) this.emitLifecycle({ type: "action.completed", actionId: running.action.id, kind: running.kind, at })
    if (running?.action.poseId) this.reconcilePose(this.semantic)
  }

  private emitLifecycle(event: BehaviorLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try { listener(event) } catch { /* Presentation observers cannot interrupt animation. */ }
    }
  }

  private async ensurePose(poseId: string, revision: number): Promise<void> {
    let waitController: AbortController | null = null
    try {
      waitController = new AbortController()
      this.poseWaitController = waitController
      const replay = this.runningAction?.action.poseId === poseId ? { restartMotion: true } : {}
      if (this.runtime.transitionToPose) {
        await this.runtime.transitionToPose(poseId, { waitUntil: "ACTIVE_LOOP", signal: waitController.signal, cancelOnAbort: false, ...replay })
      } else {
        await this.runtime.loadPoseById(poseId)
        if (!this.isCurrentPoseRequest(poseId, revision)) return
        this.poseLoadStatus = "entering"
        this.emit()
        await this.runtime.enterPose(poseId, { waitUntil: "ACTIVE_LOOP", signal: waitController.signal, ...replay })
      }
      if (!this.isCurrentPoseRequest(poseId, revision)) return
      this.pendingPoseId = null
      this.poseLoadStatus = "ready"
      if (this.statePoseId === poseId && (!this.runningAction?.action.poseId || this.runningAction.continuous?.releasedAt !== undefined)) {
        this.statePoseReadyAt = this.clock.now()
      }
      if (this.runningAction?.action.poseId === poseId) {
        this.runningAction.poseStartedAt = this.clock.now()
        if (this.runningAction.continuous) this.emitContinuous("active")
      }
      this.blendFrom = { ...this.stateParameters }
      this.blendStartedAt = this.clock.now()
      this.updateStateMotion(this.clock.now())
      this.emit()
    } catch (error) {
      if (!this.isCurrentPoseRequest(poseId, revision)) return
      this.pendingPoseId = null
      if (error instanceof Error && error.name === "AbortError") {
        this.poseLoadStatus = "idle"
        this.visualWarning = null
        if (this.runningAction?.action.poseId === poseId) this.runningAction.poseStartedAt ??= this.clock.now()
        this.emit()
        return
      }
      if (this.runningAction?.continuous) {
        this.clearAction()
        this.reconcilePose(this.semantic)
        this.visualWarning = `Continuous pose '${poseId}' failed; the current task pose is preserved.`
        this.emit()
        return
      }
      this.poseLoadStatus = "fallback"
      this.visualWarning = `Pose '${poseId}' failed; using parameter fallback: ${error instanceof Error ? error.message : String(error)}`
      if (this.runningAction?.action.poseId === poseId) this.runningAction.poseStartedAt ??= this.clock.now()
      this.emit()
    } finally {
      if (waitController && this.poseWaitController === waitController) this.poseWaitController = null
    }
  }

  private isCurrentPoseRequest(poseId: string, revision: number): boolean {
    return !this.disposed
      && revision === this.visualRevision
      && this.pendingPoseId === poseId
      && this.controlMode === "AUTO_BEHAVIOR"
      && this.desiredPoseId() === poseId
  }

  private stateDefinition(snapshot = this.semantic): BehaviorStateDefinition {
    return !this.connected && this.profile.disconnected ? this.profile.disconnected : behaviorStateDefinition(this.profile, snapshot.state)
  }

  private choosePose(owner: string, definition: { poseId?: string | null; poseVariants?: string[] }): string | null {
    const primary = definition.poseId ?? null
    if (!definition.poseVariants?.length) return primary
    const available = [primary, ...definition.poseVariants].filter((id): id is string => id !== null && this.availablePoseIds.has(id))
    return this.variants.choose(owner, available) ?? primary
  }

  private selectStatePose(snapshot = this.semantic): void {
    const owner = !this.connected && this.profile.disconnected ? "disconnected" : `state:${snapshot.state}`
    this.statePoseId = this.choosePose(owner, this.stateDefinition(snapshot))
    this.statePoseReadyAt = null
  }

  private rotateStatePose(now: number): void {
    const definition = this.stateDefinition()
    const interval = definition.poseVariantIntervalMs
    if (!interval || !definition.poseVariants?.length || this.controlMode !== "AUTO_BEHAVIOR"
      || this.runningAction || this.pointerGestureId !== null || this.pendingPoseId || this.poseLoadStatus !== "ready"
      || this.statePoseReadyAt === null || now - this.statePoseReadyAt < interval) return
    const previous = this.statePoseId
    this.selectStatePose()
    if (this.statePoseId === previous) this.statePoseReadyAt = now
    else this.reconcilePose(this.semantic)
  }

  private desiredPoseId(_snapshot = this.semantic): string | null {
    if (!this.connected && this.profile.disconnected) return this.statePoseId
    return (this.runningAction?.continuous?.releasedAt === undefined ? this.runningAction?.action.poseId : undefined) ?? this.statePoseId
  }

  private setConnected(connected: boolean): void {
    if (connected === this.connected) return
    this.connected = connected
    this.pointerGestureBlocked = true
    this.clearAction()
    this.selectStatePose()
    this.blendFrom = { ...this.stateParameters }
    this.blendStartedAt = this.clock.now()
    this.reconcilePose(this.semantic)
  }

  private abortPoseWait(reason: string): void {
    if (!this.poseWaitController) return
    this.poseWaitController.abort(reason)
    this.poseWaitController = null
  }

  private recordTransition(snapshot: CharacterStateSnapshot): void {
    const last = this.transitionHistory.at(-1)
    if (last && last.at === snapshot.stateSince && last.state === snapshot.state && last.reason === snapshot.transitionReason) return
    this.transitionHistory.push({
      at: snapshot.stateSince,
      state: snapshot.state,
      reason: snapshot.transitionReason,
      activeTaskIds: [...snapshot.activeTaskIds],
    })
    if (this.transitionHistory.length > 64) this.transitionHistory.shift()
  }

  private refreshManifestWarnings(): void {
    this.manifestWarnings = [
      ...this.profile.warnings,
      ...validateBehaviorPoseIds(this.profile, this.availablePoseIds),
    ]
  }

  private emit(): void {
    this.lastEmitAt = this.clock.now()
    for (const listener of this.listeners) listener()
  }
}
