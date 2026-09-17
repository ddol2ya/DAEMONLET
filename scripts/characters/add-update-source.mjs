import { parseArgs } from 'node:util'
import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { withPackTools } from './pack-tools.mjs'
import { exportPack } from './export-pack.mjs'

export async function archiveHash(path) { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex') }
export async function addUpdateSource(values) {
  for (const key of ['input', 'version', 'repo-id', 'manifest-path', 'output']) if (!values[key]) throw Error(`Missing --${key}`)
  const input = resolve(values.input), output = resolve(values.output), report = resolve(values.report ?? values.output + '.report.json')
  if (new Set([input, output, report]).size !== 3) throw Error('Paths must be distinct')
  for (const p of [output, report]) if (await access(p).then(() => true, () => false)) throw Error('Output/report already exists')
  const stage = await mkdtemp(join(tmpdir(), 'petchar-update-source-'))
  try { return await withPackTools(async tools => {
    const update = tools.parseUpdateSource({ schemaVersion: 1, provider: 'huggingface', repoType: 'dataset', repoId: values['repo-id'], manifestPath: values['manifest-path'] })
    const original = await tools.extractCharacterPack(input, stage), manifest = original.manifest
    if (tools.comparePackVersions(values.version, manifest.version) <= 0) throw Error('PACK_DOWNGRADE')
    const payload = join(stage, 'updated'); await mkdir(payload)
    for (const f of manifest.files) { await mkdir(dirname(join(payload, f.path)), { recursive: true }); await copyFile(join(stage, 'payload', f.path), join(payload, f.path)) }
    // ID changes are opt-in and intended only for an inspected collision, never inferred from names.
    if (values['new-id']) {
      if (!tools.isCharacterId(values['new-id']) || values['new-id'] === 'gpichan' || values['new-id'] === manifest.id) throw Error('PACK_MANIFEST')
      const character = JSON.parse(await readFile(join(payload, 'character.json'), 'utf8')); character.id = values['new-id']
      await writeFile(join(payload, 'character.json'), JSON.stringify(character, null, 2) + '\n')
    }
    const candidate = join(stage, 'candidate.petchar')
    await exportPack({ 'character-root': payload, version: values.version, output: candidate }, { ...manifest, update })
    const verifyRoot = join(stage, 'verify'); await mkdir(verifyRoot)
    const verified = await tools.extractCharacterPack(candidate, verifyRoot)
    const unchangedFiles = [], changedFiles = ['pack.json']
    for (const before of manifest.files) {
      const after = verified.manifest.files.find(f => f.path === before.path)
      if (!after || before.bytes !== after.bytes || before.sha256 !== after.sha256) {
        if (before.path !== 'character.json' || !values['new-id']) throw Error('PACK_INTEGRITY')
        changedFiles.push(before.path)
      } else unchangedFiles.push(before)
    }
    if (verified.manifest.files.length !== manifest.files.length) throw Error('PACK_INTEGRITY')
    const summary = { input: { sha256: await archiveHash(join(stage, 'archive.zip')), id: manifest.id, version: manifest.version, revision: original.revision }, output: { id: verified.manifest.id, version: verified.manifest.version, revision: verified.revision, sha256: await archiveHash(candidate), runtime: verified.manifest.runtime, update, poseCount: verified.poseCount }, changedFiles, unchangedFiles, visualAssetChanges: 0, rigChanges: 0, personaChanges: 0, validation: { inputImport: 'PASS', outputImport: 'PASS', bytePreservation: 'PASS', visualReview: 'NOT_RUN', packagedApp: 'NOT_RUN' } }
    if (await archiveHash(input) !== summary.input.sha256) throw Error('Input changed during repackaging')
    await mkdir(dirname(output), { recursive: true }); await mkdir(dirname(report), { recursive: true })
    await copyFile(candidate, output, constants.COPYFILE_EXCL)
    await writeFile(report, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return summary
  }) } finally { await rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['input', 'version', 'repo-id', 'manifest-path', 'output', 'report', 'new-id'].map(k => [k, { type: 'string' }])) })
  const report = await addUpdateSource(values)
  console.log(JSON.stringify({ ...report, unchangedFiles: report.unchangedFiles.length }, null, 2))
}
