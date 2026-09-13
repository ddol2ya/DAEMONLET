// A local installed-app replacement, distinct from the clean release/notary workflow.
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { APP_NAME, BUNDLE_ID, requireMac, selectIdentity } from './policy.mjs'
import { hashFile, repository, run, writeJSON } from './io.mjs'
import { verifyApp } from './verify.mjs'

const { values } = parseArgs({ options: { output: { type: 'string' }, 'installed-app': { type: 'string' } } })
if (!values.output || !values['installed-app']) throw new Error('Require --output <new-directory> --installed-app <existing-app>')
requireMac()
if (process.arch !== 'arm64') throw new Error('Local packaging currently targets macOS arm64')
const output = resolve(values.output), installed = resolve(values['installed-app'])
if (output === repository || installed === output || !installed.endsWith('.app')) throw new Error('Invalid package paths')
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await mkdir(output, { mode: 0o700 })
const evidence = join(output, 'evidence-private')
await mkdir(evidence, { mode: 0o700 })
const installedId = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(installed, 'Contents/Info.plist')])).stdout.trim()
if (installedId !== BUNDLE_ID) throw new Error('The installed app is not this project')
const display = await run('/usr/bin/codesign', ['-dv', '--verbose=4', installed])
const signature = display.stdout+'\n'+display.stderr
const name = signature.match(/^Authority=(Developer ID Application:.+)$/m)?.[1]
const team = signature.match(/^TeamIdentifier=(.+)$/m)?.[1]
const identities = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
const signer = selectIdentity(identities.stdout, name, team)
await mkdir(join(evidence, 'installed-before'), { mode: 0o700 })
await verifyApp(installed, signer, { evidence: join(evidence, 'installed-before') })

const sourceSnapshot = async () => {
  const files = new Set((await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.split('\0').filter(Boolean))
  const hashes = {}
  for (const file of [...files].sort()) {
    if ((await stat(join(repository, file))).isFile()) hashes[file] = await hashFile(join(repository, file))
  }
  return { baseCommit: (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    workingTreeHasChanges: Boolean((await run('git', ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()),
    sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), files: hashes }
}
const source = await sourceSnapshot()
await writeJSON(join(output, 'private-source-manifest.json'), source)
await writeJSON(join(output, 'private-build-input.json'), { signer, sourceCommit: source.baseCommit, sourceTreeSha256: source.sha256, localReplacement: true })
await run('npm', ['run', 'build:renderer'], { timeoutMs: 600000, logPath: join(evidence, 'build-renderer.json') })
await run('npm', ['run', 'build:electron:production'], { timeoutMs: 180000, logPath: join(evidence, 'build-electron.json') })
await run(process.execPath, ['scripts/macos/forge-worker.mjs', output], { timeoutMs: 900000, maxBytes: 16*1024*1024, logPath: join(evidence, 'forge-sign.json') })
const current = await sourceSnapshot()
if (current.sha256 !== source.sha256 || current.baseCommit !== source.baseCommit) throw new Error('Source changed during packaging')
const destination = join(output, 'signed', APP_NAME+'.app')
await mkdir(dirname(destination), { mode: 0o700 })
await rename(join(output, 'forge-output', APP_NAME+'-darwin-arm64', APP_NAME+'.app'), destination)
await mkdir(join(evidence, 'candidate'), { mode: 0o700 })
const manifest = await verifyApp(destination, signer, { evidence: join(evidence, 'candidate') })
const pkg = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
if (manifest.version !== pkg.version) throw new Error('Packaged version differs from source')
await writeJSON(join(output, 'private-manifest.json'), { ...manifest, signer, sourceCommit: source.baseCommit, sourceTreeSha256: source.sha256,
  workingTreeHasChanges: source.workingTreeHasChanges, localReplacement: true, notarizationSubmitted: false, createdAt: new Date().toISOString() })
console.log(JSON.stringify({ status: 'signed-local-build', app: destination, version: manifest.version,
  sourceTreeSha256: source.sha256, sourceFiles: Object.keys(source.files).length, sameSignerAsInstalled: true,
  signedCodeCount: manifest.signedCode.length, notarizationSubmitted: false }))
