import type { TaskEventSource } from "../behavior/TaskEventSource"
import type { CharacterLifecycleEvent } from "./CharacterLifecycleEvent"

export interface CharacterEventSource extends TaskEventSource {
  subscribeLifecycle(listener: (event: CharacterLifecycleEvent) => void): () => void
}

export function hasLifecycle(source: TaskEventSource): source is CharacterEventSource {
  return "subscribeLifecycle" in source && typeof source.subscribeLifecycle === "function"
}
