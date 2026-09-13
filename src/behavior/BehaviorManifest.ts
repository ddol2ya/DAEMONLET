import { DEFAULT_PARAMETERS, PARAMETER_RANGES } from "../engine/anime25d/Anime25DParameters"
import type { Anime25DParameter } from "../engine/anime25d/types"
import type { MotionTrack } from "../motion/types"
import { parseMotionTiming, parseMotionTrack } from "../motion/MotionManifest"
import type {
  BehaviorAction,
  ContinuousReaction,
  BehaviorManifest,
  BehaviorMotion,
  BehaviorProfile,
  BehaviorStateDefinition,
  BehaviorTiming,
  CharacterSemanticState,
} from "./types"

type ValidationResult<T> = { value: T; warnings: string[] }

const STATES: CharacterSemanticState[] = ["NORMAL", "BORED", "BUSY", "HAPPY", "WAITING"]
const WAITING_FALLBACK: BehaviorStateDefinition = { poseId: null }

export const behaviorStateDefinition = (profile: BehaviorManifest, state: CharacterSemanticState): BehaviorStateDefinition => profile.states[state] ?? WAITING_FALLBACK

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

const finiteNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

const positiveNumber = (value: unknown, label: string): number => {
  const parsed = finiteNumber(value, label)
  if (parsed < 0) throw new Error(`${label} must be non-negative`)
  return parsed
}

const nonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

const warnUnknown = (value: Record<string, unknown>, allowed: string[], label: string, warnings: string[]) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) warnings.push(`${label}: unknown field '${key}'`)
}

function parseMotion(value: unknown, label: string, warnings: string[]): BehaviorMotion {
  const motion = object(value, label)
  const parameters = object(motion.parameters ?? {}, `${label}.parameters`)
  warnUnknown(motion, ["loopDurationMs", "parameters", "playback", "envelope"], label, warnings)
  const timing = parseMotionTiming(motion, label, warnings)
  const parsedParameters = Object.fromEntries(Object.entries(parameters).map(([name, track]) => {
    if (!(name in DEFAULT_PARAMETERS)) throw new Error(`${label}.parameters contains unknown parameter '${name}'`)
    return [name, parseMotionTrack(track, `${label}.parameters.${name}`, warnings, timing, PARAMETER_RANGES[name as Anime25DParameter])]
  })) as Partial<Record<Anime25DParameter, MotionTrack>>
  return { ...timing, parameters: parsedParameters }
}

function parsePoseVariants(value: unknown, primary: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (typeof primary !== "string" || !primary.trim()) throw new Error(`${label} requires a primary poseId`)
  if (!Array.isArray(value) || !value.length || value.length > 7) throw new Error(`${label} must contain 1 to 7 additional poses`)
  const poses = value.map((id, index) => nonEmptyString(id, `${label}[${index}]`))
  if (new Set([primary, ...poses]).size !== poses.length + 1) throw new Error(`${label} must contain distinct poses and exclude the primary poseId`)
  return poses
}

function parseAction(value: unknown, label: string, warnings: string[]): BehaviorAction {
  const action = object(value, label)
  warnUnknown(action, ["id", "durationMs", "motion", "poseId", "poseVariants"], label, warnings)
  const poseVariants = parsePoseVariants(action.poseVariants, action.poseId, `${label}.poseVariants`)
  const durationMs = positiveNumber(action.durationMs, `${label}.durationMs`)
  if (durationMs === 0) throw new Error(`${label}.durationMs must be positive`)
  const motion = parseMotion(action.motion, `${label}.motion`, warnings)
  if (motion.envelope && durationMs !== motion.loopDurationMs) throw new Error(`${label} envelope must end at action duration`)
  return {
    id: nonEmptyString(action.id, `${label}.id`),
    durationMs,
    motion,
    ...(action.poseId === undefined ? {} : { poseId: nonEmptyString(action.poseId, `${label}.poseId`) }),
    ...(poseVariants ? { poseVariants } : {}),
  }
}

function parseContinuous(value: unknown, label: string, warnings: string[]): ContinuousReaction {
  const reaction = object(value, label)
  warnUnknown(reaction, ["poseId", "motion", "enterMs", "releaseMs", "workScale"], label, warnings)
  const motion = parseMotion(reaction.motion, `${label}.motion`, warnings)
  const facialChannels = new Set(["angleX", "angleY", "angleZ", "eyeOpenL", "eyeOpenR", "eyeX", "eyeY", "irisScale", "brow", "browAngL", "browAngR", "browAngSym", "mouthOpen", "mouthForm", "mouthCY", "eyeCY", "eyeCAng", "eyeScaleL", "eyeScaleR", "mouthScale"])
  if (Object.keys(motion.parameters).some(name => !facialChannels.has(name))) throw new Error(`${label}.motion may only own facial/head channels`)
  if (motion.playback === "once" || motion.envelope) throw new Error(`${label}.motion must be a loop without a timed envelope`)
  const enterMs = positiveNumber(reaction.enterMs ?? 180, `${label}.enterMs`)
  const releaseMs = positiveNumber(reaction.releaseMs ?? 280, `${label}.releaseMs`)
  if (enterMs > 2000 || releaseMs > 2000) throw new Error(`${label} blending must be at most 2000ms`)
  const workScale = positiveNumber(reaction.workScale ?? .55, `${label}.workScale`)
  if (workScale > 1) throw new Error(`${label}.workScale must be at most 1`)
  return { motion, enterMs, releaseMs, workScale, ...(reaction.poseId === undefined ? {} : { poseId: nonEmptyString(reaction.poseId, `${label}.poseId`) }) }
}

function parseState(value: unknown, label: string, warnings: string[]): BehaviorStateDefinition {
  const state = object(value, label)
  warnUnknown(state, ["poseId", "poseVariants", "poseVariantIntervalMs", "motion", "fallbackMotion", "actions"], label, warnings)
  if (state.poseId !== null && typeof state.poseId !== "string") throw new Error(`${label}.poseId must be a string or null`)
  const poseVariants = parsePoseVariants(state.poseVariants, state.poseId, `${label}.poseVariants`)
  const poseVariantIntervalMs = state.poseVariantIntervalMs === undefined ? undefined : finiteNumber(state.poseVariantIntervalMs, `${label}.poseVariantIntervalMs`)
  if (poseVariantIntervalMs !== undefined && (!poseVariants || poseVariantIntervalMs < 5_000 || poseVariantIntervalMs > 300_000)) {
    throw new Error(`${label}.poseVariantIntervalMs requires variants and must be between 5000 and 300000ms`)
  }
  const actions = state.actions === undefined ? undefined : (() => {
    if (!Array.isArray(state.actions)) throw new Error(`${label}.actions must be an array`)
    const parsed = state.actions.map((action, index) => parseAction(action, `${label}.actions[${index}]`, warnings))
    const ids = new Set<string>()
    for (const action of parsed) {
      if (ids.has(action.id)) throw new Error(`${label}.actions contains duplicate id '${action.id}'`)
      ids.add(action.id)
    }
    return parsed
  })()
  return {
    poseId: state.poseId === null ? null : nonEmptyString(state.poseId, `${label}.poseId`),
    ...(poseVariants ? { poseVariants } : {}),
    ...(poseVariantIntervalMs === undefined ? {} : { poseVariantIntervalMs }),
    ...(state.motion === undefined ? {} : { motion: parseMotion(state.motion, `${label}.motion`, warnings) }),
    ...(state.fallbackMotion === undefined ? {} : { fallbackMotion: parseMotion(state.fallbackMotion, `${label}.fallbackMotion`, warnings) }),
    ...(actions ? { actions } : {}),
  }
}

export const DEFAULT_BEHAVIOR_MANIFEST: BehaviorManifest = {
  schemaVersion: 1,
  timing: {
    boredAfterMs: 60_000,
    happyDurationMs: 3_500,
    stateBlendMs: 280,
    boredActionDelayMinMs: 4_000,
    boredActionDelayMaxMs: 9_000,
  },
  states: {
    NORMAL: { poseId: null },
    WAITING: { poseId: null },
    BORED: {
      poseId: null,
      motion: {
        loopDurationMs: 4_200,
        parameters: {
          eyeOpenL: { type: "constant", value: 0.72 },
          eyeOpenR: { type: "constant", value: 0.72 },
          angleY: { type: "constant", value: 0.1 },
          angleZ: { type: "sine", amplitude: 0.035, phase: 0, offset: 0.045 },
          body: { type: "sine", amplitude: 0.018, phase: 1.2, offset: 0.08 },
        },
      },
      actions: [
        {
          id: "bored-look-away",
          durationMs: 1_600,
          motion: {
            loopDurationMs: 1_600,
            parameters: {
              eyeX: { type: "sine", amplitude: 0.42, phase: -1.57, offset: 0 },
              angleX: { type: "sine", amplitude: 0.08, phase: -1.57, offset: 0 },
            },
          },
        },
        {
          id: "bored-sigh",
          durationMs: 1_900,
          motion: {
            loopDurationMs: 1_900,
            parameters: {
              body: { type: "sine", amplitude: 0.055, phase: 0, offset: 0.02 },
              angleY: { type: "sine", amplitude: 0.075, phase: 0, offset: 0.02 },
              mouthOpen: { type: "sine", amplitude: 0.018, phase: 0, offset: 0.018 },
            },
          },
        },
      ],
    },
    BUSY: {
      poseId: "writing",
      fallbackMotion: {
        loopDurationMs: 1_600,
        parameters: {
          eyeY: { type: "constant", value: 0.55 },
          angleY: { type: "constant", value: -0.18 },
          body: { type: "sine", amplitude: 0.015, phase: 0.8, offset: 0.025 },
        },
      },
    },
    HAPPY: {
      poseId: null,
      motion: {
        loopDurationMs: 900,
        parameters: {
          eyeOpenL: { type: "constant", value: 0.72 },
          eyeOpenR: { type: "constant", value: 0.72 },
          mouthForm: { type: "constant", value: 0.28 },
          body: { type: "sine", amplitude: 0.16, phase: 0, offset: -0.03 },
          angleZ: { type: "sine", amplitude: 0.045, phase: 0.6, offset: 0 },
        },
      },
    },
  },
  failureReaction: {
    id: "task-failed-recoil",
    durationMs: 720,
    motion: {
      loopDurationMs: 1_440,
      parameters: {
        angleY: { type: "sine", amplitude: 0.12, phase: 0, offset: -0.06 },
        body: { type: "sine", amplitude: 0.09, phase: 0, offset: -0.04 },
        eyeOpenL: { type: "constant", value: 0.7 },
        eyeOpenR: { type: "constant", value: 0.7 },
      },
    },
  },
}

export function parseBehaviorManifest(input: unknown): ValidationResult<BehaviorManifest> {
  const root = object(input, "behavior")
  const warnings: string[] = []
  warnUnknown(root, ["schemaVersion", "timing", "states", "failureReaction", "cancellationReaction", "interactionReactions", "continuousReactions", "disconnected", "gazeTakeoverFromCurrent"], "behavior", warnings)
  if (root.schemaVersion !== 1) throw new Error("behavior.schemaVersion must be 1")
  if (root.gazeTakeoverFromCurrent !== undefined && typeof root.gazeTakeoverFromCurrent !== "boolean") throw new Error("behavior.gazeTakeoverFromCurrent must be boolean")
  const timing = object(root.timing, "behavior.timing")
  warnUnknown(timing, ["boredAfterMs", "happyDurationMs", "stateBlendMs", "boredActionDelayMinMs", "boredActionDelayMaxMs"], "behavior.timing", warnings)
  const parsedTiming: BehaviorTiming = {
    boredAfterMs: positiveNumber(timing.boredAfterMs, "behavior.timing.boredAfterMs"),
    happyDurationMs: positiveNumber(timing.happyDurationMs, "behavior.timing.happyDurationMs"),
    stateBlendMs: positiveNumber(timing.stateBlendMs, "behavior.timing.stateBlendMs"),
    boredActionDelayMinMs: positiveNumber(timing.boredActionDelayMinMs, "behavior.timing.boredActionDelayMinMs"),
    boredActionDelayMaxMs: positiveNumber(timing.boredActionDelayMaxMs, "behavior.timing.boredActionDelayMaxMs"),
  }
  if (parsedTiming.boredActionDelayMaxMs < parsedTiming.boredActionDelayMinMs) throw new Error("behavior bored action delay max must be >= min")
  const states = object(root.states, "behavior.states")
  for (const state of Object.keys(states)) if (!STATES.includes(state as CharacterSemanticState)) throw new Error(`behavior.states contains unknown state '${state}'`)
  const parsedStates = Object.fromEntries(STATES.map((state) => {
    if (state === "WAITING" && states[state] === undefined) return [state, { poseId: null }]
    if (states[state] === undefined) throw new Error(`behavior.states.${state} is required`)
    return [state, parseState(states[state], `behavior.states.${state}`, warnings)]
  })) as Record<CharacterSemanticState, BehaviorStateDefinition>
  const interactionReactions = root.interactionReactions === undefined ? undefined : (() => {
    const reactions = object(root.interactionReactions, "behavior.interactionReactions")
    for (const name of Object.keys(reactions)) if (name !== "HEAD_TAP" && name !== "TORSO_TAP") throw new Error(`behavior.interactionReactions contains unknown interaction '${name}'`)
    return Object.fromEntries(Object.entries(reactions).map(([name, action]) => [name, parseAction(action, `behavior.interactionReactions.${name}`, warnings)]))
  })()
  const continuousReactions = root.continuousReactions === undefined ? undefined : (() => {
    const reactions = object(root.continuousReactions, "behavior.continuousReactions")
    for (const name of Object.keys(reactions)) if (name !== "PET" && name !== "HOLD") throw new Error(`behavior.continuousReactions contains unknown interaction '${name}'`)
    return Object.fromEntries(Object.entries(reactions).map(([name, value]) => [name, parseContinuous(value, `behavior.continuousReactions.${name}`, warnings)]))
  })()
  return {
    value: {
      schemaVersion: 1,
      ...(root.gazeTakeoverFromCurrent === undefined ? {} : { gazeTakeoverFromCurrent: root.gazeTakeoverFromCurrent }),
      timing: parsedTiming,
      states: parsedStates,
      ...(root.failureReaction === undefined ? {} : { failureReaction: parseAction(root.failureReaction, "behavior.failureReaction", warnings) }),
      ...(root.cancellationReaction === undefined ? {} : { cancellationReaction: parseAction(root.cancellationReaction, "behavior.cancellationReaction", warnings) }),
      ...(interactionReactions === undefined ? {} : { interactionReactions }),
      ...(continuousReactions === undefined ? {} : { continuousReactions }),
      ...(root.disconnected === undefined ? {} : { disconnected: parseState(root.disconnected, "behavior.disconnected", warnings) }),
    },
    warnings,
  }
}

export function createDefaultBehaviorProfile(extraWarnings: string[] = []): BehaviorProfile {
  return {
    ...structuredClone(DEFAULT_BEHAVIOR_MANIFEST),
    sourceUrl: null,
    warnings: [...extraWarnings],
    usedDefault: true,
  }
}

export async function loadBehaviorManifest(manifestUrl?: string, signal?: AbortSignal): Promise<BehaviorProfile> {
  if (!manifestUrl) return createDefaultBehaviorProfile()
  const response = await fetch(manifestUrl, { cache: "no-store", signal })
  if (!response.ok) throw new Error(`${manifestUrl} could not be loaded (${response.status})`)
  const parsed = parseBehaviorManifest(await response.json())
  return { ...parsed.value, sourceUrl: manifestUrl, warnings: parsed.warnings, usedDefault: false }
}

export function validateBehaviorPoseIds(profile: BehaviorProfile, availablePoseIds: Iterable<string>): string[] {
  const available = new Set(availablePoseIds)
  const warnings = STATES.flatMap((state) => {
    const poseId = behaviorStateDefinition(profile, state).poseId
    return poseId && !available.has(poseId) ? [`behavior state ${state} references unavailable pose '${poseId}'; parameter fallback will be used`] : []
  })
  const extra = [
    ["failureReaction", profile.failureReaction?.poseId],
    ["cancellationReaction", profile.cancellationReaction?.poseId],
    ["disconnected", profile.disconnected?.poseId],
    ...Object.entries(profile.interactionReactions ?? {}).map(([id, action]) => [id, action.poseId]),
  ]
  for (const [owner, poseId] of extra) if (poseId && !available.has(poseId)) warnings.push(`behavior ${owner} references unavailable pose '${poseId}'; parameter fallback will be used`)
  for (const [id, reaction] of Object.entries(profile.continuousReactions ?? {})) {
    if (reaction.poseId && !available.has(reaction.poseId)) warnings.push(`behavior continuous ${id} references unavailable pose '${reaction.poseId}'; that reaction will be unavailable`)
  }
  for (const [owner, definition] of variantDefinitions(profile)) {
    for (const poseId of definition?.poseVariants ?? []) {
      if (!available.has(poseId)) warnings.push(`behavior ${owner} references unavailable variant pose '${poseId}'; available poses will be used`)
    }
  }
  return warnings
}

function variantDefinitions(profile: BehaviorManifest): Array<[string, { poseVariants?: string[] } | undefined]> {
  return [
    ...STATES.map(state => [`state ${state}`, behaviorStateDefinition(profile, state)] as [string, BehaviorStateDefinition]),
    ...STATES.flatMap(state => (behaviorStateDefinition(profile, state).actions ?? []).map(action => [`action ${action.id}`, action] as [string, BehaviorAction])),
    ["failureReaction", profile.failureReaction], ["cancellationReaction", profile.cancellationReaction], ["disconnected", profile.disconnected],
    ...Object.entries(profile.interactionReactions ?? {}),
  ]
}

export function behaviorUsesPoseVariants(profile: BehaviorManifest): boolean {
  return variantDefinitions(profile).some(([, definition]) => Boolean(definition?.poseVariants?.length))
}
