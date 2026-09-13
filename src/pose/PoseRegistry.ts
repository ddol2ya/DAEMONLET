import type { PoseManifest, PoseSummary } from "./types"

export type RegisteredPose = { manifest: PoseManifest; manifestUrl: string }

export class PoseRegistry {
  private readonly entries = new Map<string, RegisteredPose>()

  replace(entries: RegisteredPose[]) {
    const next = new Map<string, RegisteredPose>()
    for (const entry of entries) {
      if (next.has(entry.manifest.id)) throw new Error(`character contains duplicate pose id '${entry.manifest.id}'`)
      next.set(entry.manifest.id, entry)
    }
    this.entries.clear()
    for (const [id, entry] of next) this.entries.set(id, entry)
  }

  clear() {
    this.entries.clear()
  }

  resolve(id: string): RegisteredPose {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown pose id '${id}'. Available poses: ${[...this.entries.keys()].join(", ") || "none"}`)
    return entry
  }

  list(loadedId: string | null, activeId: string | null): PoseSummary[] {
    return [...this.entries.values()].map(({ manifest, manifestUrl }) => ({
      id: manifest.id,
      label: manifest.label,
      manifestUrl,
      loaded: manifest.id === loadedId,
      active: manifest.id === activeId,
    }))
  }
}
