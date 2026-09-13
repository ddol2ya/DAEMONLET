import type { DialogueProfile } from "./types"

/** No shared voice: a missing character manifest disables dialogue only. */
export function createDefaultDialogueProfile(warning = "Dialogue manifest is unavailable; speech bubbles are disabled."): DialogueProfile {
  return { manifest: null, warnings: [warning] }
}
