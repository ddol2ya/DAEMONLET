import { validateChatDefinition } from "../../shared/character-chat-semantics"
import { parseCharacterPersona, neutralPersona } from "../../shared/character-persona"
import { compilePersona } from "./PersonaCompiler"
import type { AppLanguage } from "../../shared/app-language"
import type { CharacterSelection } from "../../shared/character-pack-contract"
import { resolvePackReference } from "../../shared/character-pack-path"
import { parseCharacterManifest } from "../../../src/pose/PoseManifest"
export type PersonaBinding = { id: string; revision: string; label: string; compiled: ReturnType<typeof compilePersona> }
export class PersonaResolver {
  constructor(private readonly read: (selection: CharacterSelection, path: string) => Promise<Uint8Array>) {}
  async resolve(selection: CharacterSelection, language: AppLanguage): Promise<PersonaBinding> {
    try {
      const character = parseCharacterManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.read(selection, "character.json")))).value
      if (character.id !== selection.id) throw new Error("PACK_PERSONA")
      const persona = character.persona ? parseCharacterPersona(await this.read(selection, resolvePackReference(character.persona, "character.json"))) : neutralPersona()
      let label = character.label
      if (character.chat) {
        try {
          const chat = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.read(selection, resolvePackReference(character.chat, "character.json"))))
          // This consumer uses identity only; pose mappings remain owned by Character Chat.
          label = validateChatDefinition(chat, []).value.profile.displayName || label
        } catch { /* Optional chat metadata must not disable a valid Side Chat persona. */ }
      }
      return { ...selection, label, compiled: compilePersona(label, persona, language) }
    } catch { throw new Error("PACK_PERSONA") }
  }
}
