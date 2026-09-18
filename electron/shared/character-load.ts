import { isCharacterId, isRevision, type CharacterSelection } from "./character-pack-contract"

export const CHARACTER_LOAD_REQUEST = "characters.load-request"
export type CharacterLoadTicket = CharacterSelection & { requestId: string; rendererGeneration: number }
export function parseCharacterLoadTicket(value: unknown): CharacterLoadTicket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as CharacterLoadTicket
  if (Object.keys(v).length !== 4 || !isCharacterId(v.id) || v.revision !== "builtin" && !isRevision(v.revision) ||
    typeof v.requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.requestId) ||
    !Number.isSafeInteger(v.rendererGeneration) || v.rendererGeneration < 0) return null
  return v
}
