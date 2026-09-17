import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { withPackTools } from './pack-tools.mjs'
import { archiveHash } from './add-update-source.mjs'

/** Exact-file allowlist. A directory is never an upload operation. No credentials in the plan. */
export async function preparePublication(plan) {
  if (!plan || Object.keys(plan).some(k => !['repoId', 'public', 'packs', 'documents'].includes(k)) || plan.public !== true || !Array.isArray(plan.packs) || plan.packs.length < 1 || plan.packs.length > 32 || !Array.isArray(plan.documents) || plan.documents.length > 8) throw Error('Invalid public publication plan')
  const stage = await mkdtemp(join(tmpdir(), 'petchar-publication-'))
  try { return await withPackTools(async tools => {
    const packs = [], ids = new Set(), paths = new Set()
    for (const [index, item] of plan.packs.entries()) {
      if (!item || Object.keys(item).some(k => !['pack', 'packId', 'artifactPath', 'manifestPath', 'minAppVersion', 'notes'].includes(k))) throw Error('Invalid pack allowlist')
      const root = join(stage, String(index)); await mkdir(root)
      const pack = await tools.extractCharacterPack(resolve(item.pack), root), m = pack.manifest
      if (m.id !== item.packId || ids.has(m.id) || !m.update || m.update.repoId !== plan.repoId || m.update.manifestPath !== item.manifestPath || paths.has(item.artifactPath) || paths.has(item.manifestPath)) throw Error('Pack/source/allowlist mismatch')
      const sha256 = await archiveHash(join(root, 'archive.zip'))
      const feed = tools.parseUpdateFeed(Buffer.from(JSON.stringify({ schemaVersion: 1, packId: m.id, version: m.version, minAppVersion: item.minAppVersion, runtime: m.runtime, artifact: { path: item.artifactPath, revision: '0'.repeat(40), bytes: (await stat(join(root, 'archive.zip'))).size, sha256 }, notes: item.notes })))
      // This template is private and cannot be published until the actual artifact commit is known.
      delete feed.artifact.revision
      if (await archiveHash(item.pack) !== sha256) throw Error('Source archive changed during validation')
      ids.add(m.id); paths.add(item.artifactPath); paths.add(item.manifestPath)
      packs.push({ file: resolve(item.pack), path: item.artifactPath, manifestPath: item.manifestPath, sha256, bytes: feed.artifact.bytes, feed })
    }
    const documents = []
    for (const item of plan.documents) {
      if (!item || Object.keys(item).length !== 2 || typeof item.file !== 'string' || !['README.md', 'SHA256SUMS.txt', 'PROVENANCE.md', 'LICENSE.txt'].includes(item.path) || paths.has(item.path)) throw Error('Document not allowlisted')
      if ((await stat(item.file)).size > 128 * 1024) throw Error('Document too large')
      paths.add(item.path); documents.push({ file: resolve(item.file), path: item.path, sha256: await archiveHash(item.file) })
    }
    return { repoId: plan.repoId, public: true, packs, documents }
  }) } finally { await rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, record: { type: 'string' }, publish: { type: 'boolean', default: false }, 'create-repo': { type: 'boolean', default: false }, python: { type: 'string', default: process.platform === 'win32' ? 'python' : 'python3' } } })
  if (!values.plan || !values.record) throw Error('Require --plan <exact-file JSON> --record <private resumable record>; default is dry-run')
  if ((await stat(values.plan)).size > 128 * 1024) throw Error('Plan too large')
  const plan = await preparePublication(JSON.parse(await readFile(values.plan, 'utf8')))
  console.log(JSON.stringify({ mode: values.publish ? 'publish' : 'dry-run', destination: `https://huggingface.co/datasets/${plan.repoId}`, visibility: 'public, ungated', files: [...plan.packs.flatMap(p => [p.path, p.manifestPath]), ...plan.documents.map(d => d.path)], hashes: plan.packs.map(p => ({ path: p.path, sha256: p.sha256, bytes: p.bytes })) }, null, 2))
  if (values.publish) {
    const staging = await mkdtemp(join(tmpdir(), 'petchar-publish-plan-'))
    try {
      const validated = join(staging, 'plan.json'); await writeFile(validated, JSON.stringify(plan), { mode: 0o600 })
      await mkdir(dirname(resolve(values.record)), { recursive: true })
      const result = await promisify(execFile)(values.python, [join(import.meta.dirname, 'publish-update-packs.py'), '--plan', validated, '--record', resolve(values.record), '--publish', ...(values['create-repo'] ? ['--create-repo'] : [])], { timeout: 30 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' } })
      console.log(result.stdout)
    } catch { throw Error('Publication did not complete. Check the private record; no feed is published before artifact verification. HF write access and the developer huggingface_hub package are required.') }
    finally { await rm(staging, { recursive: true, force: true }) }
  }
}
