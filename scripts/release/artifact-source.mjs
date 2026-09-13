// Read provenance from the selected bytes, never from the current checkout.
import {createWriteStream} from 'node:fs'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {extname, join, normalize} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {promisify} from 'node:util'
import {assertSameSource, buildIdentity, createValidation, fileIdentity} from './validation.mjs'

const JSON_LIMIT = 1024 * 1024
const ASAR_LIMIT = 512 * 1024 * 1024
const sameFile = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256
export async function readAsarIdentity(path) {
  const {extractFile, statFile, uncache} = await import('@electron/asar')
  uncache(path)
  try {
    const json = name => {
      const entry = statFile(path, normalize(name), false)
      if (entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > JSON_LIMIT) throw Error('Invalid embedded build metadata: ' + name)
      return JSON.parse(extractFile(path, normalize(name), false).toString('utf8'))
    }
    const pkg = json('package.json')
    if (pkg.name !== 'daemonlet-for-codex') throw Error('Not a Daemonlet app archive')
    const desktop = buildIdentity(json('dist-electron/build-source.json'), pkg.version)
    const renderer = buildIdentity(json('dist/build-source.json'), pkg.version)
    assertSameSource(desktop.source, renderer.source)
    return desktop
  } finally { uncache(path) }
}

async function readZipIdentity(path, creator) {
  const {open} = await import('yauzl')
  const zip = await promisify(open)(path, {lazyEntries: true, validateEntrySizes: true})
  const temporary = await mkdtemp(join(tmpdir(), 'daemonlet-artifact-source-'))
  const metadata = new Map(); let entries = 0, appFound = false
  try {
    await new Promise((done, reject) => {
      const fail = error => { zip.close(); reject(error) }
      zip.on('error', fail); zip.on('end', done)
      zip.on('entry', async entry => {
        try {
          if (++entries > 10000) throw Error('Too many artifact ZIP entries')
          const name = entry.fileName
          const app = /(^|\/)(Contents\/Resources|resources)\/app\.asar$/.test(name)
          const json = ['create-pet-character/build-source.json', 'create-pet-character/runtime/package.json'].includes(name)
          if ((creator && json) || (!creator && app)) {
            const limit = app ? ASAR_LIMIT : JSON_LIMIT
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000
            if (mode && mode !== 0o100000 || entry.generalPurposeBitFlag & 1 || entry.uncompressedSize < 1 || entry.uncompressedSize > limit) throw Error('Invalid ZIP build metadata entry')
            if (metadata.has(name) || app && appFound) throw Error('Ambiguous/duplicate ZIP build metadata')
            const stream = await promisify(zip.openReadStream.bind(zip))(entry)
            if (app) {
              appFound = true
              // Fixed destination: no ZIP entry path is used for extraction.
              const asar = join(temporary, 'app.asar')
              await pipeline(stream, createWriteStream(asar, {flags: 'wx'}))
              metadata.set(name, await readAsarIdentity(asar))
            } else {
              const chunks = []; let bytes = 0
              for await (const chunk of stream) { bytes += chunk.length; if (bytes > limit) throw Error('Oversized ZIP build metadata'); chunks.push(chunk) }
              metadata.set(name, JSON.parse(Buffer.concat(chunks).toString('utf8')))
            }
          }
          zip.readEntry()
        } catch (error) { fail(error) }
      })
      zip.readEntry()
    })
    if (!creator && appFound) return [...metadata.values()][0]
    if (creator) {
      const pkg = metadata.get('create-pet-character/runtime/package.json')
      if (pkg?.name !== 'daemonlet-character-runtime') throw Error('Missing creator package metadata')
      return buildIdentity(metadata.get('create-pet-character/build-source.json'), pkg.version)
    }
    throw Error('Artifact has no embedded app build information')
  } finally { zip.close(); await rm(temporary, {recursive: true, force: true}) }
}

async function readInstallerIdentity(artifact, results) {
  const matches = results.filter(r => r.schemaVersion === 1 && r.kind === 'windows-installer-build'
    && r.runtimeUnchanged === true && r.files?.some(file => sameFile(file, artifact)))
  if (!matches.length) throw Error('No hash-matched installer packaging result; checkout metadata cannot identify this EXE')
  const identities = matches.map(r => buildIdentity(r.source, r.appVersion))
  for (const identity of identities) assertSameBuild(identities[0], identity)
  return identities[0]
}
function assertSameBuild(expected, actual) {
  assertSameSource(expected.source, actual.source)
  if (expected.appVersion !== actual.appVersion) throw Error('Artifacts have different app versions')
}

/** @param {{root: string, artifacts: Array<{file: string, kind: string}>, packagingResults?: string[], target?: any}} options */
export async function initializeValidation({root, artifacts, packagingResults = [], target}) {
  const results = await Promise.all(packagingResults.map(async path => JSON.parse(await readFile(path, 'utf8'))))
  const inputs = []; let identity
  for (const artifact of artifacts) {
    const before = await fileIdentity(root, artifact.file), path = join(root, artifact.file)
    let current
    if (extname(path) === '.asar' && ['asar', 'testOnlySetupAsar'].includes(artifact.kind)) current = await readAsarIdentity(path)
    else if (extname(path) === '.zip' && ['creatorZip', 'windowsPortableZip', 'macosZip', 'macosUnsignedZip', 'macosFinalZip'].includes(artifact.kind)) current = await readZipIdentity(path, artifact.kind === 'creatorZip')
    else if (extname(path) === '.exe' && artifact.kind === 'windowsInstallerExe') current = await readInstallerIdentity(before, results)
    else throw Error('Unsupported artifact type: ' + artifact.kind)
    if (!sameFile(before, await fileIdentity(root, artifact.file))) throw Error('Artifact changed while identifying its source')
    if (identity) assertSameBuild(identity, current); else identity = current
    inputs.push(before)
  }
  if (!identity) throw Error('At least one identifiable artifact is required')
  const record = await createValidation({root, ...identity, artifacts, target})
  if (record.artifacts.some((a, i) => !sameFile(a, inputs[i]))) throw Error('Artifact changed before recording its source')
  return record
}
