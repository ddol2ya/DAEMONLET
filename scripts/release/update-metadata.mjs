// Local metadata only. This module never imports a publisher or uploads artifacts.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { valid, prerelease } from 'semver'
import { BUNDLE_ID, APP_NAME } from '../../electron/shared/app-identity.mjs'
import { initializeValidation } from './artifact-source.mjs'
const run = promisify(execFile)
export async function createUpdateMetadata({ artifact, output, platform, minimumSystemVersion, manifest, packagingResult, review = false }) {
  if (!['darwin', 'win32'].includes(platform) || !valid(minimumSystemVersion)) throw Error('Explicit supported platform and minimum kernel OS SemVer required')
  artifact = resolve(artifact); output = resolve(output)
  const root = resolve(artifact, '..'), file = basename(artifact)
  const record = await initializeValidation({ root, artifacts: [{ file, kind: platform === 'darwin' ? 'macosFinalZip' : 'windowsInstallerExe' }], packagingResults: packagingResult ? [resolve(packagingResult)] : [] })
  const version = record.appVersion
  if (!valid(version) || prerelease(version) || record.source.dirty) throw Error('Clean stable source identity required; never replace an already released version')
  const expected = 'Daemonlet-for-Codex-' + version + (platform === 'darwin' ? '-macOS-arm64.zip' : '-windows-x64-Setup.exe')
  if (file !== expected) throw Error('Unexpected update asset name')
  if (!review) {
    if (platform === 'darwin') {
      if (process.platform !== 'darwin' || !manifest) throw Error('Final Mac archive verification requires macOS and the private signing manifest')
      const signer = JSON.parse(await readFile(resolve(manifest), 'utf8')).signer
      const temp = await mkdtemp(join(tmpdir(), 'daemonlet-update-verify-'))
      try {
        await run('/usr/bin/ditto', ['-x', '-k', artifact, temp])
        const app = join(temp, APP_NAME + '.app')
        const { verifyApp } = await import('../macos/verify.mjs')
        const verified = await verifyApp(app, signer, { requireTicket: true })
        if (verified.version !== version) throw Error('Archive version mismatch')
        const config = JSON.parse(await readFile(join(app, 'Contents/Resources/app-update.yml'), 'utf8'))
        if (config.provider !== 'github' || config.owner !== 'ddol2ya' || config.repo !== 'DAEMONLET') throw Error('Update configuration missing before signing')
      } finally { await rm(temp, { recursive: true, force: true }) }
    } else {
      if (process.platform !== 'win32' || !packagingResult) throw Error('Windows final signature verification requires Windows')
      const result = JSON.parse(await readFile(resolve(packagingResult), 'utf8'))
      if (result.signing !== 'verified' || !result.publisherName) throw Error('Signed Windows publisher verification required')
      const { verifySignature } = await import('electron-updater/out/windowsExecutableCodeSignatureVerifier.js')
      if (await verifySignature([result.publisherName], artifact, console)) throw Error('Installer Authenticode verification failed')
    }
  }
  const hash = createHash('sha512'); let size = 0
  for await (const part of createReadStream(artifact)) { hash.update(part); size += part.length }
  const sha512 = hash.digest('base64')
  const metadata = { version, files: [{ url: file, sha512, size }], path: file, sha512, releaseDate: new Date().toISOString(), minimumSystemVersion,
    daemonlet: { appId: BUNDLE_ID, platform, arch: platform === 'darwin' ? 'arm64' : 'x64', installType: platform === 'darwin' ? 'mac' : 'nsis', ...(review ? { reviewOnly: true } : {}) } }
  await mkdir(output, { recursive: true })
  const destination = join(output, platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml')
  // JSON is YAML 1.2 and is consumed by the pinned official updater's js-yaml parser.
  await writeFile(destination, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' })
  return { metadata: destination, version, size, sha512, published: false, verification: review ? 'REVIEW_ONLY_NOT_DISTRIBUTABLE' : 'signed-final-artifact' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { artifact: { type: 'string' }, output: { type: 'string' }, platform: { type: 'string' }, 'minimum-system-version': { type: 'string' }, manifest: { type: 'string' }, 'packaging-result': { type: 'string' }, review: { type: 'boolean' } } })
  if (!values.artifact || !values.output) throw Error('Require --artifact <final archive> --output <new metadata directory> --platform darwin|win32 --minimum-system-version <kernel SemVer>')
  console.log(JSON.stringify(await createUpdateMetadata({ artifact: values.artifact, output: values.output, platform: values.platform, minimumSystemVersion: values['minimum-system-version'], manifest: values.manifest, packagingResult: values['packaging-result'], review: values.review }), null, 2))
}
