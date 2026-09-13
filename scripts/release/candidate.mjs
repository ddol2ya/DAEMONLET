import { APP_NAME, BUNDLE_ID } from "../../electron/shared/app-identity.mjs"
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify, parseArgs } from 'node:util'
import { ZipFile } from 'yazl'
import { checkCandidate } from './check.mjs'
import { packageCreator } from './creator.mjs'
import {createValidation, readBuildSource, recordCheck, saveValidation} from './validation.mjs'
import { checkExternalNotices } from './check-notices.mjs'

const { values } = parseArgs({ options: { platform: { type: 'string', default: 'win32' }, arch: { type: 'string', default: 'x64' }, output: { type: 'string' } } })
if (!values.output || values.platform !== 'win32' || values.arch !== 'x64') throw new Error('This release targets Windows x64 only. Require --output <new directory> [--platform win32 --arch x64]')
const root = resolve(import.meta.dirname, '../..'), output = resolve(values.output)
await mkdir(output, { recursive: true })
// Explicit marker creation prevents silently replacing an earlier candidate.
await writeFile(join(output, 'candidate-started.json'), JSON.stringify(values), { flag: 'wx' })
process.chdir(root)
process.env.PET_BUILD_PLATFORM = values.platform
const exec = promisify(execFile)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
async function build(script) {
  console.log(`Building ${script}`)
  const { stdout, stderr } = await exec(npm, ['run', script], { cwd: root, env: process.env, timeout: 600_000, maxBuffer: 16 * 1024 ** 2, ...(process.platform === 'win32' ? { shell: true } : {}) })
  await writeFile(join(output, script.replaceAll(':', '-') + '.log'), stdout + stderr)
}
await build('build:renderer')
await build('build:electron:production')
const { api, utils } = await import('@electron-forge/core')
const { default: base } = await import('../../forge.config.mjs')
utils.registerForgeConfigForDirectory(root, base)
let apps
try { apps = await api.package({ dir: root, platform: values.platform, arch: values.arch, outDir: join(output, 'work'), interactive: false }) }
finally { utils.unregisterForgeConfigForDirectory(root) }
const appDirectory = apps[0].packagedPath
const name = APP_NAME, app = appDirectory
const resources = join(app, 'resources')
const checks = await checkCandidate(join(resources, 'app.asar'))
await checkExternalNotices(join(resources, 'licenses'))
// Keep Electron and Chromium notices supplied with the exact runtime distribution.
const chromiumNotice = join(appDirectory, 'LICENSES.chromium.html')
await stat(chromiumNotice)
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const label = `Daemonlet-for-Codex-${pkg.version}-windows-${values.arch}`
const stage = join(output, 'bundle', label)
await mkdir(stage, { recursive: true })
await cp(app, join(stage, name), { recursive: true })
await cp(join(root, 'distribution/README.md'), join(stage, 'README.md'))
await cp(join(root, 'distribution/ARTWORK-NOTICE.md'), join(stage, 'ARTWORK-NOTICE.md'))
await cp(join(root, 'distribution/ARTWORK-LICENSE.md'), join(stage, 'ARTWORK-LICENSE.md'))
await cp(join(root, 'distribution/ARTWORK-SCOPE.json'), join(stage, 'ARTWORK-SCOPE.json'))
await cp(join(root, 'LICENSE'), join(stage, 'LICENSE.txt'))
await cp(join(root, 'dist/licenses'), join(stage, 'licenses/renderer'), { recursive: true })
await cp(join(root, 'dist-electron/licenses'), join(stage, 'licenses/desktop'), { recursive: true })
await cp(chromiumNotice, join(stage, 'licenses/LICENSES.chromium.html'))
const electronLicense = join(appDirectory, 'LICENSE')
await cp(electronLicense, join(stage, 'licenses/Electron-LICENSE.txt'))
await mkdir(join(output, 'artifacts'))
const archive = join(output, 'artifacts', label + '.zip')
async function zipDirectory(directory, archive) {
  const zip = new ZipFile()
  async function walk(path, prefix) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await walk(join(path, entry.name), prefix + entry.name + '/')
      else if (entry.isFile()) zip.addFile(join(path, entry.name), prefix + entry.name, { mode: 0o100644, mtime: new Date('2000-01-01') })
      else throw new Error('ZIP helper only accepts ordinary files')
    }
  }
  await walk(directory, basename(directory) + '/')
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(archive, { flags: 'wx' }))
}
await zipDirectory(stage, archive)
const creator = await packageCreator(join(output,'creator'))
await cp(creator.archive,join(output,'artifacts',basename(creator.archive)))
const hashes = []
for (const file of (await readdir(join(output, 'artifacts'))).sort()) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(join(output, 'artifacts', file))) hash.update(bytes)
  hashes.push(`${hash.digest('hex')}  ${file}`)
}
await writeFile(join(output, 'artifacts/SHA256SUMS.txt'), hashes.join('\n') + '\n')
await writeFile(join(output, 'candidate-review.json'), JSON.stringify({ ...checks, platform: values.platform, arch: values.arch, version: pkg.version, app, archive,
  distribution: 'test-candidate', signing: 'unsigned Windows test candidate',
  rightsReview: 'THIRD_PARTY_NOTICES.md', externalPublication: false, nativeSmoke: 'pending' }, null, 2) + '\n')
const validation = await createValidation({root: output, source: await readBuildSource(root), appVersion: pkg.version, target: {platform: values.platform, arch: values.arch, osVersion: process.platform === values.platform ? (await import('node:os')).version() : 'NOT_RUN: cross-packaged; native OS not observed'}, artifacts: [{file: 'artifacts/' + basename(archive), kind: 'windowsPortableZip'}]})
await recordCheck(validation, output, {kind: 'build', status: 'PASS', procedure: 'release:candidate: renderer, production Electron and Forge Windows package', evidence: ['build-renderer.log', 'build-electron-production.log', 'candidate-review.json']})
await recordCheck(validation, output, {kind: 'asar', status: 'PASS', procedure: 'checkCandidate and checkExternalNotices on packaged input before ZIP creation; native extraction is a separate check', evidence: ['candidate-review.json']})
await saveValidation(output, validation)
// Candidate work and evidence stay outside artifacts; only artifacts are handoff files.
await rm(join(output, 'bundle'), { recursive: true })
await rm(join(output, 'creator'), { recursive: true })
console.log(JSON.stringify({ app, archive, checks, distribution: 'test-candidate' }, null, 2))
