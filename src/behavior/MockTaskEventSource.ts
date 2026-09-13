import type { CharacterEventSource } from "../lifecycle/CharacterEventSource"
import { taskEventLifecycle, type CharacterLifecycleEvent } from "../lifecycle/CharacterLifecycleEvent"
import type { CharacterTaskEvent } from "./types"

export class MockTaskEventSource implements CharacterEventSource {
  private readonly listeners = new Set<(event: CharacterTaskEvent) => void>()
  private readonly lifecycleListeners = new Set<(event: CharacterLifecycleEvent) => void>()

  subscribe(listener: (event: CharacterTaskEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispatch(event: CharacterTaskEvent): void {
    for (const listener of this.listeners) listener(event)
    const lifecycle = taskEventLifecycle(event, event.at ?? performance.now())
    if (lifecycle) this.dispatchLifecycle(lifecycle)
  }

  subscribeLifecycle(listener: (event: CharacterLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  dispatchLifecycle(event: CharacterLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try { listener(event) } catch { /* Presentation cannot interrupt behavior. */ }
    }
  }

  dispose(): void {
    this.listeners.clear()
    this.lifecycleListeners.clear()
  }
}
