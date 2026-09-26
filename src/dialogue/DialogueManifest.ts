import { createDefaultDialogueProfile } from "./DefaultDialogueProfile"
import { isDialogueTriggerId, type DialogueEntry, type DialogueManifest, type DialogueProfile, type DialogueTriggerId } from "./types"

const invalid = (): never => { throw new Error("Invalid dialogue manifest: expected bounded, static plain text and known schema fields.") }
const record = (value: unknown, keys?: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const object = value as Record<string, unknown>
  if (keys && Object.keys(object).some((key) => !keys.includes(key))) return invalid()
  return object
}
const number = (value: unknown, min: number, max: number, integer = false): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) return invalid()
  return value
}
// Also reject format controls (including bidi overrides), braces, and markup delimiters.
const forbidden = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>{}]/u

export function parseDialogueManifest(input: unknown): DialogueManifest {
  const root = record(input, ["schemaVersion", "locale", "settings", "triggers", "poseTriggers", "poseLines"])
  if (root.schemaVersion !== 1 || root.locale !== "ko-KR") return invalid()
  const settings = record(root.settings, ["defaultDisplayMs", "fadeMs", "minGapMs", "maxQueueSize", "repeatMemory", "maxCharacters"])
  const parsedSettings = {
    defaultDisplayMs: number(settings.defaultDisplayMs, 800, 6000),
    fadeMs: number(settings.fadeMs, 0, 300),
    minGapMs: number(settings.minGapMs, 0, 60000),
    maxQueueSize: number(settings.maxQueueSize, 0, 5, true),
    repeatMemory: number(settings.repeatMemory, 0, 20, true),
    maxCharacters: number(settings.maxCharacters, 1, 36, true),
  }
  const parseLines = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) return invalid()
    const lines = value.map((line: unknown) => {
      if (typeof line !== "string" || forbidden.test(line)) return invalid()
      const text = line.trim()
      if (!text.length || [...text].length > parsedSettings.maxCharacters) return invalid()
      return text
    })
    return [...new Set(lines)]
  }
  const triggers: Partial<Record<DialogueTriggerId, DialogueEntry>> = {}
  for (const [id, value] of Object.entries(record(root.triggers))) {
    if (!isDialogueTriggerId(id)) return invalid()
    const entry = record(value, ["priority", "probability", "cooldownMs", "displayMs", "mode", "lines"])
    if (entry.mode !== "replace-lower" && entry.mode !== "queue" && entry.mode !== "drop-if-busy") return invalid()
    const lines = parseLines(entry.lines)
    triggers[id] = {
      priority: number(entry.priority, 0, 100, true),
      probability: number(entry.probability, 0, 1),
      cooldownMs: number(entry.cooldownMs, 0, 600000),
      ...(entry.displayMs === undefined ? {} : { displayMs: number(entry.displayMs, 800, 6000) }),
      mode: entry.mode,
      lines,
    }
  }
  let poseTriggers: Record<string, DialogueTriggerId> | undefined
  if (root.poseTriggers !== undefined) {
    const entries = Object.entries(record(root.poseTriggers))
    if (!entries.length || entries.length > 64) return invalid()
    poseTriggers = {}
    for (const [poseId, triggerId] of entries) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(poseId) || typeof triggerId !== "string" || !isDialogueTriggerId(triggerId) || !triggers[triggerId]) return invalid()
      poseTriggers[poseId] = triggerId
    }
  }
  let poseLines: Record<string, string[]> | undefined
  if (root.poseLines !== undefined) {
    const entries = Object.entries(record(root.poseLines))
    if (!entries.length || entries.length > 64 || !poseTriggers) return invalid()
    poseLines = {}
    for (const [poseId, lines] of entries) {
      if (!Object.hasOwn(poseTriggers, poseId)) return invalid()
      poseLines[poseId] = parseLines(lines)
    }
  }
  return { schemaVersion: 1, locale: "ko-KR", settings: parsedSettings, triggers, ...(poseTriggers ? { poseTriggers } : {}), ...(poseLines ? { poseLines } : {}) }
}

export async function loadDialogueManifest(url?: string, signal?: AbortSignal): Promise<DialogueProfile> {
  if (!url) return createDefaultDialogueProfile()
  try {
    const response = await fetch(url, { cache: "no-store", signal })
    if (!response.ok) return createDefaultDialogueProfile()
    // Limit decoded assets too, without recording the URL or an untrusted parser error.
    const text = await response.text()
    signal?.throwIfAborted()
    if (text.length > 64 * 1024) return createDefaultDialogueProfile()
    return { manifest: parseDialogueManifest(JSON.parse(text)), warnings: [] }
  } catch (error) {
    if (signal?.aborted) throw error
    return createDefaultDialogueProfile()
  }
}
