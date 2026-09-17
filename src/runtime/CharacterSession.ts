import { Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"
import { InteractionController } from "../interaction/InteractionController"
import { AdjustableClock } from "../behavior/Clock"
import { CharacterBehaviorController } from "../behavior/CharacterBehaviorController"
import { CharacterStateMachine } from "../behavior/CharacterStateMachine"
import { createDefaultBehaviorProfile } from "../behavior/BehaviorManifest"
import type { TaskEventSource } from "../behavior/TaskEventSource"
import { loadCharacterCatalog } from "../pose/PoseManifest"
import type { LoadedCharacter } from "../pose/types"
import { loadBuiltInCharacter } from "./loadBuiltInCharacter"
import { CharacterDialogueController } from "../dialogue/CharacterDialogueController"
import { createDefaultDialogueProfile } from "../dialogue/DefaultDialogueProfile"
import { hasLifecycle } from "../lifecycle/CharacterEventSource"

export class CharacterSession {
  readonly runtime: Anime25DRuntime
  readonly behavior: CharacterBehaviorController
  readonly dialogue: CharacterDialogueController
  private readonly presentationDisconnects: Array<() => void>
  private interaction: InteractionController | null
  private sourceDisconnect: (() => void) | null = null
  private loadController: AbortController | null = null
  private loadEpoch = 0
  private catalog: LoadedCharacter[] | null = null
  private catalogGeneration = -1
  private running = false
  private disposed = false
  private observedModelRevision: number | undefined

  constructor(readonly canvas: HTMLCanvasElement, private readonly catalogUrl = "/characters/catalog.json") {
    this.runtime = new Anime25DRuntime(canvas)
    const clock = new AdjustableClock()
    const profile = createDefaultBehaviorProfile()
    this.behavior = new CharacterBehaviorController(this.runtime, new CharacterStateMachine(profile.timing, clock), profile, { clock })
    this.dialogue = new CharacterDialogueController()
    this.presentationDisconnects = [
      this.runtime.subscribe(() => this.syncPoseDialogue()),
      this.behavior.subscribeLifecycle((event) => this.dialogue.handleBehavior(event)),
      this.runtime.lifecycle.subscribe((event) => {
        this.dialogue.handleMotion(event)
        if (event.type === "interaction.started") {
          if (event.interactionId === "HEAD_TAP" || event.interactionId === "TORSO_TAP") this.behavior.triggerInteraction(event.interactionId)
          else this.behavior.cancelInteractionReaction()
        }
        if (event.type === "interaction.cancelled" && event.reason !== "superseded") this.behavior.cancelInteractionReaction()
        if (event.type === "pose.enter.completed" || event.type === "pose.exit.completed") this.syncPoseDialogue()
      }),
    ]
    this.interaction = this.createInteraction()
  }

  async loadCharacter(id: string, signal?: AbortSignal, stage?: (value: "catalog" | "assets" | "decode" | "gpu-commit") => void): Promise<void> {
    if (this.disposed) throw new Error("character session is disposed")
    this.loadController?.abort()
    const controller = new AbortController()
    this.loadController = controller
    const onAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    const epoch = ++this.loadEpoch
    try {
      const generation = this.catalogGeneration
      stage?.("catalog")
      const catalog = this.catalog ?? (await loadCharacterCatalog(this.catalogUrl, controller.signal)).characters
      if (this.catalogGeneration === generation) this.catalog = catalog
      const model = catalog.find((candidate) => candidate.id === id)
      if (!model) throw new Error(`Unknown character: ${id}`)
      const loaded = await loadBuiltInCharacter(this.runtime, model, controller.signal, () => {
        controller.signal.throwIfAborted()
        this.dialogue.configure(createDefaultDialogueProfile(), null)
        this.behavior.prepareForModelChange()
      }, stage)
      if (controller.signal.aborted || epoch !== this.loadEpoch) throw new DOMException("Character load cancelled", "AbortError")
      this.behavior.configure(loaded.behavior, loaded.poses.map((pose) => pose.id), false)
      this.dialogue.configure(loaded.dialogue, model.id, Object.keys(loaded.behavior.continuousReactions ?? {}).map(id => id === "PET" ? "interaction.pet" : "interaction.face-hold"))
      this.syncPoseDialogue()
      const reactions = Object.values(loaded.behavior.interactionReactions ?? {})
      const warm = [loaded.behavior.states.BUSY.poseId, ...reactions.flatMap(action => [action.poseId, ...(action.poseVariants ?? [])]), loaded.behavior.continuousReactions?.PET?.poseId]
      void this.runtime.warmPoseAssets(warm.filter((id): id is string => typeof id === "string"), controller.signal).catch(() => {})
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  invalidateCatalog(generation: number): void {
    if (generation <= this.catalogGeneration) return
    this.catalogGeneration = generation; this.catalog = null
  }

  connectTaskSource(source: TaskEventSource): void {
    this.sourceDisconnect?.()
    this.dialogue.clear()
    const behaviorDisconnect = this.behavior.connect(source)
    const lifecycleDisconnect = hasLifecycle(source)
      ? source.subscribeLifecycle((event) => this.dialogue.handleLifecycle(event, this.behavior.machine.getSnapshot()))
      : () => {}
    this.sourceDisconnect = () => { lifecycleDisconnect(); behaviorDisconnect() }
  }

  setInteractionEnabled(enabled: boolean): void {
    if (!enabled) {
      this.interaction?.destroy()
      this.interaction = null
      this.behavior.cancelContinuousInteraction("desktop-layout")
      this.runtime.cancelInteraction("desktop-layout")
    } else if (!this.interaction && !this.disposed) this.interaction = this.createInteraction()
  }

  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.runtime.start()
    this.behavior.start()
  }

  stop(): void {
    this.running = false
    this.behavior.cancelContinuousInteraction("session-stopped")
    this.behavior.stop()
    this.runtime.stop()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loadController?.abort()
    this.loadController = null
    this.sourceDisconnect?.()
    this.sourceDisconnect = null
    this.interaction?.destroy()
    this.interaction = null
    this.behavior.dispose()
    for (const disconnect of this.presentationDisconnects) disconnect()
    this.dialogue.dispose()
    this.runtime.stop()
    this.runtime.unload()
  }

  private createInteraction(): InteractionController {
    return new InteractionController(this.canvas, this.runtime, (source) => this.behavior.dispatch({ type: "USER_ACTIVITY", source }), signal => this.behavior.handlePointerGesture(signal))
  }

  private syncPoseDialogue(): void {
    const revision = this.runtime.getModelRevision?.()
    if (revision !== this.observedModelRevision) {
      this.observedModelRevision = revision
      this.behavior.cancelContinuousInteraction("model-revision")
    }
    const pose = this.runtime.getPoseDiagnostics()
    if (pose.state === "BASE") this.dialogue.setPoseContext(null)
    else if (pose.state === "ACTIVE_LOOP") this.dialogue.setPoseContext(pose.id)
  }
}
