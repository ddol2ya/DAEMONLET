import type { CatalogManifest, CharacterManifest, LoadedCharacter, PoseManifest } from "./types"
import { DEFAULT_PARAMETERS, PARAMETER_RANGES } from "../engine/anime25d/Anime25DParameters"
import { parseMotionTiming, parseMotionTrack } from "../motion/MotionManifest"
import type { Anime25DParameter, InteractionId } from "../engine/anime25d/types"
import { parsePackAssetUrl, packAssetUrl, resolvePackReference } from "../../electron/shared/character-pack-path"

type ValidationResult<T> = { value: T; warnings: string[] }

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const string = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}
const number = (value: unknown, label: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}
const strings = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must be a string array`)
  return [...new Set(value)] as string[]
}
const warnUnknown = (value: Record<string, unknown>, allowed: string[], label: string, warnings: string[]) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) warnings.push(`${label}: unknown field '${key}'`)
}
const version = (value: unknown, label: string): 1 => {
  if (value !== 1) throw new Error(`${label}.schemaVersion must be 1`)
  return 1
}

const INTERACTIONS = new Set<InteractionId>(["HEAD_TAP", "HOLD_START", "HOLD_LOOP", "HOLD_END", "TORSO_TAP", "PET_START", "PET_LOOP", "PET_END", "DRAG"])

function parseTransformOrigin(value: unknown, label: string, warnings: string[]) {
  const origin = object(value, label)
  warnUnknown(origin, ["x", "y"], label, warnings)
  return { x: number(origin.x, `${label}.x`), y: number(origin.y, `${label}.y`) }
}

function parseTransformInfluence(value: unknown, label: string, warnings: string[]) {
  const influence = object(value, label)
  warnUnknown(influence, ["axisX", "axisY", "start", "end"], label, warnings)
  const parsed = {
    axisX: number(influence.axisX, `${label}.axisX`),
    axisY: number(influence.axisY, `${label}.axisY`),
    start: number(influence.start, `${label}.start`),
    end: number(influence.end, `${label}.end`),
  }
  if (Math.hypot(parsed.axisX, parsed.axisY) < 1e-6) throw new Error(`${label} axis must be non-zero`)
  if (parsed.end <= parsed.start) throw new Error(`${label}.end must be greater than ${label}.start`)
  return parsed
}

export function parseCatalogManifest(input: unknown): ValidationResult<CatalogManifest> {
  const root = object(input, "catalog")
  const warnings: string[] = []
  warnUnknown(root, ["schemaVersion", "characters", "generation"], "catalog", warnings)
  return { value: { schemaVersion: version(root.schemaVersion, "catalog"), characters: strings(root.characters, "catalog.characters") }, warnings }
}

export function parseCharacterManifest(input: unknown): ValidationResult<CharacterManifest> {
  const root = object(input, "character")
  const base = object(root.base, "character.base")
  const warnings: string[] = []
  warnUnknown(root, ["schemaVersion", "id", "label", "base", "poses", "behavior", "dialogue"], "character", warnings)
  warnUnknown(base, ["source", "psd", "overrides"], "character.base", warnings)
  return {
    value: {
      schemaVersion: version(root.schemaVersion, "character"),
      id: string(root.id, "character.id"),
      label: string(root.label, "character.label"),
      base: {
        source: string(base.source, "character.base.source"),
        psd: string(base.psd, "character.base.psd"),
        ...(base.overrides === undefined ? {} : { overrides: string(base.overrides, "character.base.overrides") }),
      },
      poses: strings(root.poses, "character.poses"),
      ...(root.behavior === undefined ? {} : { behavior: string(root.behavior, "character.behavior") }),
      ...(root.dialogue === undefined ? {} : { dialogue: string(root.dialogue, "character.dialogue") }),
    },
    warnings,
  }
}

export function parsePoseManifest(input: unknown): ValidationResult<PoseManifest> {
  const root = object(input, "pose")
  const registration = object(root.registration, "pose.registration")
  const layers = object(root.layers, "pose.layers")
  const transition = object(root.transition, "pose.transition")
  const warnings: string[] = []
  warnUnknown(root, ["schemaVersion", "id", "label", "source", "psd", "overrides", "strategy", "registration", "layers", "transition", "motion", "interactionScale"], "pose", warnings)
  warnUnknown(registration, ["strategy", "maxScaleDelta", "maxRotationDeg", "maxAnchorErrorPx"], "pose.registration", warnings)
  warnUnknown(layers, ["sharedFromBase", "replaceFromBase", "useFromPose", "addFromPose", "renderBehindBase", "renderInFrontOfBase"], "pose.layers", warnings)
  warnUnknown(transition, ["enterMs", "exitMs", "swapStart", "swapEnd"], "pose.transition", warnings)
  if (root.strategy !== "semantic-layer-swap" && root.strategy !== "independent-model") throw new Error("pose.strategy must be 'semantic-layer-swap' or 'independent-model'")
  const independent = root.strategy === "independent-model"
  const registrationStrategy = independent ? "identity" : "eyes-and-neck"
  if (registration.strategy !== registrationStrategy) throw new Error(`pose.registration.strategy must be '${registrationStrategy}' for ${root.strategy}`)
  const renderBehindBase = layers.renderBehindBase === undefined ? [] : (() => {
    if (!Array.isArray(layers.renderBehindBase)) throw new Error("pose.layers.renderBehindBase must be an array")
    return layers.renderBehindBase.map((value, index) => {
      const rule = object(value, `pose.layers.renderBehindBase[${index}]`)
      warnUnknown(rule, ["pose", "base"], `pose.layers.renderBehindBase[${index}]`, warnings)
      return { pose: string(rule.pose, `pose.layers.renderBehindBase[${index}].pose`), base: string(rule.base, `pose.layers.renderBehindBase[${index}].base`) }
    })
  })()
  const renderInFrontOfBase = layers.renderInFrontOfBase === undefined ? [] : (() => {
    if (!Array.isArray(layers.renderInFrontOfBase)) throw new Error("pose.layers.renderInFrontOfBase must be an array")
    return layers.renderInFrontOfBase.map((value, index) => {
      const rule = object(value, `pose.layers.renderInFrontOfBase[${index}]`)
      warnUnknown(rule, ["pose", "base"], `pose.layers.renderInFrontOfBase[${index}]`, warnings)
      return { pose: string(rule.pose, `pose.layers.renderInFrontOfBase[${index}].pose`), base: string(rule.base, `pose.layers.renderInFrontOfBase[${index}].base`) }
    })
  })()
  const motion = root.motion === undefined ? undefined : (() => {
    const value = object(root.motion, "pose.motion")
    const parameters = object(value.parameters ?? {}, "pose.motion.parameters")
    const motionLayers = object(value.layers ?? {}, "pose.motion.layers")
    warnUnknown(value, ["loopDurationMs", "parameters", "layers", "playback", "envelope", "transition"], "pose.motion", warnings)
    const timing = parseMotionTiming(value, "pose.motion", warnings)
    if (value.transition !== undefined && value.transition !== "continuous") throw new Error("pose.motion.transition must be continuous")
    const parsedParameters = Object.fromEntries(Object.entries(parameters).map(([name, track]) => {
      if (!(name in DEFAULT_PARAMETERS)) throw new Error(`pose.motion.parameters contains unknown parameter '${name}'`)
      return [name, parseMotionTrack(track, `pose.motion.parameters.${name}`, warnings, timing, PARAMETER_RANGES[name as Anime25DParameter])]
    }))
    const parsedLayers = Object.fromEntries(Object.entries(motionLayers).map(([selector, layerValue]) => {
      string(selector, "pose.motion layer selector")
      const layer = object(layerValue, `pose.motion.layers.${selector}`)
      const label = `pose.motion.layers.${selector}`
      const trackNames = ["translateX", "translateY", "rotationDeg", "scale"] as const
      warnUnknown(layer, [...trackNames, "origin", "influence"], label, warnings)
      const parsedTracks = Object.fromEntries(trackNames
        .filter((name) => layer[name] !== undefined)
        .map((name) => [name, parseMotionTrack(layer[name], `${label}.${name}`, warnings, timing, name === "scale" ? [0.1, 4] : name === "rotationDeg" ? [-180, 180] : [-2048, 2048])]))
      if (!Object.keys(parsedTracks).length) throw new Error(`${label} must define at least one transform track`)
      return [selector, {
        ...parsedTracks,
        ...(layer.origin === undefined ? {} : { origin: parseTransformOrigin(layer.origin, `${label}.origin`, warnings) }),
        ...(layer.influence === undefined ? {} : { influence: parseTransformInfluence(layer.influence, `${label}.influence`, warnings) }),
      }]
    }))
    return { ...timing, ...(value.transition ? { transition: "continuous" as const } : {}), parameters: parsedParameters, layers: parsedLayers }
  })()
  const interactionScale = root.interactionScale === undefined ? undefined : (() => {
    const value = object(root.interactionScale, "pose.interactionScale")
    return Object.fromEntries(Object.entries(value).map(([name, scale]) => {
      if (!INTERACTIONS.has(name as InteractionId)) throw new Error(`pose.interactionScale contains unknown interaction '${name}'`)
      const parsedScale = number(scale, `pose.interactionScale.${name}`)
      if (parsedScale < 0) throw new Error(`pose.interactionScale.${name} must be non-negative`)
      return [name, parsedScale]
    }))
  })()
  const parsed: PoseManifest = {
    schemaVersion: version(root.schemaVersion, "pose"),
    id: string(root.id, "pose.id"),
    label: string(root.label, "pose.label"),
    source: string(root.source, "pose.source"),
    psd: string(root.psd, "pose.psd"),
    ...(root.overrides === undefined ? {} : { overrides: string(root.overrides, "pose.overrides") }),
    strategy: root.strategy,
    registration: {
      strategy: registrationStrategy,
      maxScaleDelta: number(registration.maxScaleDelta, "pose.registration.maxScaleDelta"),
      maxRotationDeg: number(registration.maxRotationDeg, "pose.registration.maxRotationDeg"),
      maxAnchorErrorPx: number(registration.maxAnchorErrorPx, "pose.registration.maxAnchorErrorPx"),
    },
    layers: {
      sharedFromBase: strings(layers.sharedFromBase, "pose.layers.sharedFromBase"),
      replaceFromBase: strings(layers.replaceFromBase, "pose.layers.replaceFromBase"),
      useFromPose: strings(layers.useFromPose, "pose.layers.useFromPose"),
      addFromPose: strings(layers.addFromPose, "pose.layers.addFromPose"),
      renderBehindBase,
      renderInFrontOfBase,
    },
    transition: {
      enterMs: number(transition.enterMs, "pose.transition.enterMs"),
      exitMs: number(transition.exitMs, "pose.transition.exitMs"),
      swapStart: number(transition.swapStart, "pose.transition.swapStart"),
      swapEnd: number(transition.swapEnd, "pose.transition.swapEnd"),
    },
    ...(motion ? { motion } : {}),
    ...(interactionScale ? { interactionScale } : {}),
  }
  if (parsed.registration.maxScaleDelta < 0 || parsed.registration.maxRotationDeg < 0 || parsed.registration.maxAnchorErrorPx < 0) throw new Error("pose.registration tolerances must be non-negative")
  if (independent && Object.values(parsed.layers).some(values => values?.length)) throw new Error("independent-model selects its whole rig; pose.layers arrays must be empty")
  if (parsed.transition.enterMs <= 0 || parsed.transition.exitMs <= 0) throw new Error("pose transition durations must be positive")
  if (parsed.transition.swapStart < 0 || parsed.transition.swapEnd > 1 || parsed.transition.swapStart >= parsed.transition.swapEnd) throw new Error("pose transition swap range must satisfy 0 <= swapStart < swapEnd <= 1")
  return { value: parsed, warnings }
}

export function resolveManifestUrl(path: string, manifestUrl: string): string {
  const base = new URL(manifestUrl, globalThis.location?.href ?? "http://localhost/")
  if (base.pathname.startsWith("/character-packs/")) {
    const pack = parsePackAssetUrl(base.toString())
    if (!pack) throw new Error("PACK_PATH")
    return packAssetUrl(pack.id, pack.revision, resolvePackReference(path, pack.path))
  }
  return new URL(path, base).toString()
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", signal })
  if (!response.ok) throw new Error(`${url} could not be loaded (${response.status})`)
  return response.json()
}

export async function loadCharacterCatalog(catalogUrl: string, signal?: AbortSignal): Promise<{ characters: LoadedCharacter[]; warnings: string[] }> {
  const catalog = parseCatalogManifest(await fetchJson(catalogUrl, signal))
  const settled = await Promise.allSettled(catalog.value.characters.map(async (path) => {
    const manifestUrl = resolveManifestUrl(path, catalogUrl)
    const parsed = parseCharacterManifest(await fetchJson(manifestUrl, signal))
    return {
      ...parsed.value,
      manifestUrl,
      revision: parsePackAssetUrl(manifestUrl)?.revision ?? "builtin",
      baseUrls: {
        source: resolveManifestUrl(parsed.value.base.source, manifestUrl),
        psd: resolveManifestUrl(parsed.value.base.psd, manifestUrl),
        ...(parsed.value.base.overrides ? { overrides: resolveManifestUrl(parsed.value.base.overrides, manifestUrl) } : {}),
      },
      poseManifestUrls: parsed.value.poses.map((pose) => resolveManifestUrl(pose, manifestUrl)),
      ...(parsed.value.behavior ? { behaviorManifestUrl: resolveManifestUrl(parsed.value.behavior, manifestUrl) } : {}),
      ...(parsed.value.dialogue ? { dialogueManifestUrl: resolveManifestUrl(parsed.value.dialogue, manifestUrl) } : {}),
      warnings: parsed.warnings,
    }
  }))
  signal?.throwIfAborted()
  const characters: LoadedCharacter[] = []
  const warnings = [...catalog.warnings]
  for (const result of settled) {
    if (result.status === "fulfilled") characters.push(result.value)
    else warnings.push("A character manifest could not be loaded; other characters remain available")
  }
  const ids = new Set<string>()
  for (const character of characters) {
    if (ids.has(character.id)) throw new Error(`catalog contains duplicate character id '${character.id}'`)
    ids.add(character.id)
  }
  return { characters, warnings }
}

export async function loadPoseManifest(manifestUrl: string, signal?: AbortSignal): Promise<ValidationResult<PoseManifest>> {
  return parsePoseManifest(await fetchJson(manifestUrl, signal))
}
