import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { CharacterLoadDiagnostic } from "../shared/character-load-diagnostics"
import type { CharacterSelection } from "../shared/character-pack-contract"

type Locks = { waiters: number; chatApplying: boolean; chatPhase: string; packApplying: boolean; packTarget: string | null; quitting: boolean; updatePreparing: boolean; inputAllowed: boolean }
type Event = { event: "request" | "worker-ready" | "timeout" | "failed" | "ready" | "fallback" | "renderer" | "blocked"; requestId: string; target: CharacterSelection; rendererGeneration: number; locks: Locks; selected: CharacterSelection | null; lastReady: CharacterSelection | null; load?: CharacterLoadDiagnostic }
/** Bounded structural evidence only: no paths, URLs, credentials, dialogue or persona text. */
export class CharacterTransitionTrace {
  private rows: Array<Event & { at: number }> = []
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}
  record(event: Event) {
    this.rows.push({ ...structuredClone(event), at: Date.now() }); this.rows = this.rows.slice(-128)
    const json = JSON.stringify({ schemaVersion: 1, events: this.rows }, null, 2) + "\n"
    this.tail = this.tail.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true })
      const file = join(this.directory, "character-transitions.json")
      await writeFile(file + ".tmp", json, { mode: 0o600 }); await rename(file + ".tmp", file)
    }).catch(() => {})
  }
  flush() { return this.tail }
}
