import { isAppLanguage, normalizeAppLanguage, type AppLanguage } from "./app-language"
import { automaticBubblePlacement, parseBubblePlacement, type BubblePlacement } from "./bubble-placement"
export const DESKTOP_SETTINGS_SCHEMA_VERSION = 1 as const
export const CHARACTER_IDS = ["gpichan"] as const
export const CHARACTER_NAMES = { gpichan: "지피쨩" } as const
export const SCALE_PRESETS = [0.65, 0.8, 1, 1.25, 1.5] as const
export const MIN_WINDOW_SIZE = 280
export const MAX_WINDOW_SIZE = 720
export const DEFAULT_WINDOW_SIZE = 460

export type DesktopCharacterId = string
const builtinCharacter = (id: string) => (CHARACTER_IDS as readonly string[]).includes(id)
export type DesktopBounds = {
  x: number
  y: number
  width: number
  height: number
  displayId: string | number | null
}

export type DesktopSettingsV1 = {
  schemaVersion: typeof DESKTOP_SETTINGS_SCHEMA_VERSION
  characterId: DesktopCharacterId
  language: AppLanguage
  scale: number
  bounds: DesktopBounds
  visible: boolean
  alwaysOnTop: boolean
  showOnAllWorkspaces: boolean
  showOverFullScreen: boolean
  clickThrough: boolean
  adapterAutoStart: boolean
  speechBubblesEnabled: boolean
  updateAutoCheck: boolean
  sideChatEnabled: boolean
  taskBubblesEnabled: boolean
  bubblePlacement: BubblePlacement
}

export type DesktopSettingsPatch = Partial<Pick<DesktopSettingsV1,
  "characterId" | "language" | "scale" | "visible" | "alwaysOnTop" | "showOnAllWorkspaces" |
  "showOverFullScreen" | "clickThrough" | "adapterAutoStart" | "speechBubblesEnabled" | "taskBubblesEnabled" | "sideChatEnabled" | "updateAutoCheck" | "bubblePlacement"
>>

export type DisplayLike = {
  id: string | number
  scaleFactor?: number
  workArea: { x: number; y: number; width: number; height: number }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function defaultDesktopSettings(): DesktopSettingsV1 {
  return {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    characterId: "gpichan",
    language: "ko",
    scale: 1,
    bounds: { x: 24, y: 24, width: DEFAULT_WINDOW_SIZE, height: DEFAULT_WINDOW_SIZE, displayId: null },
    visible: true,
    alwaysOnTop: true,
    showOnAllWorkspaces: true,
    showOverFullScreen: false,
    clickThrough: true,
    adapterAutoStart: true,
    speechBubblesEnabled: true,
    taskBubblesEnabled: true,
    sideChatEnabled: true,
    updateAutoCheck: false,
    bubblePlacement: automaticBubblePlacement(),
  }
}

export function windowSizeForScale(scale: number): number {
  return Math.round(clamp(DEFAULT_WINDOW_SIZE * scale, MIN_WINDOW_SIZE, MAX_WINDOW_SIZE))
}

export function normalizeScale(value: unknown, fallback = 1): number {
  if (!finite(value)) return fallback
  return clamp(value, MIN_WINDOW_SIZE / DEFAULT_WINDOW_SIZE, MAX_WINDOW_SIZE / DEFAULT_WINDOW_SIZE)
}

export function normalizeDesktopSettings(value: unknown, characterAllowed: (id: string) => boolean = builtinCharacter): { value: DesktopSettingsV1; migrated: boolean; warnings: string[] } {
  const defaults = defaultDesktopSettings()
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value: defaults, migrated: true, warnings: ["desktop settings were not an object"] }
  }
  const input = value as Record<string, unknown>
  const warnings: string[] = []
  const characterId = isCharacterId(input.characterId) && characterAllowed(input.characterId) ? input.characterId : defaults.characterId
  if (input.characterId !== undefined && input.characterId !== characterId) warnings.push("unavailable character was replaced with gpichan")
  const scale = normalizeScale(input.scale, defaults.scale)
  const sourceBounds = input.bounds && typeof input.bounds === "object" && !Array.isArray(input.bounds) ? input.bounds as Record<string, unknown> : {}
  const size = windowSizeForScale(scale)
  const bounds: DesktopBounds = {
    x: finite(sourceBounds.x) ? Math.round(sourceBounds.x) : defaults.bounds.x,
    y: finite(sourceBounds.y) ? Math.round(sourceBounds.y) : defaults.bounds.y,
    width: size,
    height: size,
    displayId: typeof sourceBounds.displayId === "string" || typeof sourceBounds.displayId === "number" ? sourceBounds.displayId : null,
  }
  const normalized: DesktopSettingsV1 = {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    characterId,
    language: normalizeAppLanguage(input.language),
    scale,
    bounds,
    visible: bool(input.visible, defaults.visible),
    alwaysOnTop: bool(input.alwaysOnTop, defaults.alwaysOnTop),
    showOnAllWorkspaces: bool(input.showOnAllWorkspaces, defaults.showOnAllWorkspaces),
    showOverFullScreen: bool(input.showOverFullScreen, defaults.showOverFullScreen),
    clickThrough: bool(input.clickThrough, defaults.clickThrough),
    adapterAutoStart: bool(input.adapterAutoStart, defaults.adapterAutoStart),
    speechBubblesEnabled: bool(input.speechBubblesEnabled, defaults.speechBubblesEnabled),
    taskBubblesEnabled: bool(input.taskBubblesEnabled, defaults.taskBubblesEnabled),
    sideChatEnabled: bool(input.sideChatEnabled, defaults.sideChatEnabled),
    updateAutoCheck: bool(input.updateAutoCheck, false),
    bubblePlacement: parseBubblePlacement(input.bubblePlacement) ?? automaticBubblePlacement(),
  }
  const migrated = input.schemaVersion !== DESKTOP_SETTINGS_SCHEMA_VERSION || JSON.stringify(input) !== JSON.stringify(normalized)
  return { value: normalized, migrated, warnings }
}

export function validateDesktopSettingsPatch(value: unknown, characterAllowed: (id: string) => boolean = builtinCharacter): DesktopSettingsPatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const allowed = new Set(["characterId", "language", "scale", "visible", "alwaysOnTop", "showOnAllWorkspaces", "showOverFullScreen", "clickThrough", "adapterAutoStart", "speechBubblesEnabled", "taskBubblesEnabled", "sideChatEnabled", "updateAutoCheck", "bubblePlacement"])
  if (Object.keys(input).some((key) => !allowed.has(key))) return null
  const patch: DesktopSettingsPatch = {}
  if ("bubblePlacement" in input) { const placement = parseBubblePlacement(input.bubblePlacement); if (!placement) return null; patch.bubblePlacement = placement }
  if ("language" in input) {
    if (!isAppLanguage(input.language)) return null
    patch.language = input.language
  }
  if ("characterId" in input) {
    if (!isCharacterId(input.characterId) || !characterAllowed(input.characterId)) return null
    patch.characterId = input.characterId as DesktopCharacterId
  }
  if ("scale" in input) {
    if (!finite(input.scale) || input.scale < MIN_WINDOW_SIZE / DEFAULT_WINDOW_SIZE || input.scale > MAX_WINDOW_SIZE / DEFAULT_WINDOW_SIZE) return null
    patch.scale = input.scale
  }
  for (const key of ["visible", "alwaysOnTop", "showOnAllWorkspaces", "showOverFullScreen", "clickThrough", "adapterAutoStart", "speechBubblesEnabled", "taskBubblesEnabled", "sideChatEnabled", "updateAutoCheck"] as const) {
    if (key in input) {
      if (typeof input[key] !== "boolean") return null
      patch[key] = input[key]
    }
  }
  return patch
}

export function intersectionArea(a: Pick<DesktopBounds, "x" | "y" | "width" | "height">, b: DisplayLike["workArea"]): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

export function isSufficientlyVisible(bounds: DesktopBounds, workArea: DisplayLike["workArea"]): boolean {
  const area = intersectionArea(bounds, workArea)
  return area >= bounds.width * bounds.height * 0.25 || area >= 80 * 80
}

export function recoverWindowBounds(saved: DesktopBounds, displays: DisplayLike[], primary: DisplayLike, margin = 24): DesktopBounds {
  const preferred = displays.find((display) => String(display.id) === String(saved.displayId))
  const matching = preferred && isSufficientlyVisible(saved, preferred.workArea)
    ? preferred
    : displays.find((display) => isSufficientlyVisible(saved, display.workArea))
  if (matching) return { ...saved, displayId: matching.id }
  const size = clamp(Math.min(saved.width, saved.height), MIN_WINDOW_SIZE, Math.min(MAX_WINDOW_SIZE, primary.workArea.width, primary.workArea.height))
  return {
    x: Math.round(primary.workArea.x + primary.workArea.width - size - margin),
    y: Math.round(primary.workArea.y + primary.workArea.height - size - margin),
    width: size,
    height: size,
    displayId: primary.id,
  }
}
import { isCharacterId } from "./character-pack-contract"
