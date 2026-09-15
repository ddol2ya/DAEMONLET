import type { BrowserWindow } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { resolvePackReference } from "../shared/character-pack-path"
import type { CharacterSelection } from "../shared/character-pack-contract"
import type { CharacterRegistry } from "./CharacterRegistry"
import type { SideChatService } from "./side-chat/SideChatService"
import type { PersonaResolver } from "./side-chat/PersonaResolver"
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Runs only in an explicitly isolated smoke profile. Coordinates come from
 * each imported pack's authored interaction areas, never another character. */
export async function runSideChatPackSmoke(o: { registry: CharacterRegistry; service: SideChatService; resolver: PersonaResolver; pet: BrowserWindow; select: (value: CharacterSelection) => Promise<void>; output: string }) {
  if (process.env.ELECTRON_SMOKE_TEST !== "1" || !process.env.ELECTRON_SMOKE_USER_DATA) throw Error("Pack smoke requires isolated profile")
  const rows = []
  o.service.configure(true, "ko"); o.service.setMode("hidden")
  const external = o.registry.snapshot().entries.filter(e => e.source === "external")
  for (const entry of external) {
    await o.select(entry)
    for (let n = 0; n < 200 && (o.service.snapshot().character.id !== entry.id || o.service.snapshot().applying); n++) await wait(50)
    if (o.service.snapshot().character.id !== entry.id || o.service.snapshot().applying) throw Error("Pack smoke persona not applied")
    const binding = await o.resolver.resolve(entry, "ko")
    const path = join(o.output, entry.id); await mkdir(path, { recursive: true })
    await wait(350); await writeFile(join(path, "selected.png"), (await o.pet.webContents.capturePage()).toPNG())
    const character = JSON.parse(new TextDecoder().decode(await o.registry.readPersonaAsset(entry, "character.json")))
    const overridePath = character.base.overrides && await o.registry.resolveAsset(entry.id, entry.revision, resolvePackReference(character.base.overrides, "character.json"))
    const areas = overridePath ? JSON.parse(await readFile(overridePath, "utf8")).interactionAreas : null
    const reactions: Record<string, string> = {}
    for (const [part, trigger] of [["head", "interaction.head-tap"], ["torso", "interaction.torso-tap"]]) {
      const area = areas?.[part]
      if (!area) { reactions[part] = "NOT_RUN: no authored area"; continue }
      const point = await o.pet.webContents.executeJavaScript(`(()=>{const c=document.querySelector('canvas'),r=c.getBoundingClientRect(),scale=Math.min(r.width/c.width,r.height/c.height);return {x:Math.round(r.x+(r.width-c.width*scale)/2+${(area.x0 + area.x1) / 2}*scale),y:Math.round(r.y+(r.height-c.height*scale)/2+${(area.y0 + area.y1) / 2}*scale)}})()`)
      o.pet.webContents.sendInputEvent({ type: "mouseMove", ...point })
      o.pet.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point }); await wait(60)
      o.pet.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
      let seen = false
      for (let n = 0; n < 60; n++) { seen = await o.pet.webContents.executeJavaScript(`Boolean(document.querySelector('.speech-bubble[data-trigger="${trigger}"]'))`); if (seen) break; await wait(50) }
      reactions[part] = seen ? "PASS" : "FAIL"
      await wait(180); await writeFile(join(path, `${part}-tap.png`), (await o.pet.webContents.capturePage()).toPNG())
      await wait(3300)
    }
    rows.push({ id: entry.id, revision: entry.revision, version: entry.version, personaHash: binding.compiled.personaHash, visualApply: "PASS", reactions })
    await o.select({ id: "gpichan", revision: "builtin" })
  }
  o.service.configure(false, "ko")
  const result = { status: rows.length && rows.every(r => Object.values(r.reactions).every(v => v === "PASS")) ? "PASS" : "FAIL", rows }
  await mkdir(o.output, { recursive: true }); await writeFile(join(o.output, "pack-switch-result.json"), JSON.stringify(result, null, 2) + "\n")
  return result
}
