import { parseCharacterPersona, PERSONA_MAX_BYTES } from "../shared/character-persona"
import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { initializeCanvas, readPsd, type Layer } from "ag-psd"
import { PACK_LIMITS, type CharacterPackManifest, type PackProgress } from "../shared/character-pack-contract"
import { parseBoundedJson, parsePackManifest, validateRigOverrides } from "../shared/character-pack-validation"
import { resolvePackReference, validatePackPath } from "../shared/character-pack-path"
import { parseCharacterManifest, parsePoseManifest } from "../../src/pose/PoseManifest"
import { behaviorUsesPoseVariants, parseBehaviorManifest } from "../../src/behavior/BehaviorManifest"
import { parseDialogueManifest } from "../../src/dialogue/DialogueManifest"
import { PsdRigLoader } from "../../src/engine/anime25d/PsdRigLoader"
import { meshGridFor } from "../../src/engine/anime25d/MeshLimits"
import { registerPose } from "../../src/pose/PoseRegistration"
import { selectIndependentPoseLayers, selectPoseLayers, layerMatchesSelector } from "../../src/pose/PoseLayerSelector"
import type { RigOverrides } from "../../src/engine/anime25d/RigOverrides"
import type { RigDefinition } from "../../src/engine/anime25d/types"

export type ValidatedPack = { manifest: CharacterPackManifest; revision: string; bytes: number; poseCount: number }
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export const packRevision = (manifestBytes: Uint8Array, manifest: CharacterPackManifest) => createHash("sha256").update(manifestBytes).update("\n").update(JSON.stringify([...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))).digest("hex")
export const isPayloadPath = (path: string) => /\.(psd|png|jpg|jpeg|webp|json)$/.test(path) || path === "LICENSE.txt"

export async function containedFile(root: string, path: string): Promise<string> {
  validatePackPath(path)
  const file = join(root, path), stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("PACK_PATH")
  const actualRoot = await realpath(root), actual = await realpath(file), rel = relative(actualRoot, actual)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || relative(root, file) !== rel) throw new Error("PACK_PATH")
  return actual
}
export async function boundedFile(root: string, path: string, limit: number = PACK_LIMITS.fileBytes): Promise<Buffer> {
  const file = await containedFile(root, path)
  if ((await lstat(file)).size > limit) throw new Error("PACK_LIMIT")
  const bytes = await readFile(file)
  if (bytes.length > limit) throw new Error("PACK_LIMIT")
  return bytes
}

/** Checks layer rectangles BEFORE ag-psd can allocate decoded pixel buffers. */
export function preflightPsd(b: Buffer): { width: number; height: number; layers: number; pixels: number } {
  try {
    if (b.length < 38 || b.toString("ascii", 0, 4) !== "8BPS" || b.readUInt16BE(4) !== 1 || b.readUInt16BE(22) !== 8 || b.readUInt16BE(24) !== 3 || b.readUInt16BE(12) > 4) throw new Error("PACK_SCHEMA")
    const height = b.readUInt32BE(14), width = b.readUInt32BE(18)
    const rect = (w: number, h: number) => { if (w < 0 || h < 0 || w > PACK_LIMITS.canvasSide || h > PACK_LIMITS.canvasSide) throw new Error("PACK_LIMIT"); return w * h }
    rect(width, height); if (!width || !height) throw new Error("PACK_SCHEMA")
    let cursor = 26
    const skip = () => { const size = b.readUInt32BE(cursor); cursor += 4 + size; if (cursor > b.length) throw new Error("PACK_SCHEMA") }
    skip(); skip()
    const maskLength = b.readUInt32BE(cursor); cursor += 4
    const maskEnd = cursor + maskLength
    if (maskEnd > b.length || maskLength < 6) throw new Error("PACK_SCHEMA")
    const infoLength = b.readUInt32BE(cursor); cursor += 4
    const infoEnd = cursor + infoLength
    if (infoEnd > maskEnd || infoLength < 2) throw new Error("PACK_SCHEMA")
    const layers = Math.abs(b.readInt16BE(cursor)); cursor += 2
    if (!layers || layers > PACK_LIMITS.layerCount) throw new Error("PACK_LIMIT")
    let pixels = 0, channelBytes = 0
    for (let i = 0; i < layers; i++) {
      const top = b.readInt32BE(cursor), left = b.readInt32BE(cursor + 4), bottom = b.readInt32BE(cursor + 8), right = b.readInt32BE(cursor + 12)
      if ([top, left, bottom, right].some(n => Math.abs(n) > PACK_LIMITS.canvasSide * 2)) throw new Error("PACK_LIMIT")
      pixels += rect(right - left, bottom - top)
      if (pixels > PACK_LIMITS.layerPixels) throw new Error("PACK_LIMIT")
      const channels = b.readUInt16BE(cursor + 16); cursor += 18
      if (channels > 6) throw new Error("PACK_LIMIT")
      for (let j = 0; j < channels; j++) { channelBytes += b.readUInt32BE(cursor + 2); cursor += 6 }
      if (b.toString("ascii", cursor, cursor + 4) !== "8BIM") throw new Error("PACK_SCHEMA")
      cursor += 12
      const extraLength = b.readUInt32BE(cursor); cursor += 4
      // v1 consumes raster layers. Live masks are not part of this rig format.
      if (extraLength < 8 || b.readUInt32BE(cursor) !== 0) throw new Error("PACK_SCHEMA")
      cursor += extraLength
      if (cursor > infoEnd) throw new Error("PACK_SCHEMA")
    }
    if (cursor + channelBytes > infoEnd) throw new Error("PACK_SCHEMA")
    const metadata = readPsd(b, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true })
    const inspectNames = (children: Layer[] | undefined, depth: number) => {
      if (depth > PACK_LIMITS.jsonDepth) throw new Error("PACK_LIMIT")
      for (const layer of children ?? []) {
        const name = (layer.name ?? "").normalize("NFKC").trim().toLowerCase()
        if (name.length > 160 || ["__proto__", "prototype", "constructor"].includes(name)) throw new Error("PACK_SCHEMA")
        inspectNames(layer.children, depth + 1)
      }
    }
    inspectNames(metadata.children, 0)
    return { width, height, layers, pixels }
  } catch (e) { if (e instanceof Error && e.message.startsWith("PACK_")) throw e; throw new Error("PACK_SCHEMA") }
}

export function preflightRaster(b: Buffer, path: string): void {
  let w = 0, h = 0
  if (path.endsWith(".png") && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.toString("ascii", 12, 16) === "IHDR") { w = b.readUInt32BE(16); h = b.readUInt32BE(20) }
  else if (/\.jpe?g$/.test(path) && b.readUInt16BE(0) === 0xffd8) {
    let i = 2
    while (i + 4 < b.length) {
      if (b[i++] !== 0xff) throw new Error("PACK_SCHEMA")
      while (b[i] === 0xff) i++
      const marker = b[i++]; if (marker === 0xda || marker === 0xd9) break
      const length = b.readUInt16BE(i); if (length < 2 || i + length > b.length) throw new Error("PACK_SCHEMA")
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { h = b.readUInt16BE(i + 3); w = b.readUInt16BE(i + 5); break }
      i += length
    }
  } else if (path.endsWith(".webp") && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const tag = b.toString("ascii", 12, 16)
    if (tag === "VP8X" && !(b[20] & 2)) { w = 1 + b.readUIntLE(24, 3); h = 1 + b.readUIntLE(27, 3) }
    else if (tag === "VP8 " && b.toString("hex", 23, 26) === "9d012a") { w = b.readUInt16LE(26) & 0x3fff; h = b.readUInt16LE(28) & 0x3fff }
    else if (tag === "VP8L" && b[20] === 0x2f) { const bits = b.readUInt32LE(21); w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (!w || !h) throw new Error("PACK_SCHEMA")
  if (w > PACK_LIMITS.canvasSide || h > PACK_LIMITS.canvasSide) throw new Error("PACK_LIMIT")
}

function checkRig(rig: RigDefinition): void {
  if (rig.layers.length > PACK_LIMITS.layerCount + 20) throw new Error("PACK_LIMIT")
  let pixels = 0, vertices = 0
  for (const l of rig.layers) {
    if (l.img.width > PACK_LIMITS.canvasSide || l.img.height > PACK_LIMITS.canvasSide) throw new Error("PACK_LIMIT")
    pixels += l.img.width * l.img.height; vertices += meshGridFor(l, rig).vertexCount
  }
  if (pixels > PACK_LIMITS.rigPixels || vertices > 300_000) throw new Error("PACK_LIMIT")
}

export async function validatePackDirectory(root: string, options: { rig?: boolean; progress?: (value: PackProgress) => void } = {}): Promise<ValidatedPack> {
  const manifestBytes = await boundedFile(root, "pack.json", PACK_LIMITS.jsonBytes)
  const manifest = parsePackManifest(manifestBytes), inventory = new Set(manifest.files.map(f => f.path))
  const json = new Map<string, unknown>()
  const seen = new Map<string, string>()
  const walk = async (dir: string, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = validatePackPath(prefix + entry.name), key = path.normalize("NFKC").toLowerCase()
      if (seen.has(key) || entry.isSymbolicLink()) throw new Error("PACK_PATH")
      seen.set(key, path)
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`)
      else if (!entry.isFile() || path !== "pack.json" && !inventory.has(path)) throw new Error("PACK_INTEGRITY")
    }
  }
  await walk(root)
  let bytes = manifestBytes.length
  let checkedFiles = 0
  options.progress?.({ phase: "files", completed: 0, total: manifest.files.length })
  for (const f of manifest.files) {
    options.progress?.({ phase: "files", completed: checkedFiles++, total: manifest.files.length })
    if (!isPayloadPath(f.path)) throw new Error("PACK_SCHEMA")
    const b = await boundedFile(root, f.path)
    if (b.length !== f.bytes || sha256(b) !== f.sha256) throw new Error("PACK_INTEGRITY")
    bytes += b.length
    if (f.path.endsWith(".json")) json.set(f.path, parseBoundedJson(b))
    else if (f.path.endsWith(".psd")) preflightPsd(b)
    else if (f.path !== "LICENSE.txt") preflightRaster(b, f.path)
  }
  const usedJson = new Set(["provenance.json"])
  const ref = (path: unknown, from: string, kind: string) => { const resolved = resolvePackReference(path, from, inventory); if (!(new RegExp(kind)).test(resolved)) throw new Error("PACK_SCHEMA"); return resolved }
  const parsed = <T>(path: string, parser: (value: unknown) => { value: T; warnings: string[] }): T => {
    usedJson.add(path); const result = parser(json.get(path)); if (result.warnings.length) throw new Error("PACK_SCHEMA"); return result.value
  }
  const character = parsed("character.json", parseCharacterManifest)
  if (character.id !== manifest.id || character.label !== manifest.name) throw new Error("PACK_MANIFEST")
  if (character.poses.length > PACK_LIMITS.variantPoses) throw new Error("PACK_LIMIT")
  if (character.poses.length > PACK_LIMITS.poses && !manifest.runtime.capabilities.includes("pose-variants")) throw new Error("PACK_INCOMPATIBLE")
  if (Boolean(character.persona) !== manifest.runtime.capabilities.includes("side-chat-persona-v1")) throw new Error("PACK_PERSONA")
  if (character.persona) {
    const path = ref(character.persona, "character.json", "\\.json$")
    usedJson.add(path)
    parseCharacterPersona(await boundedFile(root, path, PERSONA_MAX_BYTES))
  }
  const models: Array<{ psd: string; overrides: RigOverrides }> = []
  const model = (value: { psd: string; source: string; overrides?: string }, from: string) => {
    ref(value.source, from, "\\.(png|jpe?g|webp)$")
    let overrides: RigOverrides = {}
    if (value.overrides) { const path = ref(value.overrides, from, "\\.json$"); usedJson.add(path); overrides = validateRigOverrides(json.get(path)) }
    const m = { psd: ref(value.psd, from, "\\.psd$"), overrides }; models.push(m); return m
  }
  model(character.base, "character.json")
  const ids = new Set<string>()
  const poses = character.poses.map(path => {
    const resolved = ref(path, "character.json", "\\.json$"), pose = parsed(resolved, parsePoseManifest)
    if (ids.has(pose.id)) throw new Error("PACK_SCHEMA"); ids.add(pose.id)
    if (!manifest.runtime.capabilities.includes(pose.strategy)) throw new Error("PACK_INCOMPATIBLE")
    model(pose, resolved); return pose
  })
  if (manifest.profile === "trial" && (poses.length !== 3 || ["waiting", "writing", "head-tap"].some(id => !ids.has(id)))) throw new Error("PACK_SCHEMA")
  if (manifest.profile === "full" && ["waiting", "writing", "head-tap", "failed", "cancelled", "disconnected", "bored", "happy", "torso-tap", "head-pet"].some(id => !ids.has(id))) throw new Error("PACK_SCHEMA")
  for (const { overrides } of models) {
    if (Object.keys(overrides.headFollow ?? {}).length && !manifest.runtime.capabilities.includes("head-follow") || overrides.anchorOverrides?.mouth?.morph && !manifest.runtime.capabilities.includes("mouth-morph") || (overrides.anchorOverrides?.eyeL?.blink || overrides.anchorOverrides?.eyeR?.blink) && !manifest.runtime.capabilities.includes("local-eye-blink")) throw new Error("PACK_INCOMPATIBLE")
    for (const start of Object.keys(overrides.meshSources ?? {})) {
      let key: string | undefined = start; const visited = new Set<string>()
      while (key && Object.hasOwn(overrides.meshSources!, key)) { if (visited.has(key)) throw new Error("PACK_SCHEMA"); visited.add(key); key = overrides.meshSources![key] }
    }
  }
  const checkPoseIds = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(checkPoseIds)
    else if (v && typeof v === "object") for (const [k, item] of Object.entries(v)) {
      if (k === "poseId" && item !== null && (typeof item !== "string" || !ids.has(item))) throw new Error("PACK_SCHEMA")
      if (k === "poseVariants" && (!Array.isArray(item) || item.some(id => typeof id !== "string" || !ids.has(id)))) throw new Error("PACK_SCHEMA")
      checkPoseIds(item)
    }
  }
  if (character.behavior) {
    const behavior = parsed(ref(character.behavior, "character.json", "\\.json$"), parseBehaviorManifest)
    if (behaviorUsesPoseVariants(behavior) && !manifest.runtime.capabilities.includes("pose-variants")) throw new Error("PACK_INCOMPATIBLE")
    checkPoseIds(behavior)
  }
  if (character.dialogue) {
    const dialogue = parsed(ref(character.dialogue, "character.json", "\\.json$"), value => ({ value: parseDialogueManifest(value), warnings: [] }))
    if (dialogue.poseLines && !manifest.runtime.capabilities.includes("pose-dialogue")) throw new Error("PACK_INCOMPATIBLE")
    for (const id of Object.keys(dialogue.poseTriggers ?? {})) if (id !== "base" && !ids.has(id)) throw new Error("PACK_SCHEMA")
  }
  for (const path of json.keys()) if (!usedJson.has(path)) throw new Error("PACK_SCHEMA")
  if (options.rig !== false) {
    initializeCanvas(() => { throw new Error("PACK_SCHEMA") }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }))
    const loader = new PsdRigLoader()
    let base: RigDefinition | undefined
    for (let index = 0; index < models.length; index++) {
      options.progress?.({ phase: "rig", completed: index, total: models.length })
      const m = models[index], b = await boundedFile(root, m.psd)
      const result = loader.loadArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, m.psd, m.overrides)
      if (result.model.missingRequiredLayers.length) throw new Error("PACK_SCHEMA")
      const rig = result.model.rig; checkRig(rig)
      if (!base) base = rig
      else {
        const pose = poses[index - 1], independent = pose.strategy === "independent-model"
        if (independent && (base.canvas.w !== rig.canvas.w || base.canvas.h !== rig.canvas.h)) throw new Error("PACK_SCHEMA")
        const registration = registerPose(independent ? rig.anchors : base.anchors, rig.anchors, pose.registration, { base: base.canvas, pose: rig.canvas })
        const selection = independent ? selectIndependentPoseLayers(base, rig) : selectPoseLayers(base, rig, pose.layers)
        if (!registration.accepted || selection.errors.length) throw new Error("PACK_SCHEMA")
        for (const selector of Object.keys(pose.motion?.layers ?? {})) if (![...selection.poseReplace, ...selection.poseAdditive].some(n => layerMatchesSelector(n, selector))) throw new Error("PACK_SCHEMA")
      }
    }
  }
  options.progress?.({ phase: options.rig === false ? "files" : "rig", completed: options.rig === false ? manifest.files.length : models.length, total: options.rig === false ? manifest.files.length : models.length })
  return { manifest, revision: packRevision(manifestBytes, manifest), bytes, poseCount: poses.length }
}
