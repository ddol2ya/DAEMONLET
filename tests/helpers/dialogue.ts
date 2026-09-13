import { parseDialogueManifest } from "../../src/dialogue/DialogueManifest"
import { DIALOGUE_TRIGGER_IDS, type DialogueManifest, type DialogueProfile } from "../../src/dialogue/types"

export function dialogueManifest(): DialogueManifest {
  return parseDialogueManifest({
    schemaVersion: 1, locale: "ko-KR",
    settings: { defaultDisplayMs: 800, fadeMs: 160, minGapMs: 100, maxQueueSize: 3, repeatMemory: 2, maxCharacters: 36 },
    triggers: Object.fromEntries(DIALOGUE_TRIGGER_IDS.map((id) => [id, {
      priority: id === "run.failed" ? 100 : id === "run.cancelled.user" ? 95 : id.startsWith("run.completed") ? 90 : id.startsWith("interaction") ? 70 : id === "run.started" ? 50 : 15,
      probability: 1, cooldownMs: 0, mode: id.startsWith("task.") || id.includes("bored") ? "drop-if-busy" : "replace-lower", lines: ["확인할게.", "살펴볼게.", "기다려 줘."],
    }])),
  })
}
export function dialogueProfile(change?: (manifest: DialogueManifest) => void): DialogueProfile {
  const manifest = dialogueManifest()
  change?.(manifest)
  return { manifest, warnings: [] }
}
