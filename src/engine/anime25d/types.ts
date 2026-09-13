export type Point = { cx: number; cy: number }

export type Bounds = { x0: number; y0: number; x1: number; y1: number }
export type FaceBounds = Bounds & Point
export type EyeBlinkProfile = {
  /** Canvas-space eye frame. Positive angles follow the tilted face clockwise. */
  center: Point
  angleDeg: number
  /** Equally spaced samples in that frame, from u0 to u1. */
  u0: number
  u1: number
  upper: number[]
  lower: number[]
  closed: number[]
  /** Position of the pose's own closed-lid artwork before/after alignment. */
  closedSource: Point
  closedTarget: Point
  closedRotationDeg: number
}
export type EyeAnchor = Bounds & { icx: number; icy: number; closeY: number; blink?: EyeBlinkProfile }
export type MouthShape = { u0: number; u1: number; upper: number[]; lower: number[] }
export type MouthMorphProfile = {
  center: Point
  angleDeg: number
  neutral: MouthShape
  open: MouthShape
  smile: MouthShape
}
export type MouthAnchor = Bounds & Point & { morph?: MouthMorphProfile }

export type RigAnchors = {
  face: FaceBounds
  eyeL?: EyeAnchor
  eyeR?: EyeAnchor
  mouth: MouthAnchor
  neckPivot: Point
  bodyPivot: Point
  neckTop: number
  neckBottom: number
  hairRootY: number
  faceScale: number
}

export type HairStrand = { x: number; rootY: number; tipY: number }
export type RigImage = { width: number; height: number; data: Uint8ClampedArray }
export type PsdCompositeLayer = { name: string; x: number; y: number; visible: boolean; img: RigImage }

export type RigLayer = {
  name: string
  x: number
  y: number
  w: number
  h: number
  z: number
  depth: number
  group: "head" | "body" | string
  phys: "hair" | null
  fade: "eyeOpen" | "eyeClose" | "mouthOpen" | "mouthClose" | null
  mouthExpression?: "neutral" | "open" | "smile"
  deformationSource?: string
  meshSource?: string
  hairAttachment?: { rootY: number; bodyY: number }
  headFollow?: { center: Point; radius: number; falloffRadius: number }
  side: "L" | "R" | null
  strands: HairStrand[] | null
  synthetic?: boolean
  img: RigImage
}

export type RigDefinition = {
  canvas: { w: number; h: number }
  layers: RigLayer[]
  anchors: RigAnchors
  interactionAreas?: Partial<Record<"face" | "head" | "torso", Bounds>>
  warnings: string[]
  synth: { eye: boolean; mouth: boolean }
}

export type PsdLayerDiagnostic = {
  name: string
  normalizedName: string
  order: number
  visible: boolean
  path: string
}

export type Anime25DModelData = {
  sourceName: string
  rig: RigDefinition
  psdLayers: PsdLayerDiagnostic[]
  missingRequiredLayers: string[]
  rawComposite: RigImage
  cleanedComposite: RigImage
  rawCompositeLayers: PsdCompositeLayer[]
  cleanedCompositeLayers: PsdCompositeLayer[]
  assetDiagnostics: RigAssetDiagnostics
}

export type RigLoadResult = {
  model: Anime25DModelData
  preprocessing: { noisy: number; layers: number }
}

export type QualityMode = "SOURCE_REFERENCE" | "RAW_PSD_COMPOSITE" | "CLEANED_PSD_COMPOSITE" | "RIG_NEUTRAL" | "RIG_ANIMATED"
export type HairTestMode = "off" | "combined" | "wind" | "inertia"

export type HairPhysicsTuning = {
  amplitude: number
  stiffness: number
  damping: number
  wind: number
  inertia: number
  rootLock: number
  maxOffset: number
}

export type HairPhysicsConfig = {
  frontHair: HairPhysicsTuning
  backHair: HairPhysicsTuning
  layers: Record<string, Partial<HairPhysicsTuning>>
}

export type RigLayerInspection = {
  id: string
  name: string
  normalizedName: string
  path: string
  order: number
  visible: boolean
  group: string
  bounds: Bounds
  alphaBefore: number
  alphaAfter: number
  fade: RigLayer["fade"]
  side: string
  hairStrands: number
}

export type RigQualityFinding = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  layer?: string
}

export type RigAssetDiagnostics = {
  source: string
  canvas: [number, number]
  rawLayers: RigLayerInspection[]
  cleanedLayers: RigLayerInspection[]
  rigLayers: Array<Pick<RigLayer, "name" | "x" | "y" | "w" | "h" | "z" | "depth" | "group" | "fade" | "side"> & { hairStrands: number }>
  anchors: RigAnchors
  warnings: string[]
  qualityFindings: RigQualityFinding[]
}

export type HitArea = "face" | "head" | "torso" | "background"
export type InteractionId = "HEAD_TAP" | "HOLD_START" | "HOLD_LOOP" | "HOLD_END" | "TORSO_TAP" | "PET_START" | "PET_LOOP" | "PET_END" | "DRAG"

export type Anime25DParameterState = {
  angleX: number
  angleY: number
  angleZ: number
  eyeOpenL: number
  eyeOpenR: number
  eyeX: number
  eyeY: number
  irisScale: number
  brow: number
  browAngL: number
  browAngR: number
  browAngSym: number
  mouthOpen: number
  mouthForm: number
  mouthCY: number
  body: number
  armY: number
  armPos: number
  physAmp: number
  soft: number
  bust: number
  bustY: number
  bangL: number
  bangC: number
  bangR: number
  fhAmp: number
  fhSoft: number
  eyeEase: number
  mouthEase: number
  eyeCY: number
  eyeCAng: number
  mouthCAng: number
  eyeScaleL: number
  eyeScaleR: number
  mouthScale: number
}

export type Anime25DParameter = keyof Anime25DParameterState

export type RigDiagnostics = {
  renderer: "Anime2.5DRig WebGL1"
  rigger: "Rigger.buildRig"
  upstreamCommit: string
  webglStencil: boolean
  fps: number
  psdCanvas: string
  psdLayerCount: number
  layerNames: string[]
  layerOrder: string[]
  missingRequiredLayers: string[]
  rigLayerCount: number
  meshCount: number
  textureCount: number
  headLayers: number
  bodyLayers: number
  eyeLayers: number
  hairLayers: number
  hairStrandCount: number
  syntheticEyeClose: boolean
  syntheticMouthClose: boolean
  warnings: string[]
  anchors: RigAnchors | null
  pointerModel: { x: number; y: number } | null
  hitArea: HitArea
  gesture: string
  interactionState: string
  poseState: string
  pose: import("../../pose/types").PoseRuntimeDiagnostics
  parameters: Anime25DParameterState
  qualityMode: QualityMode
  hairTestMode: HairTestMode
  autoBlink: boolean
  motionSources: import("../../motion/orchestration/types").MotionSourceDiagnostics[]
  blink: import("../../motion/sources/BlinkController").BlinkDiagnostics
  gaze: import("../../motion/orchestration/MotionOrchestrator").GazeDiagnostics
  lifecycle: Array<import("../../motion/orchestration/MotionLifecycleBus").RuntimeEventEnvelope<import("../../motion/orchestration/MotionLifecycleBus").MotionLifecycleEvent>>
  layerInspections: RigLayerInspection[]
  hiddenLayers: string[]
  isolatedLayer: string | null
  qualityFindings: RigQualityFinding[]
  sourceReferenceUrl: string | null
  characterId: string | null
  hairPhysics: HairPhysicsConfig
}
