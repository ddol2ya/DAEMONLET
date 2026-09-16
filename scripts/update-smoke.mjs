// Standalone local-feed QA builder/server. No imports from this file enter main.ts.
import { build } from 'esbuild'
import { api, utils } from '@electron-forge/core'
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join, resolve, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import base from '../forge.config.mjs'
import { signedForgeConfig } from './macos/policy.mjs'
const defaultDesktopSettings = () => ({ schemaVersion: 1, characterId: 'gpichan', alwaysOnTop: true, showOnAllWorkspaces: true, showOverFullScreen: false, clickThrough: true, speechBubblesEnabled: true, updateAutoCheck: false })
const run = promisify(execFile), root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { output: { type: 'string' }, 'signing-manifest': { type: 'string' }, serve: { type: 'boolean' }, pack: { type: 'string' } } })
if (!values.output) throw Error('Require --output <new isolated QA directory>')
const output = resolve(values.output), feed = join(output, 'feed'), port = 45943
if (values.serve) {
  const server = createServer(async (request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1)
      if (!['latest-mac.yml', 'Daemonlet-for-Codex-0.7.3-macOS-arm64.zip'].includes(name)) { response.writeHead(404); response.end(); return }
      const file = join(feed, name), info = await stat(file)
      response.writeHead(200, { 'Content-Length': info.size, 'Content-Type': name.endsWith('.yml') ? 'application/yaml' : 'application/zip' })
      createReadStream(file).pipe(response)
    } catch { response.writeHead(404); response.end() }
  })
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ feed: 'http://127.0.0.1:' + port, output })))
} else {
  if (process.platform !== 'darwin' || !values['signing-manifest']) throw Error('Mac signing manifest required; no signing key is exported')
  await mkdir(output); await mkdir(feed)
  const signer = JSON.parse(await readFile(resolve(values['signing-manifest']), 'utf8')).signer
  const profile = join(output, 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'desktop-settings.json'), JSON.stringify({ ...defaultDesktopSettings(), visible: true, adapterAutoStart: false, sideChatEnabled: false, taskBubblesEnabled: false, language: 'en', scale: .8, bounds: { x: 200, y: 180, width: 368, height: 368, displayId: 1 }, bubblePlacement: { schemaVersion: 1, mode: 'relative', offsetX: 210, offsetY: -85, pivotX: 0, pivotY: .5 } }))
  await writeFile(join(profile, 'side-chat.json'), JSON.stringify({ version: 1, consentVersion: 1, executable: join(output, 'uninvoked-codex-selection'), offNoticeSeen: true }), { mode: 0o600 })
  const apps = []
  for (const version of ['0.7.2', '0.7.3']) {
    const stage = join(output, 'stage-' + version)
    await mkdir(stage)
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); pkg.version = version
    await writeFile(join(stage, 'package.json'), JSON.stringify(pkg))
    for (const name of ['dist', 'dist-electron']) await cp(join(root, name), join(stage, name), { recursive: true })
    const result = await build({ absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], minify: true, metafile: true, define: { __APP_QA__: 'true', __SETUP_SMOKE__: 'false' }, entryPoints: [join(root, 'electron/main/updates/UpdateSmokeEntry.ts')], outfile: join(stage, 'dist-electron/main.cjs') })
    await writeFile(join(stage, 'dist-electron/build-mode.json'), JSON.stringify({ schemaVersion: 1, production: false, setupSmoke: false, updateSmoke: true }))
    await writeFile(join(stage, 'dist-electron/bundle-inputs.json'), JSON.stringify({ production: false, inputs: Object.keys(result.metafile.inputs) }))
    const cacheName = 'daemonlet-updater-qa-' + basename(output).replace(/[^a-zA-Z0-9-]/g, '-')
    await writeFile(join(stage, 'dist-electron/app-update.yml'), JSON.stringify({ provider: 'generic', url: 'http://127.0.0.1:' + port, updaterCacheDirName: cacheName }))
    const smokeConfig = join(stage, 'update-smoke.json')
    await writeFile(smokeConfig, JSON.stringify({ feed: 'http://127.0.0.1:' + port, output, profile, cacheName, nextVersion: '0.7.3', ...(values.pack ? { pack: resolve(values.pack) } : {}), protocolPort: 45944, hookPort: 45945 }))
    const config = signedForgeConfig(base, signer)
    config.packagerConfig.appBundleId = 'io.github.ddol2ya.daemonlet.update-review.' + createHash('sha256').update(output).digest('hex').slice(0, 12)
    config.packagerConfig.electronVersion = pkg.devDependencies.electron
    config.packagerConfig.extraResource = [join(stage, 'dist-electron/codex'), join(stage, 'dist-electron/native'), join(stage, 'dist-electron/app-update.yml'), join(root, 'dist-notices/licenses'), smokeConfig]
    utils.registerForgeConfigForDirectory(stage, config)
    try { const packaged = await api.package({ dir: stage, platform: 'darwin', arch: 'arm64', outDir: join(output, 'apps-' + version), interactive: false }); apps.push(join(packaged[0].packagedPath, 'Daemonlet for Codex.app')) } finally { utils.unregisterForgeConfigForDirectory(stage) }
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and certificate leaf = H"' + signer.fingerprint + '"', apps.at(-1)])
  }
  const file = 'Daemonlet-for-Codex-0.7.3-macOS-arm64.zip', archive = join(feed, file)
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', apps[1], archive], { timeout: 180000 })
  const hash = createHash('sha512'); for await (const part of createReadStream(archive)) hash.update(part)
  const sha512 = hash.digest('base64'), size = (await stat(archive)).size
  await writeFile(join(feed, 'latest-mac.yml'), JSON.stringify({ version: '0.7.3', files: [{ url: file, sha512, size }], path: file, sha512, minimumSystemVersion: '22.0.0', daemonlet: { appId: 'io.github.ddol2ya.daemonlet', platform: 'darwin', arch: 'arm64', installType: 'mac' } }))
  await writeFile(join(output, 'qa-build.json'), JSON.stringify({ apps, archive, sha512, size, signed: true, isolatedNativeBundleId: true, notarized: false, productionCandidate: false, publicUpload: false }, null, 2))
  console.log(JSON.stringify({ apps, output, next: 'Start this script with --serve, launch apps[0], inspect download-only.json, then write the authorized target version to approve-install.' }, null, 2))
}
