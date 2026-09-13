import type { CharacterTaskEvent } from "./types"

export interface TaskEventSource {
  subscribe(listener: (event: CharacterTaskEvent) => void): () => void
}

