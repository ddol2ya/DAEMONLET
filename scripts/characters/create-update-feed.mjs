import { parseArgs } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { withPackTools } from './pack-tools.mjs'
import { archiveHash } from './add-update-source.mjs'

export async function createUpdateFeed(values) {
  for (const k of ['pack', 'artifact-path', 'artifact-revision', 'min-app-version', 'notes-file', 'output']) if (!values[k]) throw Error(`Missing --${k}`)
  if (resolve(values.output) === resolve(values.pack) || resolve(values.output) === resolve(values['notes-file'])) throw Error('Paths must be distinct')
  const stage = await mkdtemp(join(tmpdir(), 'petchar-feed-'))
  try { return await withPackTools(async tools => {
    if ((await stat(values['notes-file'])).size > 8000) throw Error('PACK_UPDATE_METADATA')
    const pack = await tools.extractCharacterPack(resolve(values.pack), stage), m = pack.manifest
    if (!m.update || !tools.supportsUpdateRuntime(m.runtime)) throw Error('PACK_UPDATE_SOURCE')
    const artifact = join(stage, 'archive.zip')
    const feed = tools.parseUpdateFeed(Buffer.from(JSON.stringify({ schemaVersion: 1, packId: m.id, version: m.version, minAppVersion: values['min-app-version'], runtime: m.runtime, artifact: { path: values['artifact-path'], revision: values['artifact-revision'], bytes: (await stat(artifact)).size, sha256: await archiveHash(artifact) }, notes: await readFile(values['notes-file'], 'utf8') })))
    if (await archiveHash(values.pack) !== feed.artifact.sha256) throw Error('Input changed during feed generation')
    await mkdir(dirname(resolve(values.output)), { recursive: true })
    await writeFile(values.output, JSON.stringify(feed, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return feed
  }) } finally { await rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['pack', 'artifact-path', 'artifact-revision', 'min-app-version', 'notes-file', 'output'].map(k => [k, { type: 'string' }])) })
  console.log(JSON.stringify(await createUpdateFeed(values), null, 2))
}
