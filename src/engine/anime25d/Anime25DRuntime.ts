import { DEFAULT_PARAMETERS } from "./Anime25DParameters"
import { clientToModel, containTransform } from "./coordinate"
import { Anime25DRenderer } from "./Anime25DRenderer"
import { PsdRigLoader } from "./PsdRigLoader"
import { mergeHairPhysics } from "./HairPhysicsConfig"
import { compositeStoredLayers } from "./RigAssetInspector"
import type { RigOverrides } from "./RigOverrides"
import type { Anime25DParameter, Anime25DParameterState, HairPhysicsConfig, HairTestMode, HitArea, InteractionId, QualityMode, RigAssetDiagnostics, RigDefinition, RigDiagnostics, RigImage, RigLayer, RigLoadResult } from "./types"
import { HitAreaResolver } from "../../interaction/HitAreaResolver"
import { ParameterMixer } from "../../interaction/ParameterMixer"
import { PoseAssetLoader } from "../../pose/PoseAssetLoader"
import { loadPoseManifest } from "../../pose/PoseManifest"
import { samplePoseMotion, weightPoseLayerTransforms } from "../../pose/PoseMotion"
import { PoseMotionPlayback } from "../../pose/PoseMotionPlayback"
import { sampleMotionEnvelope } from "../../motion/MotionSampler"
import { PoseRegistry } from "../../pose/PoseRegistry"
import { PoseTransition } from "../../pose/PoseTransition"
import { transformPosePoint } from "../../pose/PoseRegistration"
import type { PoseAsset, PoseManifest, PoseRuntimeDiagnostics, PoseRuntimeState, PoseSummary } from "../../pose/types"
import { PerformanceClock } from "../../behavior/Clock"
import { blendBehaviorParameters } from "../../behavior/BehaviorMotion"
import type { CharacterSemanticState } from "../../behavior/types"
import { MotionSourceHost } from "../../motion/orchestration/MotionSourceHost"
import { MotionLifecycleBus, type MotionLifecycleEvent } from "../../motion/orchestration/MotionLifecycleBus"
import { MotionOrchestrator } from "../../motion/orchestration/MotionOrchestrator"
import type { MotionContributionFrame, MotionSourceLease } from "../../motion/orchestration/types"
import { InteractionMotionController } from "../../motion/sources/InteractionMotionController"

const UPSTREAM_COMMIT = "d48825867acd081de22b0e7b5585bb562288796d"

type ActiveInteraction = { id: InteractionId; startedAt: number; duration: number }
export type AlphaHitTestResult = { alpha: number; interactive: boolean }
type RigLoadOptions = { overrides?: RigOverrides; sourceReferenceUrl?: string; characterId?: string }
type PoseWaitOptions = { signal?: AbortSignal; timeoutMs?: number }
type EnterPoseOptions = PoseWaitOptions & { waitUntil?: "STARTED" | "ACTIVE_LOOP"; cancelOnAbort?: boolean; restartMotion?: boolean }
type ExitPoseOptions = PoseWaitOptions & { waitUntil?: "STARTED" | "BASE" }
type ActivePoseRequest = { requestId: string; poseId: string; direction: "enter" | "exit"; target: PoseRuntimeState }
type PoseCancelSettleMode = "reverse" | "reset" | "leave-transition"
type PoseWaiter = {
  requestId: string
  target: PoseRuntimeState
  poseId: string | null
  resolve: () => void
  reject: (error: Error) => void
  cleanup: () => void
}
const DEFAULT_POSE_TRANSITION = { enterMs: 760, exitMs: 620, swapStart: 0.32, swapEnd: 0.68 }
let nextRuntimeId = 1

function emptyPoseDiagnostics(overrides: Partial<PoseRuntimeDiagnostics> = {}): PoseRuntimeDiagnostics {
  return {
    id: null,
    label: null,
    psd: null,
    loadStatus: "unavailable",
    registrationStatus: "unavailable",
    registration: null,
    state: "BASE",
    progress: 0,
    mix: 0,
    activeLayerCount: 0,
    baseGpuResources: 0,
    poseGpuResources: 0,
    sharedBaseLayers: [],
    baseReplaceLayers: [],
    poseReplaceLayers: [],
    poseAdditiveLayers: [],
    availablePoses: [],
    motionLayerCount: 0,
    warnings: [],
    error: null,
    ...overrides,
  }
}

export class Anime25DRuntime {
  readonly renderer: Anime25DRenderer
  readonly loader = new PsdRigLoader()
  readonly poseLoader = new PoseAssetLoader(this.loader)
  readonly poseRegistry = new PoseRegistry()
  readonly mixer = new ParameterMixer()
  readonly sourceHost = new MotionSourceHost(this.mixer)
  readonly lifecycle = new MotionLifecycleBus()
  readonly poseTransition = new PoseTransition(DEFAULT_POSE_TRANSITION)
  private readonly clock = new PerformanceClock()
  private readonly runtimeOwnerId = `anime25d-runtime:${nextRuntimeId++}`
  private readonly motionOrchestrator = new MotionOrchestrator(this.sourceHost, this.mixer, this.clock, undefined, `${this.runtimeOwnerId}:procedural`)
  private readonly interactionController = new InteractionMotionController(this.sourceHost, this.lifecycle, `${this.runtimeOwnerId}:interaction`)
  private model: RigLoadResult["model"] | null = null
  private hitResolver: HitAreaResolver | null = null
  private baseHitResolver: HitAreaResolver | null = null
  private poseHitResolver: HitAreaResolver | null = null
  private poseAsset: PoseAsset | null = null
  private poseLoadController: AbortController | null = null
  private poseCrossfade: { previousId: string; startedAt: number; durationMs: number; parameters: Partial<Anime25DParameterState>; weight: number; hitResolver: HitAreaResolver | null } | null = null
  private lastPoseParameters: Partial<Anime25DParameterState> = {}
  private lastPoseWeight = 0
  private readonly poseMotionPlayback = new PoseMotionPlayback()
  private poseLoopStartedAt = 0
  private lastPoseState: PoseRuntimeDiagnostics["state"] = "BASE"
  private poseDiagnostics: PoseRuntimeDiagnostics = emptyPoseDiagnostics()
  private animationFrame = 0
  private modelRevision = 0
  private renderedModelRevision: number | null = null
  private running = false
  private lastFrame = performance.now()
  private lastDiagnosticEmit = 0
  private pointerTarget: { x: number; y: number } | null = null
  /** Kept only for compatibility with older diagnostics tests. */
  private interaction: ActiveInteraction | null = null
  private manual: Partial<Anime25DParameterState> = {}
  private autoBlink = true
  private semanticState: CharacterSemanticState = "NORMAL"
  private manualLease: MotionSourceLease | null = null
  private qaBlinkLease: MotionSourceLease | null = null
  private poseParameterLease: MotionSourceLease | null = null
  private behaviorStateLease: MotionSourceLease | null = null
  private behaviorActionLease: MotionSourceLease | null = null
  private activePoseRequest: ActivePoseRequest | null = null
  private readonly poseWaiters = new Set<PoseWaiter>()
  private poseRequestSequence = 0
  private qualityMode: QualityMode = "RIG_ANIMATED"
  private hairTestMode: HairTestMode = "combined"
  private hairPhysics = mergeHairPhysics()
  private sourceReferenceUrl: string | null = null
  private characterId: string | null = null
  private compositeCache = new Map<string, RigImage>()
  private diagnostics: RigDiagnostics
  private readonly listeners = new Set<() => void>()

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new Anime25DRenderer(canvas)
    this.diagnostics = this.emptyDiagnostics()
  }

  async loadPsd(file: File, options: RigLoadOptions = {}): Promise<RigLoadResult> {
    const result = await this.loader.load(file, options.overrides)
    this.applyLoadResult(result, options)
    return result
  }

  loadPsdBuffer(buffer: ArrayBuffer, sourceName: string, options: RigLoadOptions = {}): RigLoadResult {
    const result = this.loader.loadArrayBuffer(buffer, sourceName, options.overrides)
    this.applyLoadResult(result, options)
    return result
  }

  applyPreparedCharacter(result: RigLoadResult, options: RigLoadOptions, entries: Array<{ manifestUrl: string; manifest: PoseManifest }>, warmed: PoseAsset[], beforeCommit?: () => void): PoseSummary[] {
    // Validate all registrations before replacing any current CPU/GPU state.
    const checked = new PoseRegistry(); checked.replace(entries)
    this.applyLoadResult(result, options, beforeCommit)
    this.poseRegistry.replace(entries)
    this.poseLoader.adopt(result.model.rig, warmed)
    this.syncAvailablePoses(); this.syncPoseDiagnostics(); this.emit()
    return this.listPoses()
  }

  unload() {
    this.modelRevision++
    this.cancelInteraction("model-unload")
    this.resetPose("model-unload")
    this.poseRegistry.clear()
    this.poseLoader.clear()
    this.sourceHost.clear()
    this.invalidateSourceLeaseReferences()
    this.motionOrchestrator.reset()
    this.renderer.unload()
    this.model = null
    this.hitResolver = null
    this.baseHitResolver = null
    this.poseHitResolver = null
    this.pointerTarget = null
    this.diagnostics = this.emptyDiagnostics()
    this.emit()
  }

  setParameter(name: Anime25DParameter, value: number) {
    this.manual[name] = value
    this.ensureManualLease().update(this.absoluteContributions(this.manual))
  }

  setParameters(values: Partial<Anime25DParameterState>) {
    Object.assign(this.manual, values)
    this.ensureManualLease().update(this.absoluteContributions(this.manual))
  }

  clearManualParameters() {
    this.manual = {}
    this.manualLease?.release()
    this.manualLease = null
  }

  setBehaviorGazeTakeover(enabled: boolean) {
    this.motionOrchestrator.setGazeTakeoverFromCurrent(enabled)
  }

  setBehaviorSemanticState(state: CharacterSemanticState) {
    this.semanticState = state
  }

  setBehaviorStateParameters(values: Partial<Anime25DParameterState>, ownerId = "behavior-controller:legacy", weight = 1) {
    if (!this.behaviorStateLease?.active() || this.behaviorStateLease.ownerId !== ownerId) {
      this.behaviorStateLease = this.sourceHost.acquire({ slot: "behavior-state", ownerId, priority: 11 })
    }
    this.behaviorStateLease.update(values, { weight })
  }

  setBehaviorActionParameters(values: Partial<Anime25DParameterState>, ownerId = "behavior-controller:legacy", weight = 1) {
    if (!this.behaviorActionLease?.active() || this.behaviorActionLease.ownerId !== ownerId) {
      this.behaviorActionLease = this.sourceHost.acquire({ slot: "behavior-action", ownerId, priority: 14 })
    }
    this.behaviorActionLease.update(values, { weight })
  }

  clearBehaviorStateParameters(ownerId = "behavior-controller:legacy") {
    if (this.behaviorStateLease?.ownerId !== ownerId) return
    this.behaviorStateLease.release()
    this.behaviorStateLease = null
  }

  clearBehaviorActionParameters(ownerId = "behavior-controller:legacy") {
    if (this.behaviorActionLease?.ownerId !== ownerId) return
    this.behaviorActionLease.release()
    this.behaviorActionLease = null
  }

  setQualityMode(mode: QualityMode) {
    this.qualityMode = mode
    this.diagnostics = { ...this.diagnostics, qualityMode: mode }
    this.syncRendererPhysicsMode()
    this.emit()
  }

  setAutoBlink(enabled: boolean) {
    this.autoBlink = enabled
    if (enabled) this.clearBlinkTest()
    if (!enabled) this.motionOrchestrator.updateBlink(this.clock.now(), false)
    this.diagnostics = { ...this.diagnostics, autoBlink: enabled }
    this.emit()
  }

  forceBlink() {
    this.motionOrchestrator.blink.trigger()
  }

  resetBlink() {
    this.motionOrchestrator.blink.reset()
    this.emit()
  }

  setBlinkTest(left: number, right: number) {
    this.autoBlink = false
    this.motionOrchestrator.updateBlink(this.clock.now(), false)
    if (!this.qaBlinkLease?.active()) this.qaBlinkLease = this.sourceHost.acquire({ slot: "qa-blink", ownerId: `${this.runtimeOwnerId}:debug`, priority: 120 })
    this.qaBlinkLease.update({ eyeOpenL: { value: left, mode: "override" }, eyeOpenR: { value: right, mode: "override" } })
    this.diagnostics = { ...this.diagnostics, autoBlink: false }
    this.emit()
  }

  clearBlinkTest() {
    this.qaBlinkLease?.release()
    this.qaBlinkLease = null
  }

  setIdleGazeEnabled(enabled: boolean) {
    this.motionOrchestrator.idleGaze.setEnabled(enabled)
    this.emit()
  }

  forceNewIdleGazeTarget() {
    this.motionOrchestrator.idleGaze.forceNewTarget()
  }

  resetIdleGaze() {
    this.motionOrchestrator.idleGaze.reset()
    this.emit()
  }

  setHairTestMode(mode: HairTestMode) {
    this.hairTestMode = mode
    this.diagnostics = { ...this.diagnostics, hairTestMode: mode }
    this.syncRendererPhysicsMode()
    this.emit()
  }

  setHairPhysics(group: "frontHair" | "backHair", key: keyof HairPhysicsConfig["frontHair"], value: number) {
    this.hairPhysics = mergeHairPhysics({ ...this.hairPhysics, [group]: { ...this.hairPhysics[group], [key]: value } })
    this.renderer.setHairPhysics(this.hairPhysics)
    this.diagnostics = { ...this.diagnostics, hairPhysics: this.hairPhysics }
    this.emit()
  }

  resetHairSprings() { this.renderer.resetSprings() }
  impulseHair() { this.renderer.impulse(0.65) }

  setLayerVisible(name: string, visible: boolean, rigName = name) {
    const key = this.rigLayerKey(rigName)
    this.renderer.setLayerVisible(key, visible)
    const hidden = new Set(this.diagnostics.hiddenLayers)
    if (visible) hidden.delete(name)
    else hidden.add(name)
    this.diagnostics = { ...this.diagnostics, hiddenLayers: [...hidden] }
    this.compositeCache.clear()
    this.emit()
  }

  isolateLayer(name: string | null, rigName = name) {
    this.renderer.isolateLayer(rigName ? this.rigLayerKey(rigName) : null)
    this.diagnostics = { ...this.diagnostics, isolatedLayer: name }
    this.compositeCache.clear()
    this.emit()
  }

  clearLayerFilters() {
    this.renderer.clearLayerFilters()
    this.diagnostics = { ...this.diagnostics, hiddenLayers: [], isolatedLayer: null }
    this.compositeCache.clear()
    this.emit()
  }

  getComposite(mode: "RAW_PSD_COMPOSITE" | "CLEANED_PSD_COMPOSITE"): RigImage | null {
    if (!this.model) return null
    if (!this.diagnostics.hiddenLayers.length && !this.diagnostics.isolatedLayer) return mode === "RAW_PSD_COMPOSITE" ? this.model.rawComposite : this.model.cleanedComposite
    const cacheKey = `${mode}|${this.diagnostics.hiddenLayers.slice().sort().join(",")}|${this.diagnostics.isolatedLayer ?? ""}`
    const cached = this.compositeCache.get(cacheKey)
    if (cached) return cached
    const layers = mode === "RAW_PSD_COMPOSITE" ? this.model.rawCompositeLayers : this.model.cleanedCompositeLayers
    const hidden = new Set(this.diagnostics.hiddenLayers)
    const filtered = layers.map((layer) => ({
      ...layer,
      visible: layer.visible && !hidden.has(layer.name) && (!this.diagnostics.isolatedLayer || this.diagnostics.isolatedLayer === layer.name),
    }))
    const composite = compositeStoredLayers(this.model.rig.canvas.w, this.model.rig.canvas.h, filtered)
    this.compositeCache.set(cacheKey, composite)
    return composite
  }

  getAssetDiagnostics(): RigAssetDiagnostics | null {
    return this.model?.assetDiagnostics ?? null
  }

  captureCurrentFrame(): RigImage {
    const parameters = this.qualityMode === "RIG_NEUTRAL" ? DEFAULT_PARAMETERS : this.diagnostics.parameters
    this.renderer.render(parameters, performance.now(), this.qualityMode === "RIG_NEUTRAL")
    return this.renderer.readFrame()
  }

  sampleRenderedAlpha(clientX: number, clientY: number, options: { radius?: number; threshold?: number } = {}): AlphaHitTestResult {
    if (!this.model) return { alpha: 0, interactive: false }
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { alpha: 0, interactive: false }
    const { w, h } = this.model.rig.canvas
    const transform = containTransform(rect.width, rect.height, w, h)
    const model = clientToModel(clientX, clientY, rect, w, h)
    if (!model.inside) return { alpha: 0, interactive: false }
    const radius = Math.max(0, (options.radius ?? 2) / transform.scale)
    const bufferX = Math.max(0, Math.min(w - 1, model.x))
    const bufferY = Math.max(0, Math.min(h - 1, h - 1 - model.y))
    const alpha = this.renderer.sampleAlpha(bufferX, bufferY, radius)
    return { alpha, interactive: alpha >= (options.threshold ?? 0.1) }
  }

  async registerPoseManifests(manifestUrls: string[], signal?: AbortSignal): Promise<PoseSummary[]> {
    if (!this.model) throw new Error("Load a base rig before registering pose manifests")
    const expectedModelRevision = this.modelRevision
    const entries = await Promise.all(manifestUrls.map(async (manifestUrl) => ({
      manifestUrl,
      manifest: (await loadPoseManifest(manifestUrl, signal)).value,
    })))
    signal?.throwIfAborted()
    if (this.modelRevision !== expectedModelRevision) throw new Error("POSE_ASSET_LOAD_CANCELLED: base model changed while pose manifests were loading")
    this.poseRegistry.replace(entries)
    this.syncAvailablePoses()
    this.syncPoseDiagnostics()
    this.emit()
    return this.listPoses()
  }

  listPoses(): PoseSummary[] {
    const loadedId = this.poseAsset?.manifest.id ?? null
    const activeId = this.poseDiagnostics.state === "BASE" ? null : loadedId
    return this.poseRegistry.list(loadedId, activeId)
  }

  async loadPoseById(id: string): Promise<PoseAsset> {
    const entry = this.poseRegistry.resolve(id)
    if (this.poseAsset?.manifest.id === id && this.poseDiagnostics.loadStatus === "ready") return this.poseAsset
    return this.loadPoseAsset(entry.manifestUrl, entry.manifest)
  }

  async transitionToPose(id: string, options: EnterPoseOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    this.abortPreparedPoseLoad("superseded by pose selection")
    if (this.poseAsset?.manifest.id === id && this.poseDiagnostics.loadStatus === "ready") return this.enterPose(id, options)
    if (!this.model) throw new Error("Load a base rig before entering a pose")
    if (!this.poseAsset || !this.poseTransition.sample(this.clock.now()).active) {
      const loaded = this.loadPoseById(id)
      const controller = this.poseLoadController
      const abort = () => controller?.abort(options.signal?.reason)
      options.signal?.addEventListener("abort", abort, { once: true })
      try { await loaded; options.signal?.throwIfAborted() }
      finally { options.signal?.removeEventListener("abort", abort) }
      return this.enterPose(id, options)
    }

    // Keep the current pose and its motion alive while the next PSD is prepared.
    const entry = this.poseRegistry.resolve(id), baseRig = this.model.rig, revision = this.modelRevision
    const controller = new AbortController()
    this.poseLoadController = controller
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", abort, { once: true })
    this.poseDiagnostics = { ...this.poseDiagnostics, pendingId: id, error: null }
    this.syncPoseDiagnostics()
    this.emit()
    try {
      const asset = await this.poseLoader.load(entry.manifestUrl, baseRig, { signal: controller.signal, manifest: entry.manifest })
      if (!asset.registration.accepted || asset.selection.errors.length) throw new Error(`Pose '${id}' rejected: ${[...asset.registration.reasons, ...asset.selection.errors].join("; ")}`)
      // A burst of requests may prepare the latest asset in parallel, but only
      // two GPU pose sets are retained. Finish the short visible blend first.
      if (this.poseCrossfade) await this.waitForPoseState("ACTIVE_LOOP", { signal: controller.signal, timeoutMs: options.timeoutMs })
      controller.signal.throwIfAborted()
      if (revision !== this.modelRevision || this.poseLoadController !== controller) throw abortError("pose selection changed")
      const now = this.clock.now(), previous = this.poseAsset!, sample = this.poseTransition.sample(now)
      this.renderer.crossfadePoseRig(asset.result.model.rig, asset.selection, asset.registration.transform)
      this.poseCrossfade = { previousId: previous.manifest.id, startedAt: now, durationMs: Math.max(1, Math.min(280, asset.manifest.transition.enterMs)), parameters: { ...this.lastPoseParameters }, weight: this.lastPoseWeight, hitResolver: this.poseHitResolver }
      this.poseAsset = asset
      this.poseMotionPlayback.reset()
      this.poseTransition.configure(asset.manifest.transition, true)
      this.poseHitResolver = new HitAreaResolver(this.combinedPoseRig(asset))
      this.poseDiagnostics = emptyPoseDiagnostics({
        id, label: asset.manifest.label, psd: asset.manifest.psd, loadStatus: "ready", registrationStatus: "accepted", registration: asset.registration,
        state: "SWITCHING", progress: sample.progress, mix: sample.mix, previousId: previous.manifest.id, crossfade: 0,
        activeLayerCount: asset.selection.poseReplace.length + asset.selection.poseAdditive.length,
        baseGpuResources: this.renderer.baseResourceCount, poseGpuResources: this.renderer.poseResourceCount,
        sharedBaseLayers: asset.selection.baseShared, baseReplaceLayers: asset.selection.baseReplace,
        poseReplaceLayers: asset.selection.poseReplace, poseAdditiveLayers: asset.selection.poseAdditive,
        motionLayerCount: Object.keys(asset.manifest.motion?.layers ?? {}).length, warnings: asset.warnings,
      })
      this.poseLoadController = null
      this.syncAvailablePoses()
      this.syncPoseDiagnostics()
      this.emit()
    } catch (error) {
      if (this.poseLoadController === controller) {
        this.poseDiagnostics = { ...this.poseDiagnostics, pendingId: null, error: controller.signal.aborted ? null : error instanceof Error ? error.message : String(error) }
        this.syncPoseDiagnostics()
        this.emit()
      }
      throw error
    } finally {
      options.signal?.removeEventListener("abort", abort)
      if (this.poseLoadController === controller) this.poseLoadController = null
    }
    return this.enterPose(id, options)
  }

  private abortPreparedPoseLoad(reason: string) {
    const pending = this.poseLoadController
    this.poseLoadController?.abort(reason)
    this.poseLoadController = null
    if (pending && !this.poseAsset) {
      this.poseDiagnostics = emptyPoseDiagnostics({ baseGpuResources: this.renderer.baseResourceCount })
      this.syncPoseDiagnostics()
    } else if (this.poseDiagnostics.pendingId) {
      this.poseDiagnostics = { ...this.poseDiagnostics, pendingId: null }
      this.syncPoseDiagnostics()
    }
  }

  async warmPoseAssets(ids: string[], signal?: AbortSignal): Promise<string[]> {
    if (!this.model) return []
    const baseRig = this.model.rig, revision = this.modelRevision, warnings: string[] = []
    for (const id of new Set(ids)) {
      signal?.throwIfAborted()
      if (revision !== this.modelRevision) throw new DOMException("Character changed during pose preparation", "AbortError")
      try {
        const entry = this.poseRegistry.resolve(id)
        const asset = await this.poseLoader.load(entry.manifestUrl, baseRig, { signal, manifest: entry.manifest })
        if (!asset.registration.accepted || asset.selection.errors.length) warnings.push(`Pose '${id}' could not be prepared; parameter fallback remains available.`)
      } catch (error) {
        if (signal?.aborted) throw error
        warnings.push(`Pose '${id}' preparation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return warnings
  }

  async loadPoseAsset(manifestUrl: string, manifest?: PoseManifest): Promise<PoseAsset> {
    if (!this.model) throw new Error("Load a base rig before loading a pose asset")
    this.poseLoadController?.abort()
    this.poseLoadController = null
    this.disposePose()
    const loadController = new AbortController()
    this.poseLoadController = loadController
    const expectedModelRevision = this.modelRevision
    const baseRig = this.model.rig
    this.poseDiagnostics = emptyPoseDiagnostics({
      id: manifest?.id ?? null,
      label: manifest?.label ?? null,
      psd: manifest?.psd ?? null,
      loadStatus: "loading",
      registrationStatus: "pending",
      baseGpuResources: this.renderer.baseResourceCount,
      availablePoses: this.listPoses(),
    })
    this.syncPoseDiagnostics()
    this.emit()
    try {
      const asset = await this.poseLoader.load(manifestUrl, baseRig, { signal: loadController.signal, manifest })
      if (loadController.signal.aborted || this.modelRevision !== expectedModelRevision) throw new Error("POSE_ASSET_LOAD_CANCELLED: base model changed while the pose was loading")
      this.poseAsset = asset
      const error = !asset.registration.accepted
        ? `${asset.registration.errorCode}: ${asset.registration.reasons.join("; ")}`
        : asset.selection.errors.length ? `POSE_ASSET_LAYER_SELECTION_FAILED: ${asset.selection.errors.join("; ")}` : null
      if (error) {
        this.poseDiagnostics = emptyPoseDiagnostics({
          id: asset.manifest.id, label: asset.manifest.label, psd: asset.manifest.psd,
          loadStatus: "rejected", registrationStatus: asset.registration.accepted ? "accepted" : "rejected",
          registration: asset.registration, warnings: asset.warnings, error,
          baseGpuResources: this.renderer.baseResourceCount,
          sharedBaseLayers: asset.selection.baseShared,
          baseReplaceLayers: asset.selection.baseReplace,
          poseReplaceLayers: asset.selection.poseReplace,
          poseAdditiveLayers: asset.selection.poseAdditive,
          motionLayerCount: Object.keys(asset.manifest.motion?.layers ?? {}).length,
        })
        this.syncPoseDiagnostics()
        this.emit()
        return asset
      }
      this.renderer.applyPoseRig(asset.result.model.rig, asset.selection, asset.registration.transform)
      this.poseTransition.configure(asset.manifest.transition)
      this.poseHitResolver = new HitAreaResolver(this.combinedPoseRig(asset))
      this.poseDiagnostics = emptyPoseDiagnostics({
        id: asset.manifest.id, label: asset.manifest.label, psd: asset.manifest.psd,
        loadStatus: "ready", registrationStatus: "accepted", registration: asset.registration,
        activeLayerCount: asset.selection.poseReplace.length + asset.selection.poseAdditive.length,
        baseGpuResources: this.renderer.baseResourceCount, poseGpuResources: this.renderer.poseResourceCount,
        sharedBaseLayers: asset.selection.baseShared, baseReplaceLayers: asset.selection.baseReplace,
        poseReplaceLayers: asset.selection.poseReplace, poseAdditiveLayers: asset.selection.poseAdditive,
        motionLayerCount: Object.keys(asset.manifest.motion?.layers ?? {}).length,
        warnings: asset.warnings,
      })
      this.syncPoseDiagnostics()
      this.emit()
      if (this.poseLoadController === loadController) this.poseLoadController = null
      return asset
    } catch (error) {
      const cancelled = loadController.signal.aborted || this.modelRevision !== expectedModelRevision || error instanceof DOMException && error.name === "AbortError"
      if (this.poseLoadController === loadController) this.poseLoadController = null
      if (cancelled) throw new Error("POSE_ASSET_LOAD_CANCELLED: base model or pose selection changed while the pose was loading")
      this.poseAsset = null
      this.poseDiagnostics = emptyPoseDiagnostics({
        loadStatus: "error", registrationStatus: "rejected", baseGpuResources: this.renderer.baseResourceCount,
        error: error instanceof Error ? error.message : String(error),
      })
      this.syncPoseDiagnostics()
      this.emit()
      throw error
    }
  }

  cancelPendingPoseLoad(reason = "pose load cancelled") {
    this.cancelPoseRequest(reason, { settleMode: "reverse" })
    if (this.poseLoadController) {
      this.poseLoadController.abort()
      this.poseLoadController = null
      if (!this.poseAsset) this.poseDiagnostics = emptyPoseDiagnostics({
        baseGpuResources: this.renderer.baseResourceCount,
        warnings: [reason],
      })
      else this.poseDiagnostics = { ...this.poseDiagnostics, pendingId: null }
      this.syncAvailablePoses()
      this.syncPoseDiagnostics()
      this.emit()
    }
  }

  async enterPose(id?: string, options: EnterPoseOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    if (id && this.poseAsset?.manifest.id !== id) return this.transitionToPose(id, options)
    this.abortPreparedPoseLoad("current pose requested")
    const poseId = this.poseAsset?.manifest.id ?? id ?? "unknown"
    const requestId = this.nextPoseRequestId("enter")
    if (!this.poseAsset || this.poseDiagnostics.loadStatus !== "ready") {
      const reason = this.poseDiagnostics.error ?? "No ready pose is loaded"
      this.lifecycle.emit({ type: "pose.rejected", poseId, requestId, reason, at: this.clock.now() })
      throw new Error(reason)
    }
    const current = this.samplePoseState(this.clock.now())
    if (current.state === "ACTIVE_LOOP" && this.poseAsset.manifest.id === poseId) {
      if (options.restartMotion) {
        const now = this.clock.now()
        this.poseLoopStartedAt = now
        this.poseMotionPlayback?.restart(now)
      }
      return
    }
    if (current.state === "BASE") this.poseMotionPlayback?.reset()
    this.cancelPoseRequest("superseded by pose enter", { settleMode: "leave-transition" })
    this.activePoseRequest = { requestId, poseId, direction: "enter", target: "ACTIVE_LOOP" }
    const now = this.clock.now()
    this.poseTransition.enter(now)
    this.lifecycle.emit({ type: "pose.enter.started", poseId, requestId, at: now })
    if ((options.waitUntil ?? "ACTIVE_LOOP") === "STARTED") return
    return this.waitForPoseOperation("ACTIVE_LOOP", { ...options, poseId, requestId })
  }

  exitPose(options: ExitPoseOptions = {}): Promise<void> {
    this.abortPreparedPoseLoad("pose exit requested")
    const now = this.clock.now()
    const sample = this.poseTransition.sample(now)
    if (sample.state === "BASE") return Promise.resolve()
    const poseId = this.poseAsset?.manifest.id ?? this.poseDiagnostics.id ?? "unknown"
    this.cancelPoseRequest("superseded by pose exit", { settleMode: "leave-transition" })
    const requestId = this.nextPoseRequestId("exit")
    this.activePoseRequest = { requestId, poseId, direction: "exit", target: "BASE" }
    this.poseTransition.exit(now)
    this.lifecycle.emit({ type: "pose.exit.started", poseId, requestId, at: now })
    if ((options.waitUntil ?? "STARTED") === "STARTED") return Promise.resolve()
    return this.waitForPoseOperation("BASE", { ...options, poseId, requestId })
  }

  async togglePose(id?: string): Promise<void> {
    if (id && this.poseAsset?.manifest.id !== id) {
      await this.enterPose(id)
      return
    }
    const state = this.poseTransition.sample(performance.now()).state
    if (state === "BASE" || state === "EXITING") await this.enterPose()
    else await this.exitPose({ waitUntil: "BASE" })
  }

  getActivePoseId(): string | null {
    return this.poseDiagnostics.state === "BASE" ? null : this.poseAsset?.manifest.id ?? null
  }

  pausePoseAt(progress: number) {
    if (!this.poseAsset || this.poseDiagnostics.loadStatus !== "ready") return
    this.poseTransition.pauseAt(progress)
    const sample = this.poseTransition.sample(performance.now())
    this.renderer.setPoseMix(sample.mix)
    this.updatePoseRuntimeDiagnostics(sample)
    this.updatePoseLifecycle(sample, this.clock.now())
    this.emit()
  }

  pausePoseExitAt(progress: number) {
    if (!this.poseAsset || this.poseDiagnostics.loadStatus !== "ready") return
    this.poseTransition.pauseAt(progress, "exit")
    const sample = this.poseTransition.sample(performance.now())
    this.renderer.setPoseMix(sample.mix)
    if (this.poseAsset?.manifest.motion?.transition !== "continuous") this.renderer.setPoseLayerTransforms({})
    this.updatePoseRuntimeDiagnostics(sample)
    this.updatePoseLifecycle(sample, this.clock.now())
    this.emit()
  }

  resetPose(reason = "pose reset") {
    this.abortPreparedPoseLoad(reason)
    if (this.poseCrossfade) this.renderer.finishPoseCrossfade()
    this.poseCrossfade = null
    this.lastPoseParameters = {}
    this.lastPoseWeight = 0
    this.poseMotionPlayback?.reset()
    this.cancelPoseRequest(reason, { settleMode: "reset" })
    this.poseTransition.reset()
    this.renderer.setPoseMix(0)
    this.renderer.setPoseLayerTransforms({})
    this.hitResolver = this.baseHitResolver
    this.poseParameterLease?.release()
    this.poseParameterLease = null
    this.updatePoseRuntimeDiagnostics(this.poseTransition.sample(performance.now()))
  }

  disposePose() {
    this.poseLoadController?.abort()
    this.poseLoadController = null
    this.resetPose("pose disposed")
    this.renderer.disposePose()
    this.poseAsset = null
    this.poseHitResolver = null
    this.poseDiagnostics = emptyPoseDiagnostics({ baseGpuResources: this.renderer.baseResourceCount })
    this.syncAvailablePoses()
    this.syncPoseDiagnostics()
  }

  getPoseDiagnostics() {
    return this.poseDiagnostics
  }

  subscribeLifecycle(listener: (event: MotionLifecycleEvent) => void) {
    return this.lifecycle.subscribe(listener)
  }

  getLifecycleHistory() {
    return this.lifecycle.getHistory()
  }

  cancelInteraction(reason = "cancelled") {
    if (this.interactionController) this.interactionController.cancel(reason, this.clock?.now?.() ?? performance.now())
    else this.mixer.removeSource("interaction")
    this.interaction = null
    this.diagnostics = { ...this.diagnostics, interactionState: "IDLE", gesture: reason }
  }

  setPointerTarget(x: number, y: number) {
    this.pointerTarget = { x, y }
    this.motionOrchestrator.notifyPointerActivity(this.clock.now())
  }

  clearPointerTarget() {
    if (!this.pointerTarget) return
    this.pointerTarget = null
    this.motionOrchestrator.notifyPointerActivity(this.clock.now())
  }

  triggerInteraction(id: InteractionId) {
    const now = this.clock.now()
    this.interactionController.start(id, now)
    const scale = this.poseAsset?.manifest.interactionScale?.[id] ?? 1
    if (id === "HEAD_TAP") this.renderer.impulse(0.75 * scale)
    if (id === "TORSO_TAP") this.renderer.impulse(1.1 * scale)
    if (id === "PET_START" || id === "PET_LOOP") this.renderer.impulse(0.35 * scale)
    this.diagnostics.interactionState = id
  }

  start() {
    if (this.running) return
    this.running = true
    this.lastFrame = performance.now()
    this.animationFrame = requestAnimationFrame(this.tick)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.animationFrame)
  }

  resize() {
    this.renderer.resize()
  }

  getDiagnostics() {
    return this.diagnostics
  }

  getResourceDiagnostics() {
    const motionSources = this.diagnostics.motionSources
    return {
      meshCount: this.renderer.meshCount,
      textureCount: this.renderer.textureCount,
      bufferCount: this.renderer.bufferCount,
      framebufferCount: this.renderer.framebufferCount,
      renderbufferCount: this.renderer.renderbufferCount,
      baseGpuResources: this.renderer.baseResourceCount,
      poseGpuResources: this.renderer.poseResourceCount,
      outgoingPoseGpuResources: this.renderer.outgoingPoseResourceCount,
      poseWaiterCount: this.poseWaiters.size,
      cachedPoseAssetCount: this.poseLoader.cachedAssetCount,
      runtimeListenerCount: this.listeners.size,
      lifecycleListenerCount: this.lifecycle.listenerCount,
      motionSourceCount: motionSources.filter((source) => source.status === "active").length,
      motionSourceHistoryCount: motionSources.length,
    }
  }

  getHitAreaResolver() {
    return this.hitResolver
  }

  getModelRevision() {
    return this.modelRevision
  }
  hasRenderedModel(revision: number) { return Boolean(this.model) && this.modelRevision === revision && this.renderedModelRevision === revision }

  getBaseFaceGeometry() {
    if (!this.model) return null
    const rig = this.poseAsset?.selection.independentModel && this.poseDiagnostics.mix >= .5
      ? this.poseAsset.result.model.rig : this.model.rig
    // The head group also contains waist-length hair. Use the bounded scalp
    // region already resolved for this model, including authored overrides.
    const head = { ...(this.hitResolver?.areas.head ?? rig.anchors.face) }
    return { face: { ...rig.anchors.face }, head, width: rig.canvas.w, height: rig.canvas.h }
  }

  clientToModel(clientX: number, clientY: number) {
    if (!this.model) return { x: 0, y: 0, inside: false }
    const { w, h } = this.model.rig.canvas
    return clientToModel(clientX, clientY, this.canvas.getBoundingClientRect(), w, h)
  }

  updateInputDiagnostics(pointer: { x: number; y: number } | null, hitArea: HitArea, gesture: string) {
    this.diagnostics = { ...this.diagnostics, pointerModel: pointer, hitArea, gesture }
    this.emit()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private applyLoadResult(result: RigLoadResult, options: RigLoadOptions, beforeCommit?: () => void) {
    this.renderer.applyRig(result.model.rig)
    beforeCommit?.()
    this.modelRevision++
    this.cancelInteraction("model-change")
    this.disposePose()
    this.poseRegistry.clear()
    this.poseLoader.clear()
    this.sourceHost.clear()
    this.invalidateSourceLeaseReferences()
    this.motionOrchestrator.reset()
    this.manual = {}
    this.pointerTarget = null
    this.semanticState = "NORMAL"
    this.model = result.model
    this.compositeCache.clear()
    this.sourceReferenceUrl = options.sourceReferenceUrl ?? null
    this.characterId = options.characterId ?? null
    this.hairPhysics = mergeHairPhysics(options.overrides?.physics as Partial<HairPhysicsConfig> | undefined)
    this.baseHitResolver = new HitAreaResolver(result.model.rig)
    this.hitResolver = this.baseHitResolver
    this.renderer.setHairPhysics(this.hairPhysics)
    this.poseDiagnostics = emptyPoseDiagnostics({ baseGpuResources: this.renderer.baseResourceCount })
    this.syncRendererPhysicsMode()
    const rig = result.model.rig
    const names = rig.layers.map((layer) => layer.name)
    this.diagnostics = {
      ...this.emptyDiagnostics(),
      webglStencil: this.renderer.stencilEnabled,
      psdCanvas: `${rig.canvas.w} × ${rig.canvas.h}`,
      psdLayerCount: result.model.psdLayers.filter((layer) => layer.visible).length,
      layerNames: result.model.psdLayers.map((layer) => layer.name),
      layerOrder: names,
      missingRequiredLayers: result.model.missingRequiredLayers,
      rigLayerCount: rig.layers.length,
      meshCount: this.renderer.meshCount,
      textureCount: this.renderer.textureCount,
      headLayers: rig.layers.filter((layer) => layer.group === "head").length,
      bodyLayers: rig.layers.filter((layer) => layer.group === "body").length,
      eyeLayers: rig.layers.filter((layer) => /^(eyewhite|irides|eyelash|eye_close)/.test(layer.name)).length,
      hairLayers: rig.layers.filter((layer) => layer.phys === "hair").length,
      hairStrandCount: rig.layers.reduce((count, layer) => count + (layer.strands?.length ?? 0), 0),
      syntheticEyeClose: rig.synth.eye,
      syntheticMouthClose: rig.synth.mouth,
      warnings: [
        ...rig.warnings,
        ...(result.preprocessing.noisy ? [`저알파 노이즈 정리: ${result.preprocessing.noisy}/${result.preprocessing.layers} layers`] : []),
      ],
      anchors: rig.anchors,
      layerInspections: result.model.assetDiagnostics.cleanedLayers,
      qualityFindings: result.model.assetDiagnostics.qualityFindings,
      sourceReferenceUrl: this.sourceReferenceUrl,
      characterId: this.characterId,
      hairPhysics: this.hairPhysics,
      pose: this.poseDiagnostics,
    }
    this.emit()
  }

  private readonly tick = (now: number) => {
    if (!this.running) return
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    this.updateAutomaticSources(now, dt)
    const parameters = this.mixer.evaluate()
    const showNeutral = this.qualityMode === "RIG_NEUTRAL"
    const renderedParameters = showNeutral ? DEFAULT_PARAMETERS : parameters
    this.renderer.render(renderedParameters, now, showNeutral)
    this.renderedModelRevision = this.model ? this.modelRevision : null
    this.diagnostics = { ...this.diagnostics, parameters: renderedParameters, fps: this.renderer.fps }
    if (now - this.lastDiagnosticEmit > 120) {
      this.lastDiagnosticEmit = now
      this.syncMotionDiagnostics(now)
      this.emit()
    }
    this.animationFrame = requestAnimationFrame(this.tick)
  }

  private chatMotionPolicy: "chat-safe" | "pose-approved" | null = null
  setChatMotionPolicy(policy: "chat-safe" | "pose-approved" | null) { this.chatMotionPolicy = policy }
  private updateAutomaticSources(now: number, dt: number) {
    const transition = this.poseTransition.sample(now)
    let crossfade = this.crossfadeMix(now)
    if (this.poseCrossfade && (crossfade >= 1 || !transition.active)) {
      this.renderer.finishPoseCrossfade()
      this.poseCrossfade = null
      crossfade = 1
    }
    this.renderer.setPoseCrossfade(crossfade)
    const pose = this.samplePoseState(now)
    this.motionOrchestrator.updateBaseSources({
      now,
      dt,
      semanticState: this.semanticState,
      pointerTarget: this.pointerTarget,
      face: this.model?.rig.anchors.face ?? null,
      poseActive: pose.active,
    })
    if (pose.state === "ACTIVE_LOOP" && this.lastPoseState !== "ACTIVE_LOOP") this.poseLoopStartedAt = now
    this.renderer.setPoseMix(pose.mix)
    this.hitResolver = pose.mix >= 0.5 ? this.poseCrossfade && crossfade < .5 ? this.poseCrossfade.hitResolver : this.poseHitResolver : this.baseHitResolver
    if (pose.active) {
      const elapsedMs = pose.state === "ACTIVE_LOOP" ? now - this.poseLoopStartedAt : 0
      const definition = this.chatMotionPolicy === "chat-safe" ? undefined : this.poseAsset?.manifest.motion
      const continuous = definition?.transition === "continuous"
      const motion = continuous ? this.poseMotionPlayback.sample(definition, pose, now) : samplePoseMotion(definition, elapsedMs)
      let values = continuous ? motion.parameters : Object.fromEntries(Object.entries(motion.parameters).map(([name, value]) => [name, (value as number) * pose.progress])) as Partial<Anime25DParameterState>
      let weight = continuous ? (motion as ReturnType<PoseMotionPlayback["sample"]>).weight : sampleMotionEnvelope(definition, elapsedMs)
      if (this.poseCrossfade) {
        const from = blendBehaviorParameters({}, this.poseCrossfade.parameters, this.poseCrossfade.weight)
        values = blendBehaviorParameters(from, blendBehaviorParameters({}, values, weight), crossfade)
        weight = 1
      }
      this.lastPoseParameters = { ...values }
      this.lastPoseWeight = weight
      if (weight > 0) {
        if (!this.poseParameterLease?.active()) this.poseParameterLease = this.sourceHost.acquire({ slot: "pose-parameters", ownerId: `${this.runtimeOwnerId}:pose`, priority: 15 })
        this.poseParameterLease.update(values, { weight })
      } else {
        this.poseParameterLease?.release()
        this.poseParameterLease = null
      }
      this.renderer.setPoseLayerTransforms(continuous || pose.state === "ACTIVE_LOOP" ? (!continuous && definition?.envelope ? weightPoseLayerTransforms(motion.layers, weight) : motion.layers) : {})
    } else {
      this.lastPoseParameters = {}
      this.lastPoseWeight = 0
      this.poseMotionPlayback.reset()
      this.poseParameterLease?.release()
      this.poseParameterLease = null
      this.renderer.setPoseLayerTransforms({})
    }
    this.updatePoseRuntimeDiagnostics(pose)
    this.updatePoseLifecycle(pose, now)

    const activeInteraction = this.interactionController.getActiveId()
    const interactionScale = activeInteraction ? this.poseAsset?.manifest.interactionScale?.[activeInteraction] ?? 1 : 1
    const interaction = this.interactionController.update(now, interactionScale)
    if (this.diagnostics.interactionState !== interaction.state) this.diagnostics = { ...this.diagnostics, interactionState: interaction.state }
    this.motionOrchestrator.updateBlink(now, this.autoBlink)
  }

  private emptyDiagnostics(): RigDiagnostics {
    return {
      renderer: "Anime2.5DRig WebGL1", rigger: "Rigger.buildRig", upstreamCommit: UPSTREAM_COMMIT,
      webglStencil: this.renderer?.stencilEnabled ?? false, fps: 0, psdCanvas: "—", psdLayerCount: 0,
      layerNames: [], layerOrder: [], missingRequiredLayers: [], rigLayerCount: 0, meshCount: 0, textureCount: 0,
      headLayers: 0, bodyLayers: 0, eyeLayers: 0, hairLayers: 0, hairStrandCount: 0,
      syntheticEyeClose: false, syntheticMouthClose: false, warnings: [], anchors: null,
      pointerModel: null, hitArea: "background", gesture: "—", interactionState: "IDLE",
      poseState: "BASE",
      pose: this.poseDiagnostics,
      parameters: { ...DEFAULT_PARAMETERS },
      qualityMode: this.qualityMode,
      hairTestMode: this.hairTestMode,
      autoBlink: this.autoBlink,
      motionSources: this.sourceHost.diagnostics(),
      blink: this.motionOrchestrator.getBlinkDiagnostics(),
      gaze: this.motionOrchestrator.getGazeDiagnostics(),
      lifecycle: this.lifecycle.getHistory(),
      layerInspections: [], hiddenLayers: [], isolatedLayer: null, qualityFindings: [],
      sourceReferenceUrl: this.sourceReferenceUrl, characterId: this.characterId,
      hairPhysics: this.hairPhysics,
    }
  }

  private syncRendererPhysicsMode() {
    const comparisonMode = this.qualityMode !== "RIG_ANIMATED"
    this.renderer.setHairTestMode(comparisonMode ? "off" : this.hairTestMode)
  }

  private syncMotionDiagnostics(now = this.clock.now()) {
    this.diagnostics = {
      ...this.diagnostics,
      motionSources: this.sourceHost.diagnostics(),
      blink: this.motionOrchestrator.getBlinkDiagnostics(now),
      gaze: this.motionOrchestrator.getGazeDiagnostics(now),
      lifecycle: this.lifecycle.getHistory(),
    }
  }

  private updatePoseRuntimeDiagnostics(sample: ReturnType<PoseTransition["sample"]>) {
    this.poseDiagnostics = {
      ...this.poseDiagnostics,
      state: sample.state,
      progress: sample.progress,
      mix: sample.mix,
      baseGpuResources: this.renderer.baseResourceCount,
      poseGpuResources: this.renderer.poseResourceCount,
      previousId: this.poseCrossfade?.previousId ?? null,
      crossfade: this.crossfadeMix(this.clock.now()),
    }
    this.syncAvailablePoses()
    this.syncPoseDiagnostics()
  }

  waitForPoseState(target: PoseRuntimeState, options: PoseWaitOptions & { poseId?: string; requestId?: string } = {}): Promise<void> {
    const current = this.samplePoseState(this.clock.now())
    const poseMatches = !options.poseId || this.poseAsset?.manifest.id === options.poseId
    if (current.state === target && poseMatches) return Promise.resolve()
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason))
    const requestId = options.requestId ?? this.activePoseRequest?.requestId ?? this.nextPoseRequestId("wait")

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        this.poseWaiters.delete(waiter)
      }
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () => {
        finish(abortError(options.signal?.reason))
      }
      const waiter: PoseWaiter = {
        requestId,
        target,
        poseId: options.poseId ?? null,
        resolve: () => finish(),
        reject: (error) => finish(error),
        cleanup,
      }
      this.poseWaiters.add(waiter)
      options.signal?.addEventListener("abort", onAbort, { once: true })
      const timeoutMs = options.timeoutMs ?? 15_000
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => {
        finish(new Error(`Timed out waiting for pose state ${target}`))
      }, timeoutMs)
    })
  }

  private async waitForPoseOperation(
    target: PoseRuntimeState,
    options: PoseWaitOptions & { poseId: string; requestId: string; cancelOnAbort?: boolean },
  ): Promise<void> {
    try {
      await this.waitForPoseState(target, options)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (options.cancelOnAbort !== false || !options.signal?.aborted) this.cancelPoseRequest(reason, { requestId: options.requestId, settleMode: "reverse" })
      throw error
    }
  }

  private crossfadeMix(now: number) {
    if (!this.poseCrossfade) return 1
    const t = Math.max(0, Math.min(1, (now - this.poseCrossfade.startedAt) / this.poseCrossfade.durationMs))
    return t * t * (3 - 2 * t)
  }

  private samplePoseState(now: number): ReturnType<PoseTransition["sample"]> {
    const sample = this.poseTransition.sample(now)
    return this.poseCrossfade && sample.active && sample.state !== "EXITING"
      ? { ...sample, state: "SWITCHING" } : sample
  }

  private updatePoseLifecycle(sample: ReturnType<PoseTransition["sample"]>, now: number): void {
    const request = this.activePoseRequest
    if (request && sample.state === request.target) {
      if (request.direction === "enter") {
        this.lifecycle.emit({ type: "pose.enter.completed", poseId: request.poseId, requestId: request.requestId, at: now })
      } else {
        this.lifecycle.emit({ type: "pose.exit.completed", poseId: request.poseId, requestId: request.requestId, at: now })
      }
      this.activePoseRequest = null
      this.resolvePoseWaiters(request.requestId, request.target, request.poseId)
    }
    for (const waiter of [...this.poseWaiters]) {
      if (waiter.target === sample.state && (!waiter.poseId || waiter.poseId === this.poseAsset?.manifest.id)) waiter.resolve()
    }
    this.lastPoseState = sample.state
  }

  private cancelPoseRequest(
    reason: string,
    options: { requestId?: string; settleMode?: PoseCancelSettleMode } = {},
  ): boolean {
    const request = this.activePoseRequest
    if (!request || options.requestId && request.requestId !== options.requestId) return false
    this.activePoseRequest = null
    const now = this.clock.now()
    const settleMode = options.settleMode ?? "leave-transition"
    const settleTarget = settleMode === "reverse"
      ? request.direction === "enter" ? "BASE" : "ACTIVE_LOOP"
      : settleMode === "reset" ? "BASE" : null
    if (settleMode === "reverse") {
      if (request.direction === "enter") this.poseTransition.exit(now)
      else this.poseTransition.enter(now)
    } else if (settleMode === "reset") {
      this.poseTransition.reset()
    }
    this.lifecycle.emit({
      type: "pose.cancelled",
      poseId: request.poseId,
      requestId: request.requestId,
      reason,
      direction: request.direction,
      settleTarget,
      at: now,
    })
    const error = new Error(`POSE_REQUEST_CANCELLED: ${reason}`)
    error.name = "AbortError"
    for (const waiter of [...this.poseWaiters]) if (waiter.requestId === request.requestId) waiter.reject(error)
    return true
  }

  private resolvePoseWaiters(requestId: string, target: PoseRuntimeState, poseId: string): void {
    for (const waiter of [...this.poseWaiters]) {
      if (waiter.requestId === requestId && waiter.target === target && (!waiter.poseId || waiter.poseId === poseId)) waiter.resolve()
    }
  }

  private nextPoseRequestId(kind: string): string {
    return `${kind}:${++this.poseRequestSequence}`
  }

  private syncPoseDiagnostics() {
    if (!this.diagnostics) return
    this.diagnostics = {
      ...this.diagnostics,
      poseState: this.poseDiagnostics.state,
      pose: this.poseDiagnostics,
      meshCount: this.renderer.meshCount,
      textureCount: this.renderer.textureCount,
    }
  }

  private syncAvailablePoses() {
    const loadedId = this.poseAsset?.manifest.id ?? null
    const activeId = this.poseDiagnostics.state === "BASE" ? null : loadedId
    this.poseDiagnostics = { ...this.poseDiagnostics, availablePoses: this.poseRegistry.list(loadedId, activeId) }
  }

  private combinedPoseRig(asset: PoseAsset): RigDefinition {
    if (asset.selection.independentModel) return asset.result.model.rig
    const base = this.model as NonNullable<typeof this.model>
    const replaced = new Set(asset.selection.baseReplace)
    const selectedPose = new Set([...asset.selection.poseReplace, ...asset.selection.poseAdditive])
    const poseLayers = asset.result.model.rig.layers
      .filter((layer) => selectedPose.has(layer.name))
      .map((layer) => this.transformLayerBounds(layer, asset.registration.transform))
    return {
      ...base.rig,
      layers: [...base.rig.layers.filter((layer) => !replaced.has(layer.name)), ...poseLayers],
      anchors: base.rig.anchors,
    }
  }

  private transformLayerBounds(layer: RigLayer, transform: PoseAsset["registration"]["transform"]): RigLayer {
    const corners = [
      transformPosePoint({ cx: layer.x, cy: layer.y }, transform),
      transformPosePoint({ cx: layer.x + layer.w, cy: layer.y }, transform),
      transformPosePoint({ cx: layer.x, cy: layer.y + layer.h }, transform),
      transformPosePoint({ cx: layer.x + layer.w, cy: layer.y + layer.h }, transform),
    ]
    const xs = corners.map((point) => point.cx)
    const ys = corners.map((point) => point.cy)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { ...layer, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }

  private rigLayerKey(name: string) {
    const normalized = name.normalize("NFKC").trim().toLowerCase()
    if (this.model?.rig.layers.some((layer) => layer.name === normalized)) return normalized
    const eye = normalized.match(/^(eyewhite|irides|eyelash|eyebrow|eye_close)[-_][lr]$/)
    return eye?.[1] ?? normalized
  }

  private ensureManualLease(): MotionSourceLease {
    if (!this.manualLease?.active()) this.manualLease = this.sourceHost.acquire({ slot: "manual", ownerId: `${this.runtimeOwnerId}:manual`, priority: 100 })
    return this.manualLease
  }

  private absoluteContributions(values: Partial<Anime25DParameterState>): MotionContributionFrame {
    return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, mode: "override" }])) as MotionContributionFrame
  }

  private invalidateSourceLeaseReferences(): void {
    this.manualLease = null
    this.qaBlinkLease = null
    this.poseParameterLease = null
    this.behaviorStateLease = null
    this.behaviorActionLease = null
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}

function abortError(reason?: unknown): Error {
  const error = new Error(typeof reason === "string" ? reason : "Pose wait aborted")
  error.name = "AbortError"
  return error
}
