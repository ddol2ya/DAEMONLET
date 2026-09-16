import { parseArgs } from 'node:util'
import { readFile, stat } from 'node:fs/promises'
import { withPackTools } from './pack-tools.mjs'

const { values } = parseArgs({ options: { input: { type: 'string' } } })
if (!values.input) throw new Error('Usage: validate-persona.mjs --input <persona.json>')
await withPackTools(async tools => {
  if ((await stat(values.input)).size > tools.PERSONA_MAX_BYTES) throw new Error('PACK_PERSONA')
  const persona = tools.parseCharacterPersona(await readFile(values.input))
  console.log(JSON.stringify({ valid: true, schemaVersion: 1, personaHash: tools.sha256(Buffer.from(JSON.stringify(persona))) }))
})
