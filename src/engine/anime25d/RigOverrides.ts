import type { HairPhysicsConfig, HairPhysicsTuning, RigDefinition } from "./types"
import { isValidEyeBlinkProfile } from "./EyeBlink"
import { isValidMouthMorphProfile } from "./MouthMorph"
import { isValidHeadFollow } from "./HeadFollow"

export type RigOverrides = {
  layerAliases?: Record<string, string>
  layerOrder?: string[]
  layerOrderConstraints?: Array<{ behind: string; inFrontOf: string }>
  maskedLayerOverlays?: Array<{
    source: string
    name: string
    inFrontOf: string
    polygon: Array<[number, number]>
    replaceExisting?: boolean
    featherPx?: number
    textureSource?: string
    excludeConnectedNeutral?: { maxChroma: number; minLuminance: number; maxLuminance: number; maxColorStep: number }
  }>
  interpolatedPatchRepairs?: Array<{
    layer: string
    polygon: Array<[number, number]>
    axis: "horizontal"
  }>
  depthOverrides?: Record<string, number>
  groupOverrides?: Record<string, string>
  deformationSources?: Record<string, string>
  meshSources?: Record<string, string>
  hairAttachments?: Record<string, NonNullable<RigDefinition["layers"][number]["hairAttachment"]>>
  headFollow?: Record<string, NonNullable<RigDefinition["layers"][number]["headFollow"]>>
  cleanupThresholds?: Record<string, number>
  hiddenLayers?: string[]
  /** Keep these reference parts through mesh resolution, then omit their artwork. */
  excludeAfterMeshResolution?: string[]
  anchorOverrides?: Partial<RigDefinition["anchors"]>
  interactionAreas?: RigDefinition["interactionAreas"]
  mouthExpressions?: { neutral: string; open: string; smile: string }
  blinkRepair?: { enabled?: boolean; paddingX?: number; paddingY?: number }
  hairSplit?: { backHairLeftRight?: boolean; centerX?: number }
  physics?: Partial<Omit<HairPhysicsConfig, "frontHair" | "backHair">> & {
    frontHair?: Partial<HairPhysicsTuning>
    backHair?: Partial<HairPhysicsTuning>
  }
}

export const EMPTY_RIG_OVERRIDES: RigOverrides = {}

const normalized = (name: string) => name.normalize("NFKC").trim().toLowerCase()
const baseName = (name: string) => normalized(name).replace(/[-_]([lr])$/i, "").replace(/_\d+$/, "")

function lookup<T>(values: Record<string, T> | undefined, name: string): T | undefined {
  if (!values) return undefined
  const candidates = [name, normalized(name), baseName(name)]
  for (const candidate of candidates) if (Object.prototype.hasOwnProperty.call(values, candidate)) return values[candidate]
  return undefined
}

export function aliasLayerName(name: string, overrides: RigOverrides): string {
  return lookup(overrides.layerAliases, name) ?? name
}

export function cleanupThresholdFor(name: string, overrides: RigOverrides): number {
  return Math.max(0, Math.round(lookup(overrides.cleanupThresholds, name) ?? 40))
}

export function applyRigOverrides(rig: RigDefinition, overrides: RigOverrides): RigDefinition {
  const hidden = new Set((overrides.hiddenLayers ?? []).map(normalized))
  let layers = rig.layers
    .filter((layer) => !hidden.has(normalized(layer.name)) && !hidden.has(baseName(layer.name)))
    .map((layer) => {
      const attachment = lookup(overrides.hairAttachments, layer.name)
      const headFollow = lookup(overrides.headFollow, layer.name)
      const validAttachment = attachment && Number.isFinite(attachment.rootY) && Number.isFinite(attachment.bodyY) && attachment.bodyY > attachment.rootY
      return {
        ...layer,
        depth: lookup(overrides.depthOverrides, layer.name) ?? layer.depth,
        group: lookup(overrides.groupOverrides, layer.name) ?? layer.group,
        ...(validAttachment ? { hairAttachment: { ...attachment } } : {}),
        ...(isValidHeadFollow(headFollow) ? { headFollow: { ...headFollow, center: { ...headFollow.center } } } : {}),
      }
    })

  if (overrides.mouthExpressions) {
    const entries = Object.entries(overrides.mouthExpressions) as Array<["neutral" | "open" | "smile", string]>
    if (entries.every(([, name]) => layers.some(layer => normalized(layer.name) === normalized(name)))) {
      layers = layers.map(layer => {
        const expression = entries.find(([, name]) => normalized(layer.name) === normalized(name))?.[0]
        return expression ? { ...layer, mouthExpression: expression, group: "head", depth: 1.08 } : layer
      })
    }
  }

  for (const repair of overrides.interpolatedPatchRepairs ?? []) {
    if (repair.polygon.length < 3 || repair.axis !== "horizontal") continue
    layers = layers.map((layer) => normalized(layer.name) === normalized(repair.layer) || baseName(layer.name) === normalized(repair.layer)
      ? horizontalInterpolatedPatch(layer, repair.polygon, rig.canvas)
      : layer)
  }

  const overlayConstraints: NonNullable<RigOverrides["layerOrderConstraints"]> = []
  for (const overlay of overrides.maskedLayerOverlays ?? []) {
    if (overlay.polygon.length < 3 || normalized(overlay.name) === normalized(overlay.source)) continue
    if (overlay.replaceExisting && layers.some(layer => normalized(layer.name) === normalized(overlay.source))) {
      layers = layers.filter(layer => normalized(layer.name) !== normalized(overlay.name))
    }
    const sourceIndex = layers.findIndex((layer) => normalized(layer.name) === normalized(overlay.source) || baseName(layer.name) === normalized(overlay.source))
    if (sourceIndex < 0 || overlay.polygon.length < 3 || layers.some((layer) => normalized(layer.name) === normalized(overlay.name))) continue
    const source = layers[sourceIndex]
    const texture = overlay.textureSource ? layers.find(layer => normalized(layer.name) === normalized(overlay.textureSource!)) : undefined
    const copy = maskedLayerOverlay(source, overlay.name, overlay.polygon, rig.canvas, overlay.excludeConnectedNeutral, overlay.featherPx, texture)
    const targetIndex = layers.reduce((last, layer, index) => normalized(layer.name) === normalized(overlay.inFrontOf) || baseName(layer.name) === normalized(overlay.inFrontOf) ? index : last, -1)
    layers.splice(targetIndex < 0 ? sourceIndex + 1 : targetIndex + 1, 0, copy)
    if (texture && texture !== source) layers = layers.filter(layer => layer !== texture)
    overlayConstraints.push({ behind: overlay.inFrontOf, inFrontOf: overlay.name })
  }

  if (overrides.layerOrder?.length) {
    const rank = new Map(overrides.layerOrder.map((name, index) => [normalized(name), index]))
    layers = layers
      .map((layer, original) => ({ layer, original, rank: rank.get(normalized(layer.name)) ?? rank.get(baseName(layer.name)) }))
      .sort((a, b) => {
        if (a.rank === undefined && b.rank === undefined) return a.original - b.original
        if (a.rank === undefined) return 1
        if (b.rank === undefined) return -1
        return a.rank - b.rank || a.original - b.original
      })
      .map(({ layer }, z) => ({ ...layer, z }))
  }

  const constraints = [...(overrides.layerOrderConstraints ?? []), ...overlayConstraints]
  if (constraints.length) {
    layers = applyLayerOrderConstraints(layers, constraints)
  }

  // An overlay at a garment seam must use the garment's deformation, including
  // breathing and depth, instead of moving independently under its new name.
  layers = layers.map(layer => {
    const name = lookup(overrides.deformationSources, layer.name)
    const source = name ? layers.find(candidate => normalized(candidate.name) === normalized(name)) : undefined
    return source ? { ...layer, deformationSource: source.name, depth: source.depth, group: source.group } : layer
  })

  // Foreground cutouts of an existing surface share its complete mesh. A
  // cropped grid or independently phased springs tear the overlapping pixels.
  const resolved = new Map<string, RigDefinition["layers"][number] | null>()
  const attach = (layer: RigDefinition["layers"][number], visiting = new Set<string>()): RigDefinition["layers"][number] | null => {
    if (resolved.has(layer.name)) return resolved.get(layer.name)!
    const sourceName = lookup(overrides.meshSources, layer.name)
    if (!sourceName) return layer
    if (visiting.has(layer.name)) return null
    const source = layers.find(candidate => normalized(candidate.name) === normalized(sourceName))
    const parent = source ? attach(source, new Set([...visiting, layer.name])) : null
    const result = parent ? {
      ...maskedLayerOverlay(parent, layer.name, [[0, 0], [1, 0], [1, 1], [0, 1]], rig.canvas, undefined, 0, layer),
      z: layer.z,
      fade: layer.fade,
      mouthExpression: layer.mouthExpression,
      meshSource: parent.name,
    } : null
    resolved.set(layer.name, result)
    return result
  }
  layers = layers.map(layer => attach(layer) ?? layer)
  const referenceOnly = new Set((overrides.excludeAfterMeshResolution ?? []).map(normalized))
  layers = layers.filter(layer => !referenceOnly.has(normalized(layer.name)))

  const anchors = { ...rig.anchors, ...(overrides.anchorOverrides ?? {}) }
  for (const side of ["eyeL", "eyeR"] as const) {
    const eye = anchors[side]
    if (eye?.blink && !isValidEyeBlinkProfile(eye.blink)) {
      const { blink: _invalidBlink, ...legacyEye } = eye
      anchors[side] = legacyEye
    }
  }
  if (anchors.mouth?.morph && !isValidMouthMorphProfile(anchors.mouth.morph)) {
    const { morph: _invalidMorph, ...legacyMouth } = anchors.mouth
    anchors.mouth = legacyMouth
  }
  const result = {
    ...rig,
    layers,
    anchors,
    ...(overrides.interactionAreas ? { interactionAreas: overrides.interactionAreas } : {}),
  }
  return overrides.blinkRepair?.enabled ? addBlinkSkinPatches(result, overrides.blinkRepair) : result
}

function maskedLayerOverlay(source: RigDefinition["layers"][number], name: string, polygon: Array<[number, number]>, canvas: RigDefinition["canvas"], excludeConnectedNeutral?: NonNullable<RigOverrides["maskedLayerOverlays"]>[number]["excludeConnectedNeutral"], featherPx = 0, texture?: RigDefinition["layers"][number]): RigDefinition["layers"][number] {
  const data = new Uint8ClampedArray(source.img.data)
  const inside = new Uint8Array(source.img.width * source.img.height)
  for (let y = 0; y < source.img.height; y++) for (let x = 0; x < source.img.width; x++) {
    const canvasX = (source.x + x + 0.5) / canvas.w
    const canvasY = (source.y + y + 0.5) / canvas.h
    const offset = (y * source.img.width + x) * 4
    if (texture) {
      // Keep the source mesh and motion field, but use the separately matted
      // foreground pixels. Polygon-only copies retain background at hand/prop joins.
      const tx = Math.floor((source.x + x + .5 - texture.x) * texture.img.width / texture.w)
      const ty = Math.floor((source.y + y + .5 - texture.y) * texture.img.height / texture.h)
      if (tx >= 0 && tx < texture.img.width && ty >= 0 && ty < texture.img.height) {
        const from = (ty * texture.img.width + tx) * 4
        data.set(texture.img.data.subarray(from, from + 4), offset)
      } else data[offset + 3] = 0
    }
    const contained = insidePolygon(canvasX, canvasY, polygon)
    if (contained) inside[y * source.img.width + x] = 1
    if (Number.isFinite(featherPx) && featherPx > 0) {
      const distance = polygonEdgeDistance(canvasX * canvas.w, canvasY * canvas.h, polygon, canvas)
      const coverage = Math.max(0, Math.min(1, .5 + (contained ? distance : -distance) / featherPx))
      data[offset + 3] = Math.round(data[offset + 3] * coverage)
    } else if (!contained) data[offset + 3] = 0
  }
  if (excludeConnectedNeutral) eraseConnectedNeutralFill(data, inside, source.img.width, source.img.height, excludeConnectedNeutral)
  return { ...source, name, synthetic: true, img: { ...source.img, data } }
}

function polygonEdgeDistance(x: number, y: number, polygon: Array<[number, number]>, canvas: RigDefinition["canvas"]) {
  let distance = Infinity
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = [polygon[i][0] * canvas.w, polygon[i][1] * canvas.h]
    const [bx, by] = [polygon[(i + 1) % polygon.length][0] * canvas.w, polygon[(i + 1) % polygon.length][1] * canvas.h]
    const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy
    const t = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0
    distance = Math.min(distance, Math.hypot(x - ax - t * dx, y - ay - t * dy))
  }
  return distance
}

function horizontalInterpolatedPatch(source: RigDefinition["layers"][number], polygon: Array<[number, number]>, canvas: RigDefinition["canvas"]): RigDefinition["layers"][number] {
  const data = new Uint8ClampedArray(source.img.data)
  for (let y = 0; y < source.img.height; y++) {
    let first = -1
    let last = -1
    for (let x = 0; x < source.img.width; x++) {
      const canvasX = (source.x + x + 0.5) / canvas.w
      const canvasY = (source.y + y + 0.5) / canvas.h
      if (!insidePolygon(canvasX, canvasY, polygon)) continue
      if (first < 0) first = x
      last = x
    }
    if (first < 0) continue
    let left = first - 1
    let right = last + 1
    while (left >= 0 && data[(y * source.img.width + left) * 4 + 3] === 0) left--
    while (right < source.img.width && data[(y * source.img.width + right) * 4 + 3] === 0) right++
    if (left < 0 || right >= source.img.width || left === right) continue
    const leftOffset = (y * source.img.width + left) * 4
    const rightOffset = (y * source.img.width + right) * 4
    for (let x = first; x <= last; x++) {
      const targetOffset = (y * source.img.width + x) * 4
      const mix = (x - left) / (right - left)
      for (let channel = 0; channel < 4; channel++) data[targetOffset + channel] = Math.round(data[leftOffset + channel] * (1 - mix) + data[rightOffset + channel] * mix)
    }
  }
  return { ...source, img: { ...source.img, data } }
}

function eraseConnectedNeutralFill(data: Uint8ClampedArray, inside: Uint8Array, width: number, height: number, limits: { maxChroma: number; minLuminance: number; maxLuminance: number; maxColorStep: number }) {
  const visited = new Uint8Array(width * height)
  const queue: number[] = []
  const isNeutral = (index: number) => {
    const offset = index * 4
    if (!inside[index] || data[offset + 3] === 0) return false
    const maximum = Math.max(data[offset], data[offset + 1], data[offset + 2])
    const minimum = Math.min(data[offset], data[offset + 1], data[offset + 2])
    const luminance = (data[offset] + data[offset + 1] + data[offset + 2]) / 3
    return maximum - minimum <= limits.maxChroma && luminance >= limits.minLuminance && luminance <= limits.maxLuminance
  }
  const isBoundary = (x: number, y: number) => x === 0 || y === 0 || x === width - 1 || y === height - 1
    || !inside[y * width + x - 1] || !inside[y * width + x + 1] || !inside[(y - 1) * width + x] || !inside[(y + 1) * width + x]
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x
    if (isBoundary(x, y) && isNeutral(index)) {
      visited[index] = 1
      queue.push(index)
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor]
    const x = index % width
    const y = Math.floor(index / width)
    for (const neighbor of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
      if (neighbor < 0 || visited[neighbor] || !isNeutral(neighbor) || colorDistance(data, index, neighbor) > limits.maxColorStep) continue
      visited[neighbor] = 1
      queue.push(neighbor)
    }
  }
  for (const index of queue) data[index * 4 + 3] = 0
}

function colorDistance(data: Uint8ClampedArray, first: number, second: number) {
  const a = first * 4
  const b = second * 4
  return Math.hypot(data[a] - data[b], data[a + 1] - data[b + 1], data[a + 2] - data[b + 2])
}

function insidePolygon(x: number, y: number, polygon: Array<[number, number]>) {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const [cx, cy] = polygon[current]
    const [px, py] = polygon[previous]
    if ((cy > y) !== (py > y) && x < ((px - cx) * (y - cy)) / (py - cy) + cx) inside = !inside
  }
  return inside
}

function applyLayerOrderConstraints(layers: RigDefinition["layers"], constraints: NonNullable<RigOverrides["layerOrderConstraints"]>) {
  const edges = layers.map(() => new Set<number>())
  const indegree = layers.map(() => 0)
  const matches = (layerName: string, requested: string) => {
    const target = normalized(requested)
    return normalized(layerName) === target || baseName(layerName) === target
  }

  for (const constraint of constraints) {
    const behind = layers.flatMap((layer, index) => matches(layer.name, constraint.behind) ? [index] : [])
    const inFront = layers.flatMap((layer, index) => matches(layer.name, constraint.inFrontOf) ? [index] : [])
    for (const from of behind) for (const to of inFront) {
      if (from === to || edges[from].has(to)) continue
      edges[from].add(to)
      indegree[to] += 1
    }
  }

  const ready = layers.flatMap((_, index) => indegree[index] === 0 ? [index] : [])
  const ordered: number[] = []
  while (ready.length) {
    ready.sort((a, b) => a - b)
    const index = ready.shift() as number
    ordered.push(index)
    for (const target of edges[index]) {
      indegree[target] -= 1
      if (indegree[target] === 0) ready.push(target)
    }
  }

  // Invalid cyclic constraints must never make layers disappear. Preserve the
  // last valid order and let asset-specific tests expose the bad override.
  if (ordered.length !== layers.length) return layers.map((layer, z) => ({ ...layer, z }))
  return ordered.map((index, z) => ({ ...layers[index], z }))
}

function addBlinkSkinPatches(rig: RigDefinition, options: NonNullable<RigOverrides["blinkRepair"]>): RigDefinition {
  const face = rig.layers.find((layer) => layer.name === "face")
  if (!face) return rig
  const patches = ([['L', rig.anchors.eyeL], ['R', rig.anchors.eyeR]] as const)
    .map(([side, eye]) => eye ? createSkinPatch(face, eye, side, options.paddingX ?? 7, options.paddingY ?? 6) : null)
    .filter((layer): layer is NonNullable<typeof layer> => Boolean(layer))
  if (!patches.length) return rig
  const layers = [...rig.layers]
  const closeIndex = layers.findIndex((layer) => layer.name.startsWith("eye_close"))
  layers.splice(closeIndex < 0 ? layers.length : closeIndex, 0, ...patches)
  return { ...rig, layers: layers.map((layer, z) => ({ ...layer, z })) }
}

function createSkinPatch(face: RigDefinition["layers"][number], eye: NonNullable<RigDefinition["anchors"]["eyeL"]>, side: "L" | "R", paddingX: number, paddingY: number) {
  const x0 = Math.max(face.x, Math.floor(eye.x0 - paddingX))
  const y0 = Math.max(face.y, Math.floor(eye.y0 - paddingY))
  const x1 = Math.min(face.x + face.w, Math.ceil(eye.x1 + paddingX))
  const y1 = Math.min(face.y + face.h, Math.ceil(eye.y1 + paddingY))
  if (x1 <= x0 || y1 <= y0) return null
  const w = x1 - x0
  const h = y1 - y0
  const data = new Uint8ClampedArray(w * h * 4)
  const samples = skinSamples(face, eye)
  if (!samples.length) return null
  const left = meanColor(samples.filter((sample) => sample.x <= (eye.x0 + eye.x1) / 2), samples)
  const right = meanColor(samples.filter((sample) => sample.x > (eye.x0 + eye.x1) / 2), samples)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const offset = (y * w + x) * 4
    const t = w <= 1 ? 0.5 : x / (w - 1)
    const verticalShade = 0.985 + (y / Math.max(1, h - 1)) * 0.03
    for (let channel = 0; channel < 3; channel++) data[offset + channel] = (left[channel] * (1 - t) + right[channel] * t) * verticalShade
    const edgeX = Math.min(x + 1, w - x)
    const edgeY = Math.min(y + 1, h - y)
    data[offset + 3] = Math.round(255 * Math.min(1, edgeX / 2, edgeY / 2))
  }
  return {
    name: `eye_skin_patch_${side.toLowerCase()}`,
    x: x0, y: y0, w, h, z: 0, depth: 1.105, group: "head",
    phys: null, fade: "eyeClose" as const, side, strands: null,
    synthetic: true,
    img: { width: w, height: h, data },
  }
}

function skinSamples(face: RigDefinition["layers"][number], eye: NonNullable<RigDefinition["anchors"]["eyeL"]>) {
  const samples: Array<{ x: number; color: [number, number, number] }> = []
  const minX = Math.max(face.x, Math.floor(eye.x0 - 14))
  const maxX = Math.min(face.x + face.w - 1, Math.ceil(eye.x1 + 14))
  const minY = Math.max(face.y, Math.floor(eye.y0 - 13))
  const maxY = Math.min(face.y + face.h - 1, Math.ceil(eye.y1 + 15))
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (x >= eye.x0 - 2 && x <= eye.x1 + 2 && y >= eye.y0 - 2 && y <= eye.y1 + 3) continue
    const index = ((y - face.y) * face.img.width + (x - face.x)) * 4
    const alpha = face.img.data[index + 3]
    if (alpha < 220) continue
    const color: [number, number, number] = [face.img.data[index], face.img.data[index + 1], face.img.data[index + 2]]
    const luminance = (color[0] * 2 + color[1] * 3 + color[2]) / 6
    if (luminance < 105) continue
    samples.push({ x, color })
  }
  return samples
}

function meanColor(samples: Array<{ color: [number, number, number] }>, fallback: Array<{ color: [number, number, number] }>): [number, number, number] {
  const source = samples.length ? samples : fallback
  const total = source.reduce<[number, number, number]>((sum, sample) => [sum[0] + sample.color[0], sum[1] + sample.color[1], sum[2] + sample.color[2]], [0, 0, 0])
  return [total[0] / source.length, total[1] / source.length, total[2] / source.length]
}
