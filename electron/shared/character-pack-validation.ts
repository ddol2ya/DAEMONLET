import { parseUpdateSource, PACK_UPDATE_CAPABILITY } from "./pack-update-contract"
import { PACK_LIMITS, PACK_RUNTIME, isCharacterId, isPackVersion, isRevision, type CharacterPackManifest } from "./character-pack-contract"
import { validatePackPath } from "./character-pack-path"
import { isValidEyeBlinkProfile } from "../../src/engine/anime25d/EyeBlink"
import { isValidMouthMorphProfile } from "../../src/engine/anime25d/MouthMorph"
import { isValidHeadFollow } from "../../src/engine/anime25d/HeadFollow"
import type { RigOverrides } from "../../src/engine/anime25d/RigOverrides"

const fail = (): never => { throw new Error("PACK_SCHEMA") }
export function record(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) fail(); return v as Record<string, unknown> }
const text = (v: unknown): void => { if (typeof v !== "string" || !v.trim() || v.length > 160 || /[\u0000-\u001f\u007f]/.test(v)) fail() }
const number = (v: unknown): void => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e7) fail() }
const positive = (v: unknown): void => { number(v); if ((v as number) <= 0) fail() }
const boolean = (v: unknown): void => { if (typeof v !== "boolean") fail() }
type Check = (v: unknown) => void
const array = (check: Check, max = 128): Check => v => { if (!Array.isArray(v) || v.length > max) fail(); (v as unknown[]).forEach(check) }
const map = (check: Check): Check => v => { for (const [k, item] of Object.entries(record(v))) { text(k); check(item) } }
function shape(fields: Record<string, Check>, required: string[] = []): Check {
  return v => { const r = record(v); if (required.some(k => !(k in r)) || Object.keys(r).some(k => !Object.hasOwn(fields, k))) fail(); for (const [k, value] of Object.entries(r)) fields[k](value) }
}
const point = shape({ cx: number, cy: number }, ["cx", "cy"])
const boundsFields = { x0: number, x1: number, y0: number, y1: number }
const bounds: Check = v => { shape(boundsFields, Object.keys(boundsFields))(v); const b = record(v) as Record<string, number>; if (b.x1 <= b.x0 || b.y1 <= b.y0) fail() }
const polygon: Check = v => { array(p => { if (!Array.isArray(p) || p.length !== 2) fail(); (p as unknown[]).forEach(n => { number(n); if (Math.abs(n as number) > 4) fail() }) }, 64)(v); if ((v as unknown[]).length < 3) fail() }
const blink: Check = v => {
  shape({ center: point, angleDeg: number, u0: number, u1: number, upper: array(number), lower: array(number), closed: array(number), closedSource: point, closedTarget: point, closedRotationDeg: number })(v)
  if (!isValidEyeBlinkProfile(v)) fail()
}
const mouthShape = shape({ u0: number, u1: number, upper: array(number), lower: array(number) }, ["u0", "u1", "upper", "lower"])
const morph: Check = v => { shape({ center: point, angleDeg: number, neutral: mouthShape, open: mouthShape, smile: mouthShape })(v); if (!isValidMouthMorphProfile(v)) fail() }
const tuning = shape({ amplitude: number, stiffness: positive, damping: positive, wind: number, inertia: number, rootLock: number, maxOffset: positive })
const anchors = shape({
  face: shape({ ...boundsFields, cx: number, cy: number }, [...Object.keys(boundsFields), "cx", "cy"]),
  eyeL: shape({ ...boundsFields, icx: number, icy: number, closeY: number, blink }, [...Object.keys(boundsFields), "icx", "icy", "closeY"]),
  eyeR: shape({ ...boundsFields, icx: number, icy: number, closeY: number, blink }, [...Object.keys(boundsFields), "icx", "icy", "closeY"]),
  mouth: shape({ ...boundsFields, cx: number, cy: number, morph }, [...Object.keys(boundsFields), "cx", "cy"]),
  neckPivot: point, bodyPivot: point, neckTop: number, neckBottom: number, hairRootY: number, faceScale: positive,
})
export function validateRigOverrides(v: unknown): RigOverrides {
  shape({
    layerAliases: map(text), layerOrder: array(text), layerOrderConstraints: array(shape({ behind: text, inFrontOf: text }, ["behind", "inFrontOf"])),
    maskedLayerOverlays: array(shape({ source: text, name: text, inFrontOf: text, polygon, replaceExisting: boolean, featherPx: number, textureSource: text,
      excludeConnectedNeutral: shape({ maxChroma: number, minLuminance: number, maxLuminance: number, maxColorStep: number }, ["maxChroma", "minLuminance", "maxLuminance", "maxColorStep"]),
    }, ["source", "name", "inFrontOf", "polygon"]), 16),
    interpolatedPatchRepairs: array(shape({ layer: text, polygon, axis: v => { if (v !== "horizontal") fail() } }, ["layer", "polygon", "axis"]), 16),
    depthOverrides: map(number), groupOverrides: map(text), deformationSources: map(text), meshSources: map(text), cleanupThresholds: map(number),
    hairAttachments: map(v => { shape({ rootY: number, bodyY: number }, ["rootY", "bodyY"])(v); const p = record(v) as Record<string, number>; if (p.bodyY <= p.rootY) fail() }),
    headFollow: map(v => { shape({ center: point, radius: positive, falloffRadius: positive }, ["center", "radius", "falloffRadius"])(v); if (!isValidHeadFollow(v)) fail() }),
    hiddenLayers: array(text), excludeAfterMeshResolution: array(text), anchorOverrides: anchors,
    interactionAreas: shape({ face: bounds, head: bounds, torso: bounds }), mouthExpressions: shape({ neutral: text, open: text, smile: text }, ["neutral", "open", "smile"]),
    blinkRepair: shape({ enabled: boolean, paddingX: number, paddingY: number }), hairSplit: shape({ backHairLeftRight: boolean, centerX: number }),
    physics: shape({ frontHair: tuning, backHair: tuning, layers: map(tuning) }),
  })(v)
  return v as RigOverrides
}

export function parseBoundedJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > PACK_LIMITS.jsonBytes) throw new Error("PACK_LIMIT")
  let value: unknown
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new Error("PACK_SCHEMA") }
  let count = 0
  const visit = (v: unknown, depth: number) => {
    if (++count > PACK_LIMITS.jsonNodes || depth > PACK_LIMITS.jsonDepth) throw new Error("PACK_LIMIT")
    if (typeof v === "number" && !Number.isFinite(v)) fail()
    if (typeof v === "string" && (v.length > 4096 || /[\u0000\u007f]/.test(v))) fail()
    if (Array.isArray(v)) { if (v.length > PACK_LIMITS.arrayLength) throw new Error("PACK_LIMIT"); v.forEach(item => visit(item, depth + 1)) }
    else if (v && typeof v === "object") for (const [k, item] of Object.entries(v)) {
      if (["__proto__", "prototype", "constructor"].includes(k) || k.length > 180) fail()
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
  return value
}

export function parsePackManifest(bytes: Uint8Array): CharacterPackManifest {
  const v = record(parseBoundedJson(bytes))
  const keys = ["packFormatVersion", "id", "version", "name", "author", "entry", "thumbnail", "runtime", "files", "profile", "unsupportedReactions", "update"]
  if (Object.keys(v).some(k => !keys.includes(k)) || !isCharacterId(v.id) || !isPackVersion(v.version) || v.entry !== "character.json") throw new Error("PACK_MANIFEST")
  if (v.packFormatVersion !== 1) throw new Error("PACK_INCOMPATIBLE")
  text(v.name); if (v.author !== undefined) text(v.author)
  if (v.profile !== undefined && v.profile !== "trial" && v.profile !== "full") throw new Error("PACK_MANIFEST")
  if (v.unsupportedReactions !== undefined) array(text, 16)(v.unsupportedReactions)
  const runtime = record(v.runtime)
  if (Object.keys(runtime).some(k => !["engine", "assetApiVersion", "capabilities"].includes(k)) || runtime.engine !== PACK_RUNTIME.engine || runtime.assetApiVersion !== PACK_RUNTIME.assetApiVersion || !Array.isArray(runtime.capabilities) || runtime.capabilities.some(c => !(PACK_RUNTIME.capabilities as readonly unknown[]).includes(c))) throw new Error("PACK_INCOMPATIBLE")
  if (new Set(runtime.capabilities as string[]).size !== (runtime.capabilities as string[]).length) throw new Error("PACK_MANIFEST")
  if (Boolean(v.update) !== (runtime.capabilities as string[]).includes(PACK_UPDATE_CAPABILITY)) throw new Error("PACK_MANIFEST")
  if (v.update !== undefined) v.update = parseUpdateSource(v.update)
  if (!Array.isArray(v.files) || !v.files.length || v.files.length > PACK_LIMITS.files) throw new Error("PACK_LIMIT")
  let total = 0
  const paths = new Set<string>()
  for (const file of v.files) {
    const f = record(file), path = validatePackPath(f.path), key = path.normalize("NFKC").toLowerCase()
    if (Object.keys(f).some(k => !["path", "bytes", "sha256"].includes(k)) || path === "pack.json" || paths.has(key) || !isRevision(f.sha256) || !Number.isSafeInteger(f.bytes) || (f.bytes as number) < 1) throw new Error("PACK_MANIFEST")
    if ((f.bytes as number) > PACK_LIMITS.fileBytes) throw new Error("PACK_LIMIT")
    total += f.bytes as number; paths.add(key)
  }
  if (total > PACK_LIMITS.payloadBytes) throw new Error("PACK_LIMIT")
  if (v.thumbnail !== undefined) { validatePackPath(v.thumbnail); if (typeof v.thumbnail !== "string" || !/\.(png|jpe?g|webp)$/.test(v.thumbnail) || !v.files.some(f => f.path === v.thumbnail)) throw new Error("PACK_MANIFEST") }
  return v as CharacterPackManifest
}
