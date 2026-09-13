export const DIALOGUE_TRIGGER_IDS = [
  "run.started", "run.completed.observed", "run.completed.authoritative", "run.failed", "run.cancelled.user",
  "task.started.command", "task.started.file-change", "task.started.tool", "task.started.web-search", "task.started.subtask", "task.started.review", "task.started.other",
  "state.bored", "behavior.bored-look-away", "behavior.bored-sigh",
  "interaction.head-tap", "interaction.face-hold", "interaction.pet", "interaction.torso-tap",
  "state.normal", "state.waiting", "state.disconnected",
] as const
export type DialogueTriggerId = typeof DIALOGUE_TRIGGER_IDS[number]
export const isDialogueTriggerId = (value: string): value is DialogueTriggerId => DIALOGUE_TRIGGER_IDS.some((id) => id === value)

export type DialogueEntry = {
  priority: number
  probability: number
  cooldownMs: number
  displayMs?: number
  mode: "replace-lower" | "queue" | "drop-if-busy"
  lines: string[]
}
export type DialogueSettings = {
  defaultDisplayMs: number
  fadeMs: number
  minGapMs: number
  maxQueueSize: number
  repeatMemory: number
  maxCharacters: number
}
export type DialogueManifest = {
  schemaVersion: 1
  locale: "ko-KR"
  settings: DialogueSettings
  triggers: Partial<Record<DialogueTriggerId, DialogueEntry>>
  /** Opt in to cues driven by the visible pose; "base" is the neutral rig. */
  poseTriggers?: Record<string, DialogueTriggerId>
  /** Optional lines for individual poses sharing a trigger; requires poseTriggers. */
  poseLines?: Record<string, string[]>
}
export type DialogueProfile = { manifest: DialogueManifest | null; warnings: string[] }
export type DialogueDecision = "shown" | "queued" | "cooldown" | "probability" | "lower-priority" | "disabled" | "internal-cancel" | "global-gap" | "queue-full" | "expired" | "duplicate" | "unmapped" | "snapshot" | "cleared" | "missing-trigger"
export type DialogueHistoryEntry = { at: number; triggerId: DialogueTriggerId | null; decision: DialogueDecision; text: string | null }
export type DialogueSnapshot = {
  enabled: boolean
  characterId: string | null
  visible: boolean
  phase: "hidden" | "shown" | "exiting"
  text: string | null
  triggerId: DialogueTriggerId | null
  priority: number | null
  shownAt: number | null
  hideAt: number | null
  fadeMs: number
  queueLength: number
  suppressedCount: number
  lastDecision: DialogueDecision | null
  history: DialogueHistoryEntry[]
  warnings: string[]
}
