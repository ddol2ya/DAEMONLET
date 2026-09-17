import { isCharacterId, isRevision } from "./character-pack-contract"

export const CHARACTER_LOAD_DIAGNOSTIC = "desktop.character-load.diagnostic"
export const CHARACTER_LOAD_STAGES = ["start", "catalog", "assets", "decode", "gpu-commit", "first-frame", "ready", "aborted", "failed", "context-lost"] as const
export type CharacterLoadStage = typeof CHARACTER_LOAD_STAGES[number]
export type CharacterLoadDiagnostic = {
  loadId: string; epoch: number; id: string; revision: string; stage: CharacterLoadStage
  elapsedMs: number; hidden: boolean
}
export function parseCharacterLoadDiagnostic(v: unknown): CharacterLoadDiagnostic | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const x = v as CharacterLoadDiagnostic
  if (Object.keys(x).some(k => !["loadId", "epoch", "id", "revision", "stage", "elapsedMs", "hidden"].includes(k))
    || typeof x.loadId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x.loadId)
    || !Number.isSafeInteger(x.epoch) || x.epoch < 1 || !isCharacterId(x.id) || x.revision !== "builtin" && !isRevision(x.revision)
    || !CHARACTER_LOAD_STAGES.includes(x.stage) || !Number.isFinite(x.elapsedMs) || x.elapsedMs < 0 || x.elapsedMs > 3600_000 || typeof x.hidden !== "boolean") return null
  return x
}
