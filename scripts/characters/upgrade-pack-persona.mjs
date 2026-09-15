import { parseArgs } from 'node:util'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { withPackTools } from './pack-tools.mjs'
import { exportPack } from './export-pack.mjs'

/** Metadata-only migration. Extraction, inventory, raster and rig checks are shared with import. */
export async function upgradePackPersona(values) {
  for (const key of ['input', 'persona', 'version', 'output', 'report']) if (!values[key]) throw new Error(`Missing --${key}`)
  const input = resolve(values.input), output = resolve(values.output), report = resolve(values.report)
  if (new Set([input, resolve(values.persona), output, report]).size !== 4) throw new Error('Paths must be distinct')
  for (const path of [output, report]) if (await access(path).then(() => true, () => false)) throw new Error('Output/report already exists')
  const stage = await mkdtemp(join(tmpdir(), 'petchar-persona-'))
  try {
    return await withPackTools(async tools => {
      if (!tools.isPackVersion(values.version)) throw new Error('PACK_MANIFEST')
      const persona = tools.parseCharacterPersona(await tools.boundedFile(dirname(resolve(values.persona)), basename(resolve(values.persona)), tools.PERSONA_MAX_BYTES))
      const source = await tools.extractCharacterPack(input, stage)
      const original = source.manifest
      if (tools.comparePackVersions(values.version, original.version) <= 0) throw new Error('PACK_DOWNGRADE')
      const payload = join(stage, 'payload'), staging = join(stage, 'updated')
      await mkdir(staging)
      for (const f of original.files) {
        await mkdir(dirname(join(staging, f.path)), { recursive: true })
        await copyFile(join(payload, f.path), join(staging, f.path))
      }
      const character = JSON.parse(await readFile(join(payload, 'character.json'), 'utf8'))
      const personaPath = character.persona ? tools.resolvePackReference(character.persona, 'character.json', new Set(original.files.map(f => f.path))) : 'persona.json'
      if (!character.persona && original.files.some(f => f.path === personaPath)) throw new Error('PACK_PERSONA')
      character.persona = personaPath
      await writeFile(join(staging, personaPath), JSON.stringify(persona, null, 2) + '\n')
      await writeFile(join(staging, 'character.json'), JSON.stringify(character, null, 2) + '\n')
      const unchanged = []
      for (const f of original.files) {
        if (f.path === 'character.json' || f.path === personaPath) continue
        const after = await tools.boundedFile(staging, f.path)
        if (tools.sha256(after) !== f.sha256 || after.length !== f.bytes) throw new Error('PACK_INTEGRITY')
        unchanged.push(f)
      }
      const candidate = join(stage, 'result.petchar')
      const result = await exportPack({ 'character-root': staging, version: values.version, output: candidate }, original)
      const verifyRoot = join(stage, 'verify'); await mkdir(verifyRoot)
      const verified = await tools.extractCharacterPack(candidate, verifyRoot)
      const summary = {
        input: { file: input, sha256: tools.sha256(await readFile(join(stage, 'archive.zip'))), id: original.id, version: original.version, name: original.name, capabilities: original.runtime.capabilities, poseCount: source.poseCount },
        output: { ...result, output, sha256: tools.sha256(await readFile(candidate)), capabilities: verified.manifest.runtime.capabilities },
        personaHash: tools.sha256(Buffer.from(JSON.stringify(persona))),
        allowedChanges: ['pack.json', 'character.json', personaPath], unchangedFiles: unchanged,
        visualAssetChanges: 0, rigChanges: 0, validation: { originalImport: 'PASS', outputImport: 'PASS', bytePreservation: 'PASS', visualReview: 'NOT_RUN' },
      }
      // Publish only fully validated artifacts, using exclusive creation even on races.
      await mkdir(dirname(output), { recursive: true }); await mkdir(dirname(report), { recursive: true })
      const { constants } = await import('node:fs')
      await copyFile(candidate, output, constants.COPYFILE_EXCL)
      await writeFile(report, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      return summary
    })
  } finally { await rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['input', 'persona', 'version', 'output', 'report'].map(k => [k, { type: 'string' }])) })
  const report = await upgradePackPersona(values)
  console.log(JSON.stringify({ ...report, unchangedFiles: report.unchangedFiles.length }, null, 2))
}
