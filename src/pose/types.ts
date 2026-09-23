import type { Anime25DParameter, InteractionId, RigLoadResult } from "../engine/anime25d/types"
import type { MotionTrack, MotionTiming } from "../motion/types"

export type CatalogManifest = {
  schemaVersion: 1
  characters: string[]
}

export type CharacterManifest = {
  schemaVersion: 1
  id: string
  label: string
  base: { source: string; psd: string; overrides?: string }
  poses: string[]
  behavior?: string
  chat?: string
  persona?: string
  dialogue?: string
}

export type PoseManifest = {
  schemaVersion: 1
  id: string
  label: string
  source: string
  psd: string
  overrides?: string
  strategy: "semantic-layer-swap" | "independent-model"
  registration: {
    strategy: "eyes-and-neck" | "identity"
    maxScaleDelta: number
    maxRotationDeg: number
    maxAnchorErrorPx: number
  }
  layers: {
    sharedFromBase: string[]
    replaceFromBase: string[]
    useFromPose: string[]
    addFromPose: string[]
    renderBehindBase?: Array<{ pose: string; base: string }>
    renderInFrontOfBase?: Array<{ pose: string; base: string }>
  }
  transition: {
    enterMs: number
    exitMs: number
    swapStart: number
    swapEnd: number
  }
  motion?: PoseMotion
  interactionScale?: Partial<Record<InteractionId, number>>
}

export type PoseMotionTrack = MotionTrack

export type PoseLayerMotion = {
  translateX?: PoseMotionTrack
  translateY?: PoseMotionTrack
  rotationDeg?: PoseMotionTrack
  scale?: PoseMotionTrack
  origin?: PoseLayerTransformOrigin
  influence?: PoseLayerTransformInfluence
}

export type PoseLayerTransformOrigin = {
  /** Layer-local normalized coordinates. Values outside 0..1 allow a shared joint outside the layer bounds. */
  x: number
  y: number
}

export type PoseLayerTransformInfluence = {
  /** Layer-local direction that separates the fixed and moving sides of the joint. */
  axisX: number
  axisY: number
  /** Projected distances from origin where the smooth transform blend starts and ends. */
  start: number
  end: number
}

export type PoseMotion = MotionTiming & {
  /** Keep the sampled loop through interruptible enter/exit. Omitted preserves legacy behavior. */
  transition?: "continuous"
  parameters: Partial<Record<Anime25DParameter, PoseMotionTrack>>
  layers: Record<string, PoseLayerMotion>
}

export type PoseLayerTransform = {
  translateX: number
  translateY: number
  rotationDeg: number
  scale: number
  origin?: PoseLayerTransformOrigin
  influence?: PoseLayerTransformInfluence
}

export type PoseSummary = {
  id: string
  label: string
  manifestUrl: string
  loaded: boolean
  active: boolean
}

export type LoadedCharacter = CharacterManifest & {
  revision?: string
  manifestUrl: string
  baseUrls: { source: string; psd: string; overrides?: string }
  poseManifestUrls: string[]
  behaviorManifestUrl?: string
  dialogueManifestUrl?: string
  warnings: string[]
}

export type PoseTransform = {
  scale: number
  rotationRad: number
  translationX: number
  translationY: number
  sourceCenterX: number
  sourceCenterY: number
}

export type PoseRegistrationDiagnostics = {
  accepted: boolean
  errorCode: "POSE_ASSET_REGISTRATION_FAILED" | null
  baseEyeDistance: number
  poseEyeDistance: number
  scale: number
  scaleDelta: number
  rotationDeg: number
  eyeResidualError: number
  neckResidualError: number
  reasons: string[]
  transform: PoseTransform
}

export type PoseLayerSelection = {
  /** All visible parts and deformation anchors belong to this pose's model. */
  independentModel?: boolean
  baseShared: string[]
  baseReplace: string[]
  poseReplace: string[]
  poseAdditive: string[]
  renderBehindBase: Array<{ pose: string; base: string }>
  renderInFrontOfBase: Array<{ pose: string; base: string }>
  errors: string[]
  warnings: string[]
}

export type PoseAsset = {
  manifest: PoseManifest
  manifestUrl: string
  sourceUrl: string
  result: RigLoadResult
  registration: PoseRegistrationDiagnostics
  selection: PoseLayerSelection
  warnings: string[]
}

export type PoseRuntimeState = "BASE" | "ENTERING" | "SWITCHING" | "ACTIVE_LOOP" | "EXITING"

export type PoseRuntimeDiagnostics = {
  id: string | null
  label: string | null
  psd: string | null
  loadStatus: "unavailable" | "loading" | "ready" | "rejected" | "error"
  registrationStatus: "unavailable" | "pending" | "accepted" | "rejected"
  registration: PoseRegistrationDiagnostics | null
  state: PoseRuntimeState
  progress: number
  mix: number
  activeLayerCount: number
  baseGpuResources: number
  poseGpuResources: number
  sharedBaseLayers: string[]
  baseReplaceLayers: string[]
  poseReplaceLayers: string[]
  poseAdditiveLayers: string[]
  availablePoses: PoseSummary[]
  motionLayerCount: number
  warnings: string[]
  error: string | null
  pendingId?: string | null
  previousId?: string | null
  crossfade?: number
}
