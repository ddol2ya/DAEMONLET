import { isCharacterId } from "../../electron/shared/character-pack-contract"

export type LabSelection =
  | { kind: "character"; id: string }
  | { kind: "loose-psd" }

// UI keys occupy a separate namespace from registry IDs. In particular,
// "external" remains a valid pack ID and is never an internal mode sentinel.
export function labSelectionKey(selection: LabSelection): string {
  return selection.kind === "character" ? `character:${selection.id}` : "mode:loose-psd"
}

export function parseLabSelectionKey(value: string): LabSelection | null {
  if (value === "mode:loose-psd") return { kind: "loose-psd" }
  if (!value.startsWith("character:")) return null
  const id = value.slice("character:".length)
  return isCharacterId(id) ? { kind: "character", id } : null
}
