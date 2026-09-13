import { meshGridFor } from "./MeshLimits"
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders"
import { blendSpringOffset, DEFAULT_HAIR_PHYSICS, mergeHairPhysics, rootWeightedAmount, stepSpring, tuningForLayer } from "./HairPhysicsConfig"
import type { Anime25DParameterState, EyeAnchor, HairPhysicsConfig, HairTestMode, RigAnchors, RigDefinition, RigImage, RigLayer } from "./types"
import { transformPosePoint } from "../../pose/PoseRegistration"
import type { PoseLayerSelection, PoseLayerTransform, PoseTransform } from "../../pose/types"
import { layerMatchesSelector } from "../../pose/PoseLayerSelector"
import { alignClosedEye, deformEyeAperture, eyeFrameOffset } from "./EyeBlink"
import { deformMouthPoint, mouthFrameOffset, mouthMorphWeights } from "./MouthMorph"
import { headFollowWeight } from "./HeadFollow"
import { ModelCompositor } from "./ModelCompositor"

type SpringAxis = { x: number; v: number; dx: number }
type StrandSpring = { stiff: SpringAxis; soft: SpringAxis; phase: number }
type IndependentPoseContext = { anchors: RigAnchors; bounce: { x: number; v: number; dy: number }; eyeWhiteSides: Set<string> }

type MeshLayer = Omit<RigLayer, "img"> & {
  base: Float32Array
  current: Float32Array
  uv: Float32Array
  indices: Uint16Array
  nx: number
  ny: number
  baseName: string
  positionBuffer: WebGLBuffer
  uvBuffer: WebGLBuffer
  indexBuffer: WebGLBuffer
  texture: WebGLTexture
  strandWeights?: Float32Array
  strandU?: Float32Array
  bangWeights?: Float32Array
  springs?: StrandSpring[]
  renderSlot: number
  pose: boolean
  outgoing?: boolean
  meshParent?: MeshLayer
  independent?: IndependentPoseContext
}

type RenderParameters = Anime25DParameterState & { breath: number; breathHead: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const smooth = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t) }
const BREATH_PERIOD_SECONDS = 3.8
const BREATH_AMPLITUDE = 1.6

export function basePoseLayerAlpha(visibility: number, crossfade: number, outgoingReplaces: boolean, incomingReplaces: boolean) {
  return 1 - visibility * ((outgoingReplaces ? 1 - crossfade : 0) + (incomingReplaces ? crossfade : 0))
}

export function sampleBreathingMotion(seconds: number) {
  const phase = seconds * 2 * Math.PI / BREATH_PERIOD_SECONDS
  return {
    breath: BREATH_AMPLITUDE * Math.sin(phase),
    breathHead: BREATH_AMPLITUDE * 0.72 * Math.sin(phase - 0.18),
  }
}

export function computePoseLayerInfluenceWeight(
  u: number,
  v: number,
  origin: NonNullable<PoseLayerTransform["origin"]>,
  influence?: PoseLayerTransform["influence"],
) {
  if (!influence) return 1
  const axisLength = Math.hypot(influence.axisX, influence.axisY)
  if (axisLength < 1e-6) return 1
  const projection = ((u - origin.x) * influence.axisX + (v - origin.y) * influence.axisY) / axisLength
  return smooth((projection - influence.start) / (influence.end - influence.start))
}

function sampleMeshPoint(points: Float32Array, nx: number, ny: number, u: number, v: number): [number, number] {
  const gridX = u * nx
  const gridY = v * ny
  const x0 = clamp(Math.floor(gridX), 0, nx - 1)
  const y0 = clamp(Math.floor(gridY), 0, ny - 1)
  const tx = gridX - x0
  const ty = gridY - y0
  const point = (x: number, y: number) => {
    const index = (y * (nx + 1) + x) * 2
    return [points[index], points[index + 1]] as const
  }
  const topLeft = point(x0, y0)
  const topRight = point(x0 + 1, y0)
  const bottomLeft = point(x0, y0 + 1)
  const bottomRight = point(x0 + 1, y0 + 1)
  const topX = topLeft[0] + (topRight[0] - topLeft[0]) * tx
  const topY = topLeft[1] + (topRight[1] - topLeft[1]) * tx
  const bottomX = bottomLeft[0] + (bottomRight[0] - bottomLeft[0]) * tx
  const bottomY = bottomLeft[1] + (bottomRight[1] - bottomLeft[1]) * tx
  return [topX + (bottomX - topX) * ty, topY + (bottomY - topY) * ty]
}

export function constrainPoseRenderSlot(
  name: string,
  slot: number,
  baseLayers: Array<{ name: string; renderSlot: number }>,
  behindRules: PoseLayerSelection["renderBehindBase"],
  inFrontRules: PoseLayerSelection["renderInFrontOfBase"] = [],
) {
  const upperLimits = behindRules
    .filter((rule) => layerMatchesSelector(name, rule.pose))
    .flatMap((rule) => baseLayers.filter((layer) => layerMatchesSelector(layer.name, rule.base)).map((layer) => layer.renderSlot - 0.01))
  const lowerLimits = inFrontRules
    .filter((rule) => layerMatchesSelector(name, rule.pose))
    .flatMap((rule) => baseLayers.filter((layer) => layerMatchesSelector(layer.name, rule.base)).map((layer) => layer.renderSlot + 0.01))
  const belowBase = upperLimits.length ? Math.min(slot, ...upperLimits) : slot
  return lowerLimits.length ? Math.max(belowBase, ...lowerLimits) : belowBase
}

export function computeLayerFadeAlpha(layer: Pick<RigLayer, "fade" | "side" | "mouthExpression">, parameters: Pick<Anime25DParameterState, "eyeOpenL" | "eyeOpenR" | "eyeEase" | "mouthOpen" | "mouthEase"> & Partial<Pick<Anime25DParameterState, "mouthForm">>) {
  if (layer.mouthExpression) {
    const open = smooth(parameters.mouthOpen), smile = smooth(parameters.mouthForm ?? 0)
    if (layer.mouthExpression === "smile") return smile
    if (layer.mouthExpression === "open") return (1 - smile) * open
    return (1 - smile) * (1 - open)
  }
  if (!layer.fade) return 1
  if (layer.fade === "eyeOpen") {
    const value = layer.side === "L" ? parameters.eyeOpenL : parameters.eyeOpenR
    // The mesh supplies the half-closed aperture. Keep its lid opaque, then
    // hand off to the closed-eye artwork only near the end of the blink.
    return smooth((value - 0.08) / 0.06)
  }
  if (layer.fade === "eyeClose") {
    const value = layer.side === "L" ? parameters.eyeOpenL : parameters.eyeOpenR
    return 1 - smooth((value - 0.08) / 0.06)
  }
  if (layer.fade === "mouthOpen") return smooth((parameters.mouthOpen - (0.05 + parameters.mouthEase * 0.35)) / 0.12)
  if (layer.fade === "mouthClose") return 1 - smooth((parameters.mouthOpen - (0.05 + parameters.mouthEase * 0.35)) / 0.12)
  return 1
}

export function shouldUseEyeWhiteStencil(side: RigLayer["side"], eyeWhiteSides: ReadonlySet<string>) {
  return eyeWhiteSides.has(side ?? "both") || eyeWhiteSides.has("both")
}

function must<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`WebGL resource unavailable: ${label}`)
  return value
}

export class Anime25DRenderer {
  readonly gl: WebGLRenderingContext
  readonly stencilEnabled: boolean
  private readonly program: WebGLProgram
  private readonly positionLocation: number
  private readonly uvLocation: number
  private readonly resolutionLocation: WebGLUniformLocation
  private readonly alphaLocation: WebGLUniformLocation
  private readonly cutLocation: WebGLUniformLocation
  private layers: MeshLayer[] = []
  private poseLayers: MeshLayer[] = []
  private poseMix = 0
  private poseCrossfade = 1
  private outgoingPose: { layers: MeshLayer[]; replaced: Set<string>; transforms: Record<string, PoseLayerTransform> } | null = null
  private poseLayerTransforms: Record<string, PoseLayerTransform> = {}
  private readonly baseReplaceLayers = new Set<string>()
  private anchors: RigAnchors | null = null
  private lastTime = performance.now()
  private fpsStarted = this.lastTime
  private fpsFrames = 0
  private measuredFps = 0
  private bounce = { x: 0, v: 0, dy: 0 }
  private hairPhysics: HairPhysicsConfig = DEFAULT_HAIR_PHYSICS
  private hairTestMode: HairTestMode = "combined"
  private readonly hiddenLayers = new Set<string>()
  private isolatedLayer: string | null = null
  private readonly eyeWhiteSides = new Set<string>()
  private readonly deformedLayers = new Set<MeshLayer>()
  private compositor: ModelCompositor | null = null

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { alpha: true, stencil: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true })
    if (!gl) throw new Error("WebGL1을 사용할 수 없습니다.")
    this.gl = gl
    this.stencilEnabled = Boolean(gl.getContextAttributes()?.stencil)

    this.program = must(gl.createProgram(), "program")
    gl.attachShader(this.program, this.compile(gl.VERTEX_SHADER, VERTEX_SHADER))
    gl.attachShader(this.program, this.compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
    gl.linkProgram(this.program)
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program) || "WebGL program link failed")
    gl.useProgram(this.program)

    this.positionLocation = gl.getAttribLocation(this.program, "aPos")
    this.uvLocation = gl.getAttribLocation(this.program, "aUV")
    this.resolutionLocation = must(gl.getUniformLocation(this.program, "uRes"), "uRes")
    this.cutLocation = must(gl.getUniformLocation(this.program, "uCut"), "uCut")
    this.alphaLocation = must(gl.getUniformLocation(this.program, "uAlpha"), "uAlpha")
    gl.enableVertexAttribArray(this.positionLocation)
    gl.enableVertexAttribArray(this.uvLocation)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  }

  get fps() { return this.measuredFps }
  get meshCount() { return this.layers.length + this.poseResourceCount }
  get textureCount() { return this.meshCount + (this.compositor?.textureCount ?? 0) }
  get bufferCount() { return this.meshCount * 3 + (this.compositor?.bufferCount ?? 0) }
  get framebufferCount() { return this.compositor?.framebufferCount ?? 0 }
  get renderbufferCount() { return this.compositor?.renderbufferCount ?? 0 }
  get baseResourceCount() { return this.layers.length }
  get poseResourceCount() { return this.poseLayers.length + (this.outgoingPose?.layers.length ?? 0) }
  get outgoingPoseResourceCount() { return this.outgoingPose?.layers.length ?? 0 }
  get physicsConfig() { return this.hairPhysics }

  readFrame(): RigImage {
    const { width, height } = this.canvas
    const raw = new Uint8Array(width * height * 4)
    const data = new Uint8ClampedArray(raw.length)
    this.gl.finish()
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, raw)
    for (let y = 0; y < height; y++) {
      const source = (height - 1 - y) * width * 4
      data.set(raw.subarray(source, source + width * 4), y * width * 4)
    }
    return { width, height, data }
  }

  sampleAlpha(x: number, y: number, radius = 0): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
    const centerX = Math.round(x)
    const centerY = Math.round(y)
    const safeRadius = Math.max(0, Math.min(8, Math.round(radius)))
    const left = Math.max(0, centerX - safeRadius)
    const bottom = Math.max(0, centerY - safeRadius)
    const right = Math.min(this.canvas.width - 1, centerX + safeRadius)
    const top = Math.min(this.canvas.height - 1, centerY + safeRadius)
    if (right < left || top < bottom) return 0
    const width = right - left + 1
    const height = top - bottom + 1
    const pixels = new Uint8Array(width * height * 4)
    this.gl.readPixels(left, bottom, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels)
    let alpha = 0
    for (let index = 3; index < pixels.length; index += 4) alpha = Math.max(alpha, pixels[index])
    return alpha / 255
  }

  applyRig(rig: RigDefinition) {
    const meshes: MeshLayer[] = []
    try {
      for (const [index, layer] of rig.layers.entries()) meshes.push(this.createMesh(layer, rig, undefined, index, false))
      this.connectMeshSources(meshes)
    } catch (error) { this.deleteMeshes(meshes); throw error }
    this.unload()
    this.clearLayerFilters()
    this.anchors = rig.anchors
    this.canvas.width = rig.canvas.w
    this.canvas.height = rig.canvas.h
    this.canvas.style.aspectRatio = `${rig.canvas.w} / ${rig.canvas.h}`
    this.layers = meshes
    this.eyeWhiteSides.clear()
    this.deformedLayers.clear()
    for (const layer of rig.layers) if (layer.name.startsWith("eyewhite")) this.eyeWhiteSides.add(layer.side ?? "both")
    this.lastTime = performance.now()
    this.bounce = { x: 0, v: 0, dy: 0 }
  }

  unload() {
    this.deleteMeshes(this.layers)
    this.disposePose()
    this.layers = []
    this.anchors = null
    this.eyeWhiteSides.clear()
    this.deformedLayers.clear()
    this.compositor?.dispose()
    this.compositor = null
  }

  applyPoseRig(rig: RigDefinition, selection: PoseLayerSelection, transform: PoseTransform) {
    const layers = this.createPoseMeshes(rig, selection, transform)
    this.disposePose()
    for (const name of selection.baseReplace) this.baseReplaceLayers.add(name)
    this.poseLayers = layers
    this.poseMix = 0
  }

  crossfadePoseRig(rig: RigDefinition, selection: PoseLayerSelection, transform: PoseTransform) {
    if (this.outgoingPose) throw new Error("Finish the current pose crossfade before starting another")
    // Allocate and validate the incoming GPU set before touching the visible pose.
    const layers = this.createPoseMeshes(rig, selection, transform)
    this.outgoingPose = { layers: this.poseLayers, replaced: new Set(this.baseReplaceLayers), transforms: this.poseLayerTransforms }
    for (const layer of this.outgoingPose.layers) layer.outgoing = true
    this.poseLayers = layers
    this.poseLayerTransforms = {}
    this.baseReplaceLayers.clear()
    for (const name of selection.baseReplace) this.baseReplaceLayers.add(name)
    this.poseCrossfade = 0
  }

  setPoseCrossfade(mix: number) { this.poseCrossfade = clamp(mix, 0, 1) }

  finishPoseCrossfade() {
    if (this.outgoingPose) this.deleteMeshes(this.outgoingPose.layers)
    this.outgoingPose = null
    this.poseCrossfade = 1
  }

  private createPoseMeshes(rig: RigDefinition, selection: PoseLayerSelection, transform: PoseTransform): MeshLayer[] {
    const selected = new Set([...selection.poseReplace, ...selection.poseAdditive])
    const baseMaxZ = Math.max(1, ...this.layers.map((layer) => layer.renderSlot))
    const poseMaxZ = Math.max(1, ...rig.layers.map((layer) => layer.z))
    // Keep the pose PSD's local front/back relationships (for example the
    // memo behind the fingers but in front of the torso) while fitting its
    // stack into the base rig's single draw queue. Semantic names decide
    // ownership; the authored pose z-order decides occlusion.
    const meshes: MeshLayer[] = []
    const independent: IndependentPoseContext | undefined = selection.independentModel ? {
      anchors: rig.anchors, bounce: { x: 0, v: 0, dy: 0 },
      eyeWhiteSides: new Set(rig.layers.filter(layer => layer.name.startsWith("eyewhite")).map(layer => layer.side ?? "both")),
    } : undefined
    try {
      for (const layer of rig.layers.filter(layer => selected.has(layer.name))) {
        const authoredSlot = independent ? layer.z : layer.z / poseMaxZ * baseMaxZ + 0.01
        meshes.push(this.createMesh(layer, rig, transform, constrainPoseRenderSlot(layer.name, authoredSlot, this.layers, selection.renderBehindBase, selection.renderInFrontOfBase), true, independent))
      }
      this.connectMeshSources(meshes)
      return meshes
    } catch (error) { this.deleteMeshes(meshes); throw error }
  }

  setPoseMix(mix: number) {
    this.poseMix = clamp(mix, 0, 1)
  }

  setPoseLayerTransforms(transforms: Record<string, PoseLayerTransform>) {
    this.poseLayerTransforms = transforms
  }

  disposePose() {
    this.finishPoseCrossfade()
    this.deleteMeshes(this.poseLayers)
    this.poseLayers = []
    this.poseMix = 0
    this.poseLayerTransforms = {}
    this.baseReplaceLayers.clear()
  }

  resize() {
    if (!this.anchors) return
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
  }

  impulse(amount: number) {
    for (const layer of [...this.layers, ...this.poseLayers, ...(this.outgoingPose?.layers ?? [])]) for (const spring of layer.springs ?? []) {
      spring.stiff.v += amount * 22
      spring.soft.v += amount * 38
    }
    this.bounce.v += amount * 28
  }

  setHairPhysics(config: Partial<HairPhysicsConfig>) {
    this.hairPhysics = mergeHairPhysics(config)
  }

  setHairTestMode(mode: HairTestMode) {
    this.hairTestMode = mode
    if (mode === "off") this.resetSprings()
  }

  resetSprings() {
    for (const layer of [...this.layers, ...this.poseLayers, ...(this.outgoingPose?.layers ?? [])]) for (const spring of layer.springs ?? []) {
      spring.stiff = { x: 0, v: 0, dx: 0 }
      spring.soft = { x: 0, v: 0, dx: 0 }
    }
  }

  setLayerVisible(name: string, visible: boolean) {
    if (visible) this.hiddenLayers.delete(name)
    else this.hiddenLayers.add(name)
  }

  isolateLayer(name: string | null) {
    this.isolatedLayer = name
  }

  clearLayerFilters() {
    this.hiddenLayers.clear()
    this.isolatedLayer = null
  }

  render(parameters: Anime25DParameterState, now = performance.now(), neutral = false) {
    if (!this.anchors || !this.layers.length) return
    const dt = Math.min(0.25, Math.max(0, (now - this.lastTime) / 1000))
    this.lastTime = now
    const seconds = now / 1000
    const breathing = neutral ? { breath: 0, breathHead: 0 } : sampleBreathingMotion(seconds)
    const rendered: RenderParameters = {
      ...parameters,
      ...breathing,
    }
    if (this.hairTestMode !== "off") this.updatePhysics(rendered, seconds, dt)
    this.deformedLayers.clear()

    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clearStencil(0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height)

    if (this.poseLayers.some(layer => layer.independent) || this.outgoingPose?.layers.some(layer => layer.independent)) {
      this.renderIndependentModels(rendered)
      this.updateFps(now)
      return
    }
    const queue = [
      ...this.layers.map((layer) => ({ layer, alpha: basePoseLayerAlpha(this.poseMix, this.poseCrossfade, this.outgoingPose?.replaced.has(layer.name) ?? false, this.baseReplaceLayers.has(layer.name)), source: 0 })),
      ...(this.outgoingPose?.layers ?? []).map(layer => ({ layer, alpha: this.poseMix * (1 - this.poseCrossfade), source: 1 })),
      ...this.poseLayers.map((layer) => ({ layer, alpha: this.poseMix * this.poseCrossfade, source: 2 })),
    ].sort((a, b) => a.layer.renderSlot - b.layer.renderSlot || a.source - b.source)
    for (const item of queue) this.drawLayer(item.layer, rendered, item.alpha)
    this.updateFps(now)
  }

  private renderIndependentModels(parameters: RenderParameters) {
    const draw = (layers: MeshLayer[]) => () => {
      for (const layer of [...layers].sort((a, b) => a.renderSlot - b.renderSlot)) this.drawLayer(layer, parameters)
    }
    const compose = (layers: MeshLayer[], replaced: Set<string>) => layers.some(layer => layer.independent)
      ? layers : [...this.layers.filter(layer => !replaced.has(layer.name)), ...layers]
    const groups = [
      { weight: 1 - this.poseMix, draw: draw(this.layers) },
      ...(this.outgoingPose ? [{ weight: this.poseMix * (1 - this.poseCrossfade), draw: draw(compose(this.outgoingPose.layers, this.outgoingPose.replaced)) }] : []),
      { weight: this.poseMix * this.poseCrossfade, draw: draw(compose(this.poseLayers, this.baseReplaceLayers)) },
    ].filter(group => group.weight > 0)
    // The steady pose uses the normal framebuffer directly, without an extra pass.
    if (groups.length === 1 && groups[0].weight === 1) groups[0].draw()
    else {
      this.compositor ??= new ModelCompositor(this.gl)
      this.compositor.render(this.canvas.width, this.canvas.height, {
        position: this.positionLocation, uv: this.uvLocation, alpha: this.alphaLocation, cut: this.cutLocation,
      }, groups)
    }
  }

  private compile(type: number, source: string) {
    const shader = must(this.gl.createShader(type), "shader")
    this.gl.shaderSource(shader, source)
    this.gl.compileShader(shader)
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) throw new Error(this.gl.getShaderInfoLog(shader) || "Shader compile failed")
    return shader
  }

  private createMesh(layer: RigLayer, rig: RigDefinition, transform?: PoseTransform, renderSlot = layer.z, pose = false, independent?: IndependentPoseContext): MeshLayer {
    const gl = this.gl
    const { nx, ny, vertexCount } = meshGridFor(layer, rig)
    if (layer.img.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || layer.img.height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error("PACK_LIMIT")
    const base = new Float32Array(vertexCount * 2)
    const uv = new Float32Array(vertexCount * 2)
    let cursor = 0
    for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
      const point = { cx: layer.x + layer.w * x / nx, cy: layer.y + layer.h * y / ny }
      const mapped = transform ? transformPosePoint(point, transform) : point
      base[cursor] = mapped.cx
      base[cursor + 1] = mapped.cy
      uv[cursor] = x / nx
      uv[cursor + 1] = y / ny
      cursor += 2
    }
    const rawIndices: number[] = []
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const a = y * (nx + 1) + x
      const b = a + 1
      const c = a + nx + 1
      const d = c + 1
      rawIndices.push(a, b, c, b, d, c)
    }
    const indices = new Uint16Array(rawIndices)
    const buffers: WebGLBuffer[] = []
    let createdTexture: WebGLTexture | null = null
    const buffer = (label: string) => { const b = must(gl.createBuffer(), label); buffers.push(b); return b }
    try {
    const positionBuffer = buffer("position buffer")
    const uvBuffer = buffer("uv buffer")
    const indexBuffer = buffer("index buffer")
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)

    const texture = must(gl.createTexture(), "texture")
    createdTexture = texture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    const image = new ImageData(new Uint8ClampedArray(layer.img.data), layer.img.width, layer.img.height)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (gl.getError() !== gl.NO_ERROR) throw new Error("GPU allocation failed")

    const corners = transform ? [
      transformPosePoint({ cx: layer.x, cy: layer.y }, transform),
      transformPosePoint({ cx: layer.x + layer.w, cy: layer.y }, transform),
      transformPosePoint({ cx: layer.x, cy: layer.y + layer.h }, transform),
      transformPosePoint({ cx: layer.x + layer.w, cy: layer.y + layer.h }, transform),
    ] : null
    const meshBounds = corners ? {
      x: Math.min(...corners.map((point) => point.cx)),
      y: Math.min(...corners.map((point) => point.cy)),
      w: Math.max(...corners.map((point) => point.cx)) - Math.min(...corners.map((point) => point.cx)),
      h: Math.max(...corners.map((point) => point.cy)) - Math.min(...corners.map((point) => point.cy)),
    } : { x: layer.x, y: layer.y, w: layer.w, h: layer.h }
    const mesh: MeshLayer = {
      ...layer,
      ...meshBounds,
      base,
      current: new Float32Array(base),
      uv,
      indices,
      nx,
      ny,
      baseName: (layer.deformationSource ?? layer.name).replace(/_(l|r)$/i, "").replace(/_\d+$/, ""),
      positionBuffer,
      uvBuffer,
      indexBuffer,
      texture,
      renderSlot,
      pose,
      ...(independent ? { independent } : {}),
    }
    if (!layer.meshSource) this.createStrandWeights(mesh, rig)
    return mesh
    } catch (error) {
      for (const b of buffers) gl.deleteBuffer(b)
      if (createdTexture) gl.deleteTexture(createdTexture)
      throw error
    }
  }

  private connectMeshSources(layers: MeshLayer[]) {
    for (const layer of layers) {
      const parent = layers.find(candidate => candidate.name === layer.meshSource)
      if (parent && parent !== layer && parent.nx === layer.nx && parent.ny === layer.ny && parent.base.every((value, index) => value === layer.base[index])) layer.meshParent = parent
    }
  }

  private createStrandWeights(layer: MeshLayer, rig: RigDefinition) {
    const strands = layer.strands
    if (!strands?.length) return
    const vertexCount = layer.base.length / 2
    let spacing = 120
    if (strands.length > 1) {
      const distances = strands.slice(1).map((strand, index) => strand.x - strands[index].x).sort((a, b) => a - b)
      spacing = distances[Math.floor(distances.length / 2)]
    }
    const sigma = spacing * 0.6
    layer.strandWeights = new Float32Array(vertexCount * strands.length)
    layer.strandU = new Float32Array(vertexCount)
    layer.springs = strands.map((_, index) => ({
      stiff: { x: 0, v: 0, dx: 0 }, soft: { x: 0, v: 0, dx: 0 }, phase: index * 1.37 + layer.z,
    }))
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const x = layer.base[vertex * 2]
      const y = layer.base[vertex * 2 + 1]
      let total = 0
      for (let strand = 0; strand < strands.length; strand++) {
        const weight = Math.exp(-Math.pow((x - strands[strand].x) / sigma, 2))
        layer.strandWeights[vertex * strands.length + strand] = weight
        total += weight
      }
      let rootY = 0
      let tipY = 0
      if (total > 1e-6) {
        for (let strand = 0; strand < strands.length; strand++) {
          const index = vertex * strands.length + strand
          layer.strandWeights[index] /= total
          rootY += layer.strandWeights[index] * strands[strand].rootY
          tipY += layer.strandWeights[index] * strands[strand].tipY
        }
      } else {
        layer.strandWeights[vertex * strands.length] = 1
        rootY = strands[0].rootY
        tipY = strands[0].tipY
      }
      layer.strandU[vertex] = clamp((y - rootY) / Math.max(1, tipY - rootY), 0, 1)
    }

    if (layer.baseName === "front hair" && !layer.hairAttachment) {
      const faceWidth = rig.anchors.face.x1 - rig.anchors.face.x0
      const left = rig.anchors.face.cx - faceWidth * 0.22
      const right = rig.anchors.face.cx + faceWidth * 0.22
      layer.bangWeights = new Float32Array(vertexCount * 3)
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        const x = layer.base[vertex * 2]
        const first = smooth((x - left) / 36 + 0.5)
        const second = smooth((x - right) / 36 + 0.5)
        layer.bangWeights[vertex * 3] = 1 - first
        layer.bangWeights[vertex * 3 + 1] = first * (1 - second)
        layer.bangWeights[vertex * 3 + 2] = second
      }
    }
  }

  private fadeAlpha(layer: MeshLayer, parameters: RenderParameters) {
    const anchors = layer.independent?.anchors ?? this.anchors
    if (layer.mouthExpression && anchors?.mouth.morph) return mouthMorphWeights(parameters.mouthOpen, parameters.mouthForm, anchors.mouth.morph)[layer.mouthExpression]
    return computeLayerFadeAlpha(layer, parameters)
  }

  private deform(layer: MeshLayer, p: RenderParameters) {
    if (this.deformedLayers.has(layer)) return
    this.deformedLayers.add(layer)
    if (layer.meshParent) {
      this.deform(layer.meshParent, p)
      layer.current.set(layer.meshParent.current)
      return
    }
    const anchors = (layer.independent?.anchors ?? this.anchors) as RigAnchors
    const base = layer.base
    const output = layer.current
    const isHead = layer.group === "head"
    const headAngle = p.angleZ * 0.07
    const headCos = Math.cos(headAngle)
    const headSin = Math.sin(headAngle)
    const bodyAngle = p.body * 0.028
    const bodyCos = Math.cos(bodyAngle)
    const bodySin = Math.sin(bodyAngle)
    const eyeAnchor: EyeAnchor | undefined = layer.side === "L" ? anchors.eyeL : layer.side === "R" ? anchors.eyeR : undefined
    const eyeOpen = layer.side === "L" ? p.eyeOpenL : p.eyeOpenR
    const mouthHalfWidth = (anchors.mouth.x1 - anchors.mouth.x0) / 2
    const faceScale = anchors.faceScale
    const layerCenterX = layer.x + layer.w / 2
    const layerCenterY = layer.y + layer.h / 2
    const chest = {
      cx: anchors.neckPivot.cx,
      cy: anchors.neckBottom + (anchors.face.y1 - anchors.face.y0) * 0.6,
      rx: (anchors.face.x1 - anchors.face.x0) * 0.6,
      ry: (anchors.face.y1 - anchors.face.y0) * 0.45,
    }

    for (let index = 0; index < base.length; index += 2) {
      let x = base[index]
      let y = base[index + 1]
      const vertex = index / 2
      if (eyeAnchor && layer.baseName === "eye_close") {
        if (eyeAnchor.blink) [x, y] = alignClosedEye(x, y, eyeAnchor.blink)
        const scale = layer.side === "L" ? p.eyeScaleL : p.eyeScaleR
        const cx = eyeAnchor.blink?.closedTarget.cx ?? (eyeAnchor.x0 + eyeAnchor.x1) / 2
        const cy = eyeAnchor.blink?.closedTarget.cy ?? (eyeAnchor.y0 + eyeAnchor.y1) / 2
        x = cx + (x - cx) * scale
        y = cy + (y - cy) * scale
      }
      if (layer.mouthExpression && anchors.mouth.morph) [x, y] = deformMouthPoint(x, y, layer.mouthExpression, p.mouthOpen, p.mouthForm, anchors.mouth.morph)
      if (layer.baseName === "mouth_open" || layer.baseName === "mouth_close" || layer.mouthExpression) {
        x = anchors.mouth.cx + (x - anchors.mouth.cx) * p.mouthScale
        y = anchors.mouth.cy + (y - anchors.mouth.cy) * p.mouthScale
      }
      if (layer.fade === "eyeOpen" && eyeAnchor) {
        if (layer.baseName === "irides") {
          const gaze = eyeAnchor.blink
            ? eyeFrameOffset(p.eyeX * 11 * faceScale, p.eyeY * 6 * faceScale, eyeAnchor.blink)
            : [p.eyeX * 11 * faceScale, p.eyeY * 6 * faceScale]
          x = eyeAnchor.icx + (x - eyeAnchor.icx) * p.irisScale + gaze[0]
          y = eyeAnchor.icy + (y - eyeAnchor.icy) * p.irisScale + gaze[1]
          if (!eyeAnchor.blink) {
            const closing = smooth((0.32 - eyeOpen) / 0.32)
            y = eyeAnchor.closeY + (y - eyeAnchor.closeY) * (1 - 0.8 * closing)
          }
        } else if (eyeAnchor.blink) [x, y] = deformEyeAperture(x, y, eyeOpen, eyeAnchor.blink)
        else y = eyeAnchor.closeY + (y - eyeAnchor.closeY) * (1 - 0.85 * (1 - eyeOpen))
      }
      if (layer.fade === "eyeClose" && eyeAnchor) {
        const offset = -eyeOpen * 3 + p.eyeCY * 14 * faceScale
        if (eyeAnchor.blink) {
          const [dx, dy] = eyeFrameOffset(0, offset, eyeAnchor.blink)
          x += dx; y += dy
        } else y += offset
        const angle = p.eyeCAng * 0.3 * (layer.side === "L" ? 1 : -1)
        ;[x, y] = this.rotate(x, y, eyeAnchor.blink?.closedTarget.cx ?? layerCenterX, eyeAnchor.blink?.closedTarget.cy ?? layerCenterY, angle)
      }
      if (layer.baseName === "eyebrow") {
        y += (-p.brow * 9 + (1 - eyeOpen) * 3.5) * faceScale
        const angle = (layer.side === "L" ? p.browAngL + p.browAngSym : p.browAngR - p.browAngSym) * 0.3
        ;[x, y] = this.rotate(x, y, layerCenterX, layerCenterY, angle)
      }
      if (layer.fade === "mouthOpen" && !layer.mouthExpression) {
        y = anchors.mouth.y0 + (y - anchors.mouth.y0) * (0.5 + 0.5 * p.mouthOpen)
        const curve = Math.pow(Math.abs(x - anchors.mouth.cx) / (mouthHalfWidth + 4), 1.5)
        y -= p.mouthForm * 6 * faceScale * (curve - 0.35)
      }
      if (layer.fade === "mouthClose" || layer.mouthExpression) {
        if (anchors.mouth.morph) {
          const [dx, dy] = mouthFrameOffset(0, p.mouthCY * 14 * faceScale, anchors.mouth.morph)
          x += dx; y += dy
        } else y += p.mouthCY * 14 * faceScale
        ;[x, y] = this.rotate(x, y, anchors.mouth.cx, anchors.mouth.cy, p.mouthCAng * 0.35)
      }
      if (layer.baseName === "face" && y > anchors.mouth.cy) y += (anchors.mouth.morph ? mouthMorphWeights(p.mouthOpen, p.mouthForm).aperture : p.mouthOpen) * 6 * faceScale * smooth((y - anchors.mouth.cy) / (anchors.face.y1 - anchors.mouth.cy))

      let headWeight = isHead ? 1 : layer.group === "body" ? 0.16 : 0
      const contactWeight = headFollowWeight(base[index], base[index+1], layer.headFollow)
      const depth = layer.depth+(1-layer.depth)*contactWeight
      if (layer.hairAttachment) {
        const { rootY, bodyY } = layer.hairAttachment
        headWeight = 1 - .84 * smooth((y - rootY) / Math.max(1, bodyY - rootY))
      }
      if (layer.baseName === "neck") headWeight = 0.55 * smooth((anchors.neckBottom - y) / Math.max(1, anchors.neckBottom - anchors.neckTop))
      headWeight += (1-headWeight)*contactWeight
      if (headWeight > 0) {
        const rx = x - anchors.neckPivot.cx
        const ry = y - anchors.neckPivot.cy
        x += (rx * headCos - ry * headSin - rx) * headWeight
        y += (rx * headSin + ry * headCos - ry) * headWeight
        x += headWeight * faceScale * (p.angleX * (14 + 40 * (depth - 1)) + p.angleX * (anchors.neckPivot.cy - y) * 0.028)
        y += headWeight * faceScale * (-p.angleY * (9 + 30 * (depth - 1)) - p.angleY * (depth - 1) * (y - anchors.face.cy) * 0.05)
      }
      const breath = layer.group === "body" ? p.breath * 2 : p.breathHead * 1.6
      y -= (breath+(p.breathHead*1.6-breath)*contactWeight) * faceScale
      if (layer.baseName === "topwear" && y < chest.cy) y -= (1-contactWeight) * p.breath * 2.2 * faceScale * smooth((chest.cy - y) / (chest.ry * 2))
      if (layer.baseName === "topwear") x = anchors.neckPivot.cx + (x - anchors.neckPivot.cx) * (1 + (1-contactWeight) * p.breath * 0.003)
      if (layer.baseName === "topwear") {
        const gx = (x - chest.cx) / chest.rx
        const gy = (y - (chest.cy + p.bustY * 70 * faceScale)) / chest.ry
        y += (1-contactWeight) * (layer.independent?.bounce ?? this.bounce).dy * p.bust * Math.exp(-gx * gx - gy * gy)
      }
      if (layer.baseName === "handwear") {
        const weight = smooth((y - layer.y) / layer.h * 1.15)
        y += -p.armY * 30 * faceScale * weight + p.armPos * 40 * faceScale
        x += p.armY * 6 * faceScale * weight * (x < anchors.neckPivot.cx ? 1 : -1)
      }
      if (layer.bangWeights && layer.strandU) {
        const amount = Math.pow(layer.strandU[vertex], 1.4) * 22 * faceScale
        x += (p.bangL * layer.bangWeights[vertex * 3] + p.bangC * layer.bangWeights[vertex * 3 + 1] + p.bangR * layer.bangWeights[vertex * 3 + 2]) * amount
      }
      if (this.hairTestMode !== "off" && layer.springs && layer.strandWeights && layer.strandU) {
        const frontHair = layer.baseName === "front hair" && !layer.hairAttachment
        const tuning = tuningForLayer(this.hairPhysics, layer.name)
        const u = frontHair ? Math.min(1, layer.strandU[vertex] * 1.35) : layer.strandU[vertex]
        const amplitude = rootWeightedAmount(u, tuning.rootLock, frontHair ? 1.8 : 2.1) * tuning.amplitude * (frontHair ? p.fhAmp : p.physAmp)
        const softMix = clamp(Math.pow(u, 1.2) * (frontHair ? p.fhSoft : p.soft), 0, 1)
        let dx = 0
        for (let strand = 0; strand < layer.springs.length; strand++) {
          const weight = layer.strandWeights[vertex * layer.springs.length + strand]
          const spring = layer.springs[strand]
          dx += weight * blendSpringOffset(spring.stiff.dx, spring.soft.dx, softMix)
        }
        dx = clamp(dx, -tuning.maxOffset, tuning.maxOffset)
        x += dx * amplitude
        y += Math.abs(dx) * amplitude * 0.12
      }
      output[index] = x
      output[index + 1] = y
    }

    if (Math.abs(bodyAngle) > 1e-4) for (let index = 0; index < output.length; index += 2) {
      const rx = output[index] - anchors.bodyPivot.cx
      const ry = output[index + 1] - anchors.bodyPivot.cy
      output[index] = anchors.bodyPivot.cx + rx * bodyCos - ry * bodySin
      output[index + 1] = anchors.bodyPivot.cy + rx * bodySin + ry * bodyCos
    }

    const local = layer.pose
      ? Object.entries(layer.outgoing ? this.outgoingPose?.transforms ?? {} : this.poseLayerTransforms).find(([selector]) => layerMatchesSelector(layer.name, selector))?.[1]
      : undefined
    if (local && (local.translateX || local.translateY || local.rotationDeg || local.scale !== 1)) {
      const angle = local.rotationDeg * Math.PI / 180
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const origin = local.origin ?? { x: 0.5, y: 0.5 }
      const [cx, cy] = local.origin
        ? sampleMeshPoint(output, layer.nx, layer.ny, origin.x, origin.y)
        : [layerCenterX, layerCenterY]
      for (let index = 0; index < output.length; index += 2) {
        const x = output[index]
        const y = output[index + 1]
        const rx = (x - cx) * local.scale
        const ry = (y - cy) * local.scale
        const transformedX = cx + rx * cos - ry * sin + local.translateX
        const transformedY = cy + rx * sin + ry * cos + local.translateY
        const weight = computePoseLayerInfluenceWeight(layer.uv[index], layer.uv[index + 1], origin, local.influence)
        output[index] = x + (transformedX - x) * weight
        output[index + 1] = y + (transformedY - y) * weight
      }
    }
  }

  private updatePhysics(p: RenderParameters, seconds: number, dt: number) {
    const anchors = this.anchors as RigAnchors
    const independentLayers = [...this.poseLayers, ...(this.outgoingPose?.layers ?? [])].filter(layer => layer.independent)
    for (const layer of [...this.layers, ...independentLayers]) for (const spring of layer.springs ?? []) {
      const localAnchors = layer.independent?.anchors ?? anchors
      const headDX = (p.angleX * 14 + p.angleZ * 0.07 * (localAnchors.neckPivot.cy - localAnchors.face.cy)) * localAnchors.faceScale
      const tuning = tuningForLayer(this.hairPhysics, layer.name)
      const windEnabled = this.hairTestMode === "combined" || this.hairTestMode === "wind"
      const inertiaEnabled = this.hairTestMode === "combined" || this.hairTestMode === "inertia"
      const wind = windEnabled ? (1.3 * Math.sin(seconds * 0.8 + spring.phase) + 0.7 * Math.sin(seconds * 1.9 + spring.phase * 2.3)) * tuning.wind : 0
      const target = (inertiaEnabled ? headDX * tuning.inertia : 0) + wind * localAnchors.faceScale
      spring.stiff = stepSpring(spring.stiff, target, tuning.stiffness, tuning.damping, tuning.maxOffset, dt)
      spring.soft = stepSpring(spring.soft, target, tuning.stiffness * 0.34, tuning.damping * 0.58, tuning.maxOffset, dt)
    }
    const target = (p.breath * 3 - p.angleY * 6 + p.body * 4) * anchors.faceScale
    const bounced = stepSpring({ x: this.bounce.x, v: this.bounce.v, dx: this.bounce.dy }, target, 140, 4.2, 160, dt)
    this.bounce = { x: bounced.x, v: bounced.v, dy: bounced.dx * 3 }
    for (const context of new Set(independentLayers.map(layer => layer.independent!))) {
      const target = (p.breath * 3 - p.angleY * 6 + p.body * 4) * context.anchors.faceScale
      const state = context.bounce
      const next = stepSpring({ x: state.x, v: state.v, dx: state.dy }, target, 140, 4.2, 160, dt)
      context.bounce = { x: next.x, v: next.v, dy: next.dx * 3 }
    }
  }

  private drawLayer(layer: MeshLayer, parameters: RenderParameters, alphaMultiplier = 1) {
    const layerKeys = [layer.name, layer.baseName]
    if (this.isolatedLayer && !layerKeys.includes(this.isolatedLayer)) return
    if (layerKeys.some((name) => this.hiddenLayers.has(name))) return
    const alpha = this.fadeAlpha(layer, parameters) * alphaMultiplier
    if (alpha < 0.004 && !(layer.fade === "eyeOpen" && layer.name.startsWith("eyewhite"))) return
    this.deform(layer, parameters)
    const gl = this.gl
    gl.uniform1f(this.alphaLocation, alpha)
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, layer.current, gl.DYNAMIC_DRAW)
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.uvBuffer)
    gl.vertexAttribPointer(this.uvLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindTexture(gl.TEXTURE_2D, layer.texture)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.indexBuffer)

    if (layer.name.startsWith("eyewhite")) {
      gl.enable(gl.STENCIL_TEST)
      gl.stencilFunc(gl.ALWAYS, 1, 0xff)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
      gl.uniform1f(this.cutLocation, 0.25)
      gl.drawElements(gl.TRIANGLES, layer.indices.length, gl.UNSIGNED_SHORT, 0)
      gl.disable(gl.STENCIL_TEST)
      gl.uniform1f(this.cutLocation, 0)
    } else if (layer.name.startsWith("irides") && shouldUseEyeWhiteStencil(layer.side, layer.independent?.eyeWhiteSides ?? this.eyeWhiteSides)) {
      gl.enable(gl.STENCIL_TEST)
      gl.stencilFunc(gl.EQUAL, 1, 0xff)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP)
      gl.drawElements(gl.TRIANGLES, layer.indices.length, gl.UNSIGNED_SHORT, 0)
      gl.disable(gl.STENCIL_TEST)
    } else gl.drawElements(gl.TRIANGLES, layer.indices.length, gl.UNSIGNED_SHORT, 0)
  }

  private deleteMeshes(layers: MeshLayer[]) {
    const gl = this.gl
    for (const layer of layers) {
      gl.deleteTexture(layer.texture)
      gl.deleteBuffer(layer.positionBuffer)
      gl.deleteBuffer(layer.uvBuffer)
      gl.deleteBuffer(layer.indexBuffer)
    }
  }

  private rotate(x: number, y: number, cx: number, cy: number, angle: number): [number, number] {
    if (!angle) return [x, y]
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const rx = x - cx
    const ry = y - cy
    return [cx + rx * cos - ry * sin, cy + rx * sin + ry * cos]
  }

  private updateFps(now: number) {
    this.fpsFrames++
    if (now - this.fpsStarted < 500) return
    this.measuredFps = Math.round(this.fpsFrames * 1000 / (now - this.fpsStarted))
    this.fpsFrames = 0
    this.fpsStarted = now
  }
}
